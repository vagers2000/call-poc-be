import { initializeApp, cert, getApps } from "firebase-admin/app";
import { getFirestore } from "firebase-admin/firestore";
import { getMessaging } from "firebase-admin/messaging";
import apn from "apn";

if (!getApps().length) {
  const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT || "{}");
  initializeApp({ credential: cert(serviceAccount) });
}

const db = getFirestore();
const messaging = getMessaging();

// Init APNs provider for VoIP pushes
const apnProvider = new apn.Provider({
  token: {
    key: process.env.APN_AUTH_KEY_PATH || 'api/AuthKey_8C9AMXZAS5.p8', // Your .p8 file path
    keyId: process.env.APN_KEY_ID || '8C9AMXZAS5',
    teamId: process.env.APN_TEAM_ID || '9XVM2G2KN9',
  },
  production: process.env.APN_PRODUCTION === 'true', // true for prod, false for dev
});


const DEFAULT_ALLOWED_ORIGINS = [
  "https://flirtbate.web.app",
  "https://your-app.web.app",
  "http://localhost:3000",
  "http://localhost:5173",
];

const ALLOWED_ORIGINS = (process.env.ALLOWED_ORIGINS
  ? process.env.ALLOWED_ORIGINS.split(",").map((o) => o.trim()).filter(Boolean)
  : DEFAULT_ALLOWED_ORIGINS
);

const DEBUG = process.env.DEBUG_CORS === "true";

function isLocalhostOrigin(origin) {
  if (!origin) return false;
  return /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin);
}

function buildCorsHeaders(origin, acrHeadersRaw = "") {
  const headers = {};
  const requested = acrHeadersRaw
    ? acrHeadersRaw.split(",").map(h => (h || "").trim().toLowerCase()).filter(Boolean)
    : [];

  const allowedFromEnv = origin && ALLOWED_ORIGINS.includes(origin);
  const allowLocal = isLocalhostOrigin(origin);

  if (origin && (allowedFromEnv || allowLocal)) {
    headers["Access-Control-Allow-Origin"] = origin;
    headers["Access-Control-Allow-Credentials"] = "true";
  } else if (!origin) {
    headers["Access-Control-Allow-Origin"] = "*";
  } else {
    headers["Access-Control-Allow-Origin"] = "null";
  }

  headers["Vary"] = "Origin";
  headers["Access-Control-Allow-Methods"] = "POST,OPTIONS";

  const defaultAllowedHeaders = [
    "content-type",
    "authorization",
    "x-requested-with",
    "x-client-id",
    "x-firebase-locale",
    "x-vercel-protection-bypass",
  ];

  const set = new Set([
    ...defaultAllowedHeaders.map(h => h.toLowerCase()),
    ...requested
  ]);

  headers["Access-Control-Allow-Headers"] = Array.from(set).join(", ");
  headers["Access-Control-Max-Age"] = "3600";

  if (DEBUG) {
    console.log("CORS build:", { origin, allowedFromEnv, allowLocal, requested, headers });
  }

  return headers;
}

function normalizeDataMap(obj) {
  const out = {};
  if (!obj || typeof obj !== 'object') return out;
  Object.entries(obj).forEach(([k, v]) => {
    if (v === null || v === undefined) return;
    if (typeof v === 'string') out[k] = v;
    else out[k] = typeof v === 'object' ? JSON.stringify(v) : String(v);
  });
  return out;
}

async function sendApnsVoipPush(voipToken, payload, callType, callerName, callId) {
  let notification = new apn.Notification();

  notification.topic = `${process.env.IOS_BUNDLE_ID}.voip`; // Your iOS app bundle id + `.voip` suffix
  notification.pushType = "voip";
  notification.contentAvailable = 1;
  notification.sound = "default";
  
  notification.alert = {
    title: `${callerName || "Caller"} is calling`,
    body: `Tap to answer ${callType || "video"} call`,
  };

  notification.badge = 1;
  notification.category = "CALL_CATEGORY";
  
  notification.payload = payload;

  try {
    const result = await apnProvider.send(notification, voipToken);
    console.log("VoIP push sent:", result);
  } catch (err) {
    console.error("Error sending VoIP push:", err);
  }
}

export default async function handler(req, res) {
  const origin = req.headers.origin;
  const acrHeadersRaw = req.headers["access-control-request-headers"] || "";
  const corsHeaders = buildCorsHeaders(origin, acrHeadersRaw);
  Object.entries(corsHeaders).forEach(([k, v]) => res.setHeader(k, v));

  if (req.method === "OPTIONS") {
    if (DEBUG) {
      return res.status(204).json({
        debug: true,
        message: "preflight",
        incomingOrigin: origin,
        acrHeaders: acrHeadersRaw,
        corsHeaders,
      });
    }
    return res.status(204).end();
  }

  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  try {
    const {
      callId,
      channelName,
      callerUid,
      callerName,
      recipientId,
      agoraAppId,
      agoraToken,
      callType = "video",
      payload: incomingPayload,
    } = req.body || {};

    if (!callId || !channelName || !callerUid || !recipientId) {
      if (DEBUG) {
        return res.status(400).json({
          error: "Missing required fields",
          body: req.body,
          corsHeaders,
        });
      }
      return res.status(400).json({ error: "Missing required fields" });
    }

    // Fetch recipient by username
    const userQuery = await db.collection("user")
      .where("username", "==", recipientId)
      .limit(1)
      .get();

    if (userQuery.empty) {
      if (DEBUG) {
        console.log("Recipient not found (by username):", recipientId);
        return res.status(404).json({ error: "Recipient not found", corsHeaders });
      }
      return res.status(404).json({ error: "Recipient not found" });
    }

    const recipientDoc = userQuery.docs[0];
    const recipientData = recipientDoc.data() || {};
    const fcmToken = recipientData.fcmToken;
    const voipToken = recipientData.voipToken;
    const platform = (recipientData.platform || "android").toLowerCase();

    // Save call metadata to Firestore
    await db.collection("room").doc(channelName).set({
      channelName,
      callId,
      callerUid,
      callerName: callerName || callerUid,
      recipientId,
      createdBy: callerUid,
      createdAt: Date.now(),
      isActive: true,
      callType,
      platform: "web",
      agoraAppId: agoraAppId || process.env.AGORA_APP_ID,
      agoraToken: agoraToken || null,
    });

    console.log("Agora room created:", {
      channelName,
      callId,
      callerUid,
      recipientId,
      platform,
    });

    // Base CallKit payload fields
    const basePayload = {
      callId,
      channelName,
      webrtcRoomId: channelName,
      callerUid,
      callerName: callerName || callerUid,
      userId: recipientData.userId || recipientId,
      username: recipientId,
      name: recipientData.name || recipientId,
      imageUrl: recipientData.imageUrl || "",
      fcmToken: fcmToken || "",
      callAction: "join",
      callType: callType,

      agoraAppId: agoraAppId || process.env.AGORA_APP_ID,
      agoraToken: agoraToken || "",
      agoraChannelName: channelName,

      id: callId,
      nameCaller: callerName || callerUid,
      avatar: recipientData.imageUrl || "",
      handle: callerUid,
      type: callType === "video" ? 1 : 0,
      duration: 30000,
      textAccept: "Accept",
      textDecline: "Decline",
      missedCallNotification: {
        showNotification: true,
        count: 1,
      },
      extra: {
        agoraAppId: agoraAppId || process.env.AGORA_APP_ID,
        agoraToken: agoraToken || "",
        channelName: channelName,
      },
    };

    const mergedPayload = Object.assign({}, basePayload, incomingPayload || {});
    const dataMap = normalizeDataMap(mergedPayload);

    if (platform === "ios" && voipToken) {
      // Send direct APNs VoIP push
      await sendApnsVoipPush(voipToken, mergedPayload, callType, callerName, callId);
    } else if (fcmToken) {
      // Send regular FCM push
      const fcmMessage = {
        token: fcmToken,
        notification: {
          title: `${callerName || callerUid} is calling`,
          body: `Tap to answer ${callType} call`,
        },
        data: dataMap,
        android: {
          priority: "high",
          notification: {
            channelId: "calls",
            priority: "high",
            tag: callId,
            click_action: "FLUTTER_NOTIFICATION_CLICK",
            visibility: "public",
            sound: "default",
          },
          ttl: 60000,
        },
        apns: {
          headers: { "apns-priority": "10" },
          payload: {
            aps: {
              alert: {
                title: `${callerName || callerUid} is calling`,
                body: `Tap to answer ${callType} call`,
              },
              badge: 1,
              sound: "default",
              category: "CALL_CATEGORY",
              "content-available": 1,
            },
          },
        },
      };

      try {
        const result = await messaging.send(fcmMessage);
        console.log("FCM push sent result:", result);
      } catch (e) {
        console.error("FCM push error:", e);
      }
    } else {
      console.warn("No token (FCM or VoIP) available for recipient", recipientId);
    }

    if (DEBUG) {
      return res.status(200).json({
        success: true,
        debug: {
          corsHeaders,
          incomingOrigin: origin,
          payloadSent: mergedPayload,
          channelName,
        },
      });
    }

    return res.status(200).json({
      success: true,
      channelName,
      callId,
    });
  } catch (err) {
    console.error("Handler error:", err);
    Object.entries(
      buildCorsHeaders(req.headers.origin, req.headers["access-control-request-headers"] || "")
    ).forEach(([k, v]) => res.setHeader(k, v));

    if (DEBUG) {
      return res.status(500).json({
        error: err.message || "Internal server error",
        stack: (err.stack || "").split("\n").slice(0, 10),
      });
    }
    return res.status(500).json({ error: "Internal server error" });
  }
}

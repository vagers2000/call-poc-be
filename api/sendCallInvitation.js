// sendCallInvitation.js - Updated for Agora integration

import { initializeApp, cert, getApps } from "firebase-admin/app";
import { getFirestore } from "firebase-admin/firestore";
import { getMessaging } from "firebase-admin/messaging";

if (!getApps().length) {
  const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT || "{}");
  initializeApp({ credential: cert(serviceAccount) });
}

const db = getFirestore();
const messaging = getMessaging();

const DEFAULT_ALLOWED_ORIGINS = [
  "https://flirtbate.web.app",
  "https://your-app.web.app",
  "http://localhost:3000", // Added for local development
  "http://localhost:5173", // Vite default port
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
        corsHeaders 
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
      // ADDED: Agora-specific fields
      agoraAppId,
      agoraToken, // Optional: RTC token if using token authentication
      callType = "video", // 'video' or 'audio'
      payload: incomingPayload,
    } = req.body || {};

    if (!callId || !channelName || !callerUid || !recipientId) {
      if (DEBUG) {
        return res.status(400).json({ 
          error: "Missing required fields", 
          body: req.body, 
          corsHeaders 
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

    // Save call metadata to Firestore (for Agora)
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
      platform: 'web',
      // ADDED: Store Agora info
      agoraAppId: agoraAppId || process.env.AGORA_APP_ID,
      agoraToken: agoraToken || null,
    });

    console.log("Agora room created:", { 
      channelName, 
      callId, 
      callerUid, 
      recipientId, 
      platform 
    });

    // Build payload for mobile app
    const basePayload = {
      callId,
      channelName,
      webrtcRoomId: channelName, // Keep compatibility with Flutter app
      callerUid,
      callerName: callerName || callerUid,
      userId: recipientData.userId || recipientId,
      username: recipientId,
      name: recipientData.name || recipientId,
      imageUrl: recipientData.imageUrl || "",
      fcmToken: fcmToken || "",
      callAction: "join", // Mobile user joins the call
      callType: callType,
      // ADDED: Agora-specific data
      agoraAppId: agoraAppId || process.env.AGORA_APP_ID,
      agoraToken: agoraToken || "",
      agoraChannelName: channelName,
    };

    const mergedPayload = Object.assign({}, basePayload, incomingPayload || {});
    const dataMap = normalizeDataMap(mergedPayload);

    // iOS VoIP push
    if (platform === "ios" && voipToken) {
      const voipMessage = {
        token: voipToken,
        data: dataMap,
        apns: {
          headers: {
            "apns-topic": process.env.APNS_VOIP_TOPIC || "com.example.app.voip",
            "apns-push-type": "voip",
            "apns-priority": "10",
          },
          payload: {
            aps: {
              alert: { 
                title: `${callerName || callerUid} is calling`, 
                body: `Incoming ${callType} call` 
              },
              badge: 1,
              sound: "default",
              "content-available": 1,
            },
          },
        },
      };

      try {
        const r = await messaging.send(voipMessage);
        console.log("VoIP push result:", r);
      } catch (e) {
        console.error("VoIP push error:", e);
      }
    }

    // Regular FCM push
    if (fcmToken) {
      const fcmMessage = {
        token: fcmToken,
        notification: { 
          title: `${callerName || callerUid} is calling`, 
          body: `Tap to answer ${callType} call` 
        },
        data: dataMap,
        android: {
          priority: "high",
          notification: {
            channelId: "calls",
            priority: "max",
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
                body: `Tap to answer ${callType} call` 
              }, 
              badge: 1, 
              sound: "default", 
              category: "CALL_CATEGORY", 
              "content-available": 1 
            } 
          },
        },
      };

      try {
        const r = await messaging.send(fcmMessage);
        console.log("FCM push result:", r);
      } catch (e) {
        console.error("FCM push error:", e);
      }
    } else {
      console.warn("No FCM token for recipient", recipientId);
    }

    if (DEBUG) {
      return res.status(200).json({ 
        success: true, 
        debug: { 
          corsHeaders, 
          incomingOrigin: origin, 
          payloadSent: mergedPayload,
          channelName,
        } 
      });
    }

    return res.status(200).json({ 
      success: true,
      channelName,
      callId,
    });
  } catch (err) {
    console.error("Handler error:", err);
    Object.entries(buildCorsHeaders(req.headers.origin, req.headers["access-control-request-headers"] || ""))
      .forEach(([k,v]) => res.setHeader(k,v));
    
    if (DEBUG) {
      return res.status(500).json({ 
        error: err.message || "Internal server error", 
        stack: (err.stack||"").split("\n").slice(0,10) 
      });
    }
    return res.status(500).json({ error: "Internal server error" });
  }
}

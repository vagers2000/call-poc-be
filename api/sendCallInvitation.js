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
    key: Buffer.from(process.env.APN_P8_KEY_BASE64, "base64").toString("utf8"),
    keyId: '8C9AMXZAS5',
    teamId:  '9XVM2G2KN9',
  },
  production: process.env.APN_PRODUCTION === 'true',
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

const DEBUG = process.env.DEBUG_CORS === "true" || true; // ✅ ALWAYS DEBUG

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
    console.log("🔧 CORS build:", { origin, allowedFromEnv, allowLocal, requested, headers });
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
  console.log("🚀 SENDING VoIP PUSH:");
  console.log("   Token:", voipToken ? voipToken.substring(0, 20) + "..." : "MISSING");
  console.log("   CallId:", callId);
  console.log("   Caller:", callerName);
  
  let notification = new apn.Notification();

  notification.topic = `bma.agora.poc.voip`;
  notification.pushType = "voip";
  
  // ✅ FIXED: Root-level CallKit fields REQUIRED by flutter_callkit_incoming
  notification.payload = {
    id: callId,
    nameCaller: callerName || "Caller",
    handle: payload.handle || callId,
    type: payload.type || 1,
    extra: payload.extra || {}
  };

  notification.alert = {
    title: `${callerName || "Caller"} is calling`,
    body: `Tap to answer ${callType || "video"} call`
  };

  notification.badge = 1;
  notification.sound = "default";
  notification.category = "CALL_CATEGORY";

  console.log("📱 VoIP Payload:", JSON.stringify(notification.payload, null, 2));
  console.log("📡 Topic:", notification.topic);

  try {
    const result = await apnProvider.send(notification, voipToken);
    console.log("✅ VoIP SUCCESS:", result);
    return result;
  } catch (err) {
    console.error("❌ VoIP FAILED:", err);
    console.error("   Code:", err.status || err.code);
    console.error("   Reason:", err.reason || err.message);
    throw err;
  }
}

export default async function handler(req, res) {
  const origin = req.headers.origin;
  const corsHeaders = buildCorsHeaders(origin);
  Object.entries(corsHeaders).forEach(([k, v]) => res.setHeader(k, v));

  if (req.method === "OPTIONS") {
    return res.status(204).end();
  }

  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  console.log("📥 CALL INVITATION REQUEST:", JSON.stringify(req.body, null, 2));

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

    console.log("📋 Parsed params:", { callId, channelName, callerUid, callerName, recipientId });

    if (!callId || !channelName || !callerUid || !recipientId) {
      console.error("❌ MISSING REQUIRED FIELDS");
      return res.status(400).json({ 
        error: "Missing required fields",
        received: req.body 
      });
    }

    // Fetch recipient
    console.log("🔍 Looking up recipient:", recipientId);
    const userQuery = await db.collection("user")
      .where("username", "==", recipientId)
      .limit(1)
      .get();

    if (userQuery.empty) {
      console.error("❌ Recipient NOT FOUND:", recipientId);
      return res.status(404).json({ error: "Recipient not found" });
    }

    const recipientDoc = userQuery.docs[0];
    const recipientData = recipientDoc.data() || {};
    const fcmToken = recipientData.fcmToken;
    const voipToken = recipientData.voipToken;
    const platform = (recipientData.platform || "android").toLowerCase();

    console.log("👤 Recipient found:", {
      username: recipientId,
      platform,
      hasFCM: !!fcmToken,
      hasVoIP: !!voipToken,
      fcmToken: fcmToken ? fcmToken.substring(0, 20) + "..." : null,
      voipToken: voipToken ? voipToken.substring(0, 20) + "..." : null
    });

    // Save room
    await db.collection("room").doc(channelName).set({
      channelName, callId, callerUid, callerName: callerName || callerUid,
      recipientId, createdBy: callerUid, createdAt: Date.now(),
      isActive: true, callType, platform: "web",
      agoraAppId: agoraAppId || process.env.AGORA_APP_ID,
      agoraToken: agoraToken || null,
    });
    console.log("✅ Room saved:", channelName);

    // Build CallKit payload
    const basePayload = {
      id: callId,
      nameCaller: callerName || callerUid,
      handle: callerUid,
      type: callType === "video" ? 1 : 0,
      callAction: "create",  // Add this field explicitly

      extra: {
        agoraAppId: agoraAppId || process.env.AGORA_APP_ID,
        agoraToken: agoraToken || "",
        channelName: channelName,
        callerUid,
        recipientId
      }
    };

    const mergedPayload = Object.assign({}, basePayload, incomingPayload || {});

    console.log("📦 CallKit Payload:", JSON.stringify(mergedPayload, null, 2));

    let pushResult = null;

    if (platform === "ios" && voipToken) {
      console.log("📱 iOS + VoIP token → Sending APNs VoIP");
      pushResult = await sendApnsVoipPush(voipToken, mergedPayload, callType, callerName, callId);
    } else if (fcmToken) {
      console.log("📱 FCM token → Sending FCM");
      const fcmMessage = {
        token: fcmToken,
        notification: {
          title: `${callerName || callerUid} is calling`,
          body: `Tap to answer ${callType} call`,
        },
        data: normalizeDataMap(mergedPayload),
        android: { priority: "high", ttl: 60000 },
        apns: { headers: { "apns-priority": "10" } }
      };
      
      pushResult = await messaging.send(fcmMessage);
      console.log("✅ FCM sent:", pushResult);
    } else {
      console.error("❌ NO TOKENS FOUND for:", recipientId);
    }

    console.log("🎉 CALL INVITATION COMPLETE:", { pushResult, channelName, callId });

    return res.status(200).json({
      success: true,
      channelName,
      callId,
      recipient: {
        platform,
        hasFCM: !!fcmToken,
        hasVoIP: !!voipToken,
        pushResult: pushResult ? pushResult.messageId || pushResult : null
      },
      debug: {
        recipientTokens: { fcmToken: !!fcmToken, voipToken: !!voipToken },
        payloadSent: mergedPayload
      }
    });

  } catch (err) {
    console.error("💥 FULL ERROR:", err);
    return res.status(500).json({ 
      error: err.message,
      stack: err.stack?.split("\n").slice(0, 5),
      body: req.body 
    });
  }
}

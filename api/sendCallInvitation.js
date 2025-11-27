// sendCallInvitation.js - FIXED: FCM requires all string values

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

  return headers;
}

// ✅ FIXED: ALL data must be strings for FCM
function normalizeDataMap(obj) {
  const out = {};
  if (!obj || typeof obj !== 'object') return out;
  
  Object.entries(obj).forEach(([k, v]) => {
    if (v === null || v === undefined) return;
    
    // Everything must be a string for FCM
    if (typeof v === 'string') {
      out[k] = v;
    } else if (typeof v === 'object') {
      out[k] = JSON.stringify(v);
    } else {
      // Convert numbers, booleans, etc. to strings
      out[k] = String(v);
    }
  });
  
  return out;
}

export default async function handler(req, res) {
  const startTime = Date.now();
  const logs = [];
  
  const log = (message, data = null) => {
    const logEntry = {
      timestamp: new Date().toISOString(),
      message,
      ...(data && { data })
    };
    logs.push(logEntry);
    console.log(`[${logEntry.timestamp}] ${message}`, data || '');
  };

  const origin = req.headers.origin;
  const acrHeadersRaw = req.headers["access-control-request-headers"] || "";
  const corsHeaders = buildCorsHeaders(origin, acrHeadersRaw);
  Object.entries(corsHeaders).forEach(([k, v]) => res.setHeader(k, v));

  if (req.method === "OPTIONS") {
    log("Preflight OPTIONS request received", { origin });
    return res.status(204).end();
  }

  if (req.method !== "POST") {
    log("Invalid method", { method: req.method });
    return res.status(405).json({ error: "Method not allowed", logs });
  }

  try {
    log("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
    log("📞 Call Invitation Request Started");
    log("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");

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

    log("📥 Request body received", {
      callId,
      channelName,
      callerUid,
      callerName,
      recipientId,
      callType,
      hasAgoraAppId: !!agoraAppId,
      hasAgoraToken: !!agoraToken,
    });

    // Validate required fields
    if (!callId || !channelName || !callerUid || !recipientId) {
      log("❌ Missing required fields", {
        hasCallId: !!callId,
        hasChannelName: !!channelName,
        hasCallerUid: !!callerUid,
        hasRecipientId: !!recipientId,
      });
      return res.status(400).json({ 
        error: "Missing required fields",
        required: ['callId', 'channelName', 'callerUid', 'recipientId'],
        received: { callId, channelName, callerUid, recipientId },
        logs 
      });
    }

    log("✅ All required fields present");

    // Fetch recipient by username
    log("🔍 Fetching recipient from Firestore", { username: recipientId });
    
    const userQuery = await db.collection("user")
      .where("username", "==", recipientId)
      .limit(1)
      .get();

    if (userQuery.empty) {
      log("❌ Recipient not found", { username: recipientId });
      return res.status(404).json({ 
        error: "Recipient not found",
        username: recipientId,
        logs 
      });
    }

    const recipientDoc = userQuery.docs[0];
    const recipientData = recipientDoc.data() || {};
    const fcmToken = recipientData.fcmToken;
    const voipToken = recipientData.voipToken;
    const platform = (recipientData.platform || "android").toLowerCase();

    log("✅ Recipient found", {
      username: recipientData.username,
      platform,
      hasFcmToken: !!fcmToken,
      hasVoipToken: !!voipToken,
      fcmTokenPreview: fcmToken ? `${fcmToken.substring(0, 20)}...` : null,
    });

    // Save call metadata to Firestore
    log("💾 Saving call metadata to Firestore", { channelName });
    
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
      agoraAppId: agoraAppId || process.env.AGORA_APP_ID,
      agoraToken: agoraToken || null,
    });

    log("✅ Call metadata saved to Firestore");

    // Build proper CallKit payload
    log("📦 Building notification payload");
    
    const basePayload = {
      // Core call data
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
      
      // Agora-specific
      agoraAppId: agoraAppId || process.env.AGORA_APP_ID,
      agoraToken: agoraToken || "",
      agoraChannelName: channelName,
      
      // ✅ REQUIRED CallKit fields (will be converted to strings)
      id: callId,
      nameCaller: callerName || callerUid,
      avatar: recipientData.imageUrl || "",
      handle: callerUid,
      type: callType === 'video' ? 1 : 0, // Will become "1" or "0"
      duration: 30000, // Will become "30000"
      textAccept: 'Accept',
      textDecline: 'Decline',
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
    
    // ✅ Convert ALL values to strings for FCM
    const dataMap = normalizeDataMap(mergedPayload);
    
    log("✅ Payload built and normalized to strings", {
      callId: dataMap.callId,
      callType: dataMap.callType,
      type: dataMap.type,
      typeType: typeof dataMap.type,
      duration: dataMap.duration,
      durationType: typeof dataMap.duration,
      callerName: dataMap.nameCaller,
    });

    const notificationResults = {
      voip: null,
      fcm: null,
    };

    // iOS VoIP push (if available)
    if (platform === "ios" && voipToken) {
      log("📱 Preparing iOS VoIP notification", { hasVoipToken: true });
      
      log("🔍 iOS VoIP data sample", {
        type: dataMap.type,
        typeType: typeof dataMap.type,
        duration: dataMap.duration,
        durationType: typeof dataMap.duration,
        id: dataMap.id,
        nameCaller: dataMap.nameCaller,
      });
      
      const voipMessage = {
        token: voipToken,
        data: dataMap, // ✅ All strings now
        apns: {
          headers: {
            "apns-topic": "bma.agora.poc.voip",
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
        log("📤 Sending iOS VoIP notification...");
        const voipResult = await messaging.send(voipMessage);
        log("✅ iOS VoIP notification sent successfully", { messageId: voipResult });
        notificationResults.voip = {
          success: true,
          messageId: voipResult,
          platform: 'ios',
          type: 'voip',
        };
      } catch (e) {
        log("❌ iOS VoIP notification failed", {
          error: e.message,
          code: e.code,
          details: e.details,
        });
        notificationResults.voip = {
          success: false,
          error: e.message,
          code: e.code,
        };
      }
    }
    // Regular FCM push
    if (fcmToken) {
      log("📱 Preparing FCM notification", { 
        platform,
        hasFcmToken: true,
      });
      
      log("🔍 FCM data sample", {
        platform,
        type: dataMap.type,
        typeType: typeof dataMap.type,
        duration: dataMap.duration,
        durationType: typeof dataMap.duration,
      });
      
      const fcmMessage = {
        token: fcmToken,
        notification: { 
          title: `${callerName || callerUid} is calling`, 
          body: `Tap to answer ${callType} call` 
        },
        data: dataMap, // ✅ All strings now
        android: {
          priority: "high",
          notification: {
            channelId: "calls",
            priority: "max",
            tag: callId,
            clickAction: "FLUTTER_NOTIFICATION_CLICK",
            visibility: "public",
            sound: "default",
          },
          ttl: 60000,
        },
        apns: {
          headers: { 
            "apns-topic": "bma.agora.poc.voip",
            "apns-priority": "10",
            "apns-push-type": "voip",
          },
          payload: { 
            aps: { 
              alert: { 
                title: `${callerName || callerUid} is calling`, 
                body: `Tap to answer ${callType} call` 
              }, 
              badge: 1, 
              sound: "default", 
              category: "CALL_CATEGORY", 
              "content-available": 1,
              "mutable-content": 1,
            } 
          },
        },
      };

      try {
        log("📤 Sending FCM notification...");
        const fcmResult = await messaging.send(fcmMessage);
        log("✅ FCM notification sent successfully", { messageId: fcmResult });
        notificationResults.fcm = {
          success: true,
          messageId: fcmResult,
          platform,
          type: 'fcm',
        };
      } catch (e) {
        log("❌ FCM notification failed", {
          error: e.message,
          code: e.code,
          details: e.details,
        });
        notificationResults.fcm = {
          success: false,
          error: e.message,
          code: e.code,
        };
      }
    } else {
      log("⚠️ No FCM token available for recipient", { recipientId });
      notificationResults.fcm = {
        success: false,
        error: "No FCM token available",
      };
    }

    const duration = Date.now() - startTime;
    
    log("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
    log("✅ Call Invitation Request Completed", { durationMs: duration });
    log("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");

    // Determine overall success
    const overallSuccess = notificationResults.voip?.success || notificationResults.fcm?.success;

    return res.status(200).json({ 
      success: overallSuccess,
      channelName,
      callId,
      platform,
      notifications: notificationResults,
      summary: {
        voipSent: notificationResults.voip?.success || false,
        fcmSent: notificationResults.fcm?.success || false,
        recipient: recipientId,
        caller: callerName || callerUid,
        callType,
        durationMs: duration,
      },
      logs,
    });

  } catch (err) {
    const duration = Date.now() - startTime;
    
    log("💥 CRITICAL ERROR", {
      error: err.message,
      stack: err.stack?.split("\n").slice(0, 5),
      durationMs: duration,
    });

    console.error("Handler error:", err);
    Object.entries(buildCorsHeaders(req.headers.origin, req.headers["access-control-request-headers"] || ""))
      .forEach(([k,v]) => res.setHeader(k,v));
    
    return res.status(500).json({ 
      error: err.message || "Internal server error",
      logs,
      ...(DEBUG && { stack: err.stack?.split("\n").slice(0, 10) }),
    });
  }
}

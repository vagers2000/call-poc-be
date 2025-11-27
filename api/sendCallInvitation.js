// sendCallInvitation.updated.js
// Updated to align with Dart FCMHelper behavior: accepts an optional `payload` object
// and sends it inside `data` (stringified so values are strings), preserves VoIP & APNS
// handling, and keeps robust CORS logic from the original.

import { initializeApp, cert, getApps } from "firebase-admin/app";
import { getFirestore } from "firebase-admin/firestore";
import { getMessaging } from "firebase-admin/messaging";

// Initialize admin using service account JSON from env
if (!getApps().length) {
  const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT || "{}");
  initializeApp({ credential: cert(serviceAccount) });
}
const db = getFirestore();
const messaging = getMessaging();

const DEFAULT_ALLOWED_ORIGINS = [
  "https://flirtbate.web.app",
  "https://your-app.web.app",
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

// Helper: ensure all values in data map are strings (FCM requires string values in data)
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
      return res.status(204).json({ debug: true, message: "preflight", incomingOrigin: origin, acrHeaders: acrHeadersRaw, corsHeaders });
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
      // optional: allow passing a full payload that maps to NotificationPayload.toJson in Dart
      payload: incomingPayload,
    } = req.body || {};

    if (!callId || !channelName || !callerUid || !recipientId) {
      if (DEBUG) {
        return res.status(400).json({ error: "Missing required fields", body: req.body, corsHeaders });
      }
      return res.status(400).json({ error: "Missing required fields" });
    }

    // Fetch recipient by username (recipientId is treated as username)
    const userQuery = await db.collection("user").where("username", "==", recipientId).limit(1).get();
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

    // Save call metadata
    await db.collection("calls").doc(callId).set({
      callId,
      channelName,
      callerUid,
      callerName: callerName || callerUid,
      recipientId,
      status: "ringing",
      timestamp: Date.now(),
    });

    console.log("Call created:", { callId, channelName, callerUid, recipientId, platform });

    // Build a generic payload object merging core keys and any incoming payload
    const basePayload = {
      callId,
      channelName,
      callerUid,
      callerName: callerName || callerUid,
      callAction: incomingPayload?.callAction || "create",
    };

    const mergedPayload = Object.assign({}, basePayload, incomingPayload || {});
    const dataMap = normalizeDataMap(mergedPayload);

    // iOS VoIP push (APNs voip token) - preserve header requirements
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
              alert: { title: `${callerName || callerUid} is calling`, body: "Incoming video call" },
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

    // Regular FCM push (Android / iOS non-voip)
    if (fcmToken) {
      const fcmMessage = {
        token: fcmToken,
        notification: { title: `${callerName || callerUid} is calling`, body: "Tap to answer video call" },
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
          payload: { aps: { alert: { title: `${callerName || callerUid} is calling`, body: "Tap to answer video call" }, badge: 1, sound: "default", category: "CALL_CATEGORY", "content-available": 1 } },
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
      return res.status(200).json({ success: true, debug: { corsHeaders, incomingOrigin: origin, payloadSent: mergedPayload } });
    }
    return res.status(200).json({ success: true });
  } catch (err) {
    console.error("Handler error:", err);
    Object.entries(buildCorsHeaders(req.headers.origin, req.headers["access-control-request-headers"] || "")).forEach(([k,v]) => res.setHeader(k,v));
    if (DEBUG) {
      return res.status(500).json({ error: err.message || "Internal server error", stack: (err.stack||"").split("\n").slice(0,10) });
    }
    return res.status(500).json({ error: "Internal server error" });
  }
}

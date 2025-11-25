// pages/api/sendCallInvitation.js
import { initializeApp, cert, getApps } from "firebase-admin/app";
import { getFirestore } from "firebase-admin/firestore";
import { getMessaging } from "firebase-admin/messaging";

/**
 * sendCallInvitation API (Vercel / Next.js)
 * - Robust CORS (allows any http://localhost:PORT automatically for dev)
 * - Adds support for custom headers like x-vercel-protection-bypass
 * - DEBUG_CORS=true will return helpful debug JSON for OPTIONS and failures
 *
 * Env:
 * - FIREBASE_SERVICE_ACCOUNT  => JSON string
 * - ALLOWED_ORIGINS (optional) => comma-separated list (exact origins)
 * - DEBUG_CORS (optional "true")
 * - APNS_VOIP_TOPIC (optional)
 */

if (!getApps().length) {
  const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT || "{}");
  initializeApp({ credential: cert(serviceAccount) });
}
const db = getFirestore();
const messaging = getMessaging();

const DEFAULT_ALLOWED_ORIGINS = [
  "https://flirtbate.web.app",
  "https://your-app.web.app",
  // You can add your deployed frontend origin(s) here
];

const ALLOWED_ORIGINS = (process.env.ALLOWED_ORIGINS
  ? process.env.ALLOWED_ORIGINS.split(",").map((o) => o.trim()).filter(Boolean)
  : DEFAULT_ALLOWED_ORIGINS
);

const DEBUG = process.env.DEBUG_CORS === "true";

function isLocalhostOrigin(origin) {
  if (!origin) return false;
  // allow http(s)://localhost(:port)? and http(s)://127.0.0.1(:port)?
  return /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin);
}

// Build CORS headers: echoes the origin if allowed, allows localhost patterns, and includes requested headers + defaults
function buildCorsHeaders(origin, acrHeadersRaw = "") {
  const headers = {};
  const requested = acrHeadersRaw
    ? acrHeadersRaw.split(",").map(h => (h || "").trim().toLowerCase()).filter(Boolean)
    : [];

  const allowedFromEnv = origin && ALLOWED_ORIGINS.includes(origin);
  const allowLocal = isLocalhostOrigin(origin);

  if (origin && (allowedFromEnv || allowLocal)) {
    headers["Access-Control-Allow-Origin"] = origin; // must echo exact origin for credentials
    headers["Access-Control-Allow-Credentials"] = "true";
  } else if (!origin) {
    headers["Access-Control-Allow-Origin"] = "*";
  } else {
    headers["Access-Control-Allow-Origin"] = "null"; // browser will block
  }

  headers["Vary"] = "Origin";
  headers["Access-Control-Allow-Methods"] = "POST,OPTIONS";

  // Default allowed headers (lowercase)
  const defaultAllowedHeaders = [
    "content-type",
    "authorization",
    "x-requested-with",
    "x-client-id",
    "x-firebase-locale",
    "x-vercel-protection-bypass", // your custom header
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

export default async function handler(req, res) {
  const origin = req.headers.origin;
  const acrHeadersRaw = req.headers["access-control-request-headers"] || "";

  // set CORS headers on every response
  const corsHeaders = buildCorsHeaders(origin, acrHeadersRaw);
  Object.entries(corsHeaders).forEach(([k, v]) => res.setHeader(k, v));

  // Preflight
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

  // Only POST allowed
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  try {
    const { callId, channelName, callerUid, callerName, recipientId } = req.body || {};

    if (!callId || !channelName || !callerUid || !recipientId) {
      if (DEBUG) {
        return res.status(400).json({ error: "Missing required fields", body: req.body, corsHeaders });
      }
      return res.status(400).json({ error: "Missing required fields" });
    }

    // Fetch recipient
    const recipientDoc = await db.collection("users").doc(recipientId).get();
    if (!recipientDoc.exists) {
      if (DEBUG) {
        console.log("Recipient not found:", recipientId);
        return res.status(404).json({ error: "Recipient not found", corsHeaders });
      }
      return res.status(404).json({ error: "Recipient not found" });
    }

    const recipientData = recipientDoc.data() || {};
    const fcmToken = recipientData.fcmToken;
    const voipToken = recipientData.voipToken;
    const platform = (recipientData.platform || "android").toLowerCase();

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

    if (platform === "ios" && voipToken) {
      const voipMessage = {
        token: voipToken,
        data: { callId, channelName, callerUid, callerName: callerName || callerUid, type: "voip_incoming_call" },
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

    if (fcmToken) {
      const fcmMessage = {
        token: fcmToken,
        notification: { title: `${callerName || callerUid} is calling`, body: "Tap to answer video call" },
        data: { callId, channelName, callerUid, callerName: callerName || callerUid, type: "incoming_call", click_action: "FLUTTER_NOTIFICATION_CLICK" },
        android: { priority: "high", notification: { channelId: "calls", priority: "max", tag: callId, clickAction: "FLUTTER_NOTIFICATION_CLICK", visibility: "public", sound: "default" }, ttl: 60000 },
        apns: { headers: { "apns-priority": "10" }, payload: { aps: { alert: { title: `${callerName || callerUid} is calling`, body: "Tap to answer video call" }, badge: 1, sound: "default", category: "CALL_CATEGORY", "content-available": 1 } } },
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

    // Success
    if (DEBUG) {
      return res.status(200).json({ success: true, debug: { corsHeaders, incomingOrigin: origin } });
    }
    return res.status(200).json({ success: true });
  } catch (err) {
    console.error("Handler error:", err);
    // ensure CORS headers in error
    Object.entries(buildCorsHeaders(origin, acrHeadersRaw)).forEach(([k,v]) => res.setHeader(k,v));
    if (DEBUG) {
      return res.status(500).json({ error: err.message || "Internal server error", stack: (err.stack||"").split("\n").slice(0,10) });
    }
    return res.status(500).json({ error: "Internal server error" });
  }
}

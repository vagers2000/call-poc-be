// pages/api/call.js
import { initializeApp, cert, getApps } from "firebase-admin/app";
import { getFirestore } from "firebase-admin/firestore";
import { getMessaging } from "firebase-admin/messaging";

/**
 * Full hardened call-invite handler with CORS, Firestore write,
 * VoIP push (iOS), and FCM push (Android / fallback).
 *
 * Environment variables expected:
 * - FIREBASE_SERVICE_ACCOUNT  => JSON string of service account
 * - ALLOWED_ORIGINS (optional) => comma-separated list of allowed origins
 * - DEBUG_CORS (optional) => "true" to print helpful debug logs
 *
 * Notes:
 * - Replace APNS topics and package ids as needed.
 * - Ensure service account has messaging and firestore permissions.
 */

// Initialize Firebase Admin only once
if (!getApps().length) {
  const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT || "{}");
  initializeApp({ credential: cert(serviceAccount) });
}
const db = getFirestore();
const messaging = getMessaging();

// Default whitelist (change to your real domains)
const DEFAULT_ALLOWED_ORIGINS = [
  "https://flirtbate.web.app",
  "https://your-app.web.app",
  "http://localhost:3000",
  "http://localhost:5173",
];

// Build ALLOWED_ORIGINS from env or fallback to defaults
const ALLOWED_ORIGINS = (process.env.ALLOWED_ORIGINS
  ? process.env.ALLOWED_ORIGINS.split(",").map((o) => o.trim()).filter(Boolean)
  : DEFAULT_ALLOWED_ORIGINS
);

// Helper that sets consistent CORS headers
function setCorsHeaders(req, res) {
  const origin = req.headers.origin;
  const debug = process.env.DEBUG_CORS === "true";

  if (debug) {
    console.log("CORS: incoming origin:", origin);
    console.log("CORS: allowed origins:", ALLOWED_ORIGINS);
  }

  if (origin && ALLOWED_ORIGINS.includes(origin)) {
    // When using credentials (cookies/auth), echo the exact origin.
    res.setHeader("Access-Control-Allow-Origin", origin);
    res.setHeader("Access-Control-Allow-Credentials", "true");
  } else if (!origin) {
    // Non-browser requests (curl, server-to-server) - allow all
    res.setHeader("Access-Control-Allow-Origin", "*");
  } else {
    // Disallowed origin — echo null (browser will block)
    // You may prefer to return 403 for stricter handling.
    res.setHeader("Access-Control-Allow-Origin", "null");
    if (debug) console.warn("CORS: origin not allowed:", origin);
  }

  res.setHeader("Vary", "Origin");
  res.setHeader("Access-Control-Allow-Methods", "POST,OPTIONS");
  // Add any custom headers your client sends here
  res.setHeader(
    "Access-Control-Allow-Headers",
    "Content-Type, Authorization, X-Requested-With, X-Client-Id, X-Firebase-Locale"
  );
  // Cache preflight for 1 hour to reduce preflight traffic
  res.setHeader("Access-Control-Max-Age", "3600");
}

export default async function handler(req, res) {
  // Always set CORS headers first so preflight sees them
  try {
    setCorsHeaders(req, res);

    // Preflight - respond immediately
    if (req.method === "OPTIONS") {
      // 204 no content is good for preflight
      return res.status(204).end();
    }

    if (req.method !== "POST") {
      return res.status(405).json({ error: "Method not allowed" });
    }

    // Parse body (Next.js body parser will already have parsed it)
    const { callId, channelName, callerUid, callerName, recipientId } = req.body || {};

    // Validate required fields
    if (!callId || !channelName || !callerUid || !recipientId) {
      return res.status(400).json({ error: "Missing required fields. Required: callId, channelName, callerUid, recipientId" });
    }

    // Fetch recipient info from Firestore
    const recipientDoc = await db.collection("users").doc(recipientId).get();
    if (!recipientDoc.exists) {
      return res.status(404).json({ error: "Recipient not found" });
    }

    const recipientData = recipientDoc.data() || {};
    const fcmToken = recipientData.fcmToken;
    const voipToken = recipientData.voipToken;
    const platform = (recipientData.platform || "android").toLowerCase();

    // Write call doc to Firestore (overwrites — if you want merge, use set(..., { merge: true }))
    await db.collection("calls").doc(callId).set({
      callId,
      channelName,
      callerUid,
      callerName: callerName || callerUid,
      recipientId,
      status: "ringing",
      timestamp: Date.now(),
    });

    // Logging for debugging
    console.log("Call doc written:", { callId, channelName, callerUid, recipientId, platform });

    // Send VoIP push for iOS (if available)
    if (platform === "ios" && voipToken) {
      const voipMessage = {
        token: voipToken,
        data: {
          callId,
          channelName,
          callerUid,
          callerName: callerName || callerUid,
          type: "voip_incoming_call",
        },
        apns: {
          headers: {
            // Replace apns-topic with your app's VoIP topic (your bundle id + .voip if used)
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
        const sendResult = await messaging.send(voipMessage);
        console.log("✅ VoIP push sent:", sendResult);
      } catch (err) {
        console.error("❌ VoIP push error:", err);
      }
    }

    // Fallback / normal FCM push
    if (fcmToken) {
      const fcmMessage = {
        token: fcmToken,
        notification: {
          title: `${callerName || callerUid} is calling`,
          body: "Tap to answer video call",
        },
        data: {
          callId,
          channelName,
          callerUid,
          callerName: callerName || callerUid,
          type: "incoming_call",
          click_action: "FLUTTER_NOTIFICATION_CLICK",
        },
        android: {
          priority: "high",
          notification: {
            channelId: "calls", // ensure your Android app created this channel
            priority: "max",
            tag: callId,
            clickAction: "FLUTTER_NOTIFICATION_CLICK",
            visibility: "public",
            sound: "default",
          },
          ttl: 60000, // 60 seconds
        },
        apns: {
          headers: { "apns-priority": "10" },
          payload: {
            aps: {
              alert: { title: `${callerName || callerUid} is calling`, body: "Tap to answer video call" },
              badge: 1,
              sound: "default",
              category: "CALL_CATEGORY",
              "content-available": 1,
            },
          },
        },
      };

      try {
        const sendResult = await messaging.send(fcmMessage);
        console.log("✅ FCM push sent:", sendResult);
      } catch (err) {
        console.error("❌ FCM push error:", err);
      }
    } else {
      console.warn("No FCM token for recipient; push not sent.");
    }

    // Respond success (CORS headers already set)
    return res.status(200).json({ success: true });
  } catch (err) {
    // Ensure CORS headers on error response too
    try {
      setCorsHeaders(req, res);
    } catch (e) {
      console.error("Failed to set CORS headers in catch:", e);
    }
    console.error("Handler error:", err);
    return res.status(500).json({ error: err?.message || "Internal server error" });
  }
}

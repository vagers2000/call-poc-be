import { initializeApp, cert, getApps } from "firebase-admin/app";
import { getFirestore } from "firebase-admin/firestore";
import { getMessaging } from "firebase-admin/messaging";

if (!getApps().length) {
  const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
  initializeApp({ credential: cert(serviceAccount) });
}
const db = getFirestore();
const messaging = getMessaging();

// Call this FIRST in every request; echoes any Origin for web, * for mobile/postman
function setCorsHeaders(req, res) {
  const origin = req.headers.origin;
  if (origin) {
    // For any browser request, echo the actual origin (works for all dev/prod web)
    res.setHeader("Access-Control-Allow-Origin", origin);
    res.setHeader("Access-Control-Allow-Credentials", "true");
  } else {
    // Native, Postman, etc: allow all
    res.setHeader("Access-Control-Allow-Origin", "*");
  }
  res.setHeader("Vary", "Origin");
  res.setHeader("Access-Control-Allow-Methods", "POST,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization, X-Requested-With");
}

export default async function handler(req, res) {
  setCorsHeaders(req, res);

  // Respond to preflight (CORS) OPTIONS request
  if (req.method === "OPTIONS") {
    return res.status(204).end();
  }

  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not alloweddd" });
  }

  try {
    const { callId, channelName, callerUid, callerName, recipientId } = req.body;
    if (!callId || !channelName || !callerUid || !recipientId) {
      setCorsHeaders(req, res);
      return res.status(400).json({ error: "Missing required fields" });
    }

    const recipientDoc = await db.collection("users").doc(recipientId).get();
    if (!recipientDoc.exists) {
      setCorsHeaders(req, res);
      return res.status(404).json({ error: "Recipient not found" });
    }

    const recipientData = recipientDoc.data();
    const fcmToken = recipientData?.fcmToken;
    const voipToken = recipientData?.voipToken;
    const platform = recipientData?.platform || "android";

    // Write call doc
    await db.collection("calls").doc(callId).set({
      callId,
      channelName,
      callerUid,
      callerName: callerName || callerUid,
      recipientId,
      status: "ringing",
      timestamp: Date.now(),
    });

    // VoIP Push
    if (platform === "ios" && voipToken) {
      const voipMessage = {
        token: voipToken,
        data: { callId, channelName, callerUid, callerName, type: "voip_incoming_call" },
        apns: {
          headers: {
            "apns-topic": "com.example.agora_callkit_video_call.voip", // Change as needed
            "apns-push-type": "voip",
            "apns-priority": "10",
          },
          payload: {
            aps: {
              alert: { title: `${callerName} is calling`, body: "Incoming video call" },
              badge: 1,
              sound: "default",
              "content-available": 1,
            },
          },
        },
      };
      try {
        await messaging.send(voipMessage);
        console.log("✅ VoIP push sent");
      } catch (err) {
        console.error("❌ VoIP push error:", err);
      }
    }

    // FCM
    if (fcmToken) {
      const fcmMessage = {
        token: fcmToken,
        notification: {
          title: `${callerName} is calling`,
          body: "Tap to answer video call",
        },
        data: {
          callId,
          channelName,
          callerUid,
          callerName,
          type: "incoming_call",
          click_action: "FLUTTER_NOTIFICATION_CLICK",
        },
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
          headers: { "apns-priority": "10" },
          payload: {
            aps: {
              alert: { title: `${callerName} is calling`, body: "Tap to answer video call" },
              badge: 1,
              sound: "default",
              category: "CALL_CATEGORY",
              "content-available": 1,
            },
          },
        },
      };
      try {
        await messaging.send(fcmMessage);
        console.log("✅ FCM push sent");
      } catch (err) {
        console.error("❌ FCM push error:", err);
      }
    }

    return res.json({ success: true });
  } catch (err) {
    setCorsHeaders(req, res); // Ensure headers even on error
    console.error(err);
    return res.status(500).json({ error: err.message || "Internal server error" });
  }
}

import { initializeApp, cert, getApps } from "firebase-admin/app";
import { getFirestore } from "firebase-admin/firestore";
import { getMessaging } from "firebase-admin/messaging";

const ALLOWED_ORIGINS = ["https://flirtbate.web.app", "http://localhost:5173"]; // Replace with your frontend origins

function setCorsHeaders(res, origin) {
  if (origin && ALLOWED_ORIGINS.includes(origin)) {
    res.setHeader("Access-Control-Allow-Origin", origin);
  } else {
    // Reject disallowed origins by not setting CORS headers or returning 403
    return false;
  }

  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization, X-Requested-With");
  res.setHeader("Access-Control-Allow-Credentials", "true");
  // Optional: expose headers if your client needs them
  res.setHeader("Access-Control-Expose-Headers", "Authorization,Content-Length");
  return true;
}

// Initialize Firebase Admin SDK once
if (!getApps().length) {
  const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
  initializeApp({ credential: cert(serviceAccount) });
}

const db = getFirestore();
const messaging = getMessaging();

export default async function handler(req, res) {
  const origin = req.headers.origin;

  // Handle CORS
  const corsAllowed = setCorsHeaders(res, origin);
  if (!corsAllowed) {
    return res.status(403).json({ error: "CORS origin denied" });
  }

  // Respond to preflight requests
  if (req.method === "OPTIONS") {
    return res.status(204).end();
  }

  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  try {
    const { callId, channelName, callerUid, callerName, recipientId } = req.body;

    if (!callId || !channelName || !callerUid || !recipientId) {
      return res.status(400).json({ error: "Missing required fields" });
    }

    const recipientDoc = await db.collection("users").doc(recipientId).get();
    if (!recipientDoc.exists) {
      return res.status(404).json({ error: "Recipient not found" });
    }

    const recipientData = recipientDoc.data();
    const fcmToken = recipientData?.fcmToken;
    const voipToken = recipientData?.voipToken;
    const platform = recipientData?.platform || "android";

    // Create call document in Firestore
    await db.collection("calls").doc(callId).set({
      callId,
      channelName,
      callerUid,
      callerName: callerName || callerUid,
      recipientId,
      status: "ringing",
      timestamp: Date.now(),
    });

    // Send VoIP push for iOS
    if (platform === "ios" && voipToken) {
      const voipMessage = {
        token: voipToken,
        data: { callId, channelName, callerUid, callerName, type: "voip_incoming_call" },
        apns: {
          headers: {
            "apns-topic": "com.example.agora_callkit_video_call.voip", // Change to your iOS bundle ID
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

    // Send FCM push for Android and fallback iOS
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
    console.error(err);
    return res.status(500).json({ error: err.message });
  }
}

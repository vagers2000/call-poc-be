import { initializeApp, cert, getApps } from "firebase-admin/app";
import { getFirestore } from "firebase-admin/firestore";
import { getMessaging } from "firebase-admin/messaging";

// List allowed origins, add your production and dev origins here
const ALLOWED_ORIGINS = [
  "https://flirtbate.web.app",
  "http://localhost:5173",
  "http://localhost:3000",
  "http://localhost:51847",
  "https://your-other-frontend.com"
];

function setCorsHeaders(res, origin) {
  // If origin is in allowed list, echo it; else reject
  if (origin && ALLOWED_ORIGINS.includes(origin)) {
    res.setHeader("Access-Control-Allow-Origin", origin);
  } else {
    // For requests without Origin (e.g., native apps) or unlisted origin, allow all
    // or restrict here by returning false
    res.setHeader("Access-Control-Allow-Origin", "*");
    // If you want strict, uncomment next to reject unapproved origin
    // return false;
  }
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization, X-Requested-With");
  res.setHeader("Access-Control-Allow-Credentials", "true");
  res.setHeader("Access-Control-Expose-Headers", "Authorization,Content-Length");
  return true;
}

if (!getApps().length) {
  const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
  initializeApp({ credential: cert(serviceAccount) });
}
const db = getFirestore();
const messaging = getMessaging();

export default async function handler(req, res) {
  const origin = req.headers.origin;

  const corsAllowed = setCorsHeaders(res, origin);
  if (corsAllowed === false) {
    // Block disallowed origins if strict
    return res.status(403).json({ error: "CORS origin denied" });
  }

  if (req.method === "OPTIONS") {
    // Preflight request
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

    await db.collection("calls").doc(callId).set({
      callId,
      channelName,
      callerUid,
      callerName: callerName || callerUid,
      recipientId,
      status: "ringing",
      timestamp: Date.now(),
    });

    if (platform === "ios" && voipToken) {
      const voipMessage = {
        token: voipToken,
        data: { callId, channelName, callerUid, callerName, type: "voip_incoming_call" },
        apns: {
          headers: {
            "apns-topic": "com.example.agora_callkit_video_call.voip", // Your iOS bundle ID
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

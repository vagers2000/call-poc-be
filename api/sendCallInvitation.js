import { initializeApp, cert, getApps } from "firebase-admin/app";
import { getFirestore } from "firebase-admin/firestore";
import { getMessaging } from "firebase-admin/messaging";

const ALLOWED_ORIGINS = ["https://call-poc-be-git-main-vgs-projects-ca85a81a.vercel.app", "http://localhost:5173"]; // change as needed

function setCorsHeaders(res, origin) {
  if (origin && ALLOWED_ORIGINS.includes(origin)) {
    res.setHeader("Access-Control-Allow-Origin", origin);
  } else {
    res.setHeader("Access-Control-Allow-Origin", "null");
  }
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
  res.setHeader("Access-Control-Allow-Credentials", "true");
}

if (!getApps().length) {
  const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
  initializeApp({ credential: cert(serviceAccount) });
}
const db = getFirestore();
const messaging = getMessaging();

export default async function handler(req, res) {
  const origin = req.headers.origin;
  
  if (req.method === "OPTIONS") {
    setCorsHeaders(res, origin);
    return res.status(204).end();
  }
  
  setCorsHeaders(res, origin);

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
      timestamp: Date.now()
    });

    // VoIP Push for iOS
    if (platform === "ios" && voipToken) {
      const voipMessage = {
        token: voipToken,
        data: { callId, channelName, callerUid, callerName, type: "voip_incoming_call" },
        apns: {
          headers: {
            "apns-topic": "com.example.agora_callkit_video_call.voip",
            "apns-push-type": "voip",
            "apns-priority": "10",
          },
          payload: {
            aps: {
              alert: { title: `${callerName} is calling`, body: "Incoming video call" },
              badge: 1,
              sound: "default",
              "content-available": 1
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

    // FCM Push for Android and iOS fallback
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

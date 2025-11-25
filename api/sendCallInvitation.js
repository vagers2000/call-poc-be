import { initializeApp, cert, getApps } from "firebase-admin/app";
import { getFirestore } from "firebase-admin/firestore";
import { getMessaging } from "firebase-admin/messaging";

if (!getApps().length) {
  const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
  initializeApp({ credential: cert(serviceAccount) });
}
const db = getFirestore();
const messaging = getMessaging();

export default async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).json({error: "Method not allowed"});
  try {
    const { callId, channelName, callerUid, callerName, recipientId } = req.body;
    if (!callId || !channelName || !callerUid || !recipientId)
      return res.status(400).json({error: "Missing required fields"});

    const recipientDoc = await db.collection("users").doc(recipientId).get();
    if (!recipientDoc.exists)
      return res.status(404).json({error: "Recipient not found"});

    const recipientData = recipientDoc.data();
    const fcmToken = recipientData.fcmToken;
    const voipToken = recipientData.voipToken;
    const platform = recipientData.platform || "android";

    await db.collection("calls").doc(callId).set({
      callId,
      channelName,
      callerUid,
      callerName: callerName || callerUid,
      recipientId,
      status: "ringing",
      timestamp: Date.now()
    });

    if (platform === "ios" && voipToken) {
    await sendVoIPPush(voipToken, callId, channelName, callerUid, callerName);  
     }

    if (fcmToken) {
    await sendFCMPush(fcmToken, callId, channelName, callerUid, callerName);
      }


    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
}

async function sendVoIPPush(voipToken, callId, channelName, callerUid, callerName) {
  const message = {
    token: voipToken,
    data: {
      callId,
      channelName,
      callerUid,
      callerName,
      type: "voip_incoming_call",
    },
    apns: {
      headers: {
        "apns-topic": "com.example.agora_callkit_video_call.voip", // Replace with your iOS app bundle ID
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
    await messaging.send(message);
    console.log("✅ VoIP push sent");
  } catch (error) {
    console.error("❌ VoIP push error:", error);
  }
}

async function sendFCMPush(fcmToken, callId, channelName, callerUid, callerName) {
  const message = {
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
      headers: {
        "apns-priority": "10",
      },
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
    await messaging.send(message);
    console.log("✅ FCM push sent");
  } catch (error) {
    console.error("❌ FCM push error:", error);
  }
}

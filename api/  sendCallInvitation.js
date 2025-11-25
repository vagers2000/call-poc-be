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

    // If you also want to add push, put here: (very similar to your previous functions)
    // (Omitted for brevity; see your previous sendFCMPush/sendVoIPPush)

    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
}

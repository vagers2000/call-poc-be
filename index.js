// // server.js

// require('dotenv').config();
// const express = require('express');
// const cors = require('cors');
// const admin = require('firebase-admin');
// const { RtcTokenBuilder, RtcRole } = require('agora-access-token');

// const app = express();
// app.use(cors());
// app.use(express.json());

// const APP_ID = process.env.AGORA_APP_ID;
// const APP_CERT = process.env.AGORA_APP_CERT;
// const PORT = process.env.PORT || 3000;

// // AGORA TOKEN GENERATION ENDPOINT (WEB RTC)
// if (!APP_ID || !APP_CERT) {
//   console.error('Missing AGORA_APP_ID or AGORA_APP_CERT in environment');
//   process.exit(1);
// }

// // Health check endpoint
// app.get('/', (req, res) => res.json({ status: 'ok' }));

// // GET /token?channel=<channel>&uid=<uid>
// app.get('/token', (req, res) => {
//   try {
//     const channelName = req.query.channel;
//     const uidStr = req.query.uid || '0';
//     if (!channelName) return res.status(400).json({ error: 'channel required' });

//     const uid = uidStr === '0' ? 0 : parseInt(uidStr, 10);
//     const role = RtcRole.PUBLISHER;
//     const expirationSeconds = parseInt(process.env.TOKEN_EXPIRY_SECONDS || '600', 10);
//     const currentTimestamp = Math.floor(Date.now() / 1000);
//     const privilegeExpiredTs = currentTimestamp + expirationSeconds;

//     const token = RtcTokenBuilder.buildTokenWithUid(
//       APP_ID,
//       APP_CERT,
//       channelName,
//       uid,
//       role,
//       privilegeExpiredTs
//     );

//     return res.json({ token, channelName, uid: uidStr, expires_in: expirationSeconds });
//   } catch (err) {
//     console.error(err);
//     return res.status(500).json({ error: err.message });
//   }
// });

// /* ======================== FIREBASE ADMIN (FCM, VOIP, CALL SIGNALLING) ======================== */

// admin.initializeApp({
//   credential: admin.credential.cert(JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT)),
// });
// const db = admin.firestore();
// const messaging = admin.messaging();

// // Send Call Invitation
// app.post("/api/sendCallInvitation", async (req, res) => {
//   try {
//     const { callId, channelName, callerUid, callerName, recipientId } = req.body;

//     if (!callId || !channelName || !callerUid || !recipientId) {
//       return res.status(400).json({ error: "Missing required fields" });
//     }
//     const recipientDoc = await db.collection("users").doc(recipientId).get();
//     if (!recipientDoc.exists) {
//       return res.status(404).json({ error: "Recipient user not found" });
//     }
//     const recipientData = recipientDoc.data();
//     const fcmToken = recipientData.fcmToken;
//     const voipToken = recipientData.voipToken;
//     const platform = recipientData.platform || "android";

//     await db.collection("calls").doc(callId).set({
//       callId,
//       channelName,
//       callerUid,
//       callerName: callerName || callerUid,
//       recipientId,
//       status: "ringing",
//       timestamp: admin.firestore.FieldValue.serverTimestamp(),
//     });

//     // Send push notifications
//     if (platform === "ios" && voipToken) await sendVoIPPush(voipToken, callId, channelName, callerUid, callerName);
//     if (fcmToken) await sendFCMPush(fcmToken, callId, channelName, callerUid, callerName);

//     res.json({ success: true });
//   } catch (err) {
//     res.status(500).json({ error: err.message });
//   }
// });

// async function sendVoIPPush(voipToken, callId, channelName, callerUid, callerName) {
//   const message = {
//     token: voipToken,
//     data: {
//       callId,
//       channelName,
//       callerUid,
//       callerName,
//       type: "voip_incoming_call",
//     },
//     apns: {
//       headers: {
//         "apns-topic": "com.example.agora_callkit_video_call.voip", // <-- Change to your iOS bundle id
//         "apns-push-type": "voip",
//         "apns-priority": "10",
//       },
//       payload: {
//         aps: {
//           alert: { title: `${callerName} is calling`, body: "Incoming video call" },
//           badge: 1, sound: "default", "content-available": 1,
//         },
//       },
//     },
//   };
//   await messaging.send(message);
// }

// async function sendFCMPush(fcmToken, callId, channelName, callerUid, callerName) {
//   const message = {
//     token: fcmToken,
//     notification: { title: `${callerName} is calling`, body: "Tap to answer video call" },
//     data: {
//       callId,
//       channelName,
//       callerUid,
//       callerName,
//       type: "incoming_call",
//       click_action: "FLUTTER_NOTIFICATION_CLICK",
//     },
//     android: {
//       priority: "high",
//       notification: { channelId: "calls", priority: "max", tag: callId, clickAction: "FLUTTER_NOTIFICATION_CLICK" },
//       ttl: 60000,
//     },
//     apns: {
//       headers: { "apns-priority": "10" },
//       payload: {
//         aps: {
//           alert: { title: `${callerName} is calling`, body: "Tap to answer video call" },
//           sound: "default", badge: 1, category: "CALL_CATEGORY", "content-available": 1,
//         },
//       },
//     },
//   };
//   await messaging.send(message);
// }

// // Start the server (only ONE app.listen!)
// app.listen(PORT, () => {
//   console.log(`Token and call server running on port ${PORT}`);
// });
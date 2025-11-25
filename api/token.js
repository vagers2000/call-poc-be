import { RtcTokenBuilder, RtcRole } from "agora-access-token";

export default function handler(req, res) {
  if (req.method !== "GET") return res.status(405).json({error: "Method not allowed"});
  const APP_ID = process.env.AGORA_APP_ID;
  const APP_CERT = process.env.AGORA_APP_CERT;
  const { channel, uid } = req.query;
  if (!channel || !APP_ID || !APP_CERT) return res.status(400).json({error: "Missing params"});
  const finalUid = !uid ? 0 : parseInt(uid, 10);
  const role = RtcRole.PUBLISHER;
  const expirationSeconds = parseInt(process.env.TOKEN_EXPIRY_SECONDS || "600", 10);
  const currentTimestamp = Math.floor(Date.now() / 1000);
  const privilegeExpiredTs = currentTimestamp + expirationSeconds;
  const token = RtcTokenBuilder.buildTokenWithUid(APP_ID, APP_CERT, channel, finalUid, role, privilegeExpiredTs);
  res.json({ token, channelName: channel, uid: finalUid, expires_in: expirationSeconds });
}

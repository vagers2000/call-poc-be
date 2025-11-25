// server.js
require('dotenv').config();
const express = require('express');
const cors = require('cors');
const { RtcTokenBuilder, RtcRole } = require('agora-access-token');

const app = express();
app.use(cors());
app.use(express.json());

const APP_ID = process.env.AGORA_APP_ID;
const APP_CERT = process.env.AGORA_APP_CERT;
const PORT = process.env.PORT || 3000;

if (!APP_ID || !APP_CERT) {
  console.error('Missing AGORA_APP_ID or AGORA_APP_CERTIFICATE in env');
  process.exit(1);
}

// simple health check
app.get('/', (req, res) => res.json({ status: 'ok' }));

// GET /token?channel=<channel>&uid=<uid>
app.get('/token', (req, res) => {
  try {
    const channelName = req.query.channel;
    const uidStr = req.query.uid || '0';
    if (!channelName) return res.status(400).json({ error: 'channel required' });

    const uid = uidStr === '0' ? 0 : parseInt(uidStr, 10);
    const role = RtcRole.PUBLISHER;
    const expirationSeconds = parseInt(process.env.TOKEN_EXPIRY_SECONDS || '600', 10); // default 600s
    const currentTimestamp = Math.floor(Date.now() / 1000);
    const privilegeExpiredTs = currentTimestamp + expirationSeconds;

    const token = RtcTokenBuilder.buildTokenWithUid(
      APP_ID,
      APP_CERT,
      channelName,
      uid,
      role,
      privilegeExpiredTs
    );

    return res.json({ token, channelName, uid: uidStr, expires_in: expirationSeconds });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: err.message });
  }
});

app.listen(PORT, () => {
  console.log(`Token server running on port ${PORT}`);
});

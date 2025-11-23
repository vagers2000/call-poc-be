require("dotenv").config();
const express = require("express");
const bodyParser = require("body-parser");
const cors = require("cors");
const { RtcTokenBuilder, RtcRole } = require("agora-token");

const app = express();
app.use(cors());
app.use(bodyParser.json());

app.post("/rtcToken", (req, res) => {
  const { userId, channelName } = req.body;

  if (!channelName) {
    return res.status(400).json({ error: "channelName required" });
  }

  const uid = parseInt(userId || "0", 10); // 0 lets Agora assign uid
  const expireSeconds = 3600;
  const now = Math.floor(Date.now() / 1000);
  const privilegeExpire = now + expireSeconds;

  const token = RtcTokenBuilder.buildTokenWithUid(
    process.env.AGORA_APP_ID,
    process.env.AGORA_APP_CERT,
    channelName,
    uid,
    RtcRole.PUBLISHER,
    privilegeExpire
  );

  return res.json({ rtcToken: token, uid, expireAt: privilegeExpire });
});

app.get("/", (_, res) => res.send("RTC Token Server OK"));

app.listen(process.env.PORT || 3000, () => {
  console.log("RTC Token server running on port", process.env.PORT || 3000);
});

// pages/api/agoraToken.js
import { RtcTokenBuilder, RtcRole } from "agora-access-token";

/**
 * Agora token endpoint with robust CORS and debug logging.
 *
 * - GET /api/agoraToken?channel=CHANNEL_NAME&uid=UID(optional)
 * - Env:
 *    - AGORA_APP_ID
 *    - AGORA_APP_CERT
 *    - TOKEN_EXPIRY_SECONDS (optional, default 600)
 *    - ALLOWED_ORIGINS (optional, comma-separated list of allowed origins)
 *    - DEBUG_CORS (optional "true")
 *
 * Notes:
 * - In dev this will automatically allow http://localhost:PORT and http://127.0.0.1:PORT.
 * - If your frontend uses credentials (cookies/auth), the server echoes the exact origin when allowed.
 */

const DEFAULT_ALLOWED_ORIGINS = [
  "https://flirtbate.web.app",
  "https://your-app.web.app",
];

const ALLOWED_ORIGINS = (process.env.ALLOWED_ORIGINS
  ? process.env.ALLOWED_ORIGINS.split(",").map(o => o.trim()).filter(Boolean)
  : DEFAULT_ALLOWED_ORIGINS
);

const DEBUG = process.env.DEBUG_CORS === "true";

function isLocalhostOrigin(origin) {
  if (!origin) return false;
  return /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin);
}

function buildCorsHeaders(origin, acrHeadersRaw = "") {
  const headers = {};
  const requested = acrHeadersRaw
    ? acrHeadersRaw.split(",").map(h => (h || "").trim().toLowerCase()).filter(Boolean)
    : [];

  const allowedFromEnv = origin && ALLOWED_ORIGINS.includes(origin);
  const allowLocal = isLocalhostOrigin(origin);

  if (origin && (allowedFromEnv || allowLocal)) {
    headers["Access-Control-Allow-Origin"] = origin; // echo for credentials support
    headers["Access-Control-Allow-Credentials"] = "true";
  } else if (!origin) {
    headers["Access-Control-Allow-Origin"] = "*";
  } else {
    headers["Access-Control-Allow-Origin"] = "null";
  }

  headers["Vary"] = "Origin";
  headers["Access-Control-Allow-Methods"] = "GET,OPTIONS";

  // default allowed headers (lowercase)
  const defaultAllowedHeaders = [
    "content-type",
    "authorization",
    "x-requested-with",
    "x-client-id",
    "x-firebase-locale",
    "x-vercel-protection-bypass" // defensive: include common custom header if frontend uses it
  ];

  const combinedSet = new Set([
    ...defaultAllowedHeaders.map(h => h.toLowerCase()),
    ...requested
  ]);

  headers["Access-Control-Allow-Headers"] = Array.from(combinedSet).join(", ");
  headers["Access-Control-Max-Age"] = "3600";

  if (DEBUG) {
    console.log("CORS build:", { origin, allowedFromEnv, allowLocal, requested, headers });
  }

  return headers;
}

export default function handler(req, res) {
  const origin = req.headers.origin;
  const acrHeadersRaw = req.headers["access-control-request-headers"] || "";

  // Always set CORS headers for every response
  const corsHeaders = buildCorsHeaders(origin, acrHeadersRaw);
  Object.entries(corsHeaders).forEach(([k, v]) => res.setHeader(k, v));

  // Preflight OPTIONS
  if (req.method === "OPTIONS") {
    if (DEBUG) {
      return res.status(204).json({
        debug: true,
        message: "preflight",
        incomingOrigin: origin,
        acrHeaders: acrHeadersRaw,
        corsHeaders,
      });
    }
    return res.status(204).end();
  }

  // Only GET allowed for token retrieval
  if (req.method !== "GET") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  try {
    // Read env
    const APP_ID = process.env.AGORA_APP_ID;
    const APP_CERT = process.env.AGORA_APP_CERT;
    const expirationSeconds = parseInt(process.env.TOKEN_EXPIRY_SECONDS || "600", 10);

    const channel = req.query.channel || req.query.room || req.query.channelName;
    const uidRaw = req.query.uid || req.query.user || req.query.u;

    if (!channel || !APP_ID || !APP_CERT) {
      if (DEBUG) {
        return res.status(400).json({
          error: "Missing params/env",
          details: { channel, envHasAppId: !!APP_ID, envHasAppCert: !!APP_CERT },
          corsHeaders,
        });
      }
      return res.status(400).json({ error: "Missing params or server misconfiguration" });
    }

    // Parse uid (default 0)
    let finalUid = 0;
    if (typeof uidRaw !== "undefined" && uidRaw !== null && String(uidRaw).trim() !== "") {
      // guard against non-number values — if not a number, keep 0
      const parsed = parseInt(String(uidRaw), 10);
      if (!Number.isNaN(parsed) && parsed >= 0) finalUid = parsed;
    }

    const role = RtcRole.PUBLISHER;
    const currentTs = Math.floor(Date.now() / 1000);
    const privilegeExpiredTs = currentTs + expirationSeconds;

    const token = RtcTokenBuilder.buildTokenWithUid(APP_ID, APP_CERT, channel, finalUid, role, privilegeExpiredTs);

    // Success response
    return res.status(200).json({
      token,
      channelName: channel,
      uid: finalUid,
      expires_in: expirationSeconds,
    });
  } catch (err) {
    console.error("Agora token handler error:", err);
    // ensure CORS headers on error too
    Object.entries(buildCorsHeaders(origin, acrHeadersRaw)).forEach(([k, v]) => res.setHeader(k, v));
    if (DEBUG) {
      return res.status(500).json({ error: err?.message || "Internal server error", stack: (err.stack || "").split("\n").slice(0, 10) });
    }
    return res.status(500).json({ error: "Internal server error" });
  }
}

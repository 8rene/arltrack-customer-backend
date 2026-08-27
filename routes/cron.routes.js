const express = require("express");
const router = express.Router();

const { runExpireSessions } = require("../jobs/expireSessions.job");

// Vercel Cron hits this over HTTP on schedule (see vercel.json). If
// CRON_SECRET is set in this project's env vars, Vercel automatically sends
// it as `Authorization: Bearer <CRON_SECRET>` on every cron request; this
// checks it so nobody else can trigger a sweep by just hitting the URL.
// If you haven't set CRON_SECRET yet, this check is skipped (no-op) rather
// than blocking everything — set it in Vercel → Settings → Environment
// Variables when you're ready to lock this down. Same pattern as the
// admin backend's cron.routes.js.
const verifyCronRequest = (req, res, next) => {
  const secret = process.env.CRON_SECRET;
  if (!secret) return next(); // not configured yet — allow through
  const auth = req.headers["authorization"];
  if (auth !== `Bearer ${secret}`) {
    return res.status(401).json({ message: "Unauthorized." });
  }
  next();
};

router.get("/expire-sessions", verifyCronRequest, async (req, res) => {
  try {
    const result = await runExpireSessions();
    return res.status(200).json({ success: true, result: result || null });
  } catch (err) {
    console.error("[CRON] expire-sessions route error:", err.message);
    return res.status(200).json({ success: false, message: err.message });
  }
});

module.exports = router;
const express = require("express");
const router = express.Router();

const { runExpireSessions } = require("../jobs/expireSessions.job");
const { runCancelStaleBookings } = require("../jobs/cancelStaleBookings.job");
const { runBookingReminders } = require("../jobs/bookingNotifications.job");

// Vercel Cron hits this over HTTP on schedule (see vercel.json). If
// CRON_SECRET is set in this project's env vars, Vercel automatically sends
// it as `Authorization: Bearer <CRON_SECRET>` on every cron request; this
// checks it so nobody else can trigger a sweep by just hitting the URL.
// CRON_SECRET is REQUIRED. If it isn't set, every cron route refuses to run
// (503) instead of running for anyone who hits the URL — these sweeps cancel
// bookings and send notifications, so they must never be publicly triggerable.
// Set it in Vercel → Settings → Environment Variables (Vercel then sends it on
// every scheduled cron request automatically).
const crypto = require("crypto");
const safeEqual = (a, b) => {
  const bufA = Buffer.from(String(a || ""), "utf8");
  const bufB = Buffer.from(String(b || ""), "utf8");
  return bufA.length === bufB.length && crypto.timingSafeEqual(bufA, bufB);
};
const verifyCronRequest = (req, res, next) => {
  const secret = process.env.CRON_SECRET;
  if (!secret) {
    console.error("[CRON] CRON_SECRET is not set — refusing to run cron routes.");
    return res.status(503).json({ message: "Cron is not configured." });
  }
  if (!safeEqual(req.headers["authorization"], `Bearer ${secret}`)) {
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
    // 500 (not 200) so Vercel's cron log / any monitoring actually sees the failure.
    return res.status(500).json({ success: false, message: err.message });
  }
});

router.get("/cancel-stale-bookings", verifyCronRequest, async (req, res) => {
  try {
    const result = await runCancelStaleBookings();
    return res.status(200).json({ success: true, result: result || null });
  } catch (err) {
    console.error("[CRON] cancel-stale-bookings route error:", err.message);
    // 500 (not 200) so Vercel's cron log / any monitoring actually sees the failure.
    return res.status(500).json({ success: false, message: err.message });
  }
});

// Run every few minutes — sends "Upcoming Booking" (~24h out) and
// "Booking Reminder" (~2h out) notifications. Safe to run often: dedup
// lives in createNotification(), not here.
//
// NOTE: no separate "expire-bookings" route — that scenario (a booking's
// schedule passing with no completed payment) is already the exact thing
// cancelStaleBookings.job.js's sweep auto-cancels, and the customer
// notification for it now lives right on that single choke-point
// (cancelStaleBooking() in utils/bookings/bookingStatus.util.js) rather
// than being re-detected here.
router.get("/booking-reminders", verifyCronRequest, async (req, res) => {
  try {
    const result = await runBookingReminders();
    return res.status(200).json({ success: true, result });
  } catch (err) {
    console.error("[CRON] booking-reminders route error:", err.message);
    // 500 (not 200) so Vercel's cron log / any monitoring actually sees the failure.
    return res.status(500).json({ success: false, message: err.message });
  }
});

module.exports = router;

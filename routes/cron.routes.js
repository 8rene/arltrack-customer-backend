const express = require("express");
const router = express.Router();

const { runExpireSessions } = require("../jobs/expireSessions.job");
const { runCancelStaleBookings } = require("../jobs/cancelStaleBookings.job");
const { runBookingReminders } = require("../jobs/bookingNotifications.job");
const { runRefundNotifications } = require("../jobs/refundNotifications.job");

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

router.get("/cancel-stale-bookings", verifyCronRequest, async (req, res) => {
  try {
    const result = await runCancelStaleBookings();
    return res.status(200).json({ success: true, result: result || null });
  } catch (err) {
    console.error("[CRON] cancel-stale-bookings route error:", err.message);
    return res.status(200).json({ success: false, message: err.message });
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
    return res.status(200).json({ success: false, message: err.message });
  }
});

// Run every few minutes/hours — watches for refund requests staff just
// Approved/Rejected in the admin app and notifies the customer. Purely a
// customer-side watcher (see jobs/refundNotifications.job.js's header
// comment) — nothing in the admin backend needs to change for this.
router.get("/refund-notifications", verifyCronRequest, async (req, res) => {
  try {
    const result = await runRefundNotifications();
    return res.status(200).json({ success: true, result });
  } catch (err) {
    console.error("[CRON] refund-notifications route error:", err.message);
    return res.status(200).json({ success: false, message: err.message });
  }
});


module.exports = router;

const { db } = require("../../config/firebaseConnection/firebase");
const admin  = require("firebase-admin");

// Matches the 'sessionLogs' collection the admin panel reads
// (admin-backend/services/sessionLogs/sessionLogs.service.js):
//   { sessionLogsID, uID, username, platform, loginDateTime, logoutDateTime,
//     sessionDuration, status, closedReason, attemptedAt, blockedReason }
//
// Renamed from 'userLogs' to match the admin-side rename. This is the
// customer-facing app, so every session this file opens is hardcoded to
// platform: "customer_web" — never trust a client-supplied platform value.
const PLATFORM = "customer_web";

// ── OPEN A SESSION (successful login) ──────────────────────────────────────
// Does not throw: a logging failure should never block an actual login.
const createSessionLog = async (uID, username) => {
  try {
    const ref = db.collection("sessionLogs").doc();
    await ref.set({
      sessionLogsID: ref.id,
      uID,
      username: username || "",
      platform: PLATFORM,
      loginDateTime: admin.firestore.FieldValue.serverTimestamp(),
      logoutDateTime: null,
      sessionDuration: 0,
      status: "active",
      closedReason: null,
    });
    return ref.id;
  } catch (err) {
    console.error("createSessionLog error:", err.message);
    return null;
  }
};

// ── CLOSE A SESSION (logout — manual, or auto when the JWT expires and the
// frontend calls /auth/logout before clearing its token) ──────────────────
// closedReason: "manual" (default) — nothing on the customer frontend
// currently triggers a forced/"revoked" close (there's no real-time
// account-status listener here the way the admin panel has), but the field
// is accepted so this stays schema-compatible if that's ever added.
const closeSessionLog = async (uID, closedReason = "manual") => {
  try {
    // Query by uID + order only (no extra equality filter) so this doesn't
    // need a new Firestore composite index — then just check in code
    // whether that latest entry is still open.
    const snap = await db.collection("sessionLogs")
      .where("uID", "==", uID)
      .orderBy("loginDateTime", "desc")
      .limit(1)
      .get();

    if (snap.empty) return;

    const doc = snap.docs[0];
    const data = doc.data();
    if (data.status !== "active") return; // already closed/expired — nothing to do

    const loginDateTime = data.loginDateTime?.toDate?.() || new Date();
    const now = new Date();
    const sessionDuration = Math.max(0, Math.round((now - loginDateTime) / 1000)); // seconds

    await doc.ref.update({
      logoutDateTime: admin.firestore.FieldValue.serverTimestamp(),
      sessionDuration,
      status: "logged_out",
      closedReason,
    });
  } catch (err) {
    console.error("closeSessionLog error:", err.message);
  }
};

// ── BLOCKED LOGIN ATTEMPT (account inactive/locked) ────────────────────────
// No session ever opens here — this is a distinct row, so a blocked
// attempt still shows up somewhere instead of vanishing. Was previously
// logged to auditLogs by accountStatus.util.js; moved here to match the
// admin-side design (session/login activity — successful or not — all
// lives in one place, not split between two collections).
const recordBlockedAttempt = async (uID, username, blockedReason) => {
  try {
    const ref = db.collection("sessionLogs").doc();
    await ref.set({
      sessionLogsID: ref.id,
      uID: uID || null,
      username: username || "",
      platform: PLATFORM,
      loginDateTime: null,
      logoutDateTime: null,
      sessionDuration: 0,
      status: "blocked",
      closedReason: null,
      attemptedAt: admin.firestore.FieldValue.serverTimestamp(),
      blockedReason,
    });
    return ref.id;
  } catch (err) {
    console.error("recordBlockedAttempt error:", err.message);
    return null;
  }
};

// ── LAZY EXPIRY CHECK (run on every login) ─────────────────────────────────
// A session with no explicit logout (tab closed, phone locked, wifi died —
// the client-side timer that would've closed it never got the chance to
// run) would otherwise sit marked "active" forever. Rather than guess a
// duration for it, just mark that we don't actually know how it ended.
// Checks every still-open session for this account, not just the latest —
// nothing here enforces single-device login, so more than one could be
// stuck open at once.
const TOKEN_LIFETIME_MS = 24 * 60 * 60 * 1000; // matches the 1d JWT expiry used in login/google controllers

const expireStaleSessionsForUser = async (uID) => {
  try {
    const snap = await db.collection("sessionLogs")
      .where("uID", "==", uID)
      .where("status", "==", "active")
      .get();

    if (snap.empty) return 0;

    const now = Date.now();
    const batch = db.batch();
    let count = 0;

    snap.docs.forEach((doc) => {
      const data = doc.data();
      const loginMs = data.loginDateTime?.toDate?.().getTime();
      if (loginMs == null) return;
      if (now - loginMs >= TOKEN_LIFETIME_MS) {
        batch.update(doc.ref, { status: "expired" });
        count++;
      }
    });

    if (count > 0) await batch.commit();
    return count;
  } catch (err) {
    console.error("expireStaleSessionsForUser error:", err.message);
    return 0;
  }
};

// ── NIGHTLY SWEEP (backstop for accounts that never log back in) ──────────
// The lazy check above only fires when an account logs back in. This
// catches everyone else — called from the /api/cron/expire-sessions route.
const sweepExpiredSessions = async () => {
  try {
    const snap = await db.collection("sessionLogs")
      .where("status", "==", "active")
      .get();

    if (snap.empty) return 0;

    const now = Date.now();
    const batch = db.batch();
    let count = 0;

    snap.docs.forEach((doc) => {
      const data = doc.data();
      const loginMs = data.loginDateTime?.toDate?.().getTime();
      if (loginMs == null) return;
      if (now - loginMs >= TOKEN_LIFETIME_MS) {
        batch.update(doc.ref, { status: "expired" });
        count++;
      }
    });

    if (count > 0) await batch.commit();
    return count;
  } catch (err) {
    console.error("sweepExpiredSessions error:", err.message);
    return 0;
  }
};

module.exports = {
  createSessionLog,
  closeSessionLog,
  recordBlockedAttempt,
  expireStaleSessionsForUser,
  sweepExpiredSessions,
};
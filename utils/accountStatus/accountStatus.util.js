const { recordBlockedAttempt } = require("../sessionLogs/sessionLogs.util");
const { db } = require("../../config/firebaseConnection/firebase");

// When an admin deletes a customer the account is ARCHIVED: its Firebase Auth login is only DISABLED (same uid, email,
// phone, password) and the profile moves to the `userArchives` collection (document ID = the uid). These helpers let
// every auth path tell "archived" apart from "never existed" and show the right message.
const ARCHIVED_MESSAGE = "Your account has been archived. Please contact the administrator to have it restored.";

// true when this uid is in the admin's archive. Never throws: a lookup problem just means "not known to be archived".
const isArchivedUid = async (uid) => {
  if (!uid) return false;
  try {
    return (await db.collection("userArchives").doc(uid).get()).exists;
  } catch (err) {
    console.error("isArchivedUid failed:", err.message);
    return false;
  }
};

// same, looked up by the (lowercase) email stored on the archived copy
const isArchivedEmail = async (email) => {
  if (!email) return false;
  try {
    const snap = await db.collection("userArchives").where("email", "==", email).limit(1).get();
    return !snap.empty;
  } catch (err) {
    console.error("isArchivedEmail failed:", err.message);
    return false;
  }
};

// "locked"   = pending admin approval
// "inactive" = deactivated by an admin
const BLOCKED_STATUSES = new Set(["inactive", "locked"]);

/**
 * Single source of truth for the inactive/locked account check. Every
 * customer-side login path (email/password, Google, and any future one)
 * must call this instead of re-implementing the check inline — that
 * duplication is exactly how the check ended up on one login path but not
 * another before.
 *
 * @param {object} userData        - Firestore user document data.
 * @param {string} uid              - The user's UID (for logging).
 * @param {object} [options]
 * @param {string} [options.logPrefix] - Prefix for the blocked-attempt
 *   reason, e.g. "Blocked Google login attempt" vs "Blocked login attempt".
 *
 * @returns {{ httpStatus: number, message: string } | null} null if the
 *   account is allowed to log in, otherwise the response to send back.
 */
const checkAccountStatus = (userData, uid, { logPrefix = "Blocked login attempt" } = {}) => {
  const status = userData.status?.toLowerCase();
  if (!status || !BLOCKED_STATUSES.has(status)) return null;

  // Logged to sessionLogs (status: "blocked"), not auditLogs — matches the
  // admin-side design where all login activity, successful or not, lives
  // in one place. Fire-and-forget: a logging hiccup shouldn't change the
  // response sent back to a blocked login attempt.
  recordBlockedAttempt(
    uid,
    userData.username || userData.email || "",
    `${logPrefix}: ${userData.email || uid} (status: ${status}).`
  );

  return {
    httpStatus: 403,
    message:
      status === "locked"
        ? "Your account is pending approval. Please wait for admin verification."
        : "Your account has been deactivated. Please contact support.",
  };
};

module.exports = { checkAccountStatus, ARCHIVED_MESSAGE, isArchivedUid, isArchivedEmail };
const { recordAudit } = require("../auditLogs/auditLogs.util");

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
 * @param {string} uid              - The user's UID (for audit logging).
 * @param {object} [options]
 * @param {string} [options.logPrefix] - Prefix for the audit log description,
 *   e.g. "Blocked Google login attempt" vs "Blocked login attempt".
 *
 * @returns {{ httpStatus: number, message: string } | null} null if the
 *   account is allowed to log in, otherwise the response to send back.
 */
const checkAccountStatus = (userData, uid, { logPrefix = "Blocked login attempt" } = {}) => {
  const status = userData.status?.toLowerCase();
  if (!status || !BLOCKED_STATUSES.has(status)) return null;

  recordAudit({
    action: "auth",
    description: `${logPrefix}: ${userData.email || uid} (status: ${status}).`,
    userID: uid,
  });

  return {
    httpStatus: 403,
    message:
      status === "locked"
        ? "Your account is pending approval. Please wait for admin verification."
        : "Your account has been deactivated. Please contact support.",
  };
};

module.exports = { checkAccountStatus };

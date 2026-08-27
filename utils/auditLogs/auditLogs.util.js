const { db } = require("../../config/firebaseConnection/firebase");
const admin  = require("firebase-admin");

// Matches the 'auditLogs' collection the admin panel already reads/writes
// (admin-backend/services/auditLogs/auditLogs.service.js):
//   { auditLogsID, action, description, userID, createdAt }
//
// For customer-initiated actions that are neither a login/logout session
// (sessionLogs) nor a money event (transactionLogs) — e.g. booking
// cancellations and profile edit requests. Blocked login attempts used to
// be logged here too; moved to sessionLogs to match the admin-side design
// (all login-related activity, successful or not, lives in one place).
//
// action must be one of the same set the admin's createAuditLog validates:
const VALID_ACTIONS = ["create", "update", "delete", "export", "auth", "system"];

// Never throws — a logging failure should never block the real action
// (cancelling a booking, submitting an edit request) from completing.
const recordAudit = async ({ action, description, userID = null }) => {
  try {
    if (!VALID_ACTIONS.includes(action)) {
      console.error(`recordAudit: invalid action "${action}"`);
      return null;
    }
    if (!description) {
      console.error("recordAudit: description is required.");
      return null;
    }

    const ref = db.collection("auditLogs").doc();
    await ref.set({
      auditLogsID: ref.id,
      action,
      description,
      userID,
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
    });
    return ref.id;
  } catch (err) {
    console.error("recordAudit error:", err.message);
    return null;
  }
};

module.exports = { recordAudit };
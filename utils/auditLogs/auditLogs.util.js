const { db } = require("../../config/firebaseConnection/firebase");
const admin  = require("firebase-admin");

// Matches the 'auditLogs' collection the admin panel already reads/writes
// (admin-backend/services/auditLogs/auditLogs.service.js):
//   { action, description, userID, createdAt }
//
// Until now only the admin frontend ever wrote here (car status changes,
// discount edits, from Fleet.jsx / Payments.jsx). This is the first writer
// on the customer side — for customer-initiated actions that are neither
// a login/logout session (userLogs) nor a money event (transactionLogs),
// e.g. booking cancellations and profile edit requests.
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

    const ref = await db.collection("auditLogs").add({
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
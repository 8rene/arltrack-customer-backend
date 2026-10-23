// auditLogs/{auditLogsID} -- own auto-generated ID, also stored as a field.
// Shape only: documents are built inline by recordAudit() in utils/auditLogs/auditLogs.util.js. The admin backend's Audit Logs
// page reads the same collection, and the admin also writes it (services/auditLogs/auditLogs.service.js).
const AuditLog = {
  auditLogsID: "",      // Firestore doc ID
  action: "",           // "create" | "update" | "delete" | "export" | "auth" | "system"
  description: "",      // required free text
  userID: null,         // who did it (customer userID here); null when there is none
  // Optional links, only stored when set (so they are missing on most rows):
  bookingID: null,
  paymentID: null,
  refundRequestID: null,
  createdAt: null,      // server timestamp
};

module.exports = { AuditLog };

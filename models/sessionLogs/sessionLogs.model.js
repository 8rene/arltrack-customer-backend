// sessionLogs/{sessionLogsID} -- one row per login attempt of the CUSTOMER app (platform "customer_web").
// Shape only: written by utils/sessionLogs/sessionLogs.util.js (createSessionLog / closeSessionLog / the blocked-login logger).
// NOTE: the admin backend's models/sessionLogs/sessionLogs.model.js currently holds the transactionLogArchives shape by mistake,
// so this file is the real description of the customer-written fields.
const SessionLog = {
  sessionLogsID: "",     // Firestore doc ID
  uID: null,             // userID that logged in (null on a blocked attempt by an unknown user)
  username: "",
  platform: "customer_web",
  loginDateTime: null,   // server timestamp; null on a blocked attempt (it never opened a session)
  logoutDateTime: null,  // set when the session is closed
  sessionDuration: 0,    // seconds, set when the session is closed
  status: "active",      // "active" | "logged_out" | "blocked"
  closedReason: null,    // "manual" (default) | other reasons passed to closeSessionLog; null while open
  // Only on a blocked attempt:
  attemptedAt: null,
  blockedReason: null,
};

module.exports = { SessionLog };

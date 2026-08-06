const { db } = require("../../config/firebaseConnection/firebase");
const admin  = require("firebase-admin");

// Matches the 'userLogs' collection already read by the admin panel
// (services/userLogs/userLogs.service.js on the admin backend):
//   { uID, username, loginDateTime, logoutDateTime, sessionDuration }

// Called right after a successful login (password or Google) — opens a
// new userLogs entry. Does not throw: a logging failure should never
// block an actual login.
const recordLogin = async (uID, username) => {
  try {
    const ref = db.collection("userLogs").doc();
    await ref.set({
      uID,
      username: username || "",
      loginDateTime: admin.firestore.FieldValue.serverTimestamp(),
      logoutDateTime: null,
      sessionDuration: 0,
    });
    return ref.id;
  } catch (err) {
    console.error("recordLogin error:", err.message);
    return null;
  }
};

// Called on logout (manual, or automatic when the JWT expires client-side
// and the frontend calls /auth/logout before clearing its token) — closes
// the most recent still-open (logoutDateTime === null) entry for this user.
const recordLogout = async (uID) => {
  try {
    // Query by uID + order only (no extra equality filter) so this doesn't
    // need a new Firestore composite index — then just check in code
    // whether that latest entry is still open.
    const snap = await db.collection("userLogs")
      .where("uID", "==", uID)
      .orderBy("loginDateTime", "desc")
      .limit(1)
      .get();

    if (snap.empty) return;

    const doc = snap.docs[0];
    const data = doc.data();
    if (data.logoutDateTime) return; // already closed — nothing to do

    const loginDateTime = data.loginDateTime?.toDate?.() || new Date();
    const now = new Date();
    const sessionDuration = Math.max(0, Math.round((now - loginDateTime) / 1000)); // seconds

    await doc.ref.update({
      logoutDateTime: admin.firestore.FieldValue.serverTimestamp(),
      sessionDuration,
    });
  } catch (err) {
    console.error("recordLogout error:", err.message);
    
  }
};

module.exports = { recordLogin, recordLogout };



const { db } = require("../../config/firebaseConnection/firebase");
const { ROLE_IDS } = require("../../utils/roles/role.util");
const { createNotification } = require("../../services/notification/notification.service");

// ================================================================
// "Ask the administrator to check my account" -- the button on the login screen's archived message.
//
// Public on purpose (an archived account has no working login, so there is no token to check). Because of that it
// is only ever a REQUEST: it tells the Owners and Admins "this archived person is asking", it restores nothing,
// and staff still contact the person at the e-mail / phone on the archive record before deciding.
//
// - Same answer for every e-mail (archived or not, known or not), so this can't be used to find out which e-mails exist.
// - No free text is accepted, so there is nothing to read, filter or abuse.
// - ONE request per archived account, ever: the first press writes a marker doc in `archiveAppeals` (doc ID = the
//   archived uid) with create(), which Firestore rejects if it already exists, so even two presses at the same
//   instant send only one. Later presses (any device, any session) get { alreadySent: true } and notify nobody.
//   The marker lives in its own collection so the admin app's archive documents are never touched. If the account
//   is restored and archived again later, delete its `archiveAppeals` doc to let the person ask again.
// - On top of that, createNotification() still skips a copy that is still active for a staff member.
// - The per-IP limit is on the route (see routes/auth.routes.js).
// Notification shape (must match the admin app's Header.jsx / UserArchivePage.jsx): type "archive_appeal",
// refCollection "userArchives", refID = the archived uid (the archive document's ID).
// ================================================================

const SENT_MESSAGE = "Request sent. Staff will review your account and contact you.";
const ALREADY_SENT_MESSAGE = "You already sent a request for this account. Staff will contact you after they review it.";
const FIRESTORE_ALREADY_EXISTS = 6; // gRPC code for create() on a doc that exists

const requestArchivedReview = async (req, res) => {
  try {
    const raw = req.body?.email;
    if (typeof raw !== "string") return res.status(400).json({ message: "Email is required." });
    const typed = raw.trim();
    if (!typed || typed.length > 254 || !typed.includes("@")) {
      return res.status(400).json({ message: "Email is required." });
    }

    // Look the archive up by the e-mail as typed, then lowercased (the archived copy keeps the stored e-mail).
    const candidates = [...new Set([typed.toLowerCase(), typed])];
    let archiveDoc = null;
    for (const email of candidates) {
      const snap = await db.collection("userArchives").where("email", "==", email).limit(1).get();
      if (!snap.empty) { archiveDoc = snap.docs[0]; break; }
    }

    if (archiveDoc) {
      const data = archiveDoc.data();
      const who = data.username || data.email || archiveDoc.id;

      // Claim the one allowed request. create() fails with ALREADY_EXISTS if someone (this person, earlier) already sent it.
      const appealRef = db.collection("archiveAppeals").doc(archiveDoc.id);
      try {
        await appealRef.create({
          email: data.email || typed.toLowerCase(),
          requestedAt: new Date(),
        });
      } catch (err) {
        if (err.code === FIRESTORE_ALREADY_EXISTS) {
          return res.status(200).json({ message: ALREADY_SENT_MESSAGE, alreadySent: true });
        }
        throw err;
      }

      try {
        const staffSnap = await db.collection("user")
          .where("roleID", "in", [ROLE_IDS.OWNER, ROLE_IDS.ADMIN])
          .get();

        await Promise.all(
          staffSnap.docs.map((d) =>
            createNotification({
              type: "archive_appeal",
              refID: archiveDoc.id,
              refCollection: "userArchives",
              title: "Archived Account Review",
              message: `${who} (${data.email || typed}) is asking staff to check their archived account.`,
              userID: d.id,
            })
          )
        );
      } catch (err) {
        // Nobody was notified, so give the person their one request back and let them try again.
        await appealRef.delete().catch(() => {});
        throw err;
      }
    }

    return res.status(200).json({ message: SENT_MESSAGE });
  } catch (error) {
    console.error("archived review request error:", error);
    return res.status(500).json({ message: "Couldn't send the request. Please try again." });
  }
};

module.exports = { requestArchivedReview };
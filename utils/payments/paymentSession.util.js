// The PayMongo checkout session of a payment lives on its paymentEntries row (paymentEntries.sessionID), not on the
// payment document any more. Two lookups the customer backend needs:
//
//   getCheckoutSessionID(payment, docID, phase)  the session of the phase being paid right now
//   findPaymentDocsBySession(sessionID)          the payment a checkout_session webhook event belongs to
//
// Both still fall back to payments.paymongoSessionID, so payments that were not cleaned yet keep working during
// the migration. Neither throws.
const { db } = require("../../config/firebaseConnection/firebase");
const { nullIfSentinel, entryIDFor } = require("./paymentEntries.mapper");

const lower = (v) => String(v || "").toLowerCase();

/**
 * The checkout session id of ONE phase of a payment ("deposit" | "balance"), or null.
 * The entry row is read first: it is where a new session is written, so it can never be older than the document.
 * `phase` defaults to the payment's currentPhase.
 */
const getCheckoutSessionID = async (payment, docID, phase) => {
  if (!payment) return null;
  const ph = phase || (lower(payment.currentPhase) === "balance" ? "balance" : "deposit");
  const paymentID = payment.paymentID || docID;
  if (paymentID) {
    try {
      const snap = await db.collection("paymentEntries").doc(entryIDFor(paymentID, ph)).get();
      const fromRow = snap.exists ? nullIfSentinel(snap.data().sessionID) : null;
      if (fromRow) return fromRow;
    } catch (err) {
      console.warn("[paymentSession] could not read the paymentEntries row:", err.message);
    }
  }
  return nullIfSentinel(payment.paymongoSessionID) || null; // not cleaned yet / the sync failed at checkout
};

/**
 * Finds the payment document a checkout session belongs to. Returns { empty, docs } shaped like a Firestore
 * QuerySnapshot (at most one doc), so it drops in where `payments.where("paymongoSessionID", "==", id)` was.
 * Penalty checkouts (rows with a penaltyID) are ignored: they have no payment document.
 */
const findPaymentDocsBySession = async (sessionID) => {
  if (!sessionID) return { empty: true, docs: [] };
  try {
    const rows = await db.collection("paymentEntries").where("sessionID", "==", sessionID).limit(10).get();
    const row = rows.docs.map((d) => d.data()).find((e) => e && e.direction === "in" && !e.penaltyID && e.paymentID);
    if (row) {
      const ps = await db.collection("payments").where("paymentID", "==", row.paymentID).limit(1).get();
      if (!ps.empty) return ps;
    }
  } catch (err) {
    console.warn("[paymentSession] entry lookup by sessionID failed, trying the payment document:", err.message);
  }
  return db.collection("payments").where("paymongoSessionID", "==", sessionID).limit(1).get(); // legacy
};

module.exports = { getCheckoutSessionID, findPaymentDocsBySession };
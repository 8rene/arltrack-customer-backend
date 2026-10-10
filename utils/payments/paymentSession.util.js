// PayMongo checkout sessions live on the payment's paymentEntries rows (sessionID), not on the payments document.
// A payment has one entry per phase, keyed "<paymentID>_deposit" / "<paymentID>_balance", and each checkout attempt
// stamps its session id on that phase's row (see createPaymentLink). Imports only db, so any util can require it.
const { db } = require("../../config/firebaseConnection/firebase");

const COL = "paymentEntries";
const phaseKey = (phase) => (phase === "balance" ? "balance" : "deposit");

// The session id of the payment's latest checkout for this phase, or null when none was started.
// `paymentDoc` is the Firestore DocumentSnapshot of the payments doc.
const sessionIDForPayment = async (paymentDoc, phase) => {
  const paymentID = paymentDoc.data().paymentID || paymentDoc.id;
  const snap = await db.collection(COL).doc(`${paymentID}_${phaseKey(phase)}`).get();
  const e = snap.exists ? snap.data() : null;
  return e && e.direction !== "out" && e.sessionID ? e.sessionID : null;
};

// Webhook fallback when the event carries no reference_number: finds the payments doc whose deposit / balance
// entry holds this session id. Returns a query snapshot (.empty / .docs) like the payments queries it replaces.
const findPaymentSnapBySessionID = async (sessionID) => {
  if (!sessionID) return null;
  const snap = await db.collection(COL).where("sessionID", "==", sessionID).get();
  const row = snap.docs.map((d) => d.data()).find((e) => e.direction !== "out" && e.phase !== "penalty" && e.paymentID);
  if (!row) return null;
  return db.collection("payments").where("paymentID", "==", row.paymentID).limit(1).get();
};

module.exports = { sessionIDForPayment, findPaymentSnapBySessionID };
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

// Which phase a checkout session belongs to ("deposit" | "balance"), judged by the session ids stamped on the payment's
// entry rows -- or null when the id matches neither (an old, replaced session, or no id on the event).
// The webhook uses this instead of the payment's CURRENT phase: a late or retried event for the DEPOSIT checkout that
// arrives after the customer has opened the BALANCE checkout must not settle the balance.
const phaseForSession = async (paymentDoc, sessionID) => {
  if (!sessionID) return null;
  const [dep, bal] = await Promise.all([sessionIDForPayment(paymentDoc, "deposit"), sessionIDForPayment(paymentDoc, "balance")]);
  if (sessionID === bal) return "balance";
  if (sessionID === dep) return "deposit";
  return null;
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

module.exports = { sessionIDForPayment, phaseForSession, findPaymentSnapBySessionID };
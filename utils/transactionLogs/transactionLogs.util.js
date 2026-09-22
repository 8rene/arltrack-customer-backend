const { db } = require("../../config/firebaseConnection/firebase");
const admin  = require("firebase-admin");

// Matches the 'transactionLogs' collection the admin panel already reads
// (admin-backend/services/transactionLogs/transactionLogs.service.js):
//   { bookingID, paymentID, refundRequestID, userID, type, amount, status,
//     paymentMethod, referenceNumber, description, performedBy, createdAt }
//
// Write at the moment money actually moves or a request is finally
// resolved — the two spots on this side are the PayMongo webhook's
// "checkout_session.payment.paid" (money received) and
// "payment.refund.updated" (refund succeeded/failed) handlers.

const VALID_TYPES    = ["Payment", "Refund", "Deposit", "Discount"];
const VALID_STATUSES = ["Success", "Failed", "Pending", "Refunded", "Rejected"];

// Never throws — a logging failure should never block the webhook from
// acknowledging PayMongo (returning anything but 200 makes PayMongo retry
// the whole event, which would re-process the payment/refund).
const recordTransactionLog = async ({
  bookingID,
  paymentID,
  refundRequestID = null,
  userID,
  type,
  amount,
  status,
  paymentMethod = "",
  referenceNumber = "",
  description = "",
  performedBy = null,
  // Optional idempotency key. When given, the log is written to a doc with
  // this exact id using create() — so if the webhook and the status poll both
  // try to log the same settlement, the second attempt is a harmless no-op
  // instead of a duplicate row. Omit for one-off entries.
  logID = null,
}) => {
  try {
    if (!VALID_TYPES.includes(type)) {
      console.error(`recordTransactionLog: invalid type "${type}"`);
      return null;
    }
    if (!VALID_STATUSES.includes(status)) {
      console.error(`recordTransactionLog: invalid status "${status}"`);
      return null;
    }

    const ref = logID ? db.collection("transactionLogs").doc(logID) : db.collection("transactionLogs").doc();
    const payload = {
      transactionLogsID: ref.id,
      bookingID: bookingID || null,
      paymentID: paymentID || null,
      refundRequestID,
      userID: userID || null,
      type,
      amount: Number(amount) || 0,
      status,
      paymentMethod,
      referenceNumber,
      description,
      performedBy,
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
    };

    if (logID) {
      try {
        await ref.create(payload); // fails with ALREADY_EXISTS (code 6) if already logged
      } catch (e) {
        if (e && (e.code === 6 || /already exists/i.test(e.message || ""))) return ref.id; // duplicate — fine
        throw e;
      }
    } else {
      await ref.set(payload);
    }
    return ref.id;
  } catch (err) {
    console.error("recordTransactionLog error:", err.message);
    return null;
  }
};

module.exports = { recordTransactionLog };
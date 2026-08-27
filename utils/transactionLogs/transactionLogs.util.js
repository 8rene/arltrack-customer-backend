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

    const ref = db.collection("transactionLogs").doc();
    await ref.set({
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
    });
    return ref.id;
  } catch (err) {
    console.error("recordTransactionLog error:", err.message);
    return null;
  }
};

module.exports = { recordTransactionLog };
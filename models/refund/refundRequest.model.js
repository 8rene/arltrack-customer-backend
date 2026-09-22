// refundRequests/{refundRequestID} — own auto-generated primary key.
// paymentID / bookingID / userID are stored as plain FK fields.
//
// This file documents the SCHEMA. The live code that creates these docs is
// requestRefund() in controllers/paymongo/paymongo.controller.js (customer) and
// openRefundForLatePayment() in utils/payments/settlePayment.util.js; the admin
// backend's services/refundRequest/refundRequest.service.js approves/rejects them.
//
// status flow:
//   "Pending"   → customer submitted (or auto-opened for a payment that arrived
//                 after the booking was cancelled), waiting for staff review
//   "Approved"  → staff approved. The booking is CANCELLED at this point.
//                 PayMongo refunds were created (one per online charge) and any
//                 manual portion is waiting to be handed back + marked issued.
//   "Refunded"  → EVERY PayMongo part succeeded AND any manual portion is marked
//                 issued. The payment doc becomes "Refunded" at the same moment.
//   "Rejected"  → staff rejected it (nothing sent to PayMongo; booking untouched)
//   "Failed"    → a PayMongo part failed after approval — needs staff attention
const createRefundRequest = (refundRequestID, data = {}) => ({
  refundRequestID,       // primary key (Firestore doc ID)
  bookingID:  data.bookingID  || null,
  paymentID:  data.paymentID  || null,
  userID:     data.userID     || null,

  reason:     data.reason     || "",   // dropdown value, e.g. "Cancelled trip"
  notes:      data.notes      || "",   // optional free-text from customer

  // Total to return = everything the customer paid (deposit + balance), net of any
  // staff discount. Split into what PayMongo can return and what staff hand back.
  amount:       data.amount       || 0,
  onlineAmount: data.onlineAmount || 0, // via PayMongo
  manualAmount: data.manualAmount || 0, // by staff (balance collected in person, cash deposit, …)

  status:     data.status     || "Pending",
  autoCreated: !!data.autoCreated, // true for a payment that arrived after cancellation

  // Filled in on approval / as PayMongo responds
  paymongoRefundID:  data.paymongoRefundID  || null, // legacy: first PayMongo refund id
  paymongoRefundIDs: data.paymongoRefundIDs || [],   // every PayMongo refund id (webhook lookup key)
  // one entry per online charge: { kind: "deposit"|"balance", paymongoPaymentID,
  //   amount, paymongoRefundID, status: "pending"|"succeeded"|"failed" }
  parts:             data.parts             || [],
  // null when PayMongo returns everything; otherwise
  //   { amount, issued, issuedBy, issuedAt, method }
  manualRefund:      data.manualRefund      || null,

  processedBy:       data.processedBy      || null, // staff userID who approved/rejected
  processedAt:       data.processedAt      || null,
  rejectReason:      data.rejectReason     || null,
  customerNotified:  !!data.customerNotified,

  createdAt: new Date(),
  updatedAt: new Date(),
});

module.exports = { createRefundRequest };

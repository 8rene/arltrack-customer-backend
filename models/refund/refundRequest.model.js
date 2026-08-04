// refundRequests/{refundRequestID} — own auto-generated primary key.
// paymentID / bookingID / userID are stored as plain FK fields.
//
// status flow:
//   "Pending"   → customer submitted, waiting for admin review
//   "Approved"  → admin approved; PayMongo refund created, waiting for
//                 PayMongo to confirm via the refund.updated webhook
//   "Refunded"  → PayMongo confirmed the refund succeeded
//   "Rejected"  → admin rejected the request (never sent to PayMongo)
//   "Failed"    → PayMongo confirmed the refund failed after approval
const createRefundRequest = (refundRequestID, data = {}) => ({
  refundRequestID,       // primary key (Firestore doc ID)
  bookingID:  data.bookingID  || null,
  paymentID:  data.paymentID  || null,
  userID:     data.userID     || null,

  reason:     data.reason     || "",   // dropdown value, e.g. "Cancelled trip"
  notes:      data.notes      || "",   // optional free-text from customer

  amount:     data.amount     || 0,    // PHP amount requested (from the payment's paid amount)

  status:     data.status     || "Pending",

  // Filled in once admin approves / PayMongo responds
  paymongoRefundID: data.paymongoRefundID || null,
  processedBy:       data.processedBy      || null, // admin userID who approved/rejected
  processedAt:       data.processedAt      || null,
  rejectReason:      data.rejectReason     || null,

  createdAt: new Date(),
  updatedAt: new Date(),
});

module.exports = { createRefundRequest };

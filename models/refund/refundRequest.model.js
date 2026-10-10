// Copied from the admin backend's models/ so both backends describe the same document. Keep it identical: change the
// admin file first, then copy it here.
//
// Customer side: requestRefund() / previewRefund() in controllers/paymongo/paymongo.controller.js and
// openRefundForLatePayment() in utils/payments/settlePayment.util.js create the Pending doc;
// applyRefundPartResult() (the refund.updated webhook) moves it to Refunded / Failed.
//
// Matches the 'refundRequests' collection, normally created by the customer
// backend. Admin backend usually only reads + transitions status here; it
// never creates a request on the customer's behalf (that's the customer's
// "Confirm & Send" step). The ONE exception: staffRefundBooking()
// (services/refundRequest/refundRequest.service.js) lets staff originate a
// refund directly when they force-cancel an upcoming booking while changing
// a car's status to Maintenance/Inactive. Those docs carry source: "staff"
// and an outcome field ("refunded" | "already_refunded" | "nothing_owed" —
// the latter two mean no money actually moved, see staffRefundBooking()'s
// comment; a booking with no payment at all gets no refund doc, and a deposit
// that was kept is nothing_owed + returnDeposit: false) — status starts straight at "Approved" for a real refund, or
// goes directly to "Refunded" for the other two since there's nothing left
// to do. No review step to sit in "Pending" for either way, since staff
// already decided. getResolvedBookingsForCar() (services/fleet/fleet.
// service.js) reads these back by bookingID so the status-change screen can
// show what already happened on a retry after a partial batch failure.
//
// status flow:
//   "Pending"  → waiting for admin review
//   "Approved" → admin approved; PayMongo refund created, waiting for
//                PayMongo to confirm via the refund.updated webhook
//                (handled on the customer backend, which owns that webhook)
//   "Refunded" → PayMongo confirmed success
//   "Rejected" → admin rejected, never sent to PayMongo
//   "Failed"   → PayMongo confirmed the refund failed after approval
const RefundRequest = {
  refundRequestID: "",
  bookingID: "",
  paymentID: "",
  // userID / reason / notes are NOT stored here: they are on the booking's cancellationRequests row (the pending row
  // carrying refundRequestID, or the booking's direct row once it is cancelled). Readers get them back through
  // withCancellationInfo / hydrate. The cancellation row only holds what the customer filled in.
  source: "customer", // "customer" (default) | "staff" — see comment above
  outcome: null, // "refunded" | "already_refunded" | "nothing_owed" — staff-origin docs only. (The fleet screen's
                 // "no_payment" / "deposit_forfeited" labels are derived when read: no payment on record / nothing_owed with returnDeposit false.)
  toRefundAmount: 0,   // what goes back to the customer (was `amount`)
  bookingPaid: 0,      // everything the customer had paid before any forfeit (was `grossPaid`)
  returnDeposit: true, // the 48-hour rule's verdict when the request was made: true = the deposit goes back, false = it
                       // is kept. Replaces policyTier / pickupAt / hoursBeforePickup. A missing value = a full refund.
  depositForfeited: 0,
  forfeitWaived: false,
  // parts[] (one PayMongo refund per online charge), manualRefund (the in-person hand-back) and unrefundable[]
  // (online money with no PayMongo payment id -- never refunded, never handed back) are NOT stored here any more:
  // they are the "out" rows in paymentEntries (refundReqID = this request, ids <id>_part<n> | _manual | _unrefundable<n>).
  // hydrateRefundRequests() rebuilds the old shape, incl. unrefundableAmount (their sum), for readers.
  // No PayMongo id is stored here: the customer backend's refund.updated webhook finds the request through the
  // "out" row's referenceNumber (re_...) -> refundReqID.
  //
  // ALSO NOT STORED (derived, so there is one place for each fact):
  //   onlineAmount / manualAmount   sums of this request's "out" rows (hydrateRefundRequest fills them for readers)
  //   forfeitWaivedAmount           the deposit that was not kept; only the boolean forfeitWaived is stored. The staff
  //                                 reason for a waive is in the audit log line written when the request is approved.
  //   customerNotified              whether the customer was told is not data about the refund: the notification goes
  //                                 out when the status moves to Approved / Rejected (a staff-refund retry sends it only
  //                                 if that call is the one that cancelled the booking).
  //   requestedAt                   same moment as createdAt; readers use createdAt (old docs may still carry it).
  //   policyTier / pickupAt / hoursBeforePickup   replaced by returnDeposit. Until the customer backend writes it,
  //                                 requests still carry the old snapshot and the admin reads that (policyForRequest).
  //   amount / grossPaid            old names of toRefundAmount / bookingPaid. Old documents and the customer backend
  //                                 still use them, so every reader accepts both and the API returns both for now.
  status: "Pending",
  processedBy: null,    // staff userID who approved / rejected it (processedAt is not stored: the entry rows and the audit log carry the time)
  reason: null,         // the STAFF's reason for the decision: why it was rejected, or the note / waive reason given on approve.
                        // The customer's own reason is on the cancellation row (the API returns it as customerReason).
  // rejectReason is the old name of `reason` for a rejection. It is no longer written, but old documents still carry it
  // (and an old document whose `reason` holds the customer's words keeps the staff's reason there), so readers accept both.
  refundedAt: null,     // when the refund completed. Written when staff mark the in-person part handed back; a request the
                        // customer backend's webhook completed has none stored, readers derive it from the latest settledAt
                        // of its successful "out" rows (this replaces payments.refundedAt)
  approvalLockedAt: null, // TEMPORARY 2-minute lock: set while an admin approves, so two admins can't approve the same refund and
                        // send duplicate PayMongo refunds (reject is blocked meanwhile). Deleted when the approval ends, so a finished
                        // request carries no such field
  restoredAt: null,     // only on a request that was restored from refundArchives
  createdAt: null,
  updatedAt: null,
};

module.exports = { RefundRequest };
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
// that was kept is nothing_owed + returnDeposit: false) — a real refund is created as a "Pending" placeholder with
// approvalLockedAt (so a double-submit gets a 409 and the doc exists before PayMongo is called), then moves to
// "Approved"; the other two go directly to "Refunded" since there's nothing left to do. There is no review step
// either way, since staff already decided. getResolvedBookingsForCar() (services/fleet/fleet.
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
//   "Failed"   → PayMongo confirmed the refund failed after approval, or refused a part of it (also: a scheduled
//                same-day send that PayMongo rejected for good)
//
// Other transitions the admin code makes:
//   "Approved" → "Failed"     the cron's scheduled send (sendScheduledRefund) hit a permanent PayMongo error
//   "Failed"   → "Refunded"   staff handed back every failed part (markFailedRefundHandedBack), nothing else open
//   "Failed"   → "Approved"   staff handed back some failed parts, something is still open (a PayMongo part, or the
//                             in-person portion)
//   "Approved" → "Refunded"   the in-person part marked handed back (markManualRefundIssued) and every PayMongo part settled
//   "Pending"  → "Approved" / "Rejected"   staff decision; a grace-window request is approved by the system
// When a request reaches "Refunded" through markFailedRefundHandedBack, toRefundAmount is rewritten to what was
// actually given back (online parts that succeeded + the hand-backs).
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
  gatewayFeeKept: 0,   // online payment (gateway) fee kept on this refund: only when the deposit goes back (0 = fully refunded)
  forfeitWaived: false,
  // ── Written by the customer backend when it creates the request (requestRefund) ──
  // A request made inside the 2-hour grace window is NOT flagged: the customer backend approves it ITSELF right after creating it
  // (utils/payments/autoApproveRefund.util.js), with no staff review and no call to the admin backend. For a payment made today it saves
  // the request as Approved with a sendAfter and pending "out" rows, and the admin cron sends the money. If that approval
  // fails the request stays Pending, the customer backend notifies staff, and they approve it by hand.
  depositGraceApplied: false, // true = under 48h before pickup, but asked inside the grace window, so the deposit goes back
  // ── Same-day rule (PayMongo can't PARTIALLY refund a payment on the day it was made) ──
  // Written when a request is approved (by staff in the admin backend, or by the customer backend for a grace-window request) and
  // part of it is smaller than the charge it refunds AND that charge was paid today (Manila). A grace-window approval from the
  // customer backend always schedules its online parts, because that backend never sends to PayMongo itself.
  // Nothing is sent to PayMongo at approval; runScheduledRefunds() (admin cron, 16:10 UTC = 00:10 Manila) sends it after sendAfter.
  // What to send (each part's PayMongo payment id + amount) is on the request's online "out" rows in paymentEntries, not here.
  sendAfter: null,           // the next Manila midnight; absent when the refund went out immediately, and removed again once it has been sent
  scheduledAt: null,         // when it was put on the schedule (the moment sendAfter was set; shown on the Dashboard). Removed together with sendAfter.
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
  //   scheduledSentAt / scheduledParts / bookedAt   LEGACY, read only, never written any more. scheduledSentAt: an old
  //                                 scheduled request that was already sent (the cron, the Dashboard and the Refunds page skip it).
  //                                 scheduledParts[]: where the cron used to find what to send; it is only a fallback now, matched
  //                                 to the "out" rows by position, when a row has no paymongoPaymentID. bookedAt: when the deposit was
  //                                 paid, kept on old snapshot requests so policyForRequest() can still judge the grace window.
  //   amount / grossPaid            old names of toRefundAmount / bookingPaid. Old documents and the customer backend
  //                                 still use them, so every reader accepts both and the API returns both for now.
  status: "Pending",
  processedBy: null,    // staff userID who approved / rejected it ("system" when the grace-window auto-approve did it; staff-originated
                        // refunds record the staff user too). Rows written by staff-originated refunds before this was stored may
                        // lack it: readers fall back to the cancellation row. (processedAt is not stored: the entry rows and the audit log carry the time)
  reason: null,         // the STAFF's reason for the decision: why it was rejected, or the note / waive reason given on approve.
                        // The customer's own reason is on the cancellation row (the API returns it as customerReason).
  // rejectReason is the old name of `reason` for a rejection. It is still written in ONE case: rejecting an OLD document
  // whose `reason` holds the customer's words. Those words stay in `reason` and the staff's reason goes to rejectReason
  // instead (canWriteDecisionReason() decides, in services/refundRequest/refundRequest.service.js). Every other rejection
  // writes `reason` and deletes rejectReason, so a new document never carries it. Readers accept both.
  rejectReason: null,   // legacy rejections only, see above
  refundedAt: null,     // when the refund completed. Written when staff mark the in-person part handed back; a request the
                        // customer backend's webhook completed has none stored, readers derive it from the latest settledAt
                        // of its successful "out" rows (this replaces payments.refundedAt)
  approvalLockedAt: null, // TEMPORARY 2-minute lock: set while an admin approves, so two admins can't approve the same refund and
                        // send duplicate PayMongo refunds (reject is blocked meanwhile). Deleted when the approval ends, so a finished
                        // request carries no such field
  createdAt: null,
  updatedAt: null,
};

module.exports = { RefundRequest };
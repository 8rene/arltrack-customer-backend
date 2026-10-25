// Copied from the admin backend's models/ so both backends describe the same document. Keep it identical: change the
// admin file first, then copy it here.
//
// paymentEntries/{paymentEntryID}
//
// ONE ROW PER MONEY MOVEMENT against a payment, penalty or refund. This is the
// normalized replacement for everything that used to be embedded:
//   - payments.paymongoTransactions[]                  (deposit / balance attempts)
//   - payments.*PaymongoPaymentID / *PaymongoFee / paymongoChannel /
//     paidAt / balancePaidAt / confirmedBy / confirmedAt / balanceMethod /
//     balanceCollectedBy / balanceCollectedAt          (scattered per-phase facts)
//   - penalties.paymentMethod / referenceNumber / paidAt  (overwritten on every payment)
//   - refundRequests.parts[] / manualRefund            (STEP 2 -- direction "out")
//
// NOTE: the PayMongo checkout session id lives HERE (sessionID), not on payments. The webhook finds the payment
// through the row (sessionID -> paymentID), and a payment's deposit, balance and penalty checkouts each keep
// their own id. hydratePayment() derives payments.paymongoSessionID from the latest deposit / balance row for the
// readers that still ask for it. payments.checkoutUrl STAYS on payments: it is the URL of the one checkout open
// right now.
//
// payments, penalties and refundRequests stay as the parent documents (totals,
// workflow, review). paymentEntries only holds the money movements.
//
// Money in  -> direction "in"  (customer paid)
// Money out -> direction "out" (a refund)
//     <refundRequestID>_part<n>          one PayMongo refund        (source "online",    referenceNumber = re_...)
//     <refundRequestID>_manual           staff hand-back in person  (source "in_person") -- cash taken in person ONLY
//     <refundRequestID>_unrefundable<n>  paid online but NO PayMongo payment id: status "unrefundable", with
//                                        transactionErrorNote "Payment ID does not exist". It is reported, never
//                                        handed back.
//     <partRowID>_handback               staff paid back, themselves, an online part PayMongo refused (that part's row stays
//                                        "failed"): ONE new success row (source "in_person", method cash / gcash / maya /
//                                        bank_transfer) with handBackFor = the failed row's id. A part counts as covered once
//                                        its hand-back row exists. Written by markFailedRefundHandedBack().
//     (auto ID)                          money handed back for a staff discount that exceeded what was owed:
//                                        phase "discount", refundReqID null (no refund request exists for it).
//                                        In person: written by markRefundIssued() in the same batch as
//                                        payments.refundIssued. Online: written by applyDiscount() (pending
//                                        until PayMongo confirms).
//     (auto ID)                          the security deposit handed back at settlement: phase "deposit_return", source
//                                        "in_person", refundReqID null. One row each time settleBooking() returns money
//                                        (net > 0), written in the same transaction as payments.depositReturned.
// The "out" rows ARE the source of truth for a refund: refundRequests no longer stores parts[] / manualRefund /
// unrefundable[] (writeRefundEntries commits them with the status change; hydrateRefundRequests rebuilds the
// old shape for readers). A request that still carries those fields (not yet cleaned up) wins in hydrate.
//
// The row is the source of truth for "did this money move, how, and what is its
// external reference". Anything totalling entries MUST filter on direction.
//
// Deposit offsets (penalties covered by the held security deposit) are NOT entries: no money moves, they are
// adjustments and stay on payments (depositSettled / depositStatus ...).
//
// Staff discounts ARE written as rows. Four are direction "internal": no cash is received or released, value just moves
// between the discount's parts. One row per real event:
//     (auto ID)  discount_applied_balance   a discount given while the payment is still partial; it came off the
//                                           remaining balance. Nothing is owed back.
//     (auto ID)  discount_credit            a discount given on a FULLY PAID booking. The customer has already paid
//                                           it, so it is held and returned when the trip is settled.
//     (auto ID)  discount_in_refund         the held credit went back INSIDE a cancellation refund (a refund request was
//                                           approved, or staff cancelled and refunded). The credit is money the customer
//                                           paid, so the refund plan counts it; the cash is in that refund's own "out" rows,
//                                           and this row (refundReqID is set) only closes the credit in the ledger.
//     (auto ID)  discount_applied_penalty   part of the held credit that covered a penalty the deposit could not
//                                           (penaltyID is set).
// The fourth is real money, direction "out":
//     (auto ID)  discount_return            the held credit paid back to the customer at settlement. Its OWN payout,
//                                           separate from the deposit's deposit_return row: same way of returning (in
//                                           store -> success now; online -> pending until PayMongo confirms, with its own
//                                           refund id), same retry and in-store hand-back, a newer row supersedes a failed one.
// "internal" rows are never counted in paid-in / refunded-out totals: those filter on "in" and "out" only.
// discount_return counts in refundedOut like the legacy "discount" refund did (the money did leave).
//     (deterministic ID)  deposit_forfeited  the security deposit was KEPT by the business (a late / no-show refund, or a
//                                           cancellation with no refund). direction "internal": nothing moves, the business just
//                                           keeps what it already holds. ID = "<paymentID>_deposit_forfeited"; reason = why.
// Legacy discounts (phase "discount", direction "out") are untouched: they were refunded on the spot.

const ENTRY_COLLECTION = "paymentEntries";

const ENTRY_DIRECTIONS = ["in", "out", "internal"];   // "internal" = no cash moved (a discount changing buckets)
const ENTRY_PHASES     = ["deposit", "balance", "penalty", "deposit_return", "discount",
                                 "discount_credit", "discount_applied_balance", "discount_applied_penalty", "discount_return", "discount_in_refund", "deposit_forfeited"];
const ENTRY_SOURCES    = ["online", "in_person"];            // PayMongo | staff collected / handed back
const ENTRY_METHODS    = ["gcash", "maya", "qrph", "cash", "bank_transfer"];   // customers can only pay online via gcash / maya / qrph
// "unrefundable" is only used by direction "out" rows (an amount with no PayMongo payment id).
const ENTRY_STATUSES   = ["pending", "success", "failed", "cancelled", "unrefundable"];

const PaymentEntry = {
  paymentEntryID: "",       // same as the Firestore doc ID. Deposit/balance rows: "<paymentID>_deposit" | "<paymentID>_balance"
                            // (same key the transaction-log idempotency already uses). Penalty / later attempts: auto ID.
  paymentID:   null,        // FK -> payments.paymentID (every row)
  bookingID:   null,        // FK -> bookings.bookingID
  userID:      null,        // FK -> user (the customer)
  refundReqID: null,        // FK -> refundRequests.refundRequestID. Set on a refund's "out" rows only.
  penaltyID:   null,        // FK -> penalties.penaltyID. Set on "penalty" phase rows only.
  direction:   "in",        // "in" | "out" | "internal"
  phase:       "deposit",   // "deposit" | "balance" | "penalty" | "deposit_return" | "discount" | "discount_credit" | "discount_applied_balance" | "discount_applied_penalty" | "discount_return" | "discount_in_refund"   (for "out": the phase being refunded)
  source:      "online",    // "online" | "in_person"
  method:      null,        // gcash | maya | qrph | cash | bank_transfer | null (online, channel unknown)
  amount:      0,           // pesos moved by THIS entry
  status:      "pending",   // pending | success | failed | cancelled | unrefundable
  referenceNumber: null,    // the external id of this movement: pay_... (online), re_... (online refund),
                            // receipt / bank code (in person). null if none. Never "N/A" / "—" / "".
  sessionID:   null,        // PayMongo checkout session (online "in" rows) -- webhook lookup key
  transactionFee: null,     // PayMongo's actual fee for this charge (NOT payments.gatewayFee, which is
                            // what the customer was charged from system settings)
  processedBy: null,        // staff uid who confirmed / handed back (in person). null for online + webhooks
  processedAt: null,
  settledAt:   null,        // when the money actually moved
  groupID:     null,        // rows created by ONE payment that covered several penalties share this
  handBackFor: null,        // "<partRowID>_handback" rows ONLY: the id of the failed PayMongo part row this in-person row pays back.
                            // Not stored on any other row. A manual in-person row WITHOUT it is the request's own hand-back (_manual).
  reason: null,               // why: the reason staff gave for a discount (required) or for a forfeited deposit; null on other rows
  transactionErrorNote: null, // why a movement failed / could not happen (a failed refund part's error,
                            // "Payment ID does not exist"). null when nothing went wrong.
  createdAt:   null,
  updatedAt:   null,
};

// Indexes the app relies on (Firestore creates single-field ones automatically):
//   paymentID + phase           list a payment's entries
//   refundReqID                 list a refund's "out" rows (queried `in` [...] and `==`)
//   penaltyID                   list a penalty's payments (queried `in` [...])
//   referenceNumber + direction webhook lookup (STEP 2)
//   sessionID                   webhook lookup
//   bookingID                   permanent-delete cleanup

module.exports = { ENTRY_COLLECTION, ENTRY_DIRECTIONS, ENTRY_PHASES, ENTRY_SOURCES, ENTRY_METHODS, ENTRY_STATUSES, PaymentEntry };
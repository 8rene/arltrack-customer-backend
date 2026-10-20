// Copied from the admin backend's models/ so both backends describe the same document. Keep it identical: change the
// admin file first, then copy it here.
//
// Matches the actual 'payments' collection in Firestore.
//
// A payment document holds WHAT is owed and its STATE. Every money movement (who paid, how, when, how much, the
// pay_... / re_... reference, PayMongo's fee) is a row in paymentEntries; hydratePayment() hands the old field
// names back to readers (paymongoTransactions, balanceCollected, confirmedBy, paidAt ...), so none of them are
// listed here.
const Payment = {
  paymentID: "",
  bookingID: "",
  userID: "",
  amount: 0,          // grand total of the booking
  rentalFee: 0,
  serviceFee: 0,
  extraFee: 0,
  driversFee: 0,        // chauffeur fee (0 when self-drive)
  gatewayFee: 0,        // payment-gateway fee charged to the customer (peso amount)
  securityDeposit: 0,   // refundable deposit, already inside `amount`

  // Percentage fees, snapshotted at booking time so a later Settings change
  // never alters an existing booking. 0 on bookings made before percent fees.
  serviceFeeRate: 0,    // % of the RENTAL FEE only
  gatewayFeeRate: 0,    // % of gatewayFeeBase
  gatewayFeeBase: 0,    // rental + extra + driver's + service fee + security deposit

  // What the customer chose at booking time.
  methodOfPayment: "",  // "Full" | "Partial"
  paymentMethod: "",    // the customer's chosen channel: "gcash" | "maya" | "qrph"

  // The deposit (first) payment. Written in lowercase by the customer app / webhook ("pending" | "paid" | "failed" |
  // "refunded" | "cancelled"); the admin side writes "Approved" / "Rejected" when staff confirm. Every reader compares
  // it lowercase, so mixed casing is normal (see normalizePaymentStatus).
  status: "",

  // The URL of the PayMongo checkout currently open. The checkout SESSION ID is not stored here: it is
  // paymentEntries.sessionID on the deposit / balance row (the webhook's lookup key), and hydratePayment()
  // derives payments.paymongoSessionID from the latest such row for the readers that still ask for it.
  checkoutUrl: "",

  // Live state of a Partial payment's balance. The customer backend's settle-once guard reads these inside a
  // Firestore transaction, so they stay until that guard reads the entries instead.
  currentPhase: "",     // "deposit" | "balance": which phase the open checkout is for
  balanceStatus: "",    // "" | "not_due" | "pending" | "paid" | "failed" | "cancelled"
  balanceAmount: 0,     // what the open balance checkout charges
  // NOT stored here: balanceCollected / balanceCollectedAmount. "Staff collected the balance in person" is a settled
  // in-person balance row in paymentEntries, and hydratePayment() derives both from it. Likewise refundIssuedBy /
  // refundIssuedAt are the processedBy / processedAt of the discount-refund row (phase "discount").

  // A staff discount is an adjustment of what is owed, not a money movement, so it lives on the payment.
  // discountAmount is the running TOTAL of every discount given on the booking (more than one can be given).
  discountAmount: 0,
  // LEGACY discounts only (given before the discount ledger): who and why. A new discount does not store them: who and
  // when are on its paymentEntries row (processedBy / processedAt), and the reason is in the activity log.
  discountReason: "",
  discountBy: "",
  discountAt: null,         // when the LATEST discount was given
  // The discount's parts (see services/payments/discountLedger.js). null = a legacy discount, or none: DON'T default these
  // to 0, their absence is how a legacy discount is told apart (hasDiscountLedger). All three are written together with
  // the ledger row they describe, and discountAmount === discountApplied + discountCredit + discountReturned.
  discountApplied: null,    // used: it came off the balance or paid penalties (the discount_applied_* rows tell which)
  discountCredit: null,     // held for the customer (a discount given on a fully paid booking); the only part that drains
  discountReturned: null,   // went back to the customer (its own discount_return payout)

  // Set by applyDiscount() when a discount is applied to a booking that's
  // already fully (or partially) paid past what the new discount covers —
  // the spillover is cash that's now owed back to the customer. 0 means
  // the discount fit entirely within the outstanding balance, nothing to
  // return. See payments.service.js's computeAmounts()/applyDiscount().
  refundDue: 0,
  // Flipped true via markRefundIssued() once staff or the driver holding
  // the cash actually hands it back. Drives the "Refund Due" banner in
  // PaymentStatusModal and the Payments.jsx table/refund column. Who handed it back and when is the
  // discount-refund entry (phase "discount", out-row), not a field here.
  refundIssued: false,

  // The security deposit held for the booking. It is charged inside `amount` with the first payment, so the
  // first payment's entry row already holds how it was paid. Flat fields (read them through getDepositView(),
  // services/payments/paymentHelpers.js -- it also understands the old nested `deposit` object until
  // scripts/migrate-deposit-flat.js has run):
  //   securityDeposit      (above  ) the deposit amount
  depositStatus: "",            // "Held" | "Waived" | "Settled" | "Forfeited" | "Refunded"
  depositSettled: 0,            // pesos of the deposit USED to pay penalties. Goes up with each penalty taken from the held deposit, final once Settled (never more than the deposit;
                                // penalties beyond it stay on the penalties, amount - paidAmount, with their reasons).
  depositReturned: 0,           // Settled only: pesos handed back to the customer (depositSettled + this = the deposit)
                                // The result (Refunded / Settled / OwedByCustomer) is derived, not stored: OwedByCustomer
                                // is "nothing returned and a Confirmed penalty is still unpaid", so it clears when paid.
  depositSettledAt: null,       // when the deposit stopped being Held (settled, waived, forfeited or refunded)
  // The deposit going back IS a paymentEntries row: phase "deposit_return", direction "out", source "in_person", written
  // by the admin's settleBooking() (penalty.service.js) in the same transaction as depositReturned, and only when
  // something was returned. That row holds how it was returned (method, reference), who did it and when; depositReturned
  // here is the amount. A DepositReturn transaction log (id <paymentID>_deposit_settled) is written as well. Who waived a
  // deposit is in the audit log.

  createdAt: null,
  updatedAt: null,
  restoredAt: null,   // only on a payment that was restored from paymentsArchives
  // NOT stored here: refundedAt. When a refund completed is on its refundRequest (refundedAt); the payment only
  // carries status "Refunded".
};

module.exports = { Payment };
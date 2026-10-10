// Matches the actual 'payments' collection in Firestore
export const Payment = {
  paymentID: "",
  bookingID: "",
  paymentMethod: "",  // e.g. "gcash", "maya", "qrph" -- the customer's chosen channel
  // referenceNumber / proofUrl are NOT stored on a payment: the reference (pay_... / re_...) is
  // paymentEntries.referenceNumber, and there is no proof upload -- PayMongo is the proof.
  amount: 0,          // deposit amount (partial)
  rentalFee: 0,
  serviceFee: 0,
  extraFee: 0,
  driversFee: 0,        // chauffeur fee (0 when self-drive)
  gatewayFee: 0,        // payment-gateway fee charged to the customer (peso amount)
  securityDeposit: 0,   // refundable deposit, already inside `amount`
  // Written by the first payment settling (settlePayment.util.js): depositStatus = "Held". Everything after that is
  // the admin app's (settleBooking / waive / refund): depositSettled (used for penalties), depositReturned,
  // depositSettledAt. Read it all through getDepositView() (utils/payments/depositView.util.js, generated from the
  // admin repo); how the deposit was returned is the "<paymentID>_depositreturn" row in paymentEntries.
  depositStatus: "",    // "Held" | "Waived" | "Settled" | "Forfeited" | "Refunded"

  // Percentage fees, snapshotted at booking time so a later Settings change
  // never alters an existing booking. 0 on bookings made before percent fees.
  serviceFeeRate: 0,    // % of the RENTAL FEE only
  gatewayFeeRate: 0,    // % of gatewayFeeBase
  gatewayFeeBase: 0,    // rental + extra + driver's + service fee + security deposit

  // PayMongo ids, fees and the channel are NOT stored on a payment: each online charge is a row in
  // paymentEntries (referenceNumber = pay_..., transactionFee, method) and hydratePayment() gives
  // depositPaymongoPaymentID / balancePaymongoPaymentID / depositPaymongoFee / balancePaymongoFee /
  // paymongoFeeTotal / paymongoChannel / paymongoTransactions back to readers.
  // Only checkoutUrl stays here. The PayMongo checkout session id lives on the paymentEntries row
  // (sessionID); the webhook finds the payment through it. See utils/payments/paymentSession.util.js.
  status: "",         // "Paid" | "Pending" | "Refunded"
  discountAmount: 0,
  discountReason: "",
  discountBy: "",
  discountAt: null,
  // Set by applyDiscount() when a discount is applied to a booking that's
  // already fully (or partially) paid past what the new discount covers —
  // the spillover is cash that's now owed back to the customer. 0 means
  // the discount fit entirely within the outstanding balance, nothing to
  // return. See payments.service.js's computeAmounts()/applyDiscount().
  refundDue: 0,
  // Flipped true via markRefundIssued() once staff or the driver holding
  // the cash actually hands it back. Drives the "Refund Due" banner in
  // PaymentStatusModal and the Payments.jsx table/refund column.
  refundIssued: false,
  createdAt: null,
  updatedAt: null,
};
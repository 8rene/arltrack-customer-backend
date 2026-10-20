// The wording the customer sees about QR Ph and refunds, in ONE place so the checkout, the refund preview, the refund
// request and the cancellation answers all say the same thing.
//
// Why: PayMongo's refund API refuses payments made by QR Ph ("Refunds are not allowed for payments with source type qrph").
// The money is not lost: staff hand it back in person at the store. So the customer is told before they pay, before they ask
// for a refund, and when it is approved. (The admin backend decides the split: paymentBreakdown.js -> computeRefundPlan puts
// the QR Ph part into `manualAmount` / `qrphAmount`.)

const peso = (n) => `\u20b1${Number(n || 0).toLocaleString()}`;

// Shown when the customer picks QR Ph to pay.
const QRPH_BOOKING_NOTICE =
  "Heads up: payments made by QR Ph can't be refunded online. If you cancel and your refund is approved, you will need to visit our store to collect it.";

// Shown with a refund quote / request when part of the money was paid by QR Ph.
const qrphRefundNotice = (amount) =>
  `Part of this payment (${peso(amount)}) was made by QR Ph, which can't be refunded online. If your refund is approved, please visit our store to collect it.`;

// A trip that has started can't be cancelled from the app.
const STARTED_TRIP_MESSAGE =
  "A trip that has already started can't be cancelled. If something is wrong, please contact us; your security deposit is returned after the trip is completed.";

module.exports = { QRPH_BOOKING_NOTICE, qrphRefundNotice, STARTED_TRIP_MESSAGE };
// ─────────────────────────────────────────────────────────────────────────────
// Payment breakdown + refund plan — SINGLE SOURCE OF TRUTH (customer backend).
//
// KEEP IN SYNC with arltrack-admin-backend/services/payments/paymentBreakdown.js
// (an identical copy — the two apps deploy separately, so it can't be a shared
// import). If you change one, change the other.
//
// Pure functions only (no Firestore) so they're trivially testable.
//
// Payment doc fields this reads:
//   amount            grand total of the booking
//   methodOfPayment   "Full" | "Partial" (| legacy "Downpayment"/"Deposit")
//   status            the DEPOSIT (first) payment: pending|paid|Approved|failed|
//                     cancelled|Refunded   (mixed casing is normal — compared lowercase)
//   balanceStatus     the optional BALANCE payment (Partial only):
//                     not_applicable|not_due|pending|paid|failed|cancelled
//   balanceCollected  true when STAFF collected the balance in person
//   discountAmount / refundIssued   staff discount (see admin applyDiscount)
//   depositPaymongoPaymentID / balancePaymongoPaymentID  PayMongo payment ids, one
//                     per online charge (paymongoPaymentID = legacy "latest charge")
// ─────────────────────────────────────────────────────────────────────────────

const num   = (v) => Number(v) || 0;
const lower = (v) => String(v || "").toLowerCase();

const payTypeOf = (payment) => {
  const m = lower(payment && payment.methodOfPayment);
  if (m.includes("full"))    return "Full";
  if (m.includes("down"))    return "Downpayment";
  if (m.includes("partial")) return "Partial";
  return "Deposit"; // unrecognised/legacy — treated as an upfront-portion type, never "Full"
};

// How much the first payment is worth for each payment type.
const upfrontOf = (payType, amount, depositFee) => {
  if (payType === "Full") return amount;
  if (payType === "Downpayment" || payType === "Partial") return Math.floor(amount / 2); // == computePaymentSplit().payNow
  return depositFee; // legacy flat deposit
};

/**
 * What has actually been received, and what is still owed.
 *
 * Returns:
 *   payType, amount
 *   depositCollected   first payment received (0 until confirmed)
 *   balanceOnline      balance paid through PayMongo
 *   balanceInPerson    balance collected by staff (cash/GCash/bank) — NOT on PayMongo
 *   amountPaid         net received after any staff discount spillover
 *   balance            still owed (after discount)
 *   refundDue          discount spillover still owed back to the customer
 */
const getPaymentBreakdown = (payment) => {
  const p          = payment || {};
  const amount     = num(p.amount);
  const depositFee = num(p.depositFee);
  const status     = lower(p.status);
  const payType    = payTypeOf(p);

  if (status === "refunded") {
    return { payType, amount, depositCollected: 0, balanceOnline: 0, balanceInPerson: 0, amountPaid: 0, balance: 0, refundDue: 0 };
  }

  const isConfirmed = status === "paid" || status === "approved";
  const upfront     = upfrontOf(payType, amount, depositFee);
  const owedAfterUpfront = Math.max(0, amount - upfront);

  // First payment. NOT capped to `amount` on purpose: the original computeAmounts
  // (which this must match exactly for existing data) used the raw deposit fee even
  // if it exceeded the booking total.
  const depositCollected = isConfirmed ? upfront : 0;

  // Second payment, only when the customer paid it ONLINE (balanceStatus "paid").
  let balanceOnline = 0;
  if (isConfirmed && payType !== "Full" && lower(p.balanceStatus) === "paid") {
    balanceOnline = Math.min(owedAfterUpfront, num(p.balanceAmount) || owedAfterUpfront);
  }

  let amountPaid = depositCollected + balanceOnline;
  let balance    = amount - amountPaid;

  // Staff collected the rest in person (admin: collectRemainingBalance). Legacy
  // behaviour kept: it settles the whole amount.
  let balanceInPerson = 0;
  if (p.balanceCollected) {
    balanceInPerson = Math.max(0, amount - amountPaid);
    amountPaid = amount;
    balance    = 0;
  }

  // Flat-peso staff discount: comes off the balance first, any excess spills
  // onto amountPaid and becomes cash owed BACK (refundDue). Identical to the
  // admin's computeAmounts so both apps always agree.
  const discountAmount = num(p.discountAmount);
  let refundDue = 0;
  if (discountAmount > 0) {
    if (balance >= discountAmount) {
      balance -= discountAmount;
    } else {
      const spillover = discountAmount - balance;
      balance    = 0;
      amountPaid = Math.max(0, amountPaid - spillover);
      refundDue  = p.refundIssued ? 0 : spillover;
    }
  }

  return { payType, amount, depositCollected, balanceOnline, balanceInPerson, amountPaid, balance, refundDue };
};

/**
 * Which PayMongo payment id belongs to which phase.
 *
 * Before per-phase ids existed, BOTH phases wrote the single `paymongoPaymentID`,
 * so once the balance was paid that field holds the BALANCE charge and the
 * deposit's id is gone from our records. Handled explicitly here: in that case
 * the deposit id is null and the deposit portion of a refund falls to the
 * manual bucket (staff refund it from the PayMongo dashboard).
 */
const resolvePaymongoIDs = (payment) => {
  const p = payment || {};
  const balancePaid = lower(p.balanceStatus) === "paid";
  const deposit = p.depositPaymongoPaymentID || (balancePaid ? null : (p.paymongoPaymentID || null));
  const balance = p.balancePaymongoPaymentID || (balancePaid ? (p.paymongoPaymentID || null) : null);
  return { deposit, balance };
};

/**
 * How a refund of everything the customer has paid should be executed.
 *
 *   parts[]       one PayMongo refund per online charge (PayMongo can only refund
 *                 up to what it received on each payment_id)
 *   manualAmount  whatever PayMongo can't return: balance staff collected in
 *                 person, cash-paid deposits, or a deposit whose PayMongo id is
 *                 unknown — staff hands this back and marks it issued
 *   total         parts + manual = amountPaid (net of discount spillover)
 */
const computeRefundPlan = (payment) => {
  const b   = getPaymentBreakdown(payment);
  const ids = resolvePaymongoIDs(payment);

  let remaining = b.amountPaid;
  const parts = [];
  const take = (kind, id, cap) => {
    if (!id || cap <= 0 || remaining <= 0) return;
    const amt = Math.min(remaining, cap);
    parts.push({ kind, paymongoPaymentID: id, amount: amt });
    remaining -= amt;
  };
  take("deposit", ids.deposit, b.depositCollected);
  take("balance", ids.balance, b.balanceOnline);

  return { total: b.amountPaid, parts, manualAmount: remaining, breakdown: b };
};

module.exports = { getPaymentBreakdown, resolvePaymongoIDs, computeRefundPlan, payTypeOf };

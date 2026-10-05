// ─────────────────────────────────────────────────────────────────────────────
// Payment breakdown + refund plan — customer backend copy.
//
// GENERATED from arltrack-admin-backend/services/payments/paymentBreakdown.js
// (the two apps deploy separately, so it can't be a shared import). The only
// difference is the export line (CommonJS here, ESM there). If you change one,
// change the other — the logic must stay identical.
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
// securityDeposit (refundable, included in `amount`) is always paid in full up
// front; 0 for older payments, which gives the original plain 50%.
const upfrontOf = (payType, amount, depositFee, securityDeposit = 0) => {
  if (payType === "Full") return amount;
  if (payType === "Downpayment" || payType === "Partial") {
    const sec = Math.min(Math.max(0, securityDeposit), amount);
    return sec + Math.floor((amount - sec) / 2); // == computePaymentSplit().payNow
  }
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
  const upfront     = upfrontOf(payType, amount, depositFee, num(p.securityDeposit));
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
    const rec = p.balanceCollectedAmount;
    if (rec !== undefined && rec !== null && Number.isFinite(Number(rec)) && Number(rec) >= 0) {
      // What staff ACTUALLY took in person (collectRemainingBalance stores it
      // net of any discount already given at that moment). Counting the whole
      // `amount` as paid here made a discount given BEFORE the balance was
      // collected look like it had to be handed back — the customer had
      // already paid the reduced balance. Any discount is applied below,
      // exactly once.
      balanceInPerson = Math.min(Number(rec), Math.max(0, amount - amountPaid));
      amountPaid += balanceInPerson;
      balance     = amount - amountPaid;
    } else {
      // Older records without the collected amount: legacy behaviour kept.
      balanceInPerson = Math.max(0, amount - amountPaid);
      amountPaid = amount;
      balance    = 0;
    }
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
//
// opts.forfeit — pesos the customer FORFEITS (the deposit, under the 48-hour
// policy — see getRefundPolicy below). It comes out of the first (deposit-phase)
// payment, so the PayMongo refund on that charge is reduced by it; every other
// charge is refunded in full. Default 0 = refund everything paid.
//
//   total        = amountPaid − forfeit      (what the customer actually gets back)
//   grossPaid    = amountPaid                (everything they paid, before the forfeit)
//   forfeit      = what is being kept
const computeRefundPlan = (payment, opts = {}) => {
  const b   = getPaymentBreakdown(payment);
  const ids = resolvePaymongoIDs(payment);

  const forfeit = Math.min(Math.max(0, num(opts.forfeit)), b.amountPaid);

  let remaining = b.amountPaid - forfeit;
  const parts = [];
  const take = (kind, id, cap) => {
    if (!id || cap <= 0 || remaining <= 0) return;
    const amt = Math.min(remaining, cap);
    parts.push({ kind, paymongoPaymentID: id, amount: amt });
    remaining -= amt;
  };
  take("deposit", ids.deposit, Math.max(0, b.depositCollected - forfeit));
  take("balance", ids.balance, b.balanceOnline);

  return { total: b.amountPaid - forfeit, grossPaid: b.amountPaid, forfeit, parts, manualAmount: remaining, breakdown: b };
};

// ─────────────────────────────────────────────────────────────────────────────
// 48-hour refund policy (Terms & Conditions → Cancellation & Refund Policy).
//
// The tier is judged by WHEN THE CUSTOMER ASKED FOR THE REFUND (requestedAt =
// the request's server-side createdAt), NOT when staff approve it — a request
// made 50 hours before pickup and approved 40 hours before is still a "full"
// refund.
//
//   hours before pickup >= 48   → "full"     nothing forfeited
//   0 <= hours < 48             → "late"     the deposit is forfeited
//   hours < 0 (after pickup)    → "no_show"  the deposit is forfeited
//
// The ONE variable the policy depends on is the deposit amount:
//   payment.deposit.amount  (the held security deposit, once the first payment cleared)
//   → payment.securityDeposit (snapshotted on the payment at booking time)
//   → payment.depositFee      (legacy flat deposit on older payments)
// It is capped at what the customer actually paid, so a refund is never negative.
//
// Everything else the customer paid (rental, extra/driver's fee, service fee,
// gateway fee…) is refunded.
//
// waiveForfeit: staff override (goodwill, duplicate charge, business-caused
// cancellation). The tier is still reported; the forfeit is just 0.
// ─────────────────────────────────────────────────────────────────────────────
const REFUND_FULL_WINDOW_HOURS = 48;
const HOUR_MS = 60 * 60 * 1000;

const toDate = (v) => {
  if (!v) return null;
  const d = typeof v.toDate === "function" ? v.toDate()
          : v._seconds !== undefined ? new Date(v._seconds * 1000)
          : new Date(v);
  return d && !isNaN(d.getTime()) ? d : null;
};

// The real pickup INSTANT of a booking.
//   1. booking.pickupAt — saved at booking time with an explicit Manila (+08:00)
//      offset, so it is exact on any server.
//   2. Older bookings only have startDateTime, which was parsed from the typed
//      date+time with NO timezone. The typed time is Manila wall-clock, so read
//      it back with the same local getters the rest of the code uses and
//      re-interpret it as Manila. This gives the right instant whether the
//      server runs in UTC or in Manila time. (Assumes the server reading the
//      booking runs in the same timezone as the one that created it — normally
//      the same host. A refund request snapshots the pickup instant at the
//      moment it is made, so this fallback only matters for the first quote and
//      for the admin no-show check on bookings made before pickupAt existed.)
const MANILA_OFFSET_MS = 8 * HOUR_MS;
const resolvePickupAt = (booking) => {
  const b = booking || {};
  const explicit = toDate(b.pickupAt);
  if (explicit) return explicit;
  const s = toDate(b.startDateTime);
  if (!s) return null;
  return new Date(Date.UTC(s.getFullYear(), s.getMonth(), s.getDate(), s.getHours(), s.getMinutes(), s.getSeconds()) - MANILA_OFFSET_MS);
};

const getDepositAmount = (payment) => {
  const p = payment || {};
  return num(p.deposit && p.deposit.amount) || num(p.securityDeposit) || num(p.depositFee);
};

const getRefundPolicy = (payment, { pickupAt, requestedAt, waiveForfeit = false } = {}) => {
  const pickup    = toDate(pickupAt);
  const requested = toDate(requestedAt);
  const depositAmount = getDepositAmount(payment);
  const amountPaid    = getPaymentBreakdown(payment).amountPaid;

  // Can't judge the timing without both timestamps → fail OPEN (full refund)
  // and say so, so staff can see why and decide.
  if (!pickup || !requested) {
    return { tier: "full", hoursBeforePickup: null, depositAmount, forfeit: 0, waived: false, unknownTiming: true, windowHours: REFUND_FULL_WINDOW_HOURS };
  }

  const hoursBeforePickup = (pickup.getTime() - requested.getTime()) / HOUR_MS;
  const tier = hoursBeforePickup >= REFUND_FULL_WINDOW_HOURS ? "full"
             : hoursBeforePickup >= 0                        ? "late"
             :                                                 "no_show";

  const wouldForfeit = tier === "full" ? 0 : Math.min(depositAmount, amountPaid);
  const forfeit = waiveForfeit ? 0 : wouldForfeit;

  return {
    tier,
    hoursBeforePickup: Math.round(hoursBeforePickup * 100) / 100,
    depositAmount,
    forfeit,
    waived: !!waiveForfeit && wouldForfeit > 0,
    waivedAmount: waiveForfeit ? wouldForfeit : 0,
    unknownTiming: false,
    windowHours: REFUND_FULL_WINDOW_HOURS,
    fullRefundUntil: new Date(pickup.getTime() - REFUND_FULL_WINDOW_HOURS * HOUR_MS),
  };
};

// Policy + plan in one call: what a refund requested at `requestedAt` is worth.
const computeRefundQuote = (payment, { pickupAt, requestedAt, waiveForfeit = false } = {}) => {
  const policy = getRefundPolicy(payment, { pickupAt, requestedAt, waiveForfeit });
  const plan   = computeRefundPlan(payment, { forfeit: policy.forfeit });
  return { policy, plan };
};

module.exports = { getPaymentBreakdown, resolvePaymongoIDs, computeRefundPlan, getRefundPolicy, computeRefundQuote, getDepositAmount, resolvePickupAt, payTypeOf, REFUND_FULL_WINDOW_HOURS };

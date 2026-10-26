// ─────────────────────────────────────────────────────────────────────────────
// Payment breakdown + refund plan — customer backend copy.
//
// GENERATED from arltrack-admin-backend/services/payments/paymentBreakdown.js
// (the two apps deploy separately, so it can't be a shared import). The only
// differences are the export line (CommonJS here, ESM there) and the 2-hour
// "booked by mistake" grace (REFUND_GRACE_HOURS / bookedAt), which exists only on
// this side for now. If you change one, change the other — the logic must stay
// identical.
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
//   discountApplied                 present on a LEDGER discount (see discountLedger.js): the part that came off the
//                                   balance reduces it; the rest is held / used for penalties and is never refundDue
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
  if (discountAmount > 0 && p.discountApplied !== undefined && p.discountApplied !== null) {
    // LEDGER discount (see discountLedger.js). Only the part that came off the remaining balance reduces what is
    // owed. The rest was ALREADY PAID by the customer, so it is not rental money any more: it is held for them (and
    // returned with the security deposit), paid a penalty, or went back. It leaves amountPaid exactly as the old
    // spillover did, so refunds, receipts and the customer's totals read the same as before -- but it is never
    // "refundDue": nothing is handed back on the spot, so no refund prompt, no in-store hand-back and no PayMongo refund.
    // discountApplied also holds the part that paid penalties, which only exists once the balance is 0, so
    // min(balance, discountApplied) is exactly the part that came off the balance.
    const toBalance = Math.min(Math.max(0, balance), Math.max(0, num(p.discountApplied)));
    balance -= toBalance;
    const held = Math.max(0, discountAmount - toBalance);
    amountPaid = Math.max(0, amountPaid - held);
  } else if (discountAmount > 0) {
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

// The note shown wherever an online payment has no PayMongo payment id on record.
const PAYMENT_ID_MISSING_NOTE = "Payment ID does not exist — this amount can't be refunded through PayMongo.";

// Was the first (deposit) payment taken ONLINE? Same evidence the paymentEntries mapper uses: a PayMongo
// payment id, a recorded channel, or a checkout session that staff did not confirm by hand.
const depositWasOnline = (payment, ids) => {
  const p = payment || {};
  const has = (v) => { const s = String(v == null ? "" : v).trim().toLowerCase(); return !!s && !["n/a", "—", "-"].includes(s); };
  return !!((ids && ids.deposit) || has(p.paymongoChannel) || (has(p.paymongoSessionID) && !has(p.confirmedBy)));
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
// Channels PayMongo's refund API refuses ("Refunds are not allowed for payments with source type qrph"). Money paid
// this way is NOT unrefundable -- it is in our hands, so it goes into the manual bucket: staff hand it back in person
// (or by bank transfer) and mark it issued. Judged PER PHASE: a deposit paid by GCash and a balance paid by QR Ph
// split correctly. The per-phase channel is derived from the entry rows (hydratePayment); older payments fall back
// to the single paymongoChannel.
const NO_API_REFUND_CHANNELS = ["qrph"];
const channelOfPhase = (payment, phase) => {
  const p = payment || {};
  const own = phase === "balance" ? p.balancePaymongoChannel : p.depositPaymongoChannel;
  return lower(own || p.paymongoChannel);
};
const refundableOnlyByHand = (payment, phase) => NO_API_REFUND_CHANNELS.includes(channelOfPhase(payment, phase));

// A discount given on a FULLY PAID booking is held for the customer (discountCredit): money they already paid.
// getPaymentBreakdown takes it out of amountPaid (it is not rental revenue), but a cancellation refunds what the
// customer actually PAID, so it goes back with the rest -- no separate payout, and no deduction for the discount.
// Only the still-held part counts: what already paid a penalty or went back is gone, and a discount that came off the
// balance was never paid. A legacy discount has no credit (it was refunded on the spot).
const heldCreditOf = (p) =>
  p && p.discountApplied !== undefined && p.discountApplied !== null ? Math.max(0, num(p.discountCredit)) : 0;

// ─────────────────────────────────────────────────────────────────────────────
// Gateway fee on a refund.
//
// The online payment (gateway) fee is charged on top of the booking (payment.gatewayFee). Policy:
//   deposit goes BACK to the customer (asked 48h+ before pickup, or inside the 2-hour grace) -> the gateway fee is KEPT
//   deposit is KEPT (late / no-show)                                                         -> the gateway fee is REFUNDED
//   staff-initiated refunds / cancellations, and a waived forfeit                            -> the gateway fee is REFUNDED
// Only the part of the fee the customer has actually paid is ever kept: a Partial booking that has only paid its first
// half has paid only that share of the fee (fee x amountPaid / amount). round2 keeps it to centavos.
// ─────────────────────────────────────────────────────────────────────────────
const getGatewayFeeShare = (payment) => {
  const p = payment || {};
  const fee = num(p.gatewayFee), amount = num(p.amount);
  if (!(fee > 0) || !(amount > 0)) return 0;
  const paid = getPaymentBreakdown(p).amountPaid;
  if (!(paid > 0)) return 0;
  return Math.round(fee * Math.min(1, paid / amount) * 100) / 100;
};

const computeRefundPlan = (payment, opts = {}) => {
  const b   = getPaymentBreakdown(payment);
  const ids = resolvePaymongoIDs(payment);
  let qrphAmount = 0;   // the part handed back by staff only because the channel is QR Ph (included in manualAmount)

  const heldCredit = heldCreditOf(payment);
  const paid       = b.amountPaid + heldCredit;   // everything the customer paid for this booking, before the forfeit

  const forfeit = Math.min(Math.max(0, num(opts.forfeit)), paid);
  // opts.gatewayFeeKept -- pesos of the gateway fee that are NOT refunded (see getGatewayFeeShare). It comes out of the
  // first payment together with the forfeit, and can never take more than is left after it.
  const gatewayFeeKept = Math.min(Math.max(0, num(opts.gatewayFeeKept)), Math.max(0, paid - forfeit));
  const withheld = forfeit + gatewayFeeKept;

  let remaining = paid - withheld;
  const parts = [];
  const unrefundable = [];
  let manualAmount = 0;

  // Walk the money in the order it was received. Each bucket takes what is left, up to what it
  // received (the forfeit comes out of the first, deposit-phase payment). What happens to the
  // amount depends on WHERE that money actually is:
  //   has a PayMongo payment id      -> a PayMongo refund part
  //   paid online but NO payment id  -> unrefundable: it is on PayMongo, not in a drawer, so it must
  //                                     NOT become a "hand back in person" -- it is reported instead
  //   collected by staff in person   -> manual hand-back (the only money staff can hand back)
  const allot = (cap) => {
    const amt = Math.min(remaining, Math.max(0, cap));
    remaining -= amt;
    return amt;
  };

  // 1. the first payment (the deposit, or the whole amount for a Full payment)
  const depositCap = Math.max(0, b.depositCollected - withheld);
  if (depositCap > 0 && remaining > 0) {
    const amt = allot(depositCap);
    if (amt > 0) {
      if (refundableOnlyByHand(payment, "deposit")) { manualAmount += amt; qrphAmount += amt; }   // QR Ph: hand back, PayMongo refuses it
      else if (ids.deposit)                     parts.push({ kind: "deposit", paymongoPaymentID: ids.deposit, amount: amt });
      else if (depositWasOnline(payment, ids))  unrefundable.push({ kind: "deposit", amount: amt, reason: "payment_id_missing" });
      else                                      manualAmount += amt; // taken in cash / by staff
    }
  }
  // 2. the balance, when it was paid online
  if (b.balanceOnline > 0 && remaining > 0) {
    const amt = allot(b.balanceOnline);
    if (amt > 0) {
      if (refundableOnlyByHand(payment, "balance")) { manualAmount += amt; qrphAmount += amt; }   // QR Ph: hand back
      else if (ids.balance) parts.push({ kind: "balance", paymongoPaymentID: ids.balance, amount: amt });
      else             unrefundable.push({ kind: "balance", amount: amt, reason: "payment_id_missing" });
    }
  }
  // 3. the balance, when staff collected it in person
  if (b.balanceInPerson > 0 && remaining > 0) manualAmount += allot(b.balanceInPerson);
  // Anything the buckets can't explain (rounding, very old records) keeps the old behaviour: staff hand it back.
  if (remaining > 0) { manualAmount += remaining; remaining = 0; }

  const unrefundableAmount = unrefundable.reduce((s, u) => s + u.amount, 0);
  // total = what can actually be returned (parts + manual). The unrefundable amount is NOT promised to the customer.
  return {
    total: paid - withheld - unrefundableAmount,
    grossPaid: paid, heldCredit, forfeit, gatewayFeeKept, parts, manualAmount, qrphAmount,
    channels: { deposit: channelOfPhase(payment, "deposit") || null, balance: channelOfPhase(payment, "balance") || null },
    unrefundable, unrefundableAmount, breakdown: b,
  };
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
//   payment.securityDeposit (snapshotted on the payment at booking time)
//   → payment.deposit.amount  (old nested deposit object, until it is migrated away)
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
// "Booked by mistake" grace: a refund asked within this many hours of the deposit being paid gets the deposit back
// even when pickup is under REFUND_FULL_WINDOW_HOURS away. It never applies once the pickup time has passed (no-show).
const REFUND_GRACE_HOURS = 2;
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
  return num(p.securityDeposit) || num(p.deposit && p.deposit.amount) || num(p.depositFee);
};

const getRefundPolicy = (payment, { pickupAt, requestedAt, waiveForfeit = false, bookedAt = null } = {}) => {
  const pickup    = toDate(pickupAt);
  const requested = toDate(requestedAt);
  const depositAmount = getDepositAmount(payment);
  const amountPaid    = getPaymentBreakdown(payment).amountPaid;

  // Can't judge the timing without both timestamps → fail OPEN (full refund)
  // and say so, so staff can see why and decide.
  if (!pickup || !requested) {
    return { tier: "full", hoursBeforePickup: null, depositAmount, forfeit: 0, gatewayFeeKept: 0, waived: false, unknownTiming: true, windowHours: REFUND_FULL_WINDOW_HOURS };
  }

  const hoursBeforePickup = (pickup.getTime() - requested.getTime()) / HOUR_MS;
  const tier = hoursBeforePickup >= REFUND_FULL_WINDOW_HOURS ? "full"
             : hoursBeforePickup >= 0                        ? "late"
             :                                                 "no_show";

  // Grace: the customer asks soon after paying (bookedAt = when the deposit was paid, else when the booking was
  // made) and the pickup hasn't passed. Unknown bookedAt means no grace.
  const booked = toDate(bookedAt);
  const hoursSinceBooked = booked ? (requested.getTime() - booked.getTime()) / HOUR_MS : null;
  const graceApplied = tier === "late" && hoursSinceBooked !== null && hoursSinceBooked >= 0 && hoursSinceBooked < REFUND_GRACE_HOURS;

  const wouldForfeit = (tier === "full" || graceApplied) ? 0 : Math.min(depositAmount, amountPaid);
  const forfeit = waiveForfeit ? 0 : wouldForfeit;

  // The deposit goes back (full tier, or the 2-hour grace) -> the gateway fee is kept. A staff waiver keeps neither.
  const depositReturned = (tier === "full" || graceApplied) && !waiveForfeit;
  const gatewayFeeKept = depositReturned ? getGatewayFeeShare(payment) : 0;

  return {
    graceApplied,
    gatewayFeeKept,
    graceHours: REFUND_GRACE_HOURS,
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

// The same policy from the stored verdict instead of timestamps. refundRequests keep ONE fact about the 48-hour rule,
// returnDeposit: true = the deposit goes back (asked 48h or more before pickup), false = it is kept (asked later, or
// after the pickup). A missing value is not judged here (callers treat it as a full refund). The late / no-show
// split is not kept: both are "late" here.
const getRefundPolicyFromFlag = (payment, { returnDeposit, waiveForfeit = false, gatewayFeeKept = 0 } = {}) => {
  const depositAmount = getDepositAmount(payment);
  const amountPaid    = getPaymentBreakdown(payment).amountPaid;
  const keep = returnDeposit === false;
  const wouldForfeit = keep ? Math.min(depositAmount, amountPaid) : 0;
  return {
    tier: keep ? "late" : "full",
    hoursBeforePickup: null,
    depositAmount,
    // The request stores the gateway fee that was kept when it was made (0 on requests made before this rule existed),
    // so approving later never changes the amount the customer was shown.
    gatewayFeeKept: keep || waiveForfeit ? 0 : Math.max(0, num(gatewayFeeKept)),
    forfeit: waiveForfeit ? 0 : wouldForfeit,
    waived: !!waiveForfeit && wouldForfeit > 0,
    waivedAmount: waiveForfeit ? wouldForfeit : 0,
    unknownTiming: false,
    fromFlag: true,
    windowHours: REFUND_FULL_WINDOW_HOURS,
  };
};

// Policy + plan in one call: what a refund requested at `requestedAt` is worth.
const computeRefundQuote = (payment, { pickupAt, requestedAt, waiveForfeit = false, bookedAt = null } = {}) => {
  const policy = getRefundPolicy(payment, { pickupAt, requestedAt, waiveForfeit, bookedAt });
  const plan   = computeRefundPlan(payment, { forfeit: policy.forfeit, gatewayFeeKept: policy.gatewayFeeKept });
  return { policy, plan };
};

module.exports = { PAYMENT_ID_MISSING_NOTE, depositWasOnline, getPaymentBreakdown, resolvePaymongoIDs, computeRefundPlan, getGatewayFeeShare, getRefundPolicy, getRefundPolicyFromFlag, computeRefundQuote, getDepositAmount, resolvePickupAt, payTypeOf, REFUND_FULL_WINDOW_HOURS, REFUND_GRACE_HOURS };
// GENERATED from arltrack-admin-backend/services/payments/discountLedger.js -- DO NOT EDIT BY HAND.
// Change the admin file, then copy it here again (only the `export` keywords change to module.exports).
// ─────────────────────────────────────────────────────────────────────────────
// Staff discounts — SINGLE SOURCE OF TRUTH for how a discount moves (admin backend).
// Pure functions only (no Firestore, no imports), so they are trivially testable and can be copied to the
// customer backend unchanged, the same way depositView.js / paymentBreakdown.js are.
//
// THE MODEL
// A discount is money the customer does not have to pay. When it is given there are two cases:
//
//   • the payment is still PARTIAL  -> it comes off the remaining balance. Nothing was paid yet, so nothing is owed
//                                      back:                                   discountApplied += amount
//   • the payment is FULLY PAID     -> the customer has already paid it, so it is HELD for them and returned with
//                                      the security deposit when the trip is settled:   discountCredit += amount
//
// The held credit then moves on in one of two ways:
//   • a penalty is paid from it (right away if one is unpaid, otherwise at settlement): credit -= x, applied += x
//   • at settlement what is left goes back to the customer, as its own payout: credit -> 0, returned += credit
//   • the booking is CANCELLED (a refund request is approved, or staff cancel and refund): the credit is money the
//     customer paid, so it goes back INSIDE that refund (the refund plan counts it), with no payout of its own:
//     credit -> 0, returned += credit, and one internal row (discount_in_refund) says so. The cash is in the refund's rows.
//
// Fields on payments/{paymentID} (written together, in the same transaction as the ledger row they describe):
//   discountAmount    total discount given, across every discount given on this booking (a running total)
//   discountApplied   the part that was USED: it came off the balance or paid penalties (the rows tell which)
//   discountCredit    the part still held for the customer (the only one that drains)
//   discountReturned  the part that went back to the customer
//   → discountAmount === discountApplied + discountCredit + discountReturned
// Who gave a discount and when is on its ledger row (processedBy / processedAt). Its reason is not stored on the
// payment or the row: it is in the activity log.
//
// A payment WITHOUT discountApplied is a "legacy" discount (given before this model, refunded on the spot):
// it keeps its old behaviour everywhere and cannot be added to.
//
// Ledger rows live in paymentEntries (see models/paymentEntries/paymentEntry.model.js):
//   internal (no cash)  discount_applied_balance · discount_credit · discount_applied_penalty · discount_in_refund
//   out (real money)    discount_return -- the credit paid back. Its OWN payout, separate from deposit_return: same
//                       way of returning (in store, or its own PayMongo refund), its own status, retry and hand-back.
// ─────────────────────────────────────────────────────────────────────────────

const num = (v) => { const n = Number(v); return Number.isFinite(n) ? n : 0; };
const round2 = (n) => Math.round(num(n) * 100) / 100;
const lower = (v) => String(v == null ? "" : v).trim().toLowerCase();

const DISCOUNT_PHASES = Object.freeze({
  credit: "discount_credit",
  appliedBalance: "discount_applied_balance",
  appliedPenalty: "discount_applied_penalty",
  return: "discount_return",
  inRefund: "discount_in_refund",   // internal: the held credit went back INSIDE a cancellation refund (no cash of its own)
});
const DISCOUNT_ROW_PHASES = Object.freeze(Object.values(DISCOUNT_PHASES));

/** True once a payment carries the new fields (every new-style discount writes all of them together). */
const hasDiscountLedger = (p) => !!p && p.discountApplied !== undefined && p.discountApplied !== null;

/** True for a discount given before the ledger existed: refunded on the spot, never added to. */
const hasLegacyDiscount = (p) => !!p && num(p.discountAmount) > 0 && !hasDiscountLedger(p);

/** The discount's figures. Legacy / no discount: only `total` is meaningful. */
const getDiscountFigures = (p) => {
  const total = round2(p && p.discountAmount);
  if (!hasDiscountLedger(p)) return { ledger: false, total, applied: 0, credit: 0, returned: 0 };
  return { ledger: true, total, applied: round2(p.discountApplied), credit: round2(p.discountCredit), returned: round2(p.discountReturned) };
};

/** The identity every ledger discount must satisfy. */
const figuresBalance = (f) =>
  !f.ledger || Math.abs(f.total - (f.applied + f.credit + f.returned)) < 0.005;

/**
 * Where the discount stands, for staff. Derived from the figures, never stored.
 *   none            no discount
 *   legacy          given before the ledger (refunded on the spot): see deriveDiscountRefund
 *   applied         fully used (on the balance and / or penalties): nothing is owed back
 *   held            credit is held for the customer, nothing returned yet
 *   partly_returned some credit went back, some is still held
 *   returned        every peso of credit went back
 */
const discountStatusOf = (f) => {
  if (!(f.total > 0)) return "none";
  if (!f.ledger) return "legacy";
  if (f.credit > 0 && f.returned > 0) return "partly_returned";
  if (f.credit > 0) return "held";
  if (f.returned > 0) return "returned";
  return "applied";
};

// ── giving a discount ───────────────────────────────────────────────────────────────────────────────────────

/**
 * How much more discount could be given right now, and where it would go. Pure.
 *   totalFee      the booking's grand total
 *   grossPaid     what the customer has paid in total, BEFORE any discount
 *   balance       what is still owed after the discounts already given
 *   given         total of the discounts already given (0 for the first)
 *   depositStatus the security deposit's status ("Held" | "Settled" | ... | null when none was recorded)
 *   legacy        a discount given under the old rules is on the payment
 * Returns { kind: "balance" | "credit", max, blocked } -- `blocked` is the reason no discount can be given, or null.
 */
const discountRoom = ({ totalFee, grossPaid, balance, given = 0, depositStatus = null, legacy = false }) => {
  const bal = Math.max(0, round2(balance));
  const kind = bal > 0 ? "balance" : "credit";
  const max = kind === "balance"
    ? bal
    : Math.max(0, round2(Math.min(num(totalFee), num(grossPaid)) - num(given)));
  let blocked = null;
  if (legacy) blocked = "A discount was already given on this booking under the old rules, so it can't be changed or added to.";
  else if (lower(depositStatus) === "settled") blocked = "The security deposit has already been settled, so a discount can't be given any more.";
  else if (kind === "credit" && lower(depositStatus) !== "held") blocked = "This booking is fully paid and has no held security deposit to return the discount with, so a discount can't be given.";
  else if (!(max > 0)) blocked = "No more discount can be given on this booking: the discounts already given add up to everything the customer paid.";
  return { kind, max: blocked ? 0 : max, blocked };
};

/**
 * Can this discount be given, and where does it go?  Pure.  Same inputs as discountRoom, plus `amount`.
 * Returns { ok: true, kind, max } or { ok: false, error, max }.
 */
const planNewDiscount = ({ amount, ...room }) => {
  const a = round2(amount);
  const peso = (n) => `₱${round2(n).toLocaleString()}`;
  const r = discountRoom(room);
  if (r.blocked) return { ok: false, max: 0, error: r.blocked };
  if (!Number.isFinite(Number(amount)) || !(a > 0)) return { ok: false, max: r.max, error: "Enter a discount greater than ₱0." };
  if (a > r.max) {
    return {
      ok: false, max: r.max,
      error: r.kind === "balance"
        ? `A discount on a partial payment can't be more than the remaining balance of ${peso(r.max)}.`
        : `The discount can't be more than ${peso(r.max)} (all the discounts together can't go past what the customer paid).`,
    };
  }
  return { ok: true, kind: r.kind, max: r.max };
};

/** The figures after a new discount of `amount` has been given as `kind`. */
const applyNewDiscount = (p, kind, amount) => {
  const f = getDiscountFigures(p);
  const a = round2(amount);
  return {
    discountAmount: round2(f.total + a),
    discountApplied: round2(f.applied + (kind === "balance" ? a : 0)),
    discountCredit: round2(f.credit + (kind === "credit" ? a : 0)),
    discountReturned: f.returned,
  };
};

// ── a penalty drawing from the held credit ──────────────────────────────────────────────────────────────────

/** How much of `owed` the held credit can pay. */
const creditDrawFor = (p, owed) => Math.max(0, round2(Math.min(num(owed), getDiscountFigures(p).credit)));

/** The figures after `amount` of the held credit paid a penalty. */
const applyCreditToPenalty = (p, amount) => {
  const f = getDiscountFigures(p);
  const a = Math.min(round2(amount), f.credit);
  return {
    discountAmount: f.total,
    discountApplied: round2(f.applied + a),
    discountCredit: round2(f.credit - a),
    discountReturned: f.returned,
  };
};

// ── settlement ──────────────────────────────────────────────────────────────────────────────────────────────

/**
 * What settling the booking does with the deposit, the penalties and the held credit. Pure.
 *   depositAmount   the security deposit
 *   alreadyApplied  the part of it already used when penalties were confirmed
 *   penalties       the unpaid confirmed penalties, oldest first: [{ id, owed }]
 *   credit          the discount credit still held
 * Each penalty is paid from the deposit first, then from the credit; whatever is left stays owed.
 *   → { perPenalty: [{ id, owed, fromDeposit, fromCredit, stillOwed }],
 *       depositUsed, creditUsed, depositNet, depositReturn, creditReturn, payout, stillOwed, net, confirmedPenaltyTotal }
 *   depositReturn and creditReturn go back as TWO payouts (deposit_return and discount_return); `payout` is their sum.
 *   net    = payout − stillOwed (negative = the customer still owes money).
 */
const planSettlement = ({ depositAmount, alreadyApplied = 0, penalties = [], credit = 0 }) => {
  let depositLeft = round2(num(depositAmount) - num(alreadyApplied));
  let creditLeft = round2(Math.max(0, num(credit)));
  const perPenalty = [];
  let confirmedPenaltyTotal = 0;
  let depositUsed = 0;
  let creditUsed = 0;
  for (const p of penalties) {
    const owed = round2(p.owed);
    confirmedPenaltyTotal = round2(confirmedPenaltyTotal + owed);
    const fromDeposit = round2(Math.max(0, Math.min(depositLeft, owed)));
    depositLeft = round2(depositLeft - fromDeposit);
    const fromCredit = round2(Math.max(0, Math.min(creditLeft, owed - fromDeposit)));
    creditLeft = round2(creditLeft - fromCredit);
    depositUsed = round2(depositUsed + fromDeposit);
    creditUsed = round2(creditUsed + fromCredit);
    perPenalty.push({ id: p.id, owed, fromDeposit, fromCredit, stillOwed: round2(owed - fromDeposit - fromCredit) });
  }
  const depositNet = round2(num(depositAmount) - num(alreadyApplied) - confirmedPenaltyTotal);   // can be negative
  const depositReturn = Math.max(0, depositNet);
  const creditReturn = creditLeft;
  const stillOwed = round2(perPenalty.reduce((s, x) => s + x.stillOwed, 0));
  const payout = round2(depositReturn + creditReturn);
  return {
    perPenalty, depositUsed, creditUsed, depositNet, depositReturn, creditReturn, payout, stillOwed,
    net: round2(payout - stillOwed), confirmedPenaltyTotal,
  };
};

/**
 * The figures after the held credit went back INSIDE a cancellation refund: all of it moves from `credit` to `returned`.
 * (The refund plan counts the credit as paid money -- see computeRefundPlan -- so no payout of its own is needed.)
 */
const closeCreditInRefund = (p) => {
  const f = getDiscountFigures(p);
  return {
    discountAmount: f.total,
    discountApplied: f.applied,
    discountCredit: 0,
    discountReturned: round2(f.returned + f.credit),
  };
};

/** The figures after settlement: the credit that went back moves from `credit` to `returned`, the rest was used on penalties. */
const applySettlement = (p, plan) => {
  const f = getDiscountFigures(p);
  return {
    discountAmount: f.total,
    discountApplied: round2(f.applied + plan.creditUsed),
    discountCredit: 0,
    discountReturned: round2(f.returned + plan.creditReturn),
  };
};

// ── reading the ledger rows ─────────────────────────────────────────────────────────────────────────────────

const millis = (d) => {
  const v = d && d.toDate ? d.toDate() : d ? new Date(d) : null;
  return v && !isNaN(v) ? v.getTime() : 0;
};
const iso = (d) => {
  const v = d && d.toDate ? d.toDate() : d ? new Date(d) : null;
  return v && !isNaN(v) ? v.toISOString() : null;
};
// The ledger rows: the three no-cash "internal" ones (only when they succeeded) and the real-money discount_return payout
// (whatever its status: it is how the credit went back, and a failed attempt is history too).
const isLedgerRow = (e) => !!e && (
  (e.direction === "internal" && [DISCOUNT_PHASES.credit, DISCOUNT_PHASES.appliedBalance, DISCOUNT_PHASES.appliedPenalty, DISCOUNT_PHASES.inRefund].includes(e.phase) && lower(e.status) === "success") ||
  (e.direction === "out" && e.phase === DISCOUNT_PHASES.return)
);
const byTime = (a, b) => millis(a.createdAt || a.processedAt) - millis(b.createdAt || b.processedAt)
  || String(a.id || a.paymentEntryID).localeCompare(String(b.id || b.paymentEntryID));
const returnRows = (entries) => (entries || []).filter((e) => e && e.direction === "out" && e.phase === DISCOUNT_PHASES.return).sort(byTime);

/** The discount's history, oldest first: one item per ledger row. */
const listDiscountEvents = (entries = []) =>
  (entries || []).filter(isLedgerRow).sort(byTime).map((e) => ({
    id: e.id || e.paymentEntryID,
    kind: e.phase === DISCOUNT_PHASES.appliedBalance ? "balance"
        : e.phase === DISCOUNT_PHASES.credit ? "credit"
        : e.phase === DISCOUNT_PHASES.appliedPenalty ? "penalty"
        : e.phase === DISCOUNT_PHASES.inRefund ? "refund" : "return",
    phase: e.phase,
    amount: round2(e.amount),
    status: lower(e.status),
    penaltyID: e.penaltyID || null,
    by: e.processedBy || null,
    at: iso(e.processedAt || e.createdAt),
  }));

/**
 * Where the credit's payout stands: the newest discount_return row decides (a retry or an in-store hand-back writes a
 * newer one that supersedes a failed one).
 *   null | { state: "processing" | "returned" | "failed", amount, via, method, referenceNumber, errorNote, at }
 */
const deriveCreditReturn = (entries = []) => {
  const rows = returnRows(entries);
  if (!rows.length) return null;
  const latest = rows[rows.length - 1];
  const st = lower(latest.status);
  return {
    state: st === "success" ? "returned" : st === "failed" ? "failed" : "processing",
    amount: round2(latest.amount),
    via: latest.source === "online" ? "paymongo" : "in_store",
    method: latest.method || null,
    referenceNumber: latest.referenceNumber || null,
    errorNote: latest.transactionErrorNote || null,
    at: iso(latest.settledAt || latest.processedAt || latest.createdAt),
  };
};

/**
 * The figures rebuilt from the ledger rows alone — used to prove the stored fields have not drifted.
 * The credit is returned ONCE, at settlement; every retry or hand-back repeats the same amount, so the newest
 * discount_return row (whatever its status) is the amount that was returned. `appliedBalance` / `appliedPenalty` are for
 * display: the stored field is their sum.
 */
const rebuildFiguresFromEntries = (entries = []) => {
  const rows = (entries || []).filter(isLedgerRow);
  const sum = (phase) => round2(rows.filter((r) => r.phase === phase).reduce((s, r) => s + num(r.amount), 0));
  const creditGiven = sum(DISCOUNT_PHASES.credit);
  const appliedBalance = sum(DISCOUNT_PHASES.appliedBalance);
  const appliedPenalty = sum(DISCOUNT_PHASES.appliedPenalty);
  const returnedInRefund = sum(DISCOUNT_PHASES.inRefund);   // went back inside a cancellation refund
  const rr = returnRows(entries);
  const returned = round2((rr.length ? num(rr[rr.length - 1].amount) : 0) + returnedInRefund);
  return {
    total: round2(appliedBalance + creditGiven),
    applied: round2(appliedBalance + appliedPenalty),
    appliedBalance, appliedPenalty, returned, returnedInRefund,
    credit: round2(creditGiven - appliedPenalty - returned),
  };
};

/** { ok, problems[] } — the stored figures must add up AND match the rows. Legacy / no-discount payments are always ok. */
const checkDiscountLedger = (p, entries = []) => {
  const f = getDiscountFigures(p);
  if (!f.ledger) return { ok: true, problems: [] };
  const problems = [];
  if (!figuresBalance(f)) problems.push("The discount's parts don't add up to the total given.");
  const r = rebuildFiguresFromEntries(entries);
  const same = (k, label) => { if (Math.abs(f[k] - r[k]) >= 0.005) problems.push(`${label} is ₱${f[k]} on the payment but ₱${r[k]} on the ledger rows.`); };
  same("total", "The total discount");
  same("applied", "The part used (off the balance or on penalties)");
  same("credit", "The held credit");
  same("returned", "The part returned");
  return { ok: problems.length === 0, problems };
};

/**
 * Everything the screens need about a payment's discount, in one object. `entries` = the payment's paymentEntries rows.
 *   { total, applied, appliedBalance, appliedPenalty, credit, returned, status, ledger, creditReturn, events[], consistent, problems[] }
 * null when no discount was ever given.
 */
const getDiscountView = (p, entries = []) => {
  const f = getDiscountFigures(p);
  if (!(f.total > 0)) return null;
  const check = checkDiscountLedger(p, entries);
  const rebuilt = f.ledger ? rebuildFiguresFromEntries(entries) : null;
  return {
    ...f,
    // for display: how the used part splits (the payment stores only the sum)
    appliedBalance: rebuilt ? rebuilt.appliedBalance : 0,
    appliedPenalty: rebuilt ? rebuilt.appliedPenalty : 0,
    returnedInRefund: rebuilt ? rebuilt.returnedInRefund : 0,   // part of `returned` that went back inside a cancellation refund
    status: discountStatusOf(f),
    creditReturn: f.ledger ? deriveCreditReturn(entries) : null,
    events: f.ledger ? listDiscountEvents(entries) : [],
    consistent: check.ok,
    problems: check.problems,
  };
};

module.exports = { DISCOUNT_PHASES, DISCOUNT_ROW_PHASES, hasDiscountLedger, hasLegacyDiscount, getDiscountFigures, figuresBalance, discountStatusOf, discountRoom, planNewDiscount, applyNewDiscount, creditDrawFor, applyCreditToPenalty, planSettlement, closeCreditInRefund, applySettlement, listDiscountEvents, deriveCreditReturn, rebuildFiguresFromEntries, checkDiscountLedger, getDiscountView };

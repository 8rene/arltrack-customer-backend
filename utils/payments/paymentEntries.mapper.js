// GENERATED from arltrack-admin-backend/services/paymentEntries/paymentEntries.mapper.js -- DO NOT EDIT BY HAND.
// Change the admin file, then run: node scripts/build-customer-payment-entries.mjs <this repo>
// paymentEntries mapper -- PURE functions only (no Firestore), so they are testable.
//
// KEEP IN SYNC with arltrack-customer-backend/utils/payments/paymentEntries.mapper.js
// (generated copy -- the two apps deploy separately, so it can't be a shared import).
// If you change one, change the other.
//
// What lives here:
//   buildPaymentEntries     legacy payments doc  -> deposit / balance "in" rows
//   buildLegacyPenaltyEntry legacy penalties doc -> one aggregate row (or a review reason)
//   buildPenaltyPaymentEntry a NEW penalty payment -> row (used by recordShortfallPayment)
//   mergeEntry              how a re-derived row is applied over an existing one
//   hydratePayment / hydratePenalty  rows -> the OLD field names, so readers don't change
//   buildRefundEntries      refundRequests doc -> "out" rows (online parts, manual hand-back, unrefundable)
//   mergeRefundEntry / hydrateRefundRequest  same two jobs, for refund rows
const { getPaymentBreakdown, resolvePaymongoIDs, payTypeOf, PAYMENT_ID_MISSING_NOTE } = require("./paymentBreakdown.util");

// ── small helpers ───────────────────────────────────────────────────────────
const low = (v) => String(v ?? "").trim().toLowerCase();
const num = (v) => { const n = Number(v); return Number.isFinite(n) ? n : 0; };
const orNull = (v) => (v === undefined ? null : v);

const SENTINELS = new Set(["", "—", "-", "n/a", "na", "none", "null", "undefined"]);

/** "N/A", "—", "" and friends -> null. Anything else -> the trimmed string. */
const nullIfSentinel = (v) => {
  if (v === null || v === undefined) return null;
  const s = String(v).trim();
  return SENTINELS.has(s.toLowerCase()) ? null : s;
};

// Old free-text labels -> the method codes. Staff-typed labels ("Bank Transfer",
// "InStore", "paymaya" ...) all land on one code.
const METHOD_MAP = {
  gcash: "gcash",
  maya: "maya", paymaya: "maya",
  qrph: "qrph",
  cash: "cash", instore: "cash",
  banktransfer: "bank_transfer", bank: "bank_transfer",
};
// Labels that are known NOT to be a method (so they don't count as "unmapped").
const NON_METHODS = new Set(["paymongo", "online", "deposit", "depositpartial"]);

/** -> { method, unmapped }.  method is a code or null; unmapped is the raw text if unknown. */
const normalizeMethod = (raw) => {
  const s = nullIfSentinel(raw);
  if (!s) return { method: null, unmapped: null };
  const key = s.toLowerCase().replace(/[\s_-]/g, "");
  if (METHOD_MAP[key]) return { method: METHOD_MAP[key], unmapped: null };
  if (NON_METHODS.has(key)) return { method: null, unmapped: null };
  return { method: null, unmapped: s };
};

// Method code -> the labels the OLD fields used (for hydrate).
const BALANCE_METHOD_LABEL = { cash: "Cash", gcash: "GCash", maya: "Maya", qrph: "QRPH", bank_transfer: "Bank Transfer" };
const PENALTY_METHOD_LABEL = { cash: "InStore", gcash: "GCash", maya: "Maya", bank_transfer: "BankTransfer" };
const LEGACY_CHANNEL       = { gcash: "gcash", maya: "paymaya", qrph: "qrph" }; // paymongoChannel values

/** Old status text -> entry status. A refunded payment WAS paid; the refund is its own "out" row (STEP 2). */
const statusFromLegacy = (raw) => {
  const s = low(raw);
  if (["paid", "approved", "refunded", "success"].includes(s)) return "success";
  if (["failed", "rejected"].includes(s)) return "failed";
  if (["cancelled", "canceled"].includes(s)) return "cancelled";
  return "pending";
};

const entryIDFor = (paymentID, phase) => `${paymentID}_${phase}`;

// ── payments -> deposit / balance entries ───────────────────────────────────
/**
 * Derives the entries for ONE legacy payment doc from the fields (and the old
 * paymongoTransactions array) that are always written. Deterministic: the same
 * doc always yields the same ids, so running it again only updates.
 *
 * Returns { entries, skipped } -- skipped = [{ phase, reason }] for things that
 * never actually happened (a deposit checkout never started, a balance never due).
 */
const buildPaymentEntries = (p, docID, opts = {}) => {
  p = p || {};
  const now = opts.now || new Date();
  const paymentID = p.paymentID || docID;
  const ids = resolvePaymongoIDs(p);
  const payType = payTypeOf(p);
  const amount = num(p.amount);
  const arr = Array.isArray(p.paymongoTransactions) ? p.paymongoTransactions : [];
  const arrOf = (phase) => arr.find((t) => t && t.phase === phase) || null;

  // What each phase is worth, whether or not it has been paid yet.
  const expectedDeposit = getPaymentBreakdown({ ...p, status: "paid", balanceStatus: "", balanceCollected: false, discountAmount: 0 }).depositCollected;
  const expectedBalance = Math.max(0, amount - expectedDeposit);

  // The PayMongo checkout session belongs to whichever phase was started last.
  const sessionPhase = low(p.currentPhase) === "balance" ? "balance" : "deposit";
  const sessionOf = (phase) => (sessionPhase === phase ? nullIfSentinel(p.paymongoSessionID) : null);

  const common = (phase) => ({
    paymentEntryID: entryIDFor(paymentID, phase),
    paymentID,
    bookingID: p.bookingID || null,
    userID: p.userID || null,
    refundReqID: null,
    penaltyID: null,
    direction: "in",
    phase,
    groupID: null,
    transactionErrorNote: null,
    updatedAt: now,
  });

  const entries = [];
  const skipped = [];

  // ── deposit (or the single payment for Full) ──
  const depStatusRaw = low(p.status);
  const depStarted =
    ["paid", "approved", "refunded", "failed", "rejected", "cancelled", "canceled"].includes(depStatusRaw) ||
    !!ids.deposit || !!nullIfSentinel(p.paymongoChannel) || !!nullIfSentinel(p.paymongoSessionID);

  if (!depStarted) {
    skipped.push({ phase: "deposit", reason: "not_started" });
  } else {
    // Online unless the evidence says staff took it: no pay_ id, no channel, and
    // either already paid or confirmed by staff.
    const online = !!(
      ids.deposit ||
      nullIfSentinel(p.paymongoChannel) ||
      (nullIfSentinel(p.paymongoSessionID) && !nullIfSentinel(p.confirmedBy)) ||
      !["paid", "approved", "refunded"].includes(depStatusRaw)
    );
    const status = statusFromLegacy(p.status);
    const m = normalizeMethod(online ? p.paymongoChannel : p.paymentMethod);
    entries.push({
      ...common("deposit"),
      source: online ? "online" : "in_person",
      method: m.method,
      amount: expectedDeposit,
      status,
      referenceNumber: online ? (ids.deposit || null) : null,
      sessionID: online ? sessionOf("deposit") : null,
      transactionFee: online ? orNull(p.depositPaymongoFee) : null,
      processedBy: online ? null : nullIfSentinel(p.confirmedBy),
      processedAt: online ? null : orNull(p.confirmedAt),
      settledAt: status === "success" ? (orNull(p.paidAt) || orNull(p.confirmedAt) || null) : null,
      createdAt: p.createdAt || now,
    });
  }

  // ── balance (Partial / Downpayment only) ──
  if (payType === "Full" || expectedBalance <= 0) {
    skipped.push({ phase: "balance", reason: "no_balance_phase" });
  } else if (p.balanceCollected) {
    // Staff collected it in person -- never touched PayMongo.
    const rec = p.balanceCollectedAmount;
    const recorded = rec !== null && rec !== undefined && Number.isFinite(Number(rec));
    const m = normalizeMethod(p.balanceMethod);
    entries.push({
      ...common("balance"),
      source: "in_person",
      method: m.method,
      amount: recorded ? Number(rec) : expectedBalance,
      status: "success",
      referenceNumber: null,
      sessionID: null,
      transactionFee: null,
      processedBy: nullIfSentinel(p.balanceCollectedBy),
      processedAt: orNull(p.balanceCollectedAt),
      settledAt: orNull(p.balanceCollectedAt),
      createdAt: p.balanceCollectedAt || p.createdAt || now,
    });
  } else {
    const bs = low(p.balanceStatus);
    if (!["paid", "pending", "failed", "cancelled", "canceled"].includes(bs)) {
      skipped.push({ phase: "balance", reason: "not_due" });
    } else {
      const status = statusFromLegacy(bs);
      const m = normalizeMethod(ids.balance || bs === "pending" ? p.paymongoChannel : null);
      const fromArr = num(arrOf("balance") && arrOf("balance").amount);   // what the checkout really charged
      entries.push({
        ...common("balance"),
        source: "online",
        method: m.method,
        amount: fromArr || num(p.balanceAmount) || expectedBalance,
        status,
        referenceNumber: ids.balance || null,
        sessionID: sessionOf("balance"),
        transactionFee: orNull(p.balancePaymongoFee),
        processedBy: null,
        processedAt: null,
        settledAt: status === "success" ? (orNull(p.balancePaidAt) || null) : null,
        createdAt: p.balancePaidAt || p.updatedAt || now,
      });
    }
  }
  return { entries, skipped };
};

// ── penalties ───────────────────────────────────────────────────────────────
/**
 * One OLD penalty doc -> at most one "legacy_aggregate" row.
 *
 * Old penalty rows only kept the LAST payment's method / reference / date (each
 * payment overwrote them), so earlier installments are not recoverable: one row
 * for the total paidAmount, flagged. New payments get a proper row each.
 *
 * Returns { entry } or { review } (a reason it was NOT converted) or {} (nothing paid).
 *   deposit_offset   paid entirely from the held deposit: no money moved -> no row
 *   deposit_involved the booking's deposit was settled, so part of paidAmount came from
 *                    the deposit and can't be split per penalty -> staff review, no guess
 */
const buildLegacyPenaltyEntry = (pen, docID, payment, opts = {}) => {
  pen = pen || {};
  const now = opts.now || new Date();
  const paid = num(pen.paidAmount);
  if (paid <= 0) return {};
  const methodKey = low(pen.paymentMethod).replace(/[\s_-]/g, "");
  if (methodKey === "deposit") return { review: "deposit_offset" };
  if (methodKey === "depositpartial") return { review: "deposit_involved" };
  const settled = payment && payment.deposit && payment.deposit.settlement && payment.deposit.settlement.status;
  if (settled) return { review: "deposit_involved" };

  const penaltyID = pen.penaltyID || docID;
  const online = methodKey === "paymongo";
  const m = normalizeMethod(pen.paymentMethod);
  return {
    entry: {
      paymentEntryID: `${penaltyID}_legacy`,
      paymentID: pen.paymentID || null,
      bookingID: pen.bookingID || null,
      userID: pen.userID || null,
      refundReqID: null,
      penaltyID,
      direction: "in",
      phase: "penalty",
      source: online ? "online" : "in_person",
      method: m.method,
      amount: paid,
      status: "success",
      referenceNumber: nullIfSentinel(pen.referenceNumber),
      sessionID: null,
      transactionFee: null,
      processedBy: null,
      processedAt: null,
      settledAt: orNull(pen.paidAt),
      groupID: null,
      transactionErrorNote: null,
      createdAt: pen.paidAt || pen.updatedAt || pen.createdAt || now,
      updatedAt: now,
    },
  };
};

/** A NEW penalty payment (recordShortfallPayment): one row per penalty covered, sharing groupID. */
const buildPenaltyPaymentEntry = ({ penalty, penaltyID, amount, method, referenceNumber, processedBy, groupID, now }) => {
  const at = now || new Date();
  const m = normalizeMethod(method);
  const online = low(method).replace(/[\s_-]/g, "") === "paymongo";
  return {
    paymentID: (penalty && penalty.paymentID) || null,
    bookingID: (penalty && penalty.bookingID) || null,
    userID: (penalty && penalty.userID) || null,
    refundReqID: null,
    penaltyID,
    direction: "in",
    phase: "penalty",
    source: online ? "online" : "in_person",
    method: m.method,
    amount: num(amount),
    status: "success",
    referenceNumber: nullIfSentinel(referenceNumber),
    sessionID: null,
    transactionFee: null,
    processedBy: nullIfSentinel(processedBy),
    processedAt: at,
    settledAt: at,
    groupID: groupID || null,
    transactionErrorNote: null,
    createdAt: at,
    updatedAt: at,
  };
};

// ── applying a re-derived row over an existing one ──────────────────────────
/**
 * Returns what to write: the whole row when it doesn't exist yet, a patch when it
 * does, or null when nothing should change.
 *  - createdAt / paymentEntryID of an existing row are never touched
 *  - a "success" row is never downgraded by a late pending/failed/cancelled event
 *    (same rule the old upsertTransaction had) unless opts.force (a deliberate manual change)
 */
const mergeEntry = (existing, built, opts = {}) => {
  if (!existing) return built;
  if (!opts.force && existing.status === "success" && built.status !== "success") return null;
  const next = { ...built };
  delete next.createdAt;
  delete next.paymentEntryID;
  return next;
};

// ── read-compat: rows -> the OLD field names ────────────────────────────────
const tsMillis = (v) => {
  if (!v) return 0;
  if (typeof v.toMillis === "function") return v.toMillis();
  if (v._seconds !== undefined) return v._seconds * 1000;
  const d = new Date(v);
  return isNaN(d.getTime()) ? 0 : d.getTime();
};
const latestOf = (rows) =>
  [...rows].sort((a, b) => (tsMillis(b.settledAt || b.createdAt)) - (tsMillis(a.settledAt || a.createdAt)))[0] || null;

/** The row that best represents a phase: latest successful one, else latest of any status. */
const pickEntry = (rows, phase) => {
  const of = rows.filter((e) => e.direction !== "out" && e.phase === phase);
  return latestOf(of.filter((e) => e.status === "success")) || latestOf(of);
};

/** Rows -> the shape the old payments.paymongoTransactions[] had (for code that still reads it). */
const entriesToLegacyTransactions = (rows) =>
  ["deposit", "balance"].map((ph) => pickEntry(rows, ph)).filter(Boolean).map((e) => ({
    phase: e.phase,
    ref: e.referenceNumber || null,
    sessionID: e.sessionID || null,
    amount: e.amount,
    fee: e.transactionFee ?? null,
    channel: e.source === "online" ? (LEGACY_CHANNEL[e.method] || e.method || null) : (BALANCE_METHOD_LABEL[e.method] || null),
    source: e.source,
    status: e.status === "success" ? "paid" : e.status,
    createdAt: e.createdAt || null,
    updatedAt: e.updatedAt || null,
    paidAt: e.settledAt || null,
    by: e.source === "in_person" ? (e.processedBy || null) : null,
  }));

/**
 * Returns a copy of `payment` with the OLD scattered fields filled in from its
 * entries -- only where the payment doesn't already have a value, so a document
 * that still carries the legacy fields is returned unchanged. This is what lets
 * the cleanup phase remove those fields without changing a single reader.
 */
const MOVED_PAYMENT_FIELDS = [
  "depositPaymongoPaymentID", "balancePaymongoPaymentID", "paymongoPaymentID",
  "depositPaymongoFee", "balancePaymongoFee", "paymongoChannel", "lastSettledVia",
  "paidAt", "balancePaidAt", "confirmedBy", "confirmedAt",
  "balanceMethod", "balanceCollectedBy", "balanceCollectedAt", "paymongoTransactions",
];
const MOVED_PENALTY_FIELDS = ["paymentMethod", "referenceNumber", "paidAt"];
const MOVED_REFUND_FIELDS  = ["parts", "manualRefund", "unrefundable", "unrefundableAmount", "paymongoRefundID"];

/**
 * opts.rowsOnly  READ mode: the rows are the ONLY source. Whatever the document still carries in the moved fields
 *                is dropped first and the values come from the rows alone -- there is no "else try the old field".
 *                (The default, doc-first mode exists for the writers: syncPaymentEntries lays a fresh webhook / staff
 *                write over the document and needs it to win while it derives the row.)
 */
const hydratePayment = (payment, entries, opts = {}) => {
  if (!payment) return payment;
  const rows = (entries || []).filter((e) => e && e.direction !== "out" && e.phase !== "penalty");
  if (!rows.length && !opts.rowsOnly) return payment;
  const out = { ...payment };
  if (opts.rowsOnly) for (const k of MOVED_PAYMENT_FIELDS) delete out[k];
  const fill = (k, v) => {
    if ((out[k] === undefined || out[k] === null || out[k] === "") && v !== undefined && v !== null && v !== "") out[k] = v;
  };
  const dep = pickEntry(rows, "deposit");
  const bal = pickEntry(rows, "balance");

  if (dep) {
    if (dep.source === "online") {
      fill("depositPaymongoPaymentID", dep.referenceNumber);
      fill("depositPaymongoFee", dep.transactionFee);
      fill("paymongoChannel", LEGACY_CHANNEL[dep.method] || dep.method);
    } else {
      fill("confirmedBy", dep.processedBy);
      fill("confirmedAt", dep.processedAt);
    }
    if (dep.status === "success") fill("paidAt", dep.settledAt);
  }
  if (bal) {
    if (bal.source === "online") {
      fill("balancePaymongoPaymentID", bal.referenceNumber);
      fill("balancePaymongoFee", bal.transactionFee);
      fill("paymongoChannel", LEGACY_CHANNEL[bal.method] || bal.method);
      if (bal.status === "success") fill("balancePaidAt", bal.settledAt);
    } else {
      fill("balanceMethod", BALANCE_METHOD_LABEL[bal.method] || null);
      fill("balanceCollectedBy", bal.processedBy);
      fill("balanceCollectedAt", bal.processedAt || bal.settledAt);
    }
  }
  // Latest charge id + the open checkout session.
  const paidOnline = rows.filter((e) => e.source === "online" && e.status === "success" && e.referenceNumber);
  fill("paymongoPaymentID", (latestOf(paidOnline) || {}).referenceNumber);
  const withSession = rows.filter((e) => e.sessionID);
  fill("paymongoSessionID", (latestOf(withSession) || {}).sessionID);
  if (!Array.isArray(out.paymongoTransactions) || !out.paymongoTransactions.length) {
    out.paymongoTransactions = entriesToLegacyTransactions(rows);
  }
  return out;
};

/**
 * Penalty: fills paymentMethod / referenceNumber / paidAt from its entries when the
 * penalty no longer stores them. No rows but paidAmount > 0 => it was paid from the deposit.
 */
const hydratePenalty = (penalty, entries, opts = {}) => {
  if (!penalty) return penalty;
  const rows = (entries || []).filter((e) => e && e.direction !== "out" && e.phase === "penalty" && e.status === "success");
  const out = { ...penalty };
  if (opts.rowsOnly) for (const k of MOVED_PENALTY_FIELDS) delete out[k];   // rows only -- no fallback to the old fields
  const fill = (k, v) => {
    if ((out[k] === undefined || out[k] === null || out[k] === "") && v !== undefined && v !== null && v !== "") out[k] = v;
  };
  const last = latestOf(rows);
  if (last) {
    const label = last.source === "online" ? "PayMongo" : (PENALTY_METHOD_LABEL[last.method] || "InStore");
    fill("paymentMethod", label);
    fill("referenceNumber", last.referenceNumber);
    fill("paidAt", last.settledAt);
  } else if (num(penalty.paidAmount) > 0) {
    fill("paymentMethod", "Deposit");
  }
  return out;
};


// ── refunds: money OUT ──────────────────────────────────────────────────────
/**
 * One refundRequests doc -> its "out" rows. Derived from what the request records (STEP 2 bridge: the
 * request still carries parts[] / manualRefund / unrefundable[] and stays the source of truth until the
 * writers are switched). Deterministic ids, so re-deriving only updates.
 *
 *   <refundRequestID>_part<n>          one PayMongo refund (online). referenceNumber = the re_... refund id
 *   <refundRequestID>_manual           staff handed money back in person (cash taken in person only)
 *   <refundRequestID>_unrefundable<n>  paid online but NO PayMongo payment id: nothing to refund -- NOT a hand-back
 *
 * A refund row is tied to what it refunds by paymentID + phase (no separate parent link). A pending / rejected
 * request has no parts yet, so it produces no rows.
 */
const buildRefundEntries = (r, docID, opts = {}) => {
  r = r || {};
  const now = opts.now || new Date();
  const refundRequestID = r.refundRequestID || docID;
  const paymentID = r.paymentID || null;
  const base = (suffix, extra) => ({
    paymentEntryID: `${refundRequestID}_${suffix}`,
    paymentID,
    bookingID: r.bookingID || null,
    userID: r.userID || null,
    refundReqID: refundRequestID,
    penaltyID: null,
    direction: "out",
    sessionID: null,
    transactionFee: null,
    groupID: null,
    createdAt: r.processedAt || r.createdAt || now,
    updatedAt: now,
    ...extra,
  });
  const partStatus = (s) => { const v = low(s); return v === "succeeded" || v === "success" ? "success" : v === "failed" ? "failed" : "pending"; };

  const entries = [];

  // online parts (older requests have no parts[]: the single paymongoRefundID is one part)
  let parts = Array.isArray(r.parts) && r.parts.length ? r.parts : null;
  if (!parts && nullIfSentinel(r.paymongoRefundID)) {
    parts = [{
      kind: "deposit", paymongoRefundID: r.paymongoRefundID, amount: num(r.onlineAmount) || num(r.amount),
      status: low(r.status) === "refunded" ? "succeeded" : low(r.status) === "failed" ? "failed" : "pending",
    }];
  }
  (parts || []).forEach((p, i) => {
    const phase = p.kind === "balance" ? "balance" : "deposit";
    const status = partStatus(p.status);
    entries.push(base(`part${i + 1}`, {
      phase, source: "online", method: null,
      amount: num(p.amount), status,
      referenceNumber: nullIfSentinel(p.paymongoRefundID),
      processedBy: nullIfSentinel(r.processedBy), processedAt: orNull(r.processedAt),
      settledAt: status === "success" ? (orNull(p.settledAt) || orNull(r.updatedAt)) : null,
      transactionErrorNote: p.error ? String(p.error) : null,
    }));
  });

  // the part staff hand back in person (cash / money collected in person)
  const m = r.manualRefund;
  if (m && num(m.amount) > 0) {
    const mm = normalizeMethod(m.method);
    const issued = !!m.issued;
    entries.push(base("manual", {
      phase: opts.payment && opts.payment.balanceCollected ? "balance" : "deposit",
      source: "in_person", method: mm.method,
      amount: num(m.amount), status: issued ? "success" : "pending",
      referenceNumber: null,
      processedBy: nullIfSentinel(m.issuedBy), processedAt: orNull(m.issuedAt),
      settledAt: issued ? orNull(m.issuedAt) : null,
      transactionErrorNote: null,
    }));
  }

  // online money with no payment id on record -- reported, never handed back
  (Array.isArray(r.unrefundable) ? r.unrefundable : []).forEach((u, i) => {
    const phase = u.kind === "balance" ? "balance" : "deposit";
    entries.push(base(`unrefundable${i + 1}`, {
      phase, source: "online", method: null,
      amount: num(u.amount), status: "unrefundable",
      referenceNumber: null, processedBy: null, processedAt: null, settledAt: null,
      transactionErrorNote: PAYMENT_ID_MISSING_NOTE,
    }));
  });

  return { entries };
};

/** Like mergeEntry, but remembers WHEN a refund settled: kept once known, stamped on the first success. */
const mergeRefundEntry = (existing, built, opts = {}) => {
  const stamp = opts.now || new Date();
  if (!existing) {
    return { ...built, settledAt: built.status === "success" ? (built.settledAt || stamp) : built.settledAt };
  }
  if (!opts.force && existing.status === "success" && built.status !== "success") return null;
  const next = { ...built };
  delete next.createdAt;
  delete next.paymentEntryID;
  next.settledAt = existing.settledAt || (built.status === "success" ? (built.settledAt || stamp) : null);
  return next;
};

/**
 * Refund request: rebuilds parts[] / manualRefund / paymongoRefundID(s) / unrefundable[] from its "out" rows
 * -- only where the request no longer carries them, so a request that still has them is returned unchanged.
 */
const hydrateRefundRequest = (request, entries, opts = {}) => {
  if (!request) return request;
  const rows = (entries || []).filter((e) => e && e.direction === "out");
  if (!rows.length && !opts.rowsOnly) return request;
  const out = { ...request };
  if (opts.rowsOnly) for (const k of MOVED_REFUND_FIELDS) delete out[k];   // rows only -- no fallback to the old fields
  if (!rows.length) return out;
  // The "out" rows are the source of truth: where a row exists it OVERRIDES whatever legacy parts / manualRefund /
  // unrefundable the document may still carry (they go stale -- nothing writes them any more).
  const seq = (e) => Number(String(e.paymentEntryID || "").match(/(\d+)$/)?.[1] || 0);

  const online = rows.filter((e) => e.source === "online" && e.status !== "unrefundable").sort((a, b) => seq(a) - seq(b));
  if (online.length) {
    out.parts = online.map((e) => ({
      kind: e.phase === "balance" ? "balance" : "deposit", paymongoPaymentID: null, amount: e.amount,
      paymongoRefundID: e.referenceNumber, status: e.status === "success" ? "succeeded" : e.status === "failed" ? "failed" : "pending",
      ...(e.transactionErrorNote ? { error: e.transactionErrorNote } : {}),
    }));
  }
  if (online.length) out.paymongoRefundIDs = online.map((e) => e.referenceNumber).filter(Boolean);
  if (online.length) out.paymongoRefundID = online[0].referenceNumber || null;

  const manual = rows.find((e) => e.source === "in_person");
  if (manual) {
    out.manualRefund = {
      amount: manual.amount, issued: manual.status === "success", issuedBy: manual.processedBy || null,
      issuedAt: manual.processedAt || null, method: BALANCE_METHOD_LABEL[manual.method] || null,
    };
  }
  const unref = rows.filter((e) => e.status === "unrefundable").sort((a, b) => seq(a) - seq(b));
  if (unref.length) {
    out.unrefundable = unref.map((e) => ({ kind: e.phase === "balance" ? "balance" : "deposit", amount: e.amount, reason: "payment_id_missing" }));
  }
  if (unref.length) {
    out.unrefundableAmount = unref.reduce((s, e) => s + e.amount, 0);
  }
  return out;
};

module.exports = {
  buildRefundEntries, mergeRefundEntry, hydrateRefundRequest, PAYMENT_ID_MISSING_NOTE,
  MOVED_PAYMENT_FIELDS, MOVED_PENALTY_FIELDS, MOVED_REFUND_FIELDS,
  low, num, nullIfSentinel, normalizeMethod, statusFromLegacy, entryIDFor,
  buildPaymentEntries, buildLegacyPenaltyEntry, buildPenaltyPaymentEntry,
  mergeEntry, pickEntry, entriesToLegacyTransactions, hydratePayment, hydratePenalty,
};

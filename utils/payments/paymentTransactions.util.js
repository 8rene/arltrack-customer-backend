// Shared helper for payments.paymongoTransactions (see the comment below).
// payments.paymongoTransactions — one entry per charge on a payment.
//
//   { phase, ref, sessionID, amount, fee, channel, source, status,
//     createdAt, updatedAt, paidAt, by }
//
//   phase     "deposit" (the first / only payment) | "balance" (Partial's second payment)
//   ref       PayMongo payment id (pay_…); null for pending charges and in-person payments
//   fee       PayMongo's own transaction fee for this charge; null = not recorded
//   source    "online" (PayMongo) | "in_person" (cash / GCash / bank collected by staff)
//   status    "pending" | "paid" | "failed" | "cancelled"
//
// STEP 1 of the migration: this array is written ALONGSIDE the old fields
// (status, balanceStatus, *PaymongoPaymentID, *PaymongoFee …), which stay the source
// of truth until the readers are switched over. A helper failure must never block
// a real payment, so this never throws — on error it returns the list unchanged.
//
// The customer backend and the admin backend each carry an identical copy of this file.

const PHASES = ["deposit", "balance"];
const phaseOf = (phase) => (phase === "balance" ? "balance" : "deposit");

// Drop undefined (Firestore rejects it) so a patch only changes what it actually sets.
const clean = (patch) =>
  Object.fromEntries(Object.entries(patch || {}).filter(([, v]) => v !== undefined));

/**
 * Returns a NEW array with the entry for `phase` created or updated by `patch`.
 * A paid entry is never downgraded to pending / failed / cancelled — unless
 * opts.force is set (a deliberate manual change by staff, not a late webhook).
 */
const upsertTransaction = (payment, phase, patch = {}, opts = {}) => {
  const existing = Array.isArray(payment && payment.paymongoTransactions) ? payment.paymongoTransactions : [];
  try {
    const ph   = phaseOf(phase);
    const list = existing.map((t) => ({ ...t }));
    const i    = list.findIndex((t) => t.phase === ph);
    const now  = new Date();
    const base = i >= 0 ? list[i] : {
      phase: ph, ref: null, sessionID: null, amount: null, fee: null, channel: null,
      source: "online", status: "pending", createdAt: now, paidAt: null, by: null,
    };

    const next = { ...base, ...clean(patch), phase: ph, updatedAt: now };
    if (!opts.force && base.status === "paid" && patch && patch.status && patch.status !== "paid" && patch.status !== "refunded") {
      next.status = "paid";
    }

    if (i >= 0) list[i] = next; else list.push(next);
    list.sort((a, b) => PHASES.indexOf(a.phase) - PHASES.indexOf(b.phase));
    return list;
  } catch (err) {
    console.error("[paymongoTransactions] upsert failed, leaving the list unchanged:", err.message);
    return existing;
  }
};

module.exports = { upsertTransaction };
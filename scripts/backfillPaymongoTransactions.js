// One-time backfill: build payments.paymongoTransactions for payments that were
// created BEFORE the array existed (see utils/payments/paymentTransactions.util.js).
//
// For each payment whose array is missing or empty, the entries are rebuilt from the
// fields that were always saved (status, balanceStatus, depositPaymongoPaymentID,
// balancePaymongoPaymentID, the fees, balanceCollected …). The old fields are NEVER
// changed or removed — this only adds the array. Payments that already have one are
// skipped, so it is safe to run again.
//
// A balance that was never requested ("not_due") gets no entry: an entry is only
// created for something that actually happened.
//
// DRY-RUNS by default — nothing is written until you pass --apply:
//   node scripts/backfillPaymongoTransactions.js           # list what would be written
//   node scripts/backfillPaymongoTransactions.js --apply   # write it
require("dotenv").config();
const { db } = require("../config/firebaseConnection/firebase");
const { getPaymentBreakdown, resolvePaymongoIDs, payTypeOf } = require("../utils/payments/paymentBreakdown.util");

const APPLY = process.argv.includes("--apply");

const low = (v) => String(v || "").toLowerCase();
const num = (v) => Number(v) || 0;

const depositStatus = (raw) => {
  const s = low(raw);
  if (s === "paid" || s === "approved" || s === "refunded") return "paid"; // refunded = it WAS paid
  if (s === "failed" || s === "rejected") return "failed";
  if (s === "cancelled" || s === "canceled") return "cancelled";
  return "pending";
};

const buildEntries = (p) => {
  const ids     = resolvePaymongoIDs(p);
  const payType = payTypeOf(p);
  const amount  = num(p.amount);
  const now     = new Date();

  // What each phase is worth, whether or not it has been paid.
  const expectedDeposit = getPaymentBreakdown({ ...p, status: "paid", balanceStatus: "", balanceCollected: false, discountAmount: 0 }).depositCollected;
  const expectedBalance = Math.max(0, amount - expectedDeposit);

  const entries = [];

  // ── deposit (or the single payment for Full) ──
  const manualRef = p.referenceNumber && !["—", "N/A"].includes(p.referenceNumber) ? p.referenceNumber : null;
  const online = !!(ids.deposit || p.paymongoChannel || !["paid", "approved", "refunded"].includes(low(p.status)));
  entries.push({
    phase: "deposit",
    ref: ids.deposit || manualRef || null,
    sessionID: p.paymongoSessionID || null,
    amount: expectedDeposit,
    fee: p.depositPaymongoFee ?? null,
    channel: online ? (p.paymongoChannel || null) : (p.paymentMethod && p.paymentMethod !== "—" ? p.paymentMethod : null),
    source: online ? "online" : "in_person",
    status: depositStatus(p.status),
    createdAt: p.createdAt || now,
    updatedAt: now,
    paidAt: p.paidAt || p.confirmedAt || null,
    by: online ? null : (p.confirmedBy || null),
  });

  // ── balance (Partial / Downpayment only) ──
  if (payType !== "Full" && expectedBalance > 0) {
    if (p.balanceCollected) {
      const rec = p.balanceCollectedAmount;
      entries.push({
        phase: "balance", ref: null, sessionID: null,
        amount: rec !== undefined && rec !== null && Number.isFinite(Number(rec)) ? Number(rec) : expectedBalance,
        fee: null,
        channel: p.balanceMethod || null,
        source: "in_person",
        status: "paid",
        createdAt: p.balanceCollectedAt || p.createdAt || now,
        updatedAt: now,
        paidAt: p.balanceCollectedAt || null,
        by: p.balanceCollectedBy || null,
      });
    } else {
      const bs = low(p.balanceStatus);
      const status = bs === "paid" ? "paid" : bs === "pending" ? "pending" : bs === "failed" ? "failed" : bs === "cancelled" ? "cancelled" : null;
      if (status) {
        entries.push({
          phase: "balance",
          ref: ids.balance || null,
          sessionID: null,
          amount: num(p.balanceAmount) || expectedBalance,
          fee: p.balancePaymongoFee ?? null,
          channel: p.paymongoChannel || null,
          source: "online",
          status,
          createdAt: p.balancePaidAt || p.updatedAt || now,
          updatedAt: now,
          paidAt: p.balancePaidAt || null,
          by: null,
        });
      }
    }
  }
  return entries;
};

(async () => {
  const snap = await db.collection("payments").get();
  let written = 0, already = 0, failed = 0;

  for (const doc of snap.docs) {
    const p = doc.data();
    if (Array.isArray(p.paymongoTransactions) && p.paymongoTransactions.length > 0) { already++; continue; }

    try {
      const entries = buildEntries(p);
      const label = `${p.paymentID || doc.id} (${p.methodOfPayment || "?"}, ${p.status || "?"})`;
      console.log(`${APPLY ? "WRITE" : "WOULD WRITE"} ${label}: ` +
        entries.map((e) => `${e.phase} ${e.status}${e.ref ? " " + e.ref : ""}`).join(" | "));
      if (APPLY) await doc.ref.update({ paymongoTransactions: entries });
      written++;
    } catch (err) {
      failed++;
      console.error(`FAILED ${p.paymentID || doc.id}: ${err.message}`);
    }
  }

  console.log(`\n${APPLY ? "Written" : "Would write"}: ${written}   already had the array: ${already}   failed: ${failed}`);
  if (!APPLY && written) console.log("Dry run only — re-run with --apply to save.");
  process.exit(failed ? 1 : 0);
})().catch((err) => { console.error(err); process.exit(1); });
// One-time backfill: record PayMongo's real transaction fee on payments that were
// settled BEFORE fee tracking existed (see utils/payments/paymongoFee.util.js).
//
// For every payment that has a stored PayMongo payment id but no saved fee, this
// asks PayMongo for that payment (GET /v1/payments/:id) and saves its fee
// per phase, plus the running total — exactly what settlePhasePayment now does
// at payment time. A fee that is already saved is never overwritten.
//
// Payments whose PayMongo id was never stored (older two-phase payments only kept
// the latest id) can't be looked up and are listed as "skipped".
//
// DRY-RUNS by default — nothing is written until you pass --apply:
//   node scripts/backfillPaymongoFees.js           # list what would be recorded
//   node scripts/backfillPaymongoFees.js --apply   # write it
require("dotenv").config();
const { db } = require("../config/firebaseConnection/firebase");
const { axios, PAYMONGO_V1, paymongoHeaders } = require("../utils/payments/paymongoClient.util");
const { chargeFromPaymentResource, buildFeePatch, hasFee } = require("../utils/payments/paymongoFee.util");

const APPLY = process.argv.includes("--apply");

const fetchPayment = async (id) => {
  const res = await axios.get(`${PAYMONGO_V1}/payments/${id}`, { headers: paymongoHeaders(), timeout: 15000 });
  return res.data && res.data.data;
};

(async () => {
  const snap = await db.collection("payments").get();
  let recorded = 0, already = 0, skipped = 0, failed = 0, feeSum = 0;

  for (const doc of snap.docs) {
    const p = doc.data();
    // (phase, PayMongo id) pairs this payment can be looked up by.
    const targets = [
      ["deposit", p.depositPaymongoPaymentID || (p.balancePaymongoPaymentID ? null : p.paymongoPaymentID)],
      ["balance", p.balancePaymongoPaymentID],
    ].filter(([, id]) => id);

    if (!targets.length) { if (String(p.status).toLowerCase() === "paid") skipped++; continue; }

    let working = { ...p };
    let update = {};
    for (const [phase, id] of targets) {
      if (hasFee(working, phase)) { already++; continue; }
      try {
        const charge = chargeFromPaymentResource(await fetchPayment(id));
        if (!charge) { skipped++; continue; }
        const patch = buildFeePatch(working, phase, charge);
        working = { ...working, ...patch };
        update = { ...update, ...patch };
        feeSum += charge.fee;
        recorded++;
        console.log(`${APPLY ? "recorded" : "would record"}  ${p.paymentID || doc.id}  ${phase}  ${id}  fee ₱${charge.fee}`);
      } catch (e) {
        failed++;
        console.error(`failed  ${p.paymentID || doc.id}  ${phase}  ${id}  ${e?.response?.status || ""} ${e.message}`);
      }
    }
    if (APPLY && Object.keys(update).length) await doc.ref.update(update);
  }

  console.log(`\n${APPLY ? "Done" : "Dry run"}: ${recorded} charge(s) ${APPLY ? "recorded" : "to record"} (₱${feeSum.toFixed(2)} in fees), ${already} already had a fee, ${skipped} skipped, ${failed} failed.`);
  if (!APPLY && recorded) console.log("Run again with --apply to write them.");
  process.exit(0);
})();
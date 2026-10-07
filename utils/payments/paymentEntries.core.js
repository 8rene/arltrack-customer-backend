// GENERATED from arltrack-admin-backend/services/paymentEntries/paymentEntries.core.js -- DO NOT EDIT BY HAND.
// Change the admin file, then run: node scripts/build-customer-payment-entries.mjs <this repo>
// paymentEntries -- database logic, with `db` passed in so it can be tested against a fake.
// paymentEntries.service.js binds it to the real Firestore connection.
//
// KEEP IN SYNC with arltrack-customer-backend/utils/payments/paymentEntries.core.js
// (generated: run scripts/build-customer-payment-entries.mjs).
const ENTRY_COLLECTION = "paymentEntries";
const {
  buildPaymentEntries, mergeEntry, hydratePayment, hydratePenalty,
} = require("./paymentEntries.mapper");

// Firestore `in` accepts at most 30 values.
const chunk = (list, n = 30) => {
  const out = [];
  for (let i = 0; i < list.length; i += n) out.push(list.slice(i, i + n));
  return out;
};

const makeEntriesDb = (db) => {
  const col = () => db.collection(ENTRY_COLLECTION);

  /**
   * Re-derives and writes the deposit / balance entries of ONE payment.
   *   opts.force  a deliberate manual change by staff (e.g. Approved -> Rejected) may
   *               downgrade a "success" row; a late webhook may not.
   * NEVER throws -- a failure here must not block a real payment. Returns { written }.
   */
  const syncPaymentEntries = async (paymentDocID, opts = {}) => {
    try {
      if (!paymentDocID) return { written: 0 };
      const snap = await db.collection("payments").doc(paymentDocID).get();
      if (!snap.exists) return { written: 0 };
      const { entries } = buildPaymentEntries(snap.data(), snap.id);
      if (!entries.length) return { written: 0 };

      const refs = entries.map((e) => col().doc(e.paymentEntryID));
      const existing = await db.getAll(...refs);
      const batch = db.batch();
      let written = 0;
      entries.forEach((e, i) => {
        const prev = existing[i].exists ? existing[i].data() : null;
        const patch = mergeEntry(prev, e, opts);
        if (!patch) return;
        if (prev) batch.update(refs[i], patch); else batch.set(refs[i], patch);
        written += 1;
      });
      if (written) await batch.commit();
      return { written };
    } catch (err) {
      console.error("[paymentEntries] sync failed (the payment itself is unaffected):", err.message);
      return { written: 0, error: err.message };
    }
  };

  /** paymentID[] -> Map(paymentID -> entries[]). One query per 30 ids, not one per payment. */
  const getEntriesForPaymentIDs = async (paymentIDs) => {
    const ids = [...new Set((paymentIDs || []).filter(Boolean))];
    const map = new Map(ids.map((id) => [id, []]));
    for (const part of chunk(ids)) {
      const snap = await col().where("paymentID", "in", part).get();
      snap.docs.forEach((d) => {
        const row = { id: d.id, ...d.data() };
        if (map.has(row.paymentID)) map.get(row.paymentID).push(row);
      });
    }
    return map;
  };

  /** penaltyID[] -> Map(penaltyID -> entries[]). */
  const getEntriesForPenaltyIDs = async (penaltyIDs) => {
    const ids = [...new Set((penaltyIDs || []).filter(Boolean))];
    const map = new Map(ids.map((id) => [id, []]));
    for (const part of chunk(ids)) {
      const snap = await col().where("refID", "in", part).get();
      snap.docs.forEach((d) => {
        const row = { id: d.id, ...d.data() };
        if (row.refCollection === "penalties" && map.has(row.refID)) map.get(row.refID).push(row);
      });
    }
    return map;
  };

  /** payments[] -> the same payments with the old moved fields filled in from their entries. */
  const hydratePayments = async (payments) => {
    const list = payments || [];
    const map = await getEntriesForPaymentIDs(list.map((p) => p.paymentID || p.id));
    return list.map((p) => hydratePayment(p, map.get(p.paymentID || p.id) || []));
  };

  /** penalties[] -> the same penalties with paymentMethod / referenceNumber / paidAt filled in. */
  const hydratePenalties = async (penalties) => {
    const list = penalties || [];
    const map = await getEntriesForPenaltyIDs(list.map((p) => p.penaltyID || p.id));
    return list.map((p) => hydratePenalty(p, map.get(p.penaltyID || p.id) || []));
  };

  /** Refs of every entry that belongs to a booking -- used by the permanent delete. */
  const getEntryRefsForBooking = async (bookingID) => {
    if (!bookingID) return [];
    const snap = await col().where("bookingID", "==", bookingID).get();
    return snap.docs.map((d) => d.ref);
  };

  return {
    syncPaymentEntries, getEntriesForPaymentIDs, getEntriesForPenaltyIDs,
    hydratePayments, hydratePenalties, getEntryRefsForBooking,
  };
};

module.exports = { makeEntriesDb, chunk };

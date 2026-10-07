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
  buildRefundEntries, mergeRefundEntry, hydrateRefundRequest, entryIDFor,
} = require("./paymentEntries.mapper");

// Firestore `in` accepts at most 30 values.
const chunk = (list, n = 30) => {
  const out = [];
  for (let i = 0; i < list.length; i += n) out.push(list.slice(i, i + n));
  return out;
};

// The id a payment / penalty's entries are keyed by. A live document carries paymentID / penaltyID; an archived
// copy may only carry originalId (the id the live document had), which is what the migration keyed its rows by.
const paymentKeyOf = (p) => p.paymentID || p.originalId || p.id;
const penaltyKeyOf = (p) => p.penaltyID || p.originalId || p.id;

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
      const data = snap.data();

      // After the PHASE 2 cleanup the payment document no longer carries the reference number, fee, channel,
      // "processed by" ... -- the rows are the only copy. Re-deriving from the thinned document would overwrite
      // those rows with nulls, so first fill the document's gaps from the rows it already has. A value that IS
      // on the document (a fresh write by staff or a webhook) still wins, because hydrate only fills what is missing.
      const paymentID = data.paymentID || snap.id;
      const refs = ["deposit", "balance"].map((ph) => col().doc(entryIDFor(paymentID, ph)));
      const existing = await db.getAll(...refs);
      const priorRows = existing.filter((x) => x.exists).map((x) => x.data());
      const { entries } = buildPaymentEntries(hydratePayment(data, priorRows), snap.id);
      if (!entries.length) return { written: 0 };

      const refOf = new Map(refs.map((r, i) => [r.id, i]));
      const batch = db.batch();
      let written = 0;
      entries.forEach((e) => {
        const i = refOf.get(e.paymentEntryID);
        const ref = refs[i];
        const prev = existing[i].exists ? existing[i].data() : null;
        const patch = mergeEntry(prev, e, opts);
        if (!patch) return;
        if (prev) batch.update(ref, patch); else batch.set(ref, patch);
        written += 1;
      });
      if (written) await batch.commit();
      return { written };
    } catch (err) {
      console.error("[paymentEntries] sync failed (the payment itself is unaffected):", err.message);
      return { written: 0, error: err.message };
    }
  };

  /**
   * Re-derives and writes the "out" rows of ONE refund request: its PayMongo refund parts, the in-person
   * hand-back, and any amount that has no payment id on record. Same guarantees as syncPaymentEntries:
   * never throws, a settled ("success") refund row is never moved back to pending / failed.
   */
  const syncRefundEntries = async (refundRequestDocID, opts = {}) => {
    try {
      if (!refundRequestDocID) return { written: 0 };
      const snap = await db.collection("refundRequests").doc(refundRequestDocID).get();
      if (!snap.exists) return { written: 0 };
      const r = snap.data();
      let payment = null;
      if (r.paymentID) {
        const ps = await db.collection("payments").where("paymentID", "==", r.paymentID).limit(1).get();
        payment = ps.docs.length ? ps.docs[0].data() : null;
      }
      const { entries } = buildRefundEntries(r, snap.id, { payment });
      if (!entries.length) return { written: 0 };

      const refs = entries.map((e) => col().doc(e.paymentEntryID));
      const existing = await db.getAll(...refs);
      const batch = db.batch();
      let written = 0;
      entries.forEach((e, i) => {
        const prev = existing[i].exists ? existing[i].data() : null;
        const patch = mergeRefundEntry(prev, e, opts);
        if (!patch) return;
        if (prev) batch.update(refs[i], patch); else batch.set(refs[i], patch);
        written += 1;
      });
      if (written) await batch.commit();
      return { written };
    } catch (err) {
      console.error("[paymentEntries] refund sync failed (the refund itself is unaffected):", err.message);
      return { written: 0, error: err.message };
    }
  };

  /** refundRequestID[] -> Map(refundRequestID -> "out" entries[]). */
  const getEntriesForRefundRequestIDs = async (refundRequestIDs) => {
    const ids = [...new Set((refundRequestIDs || []).filter(Boolean))];
    const map = new Map(ids.map((id) => [id, []]));
    for (const part of chunk(ids)) {
      const snap = await col().where("refID", "in", part).get();
      snap.docs.forEach((d) => {
        const row = { id: d.id, ...d.data() };
        if (row.refCollection === "refundRequests" && map.has(row.refID)) map.get(row.refID).push(row);
      });
    }
    return map;
  };

  /** refundRequests[] -> the same requests with parts[] / manualRefund / unrefundable[] filled in from their rows. */
  const hydrateRefundRequests = async (requests) => {
    const list = requests || [];
    const map = await getEntriesForRefundRequestIDs(list.map((r) => r.refundRequestID || r.id));
    return list.map((r) => hydrateRefundRequest(r, map.get(r.refundRequestID || r.id) || []));
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
    const map = await getEntriesForPaymentIDs(list.map(paymentKeyOf));
    return list.map((p) => hydratePayment(p, map.get(paymentKeyOf(p)) || []));
  };

  /**
   * ONE payment document's data (doc.data(), as the readers have it) -> the same data with the moved fields
   * filled in from its rows. `docID` is the Firestore id, used when the data has no paymentID of its own.
   * Adds no keys of its own (unlike hydratePayments over {id, ...data}), so it is safe where the object is
   * written back or spread into another document. Never throws: on any failure the data is returned as it is.
   */
  const hydratePaymentData = async (data, docID) => {
    if (!data) return data;
    try {
      const key = data.paymentID || data.originalId || docID;
      if (!key) return data;
      const map = await getEntriesForPaymentIDs([key]);
      return hydratePayment(data, map.get(key) || []);
    } catch (err) {
      console.error("[paymentEntries] hydrate failed, using the document as it is:", err.message);
      return data;
    }
  };

  /** penalties[] -> the same penalties with paymentMethod / referenceNumber / paidAt filled in. */
  const hydratePenalties = async (penalties) => {
    const list = penalties || [];
    const map = await getEntriesForPenaltyIDs(list.map(penaltyKeyOf));
    return list.map((p) => hydratePenalty(p, map.get(penaltyKeyOf(p)) || []));
  };

  /** Refs of every entry that belongs to a booking -- used by the permanent delete. */
  const getEntryRefsForBooking = async (bookingID) => {
    if (!bookingID) return [];
    const snap = await col().where("bookingID", "==", bookingID).get();
    return snap.docs.map((d) => d.ref);
  };

  return {
    syncPaymentEntries, syncRefundEntries, getEntriesForPaymentIDs, getEntriesForPenaltyIDs,
    getEntriesForRefundRequestIDs, hydratePayments, hydratePaymentData, hydratePenalties, hydrateRefundRequests,
    getEntryRefsForBooking,
  };
};

module.exports = { makeEntriesDb, chunk };

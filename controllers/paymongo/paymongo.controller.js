import { db } from "../../config/firebaseConnection/firebase.js";
import admin from "firebase-admin";
import { createTransactionLog } from "../transactionLogs/transactionLogs.service.js";
import { resolveNotification, createNotification } from "../notification/notification.service.js";
import { ROLE_IDS } from "../../utils/roles/role.util.js";
import { auditSafe } from "../auditLogs/auditLogs.service.js";
import { computeRefundPlan, getRefundPolicy, getRefundPolicyFromFlag, resolvePickupAt, getDepositAmount, PAYMENT_ID_MISSING_NOTE } from "../payments/paymentBreakdown.js";
import { PAYMENT_METHODS, findOpenRefundRequest, getDiscountRefundState } from "../payments/payments.service.js";
import { getSessionByBookingID, markSessionCancelled } from "../booking/bookingSession.service.js";
import { sendRefundEmail, sendCancellationEmail } from "../email/email.service.js";
import { resolveCurrentDriverID, completeActiveAssignment } from "../driverAssignments/driverAssignments.service.js";
import { recordDirectCancellation, inferCancelledBy, getRequestsByBookingKeys, getCancellationInfoForBooking, recordRefundRejection } from "../cancellationRequests/cancellationRequests.service.js";
import { writeRefundEntries, hydrateRefundRequests, hydratePaymentData, ENTRY_COLLECTION } from "../paymentEntries/paymentEntries.service.js";
import { normalizeMethod, nullIfSentinel } from "../paymentEntries/paymentEntries.mapper.js";
import { getDepositView } from "../payments/paymentHelpers.js";
import { closeCreditInRefund, getDiscountFigures, DISCOUNT_PHASES } from "../payments/discountLedger.js";

// A refund's parts[] / manualRefund / unrefundable[] live ONLY in paymentEntries ("out" rows) now. Readers get
// the old shape back through hydrate (it only fills what the request document does not carry).
//   The request stores no PayMongo id: the customer backend's refund.updated webhook finds it through the "out"
//   row's referenceNumber (re_...) -> refundReqID.
const hydrateOne = async (data, docID) => {
  if (!data) return data;
  const [h] = await hydrateRefundRequests([{ ...data, refundRequestID: data.refundRequestID || docID }]);
  return h;
};

// Same PayMongo account as the customer backend — the secret key must be
// set in this backend's own env too (it's a separate deployment/process).
const PAYMONGO_V1 = "https://api.paymongo.com/v1";

// Read at call time (not import time) so it works regardless of when dotenv loads.
const paymongoHeaders = () => ({
  "Content-Type": "application/json",
  "Authorization": `Basic ${Buffer.from((process.env.PAYMONGO_SECRET_KEY || "") + ":").toString("base64")}`,
});

const lower = (v) => String(v || "").toLowerCase();
const peso  = (n) => `₱${Number(n || 0).toLocaleString()}`;

// Online money with no PayMongo payment id on record can't be refunded through PayMongo, and it is NOT
// handed back by staff either. The customer must not be promised it, so every message says so plainly.
const unrefundableSentence = (amount) =>
  Number(amount) > 0
    ? ` ${peso(amount)} could not be refunded automatically because its payment record is incomplete — please contact support about it.`
    : "";

// How the customer is told their money comes back. A QR Ph payment can't go through PayMongo's refund API at all, so a
// refund that is ALL hand-back (nothing online) must not say "₱0 will be returned through PayMongo".
const returnRouteSentence = ({ onlineAmount = 0, manualAmount = 0, qrphAmount = 0 }) => {
  if (manualAmount > 0 && !(onlineAmount > 0)) {
    return `${qrphAmount > 0 ? "Payments made by QR Ph can't be refunded online. " : ""}Please visit our store to collect your ${peso(manualAmount)} refund.`;
  }
  if (manualAmount > 0) {
    return `${peso(onlineAmount)} will be returned through PayMongo (please allow up to 24 hours). Please visit our store to collect the other ${peso(manualAmount)}.`;
  }
  return "Please allow up to 24 hours for PayMongo to process it — we'll notify you once it has been returned.";
};

// How the customer PAID, per phase, for the refund screen: "gcash" | "maya" | "qrph" | "cash" | "bank_transfer" | null.
// Online phases read the per-phase channel (derived from the entry rows); in-person phases read the method staff recorded.
const methodCode = (v) => {
  const s = lower(v).replace(/[\s_-]/g, "");
  if (!s || s === "na" || s === "—") return null;
  if (s === "paymaya" || s === "maya") return "maya";
  if (s === "qrph") return "qrph";
  if (s === "gcash") return "gcash";
  if (s === "cash") return "cash";
  if (s === "banktransfer" || s === "bank") return "bank_transfer";
  return lower(v);
};
const paidWithOf = (payment) => {
  const p = payment || {};
  const dep = methodCode(p.depositPaymongoChannel || p.paymongoChannel || p.paymentMethod);
  const balancePaid = lower(p.balanceStatus) === "paid" || !!p.balancePaymongoPaymentID || !!p.balanceMethod;
  const bal = balancePaid ? methodCode(p.balancePaymongoChannel || p.balanceMethod) : null;
  return { deposit: dep, balance: bal };
};

// A second admin clicking Approve while the first is still talking to PayMongo
// would create a second set of refunds. The lock (a timestamp on the request,
// claimed in a transaction) makes that a clean 409. It expires so a crashed
// serverless invocation can never leave a request permanently stuck.
const APPROVAL_LOCK_MS = 2 * 60 * 1000;
const isLocked = (r) => {
  const at = r.approvalLockedAt?.toDate ? r.approvalLockedAt.toDate() : r.approvalLockedAt ? new Date(r.approvalLockedAt) : null;
  return !!at && Date.now() - at.getTime() < APPROVAL_LOCK_MS;
};

// resolve customer name for display — mirrors payments.service.js's helper
const resolveCustomerName = async (userID) => {
  if (!userID) return "—";
  try {
    const snap = await db.collection("userDetails").where("userID", "==", userID).limit(1).get();
    if (!snap.empty) {
      const { firstName = "", lastName = "" } = snap.docs[0].data();
      const fullName = [firstName, lastName].filter(Boolean).join(" ").trim();
      if (fullName) return fullName;
    }
    const userDoc = await db.collection("user").doc(userID).get();
    if (userDoc.exists) {
      const { username = "", email = "" } = userDoc.data();
      return username || email || "—";
    }
    return "—";
  } catch { return "—"; }
};

const fail = (message, status) => { const err = new Error(message); err.status = status; return err; };

// Field names on a refundRequests document: toRefundAmount (was amount), bookingPaid (was grossPaid) and
// returnDeposit (was policyTier). Documents written before the rename, and by the customer backend until it is
// switched, still carry the old names, so every read goes through these. What the API returns carries BOTH names for
// now, so the web apps keep working until they read the new ones.
const amountOf = (r) => Number(r && (r.toRefundAmount ?? r.amount)) || 0;
// Who asked (userID) and why (customerReason, notes) live on the booking's cancellationRequests row (what the
// customer filled in). The refund request's own `reason` is the STAFF's reason for the decision: the reject reason, or
// the note / waive reason given on approve. One field for every decision.
// Old refund documents (and staff-created ones) still carry the customer's fields on the document itself: userID,
// notes, and the customer's reason inside `reason`, with the staff's reject reason in `rejectReason`. A document that
// carries userID / notes / rejectReason is read that way; the row only fills the gaps. Old rows may also carry the
// decision (processedBy, processedAt, rejectReason), taken from the row only once the request is no longer Pending.
const isLegacyRefundDoc = (r) => !!(r && (r.userID || r.notes || r.rejectReason));
const withCancellationInfo = (r, row) => {
  if (!r) return r;
  const decided = !!(r.status && r.status !== "Pending");
  const legacy = isLegacyRefundDoc(r);
  const customerReason = (legacy ? r.reason : "") || (row && row.reason) || "";
  const decisionReason = (legacy ? r.rejectReason : r.reason) || (decided && row ? row.rejectReason : "") || "";
  return {
    ...r,
    ...(row ? {
      userID: r.userID || row.userID || null,
      notes: r.notes || row.notes || "",
      ...(decided ? {
        processedBy: r.processedBy || row.processedBy || null,
        processedAt: r.processedAt || row.processedAt || null,
      } : {}),
    } : {}),
    customerReason,
    reason: decisionReason,
    // old name, kept in the response only so the web apps keep working until they read `reason`
    rejectReason: r.status === "Rejected" ? (decisionReason || null) : (r.rejectReason ?? null),
  };
};
// Is it safe to write the staff's decision into `reason`? On an old document `reason` still holds the customer's
// words, so it is only overwritten when the cancellation row has the same text (nothing is lost).
const canWriteDecisionReason = (doc, row) =>
  !isLegacyRefundDoc(doc) || !doc.reason || (!!row && String(row.reason || "") === String(doc.reason || ""));

const withRefundAliases = (r) => {
  if (!r) return r;
  const out = { ...r };
  const amt = r.toRefundAmount ?? r.amount;
  if (amt !== undefined) { out.toRefundAmount = amt; out.amount = amt; }
  const paid = r.bookingPaid ?? r.grossPaid;
  if (paid !== undefined) { out.bookingPaid = paid; out.grossPaid = paid; }
  return out;
};
// Removes the old names from a stored document in the same update that writes the new ones.
const dropOldRefundNames = () => ({ amount: admin.firestore.FieldValue.delete(), grossPaid: admin.firestore.FieldValue.delete(), paymongoRefundIDs: admin.firestore.FieldValue.delete(), customerNotified: admin.firestore.FieldValue.delete() });

// ─────────────────────────────────────────────────────────────────────────────
// 48-hour refund policy (see paymentBreakdown.js → getRefundPolicy).
//
// A customer's request carries the verdict of that rule, written at the moment they asked:
// returnDeposit (true = the deposit goes back, false = it is kept). It is always judged from THAT moment — never
// from when staff approve — so a request made 50 hours before pickup and approved 40 hours before is still a full
// refund. Requests written before returnDeposit existed carry the older snapshot (policyTier, pickupAt,
// requestedAt …); that is still read, and judged from the snapshot, until the cleanup script converts it.
//
// Requests with neither (created before the policy existed, or opened automatically for a payment that arrived
// after cancellation) are refunded in full: the customer was never shown a forfeit for them.
// ─────────────────────────────────────────────────────────────────────────────
const policyForRequest = (request, payment, { waiveForfeit = false } = {}) => {
  if (!request) return null;
  if (typeof request.returnDeposit === "boolean") return getRefundPolicyFromFlag(payment, { returnDeposit: request.returnDeposit, waiveForfeit });
  if (!request.policyTier) return null;
  return getRefundPolicy(payment, {
    pickupAt: request.pickupAt,
    requestedAt: request.requestedAt || request.createdAt,
    waiveForfeit,
    bookedAt: request.bookedAt || null,   // when the deposit was paid, if the request snapshot kept it (no grace without it)
  });
};

// A discount given on a fully paid booking is HELD for the customer, and it is money they already paid. So when the booking
// is cancelled and refunded, it goes back INSIDE that refund: computeRefundPlan counts it with everything else the customer
// paid (only the security deposit is ever forfeited -- never the credit). This closes it in the ledger in the SAME batch
// that commits the refund: payments.discountCredit -> 0, discountReturned += credit, and one internal row (no cash of its
// own -- the money is in the refund's "out" rows) that says so. Returns the credit it closed (0 when there was none).
const closeHeldCreditInBatch = (batch, paymentRef, payment, { refundRequestID, bookingID, paymentID, userID, processedBy, at }) => {
  const credit = getDiscountFigures(payment).credit;
  if (!(credit > 0)) return 0;
  const entryRef = db.collection(ENTRY_COLLECTION).doc();
  batch.update(paymentRef, { ...closeCreditInRefund(payment), updatedAt: at });
  batch.set(entryRef, {
    paymentEntryID: entryRef.id,
    paymentID,
    bookingID,
    userID: userID || null,
    refundReqID: refundRequestID,                    // the refund this credit went back with
    penaltyID: null,
    direction: "internal",                           // no cash moved here: it is in the refund's own rows
    phase: DISCOUNT_PHASES.inRefund,
    source: null,
    method: null,
    amount: credit,
    status: "success",
    referenceNumber: null,
    sessionID: null,
    transactionFee: null,
    processedBy: processedBy || null,
    processedAt: at,
    settledAt: at,
    groupID: null,
    transactionErrorNote: null,
    createdAt: at,
    updatedAt: at,
  });
  return credit;
};

// After a refund is committed, the held security deposit is no longer "Held":
// it was either KEPT (forfeit > 0 → "Forfeited") or returned to the customer
// inside the refund ("Refunded"). Without this the deposit would still look
// Held and could be offered for return/settlement a second time.
const markDepositAfterRefund = async (paymentRef, payment, forfeit) => {
  const dep = getDepositView(payment);
  if (!dep || dep.status !== "Held") return;
  const now = new Date();
  try {
    // Status + when it left Held. The forfeited amount is not stored here: it is the refund request's
    // depositForfeited. securityDeposit is written so the amount survives dropping the old nested object.
    await paymentRef.update({
      securityDeposit: dep.amount,
      depositStatus: forfeit > 0 ? "Forfeited" : "Refunded",
      depositSettledAt: now,
      deposit: admin.firestore.FieldValue.delete(),
      updatedAt: now,
    });
  } catch (err) {
    console.error("[REFUND] failed to update the deposit status:", err.message);
  }
};

// Looks a booking up by Firestore doc id OR by its bookingID field.
const findBooking = async (id) => {
  if (!id) return null;
  const direct = await db.collection("bookings").doc(id).get();
  if (direct.exists) return direct.data();
  const q = await db.collection("bookings").where("bookingID", "==", id).limit(1).get();
  return q.empty ? null : q.docs[0].data();
};

// ─────────────────────────────────────────────────────────────────────────────
// List refund requests, newest first. Optional status filter.
//
// Pending requests also carry a planPreview — what approving would do RIGHT NOW
// (recomputed from the payment as it stands today: the balance may have been
// paid or collected since the customer asked) — so staff see "₱2,500 via PayMongo
// + ₱2,501 to hand back in cash" before they click Approve.
// ─────────────────────────────────────────────────────────────────────────────
export const getAllRefundRequests = async (status) => {
  let query = db.collection("refundRequests");
  if (status) query = query.where("status", "==", status);
  const snap = await query.get();
  const cancellationRows = await getRequestsByBookingKeys(snap.docs.map((d) => d.data().bookingID));

  const requests = await Promise.all(
    snap.docs.map(async (doc) => {
      const data = withCancellationInfo(doc.data(), (cancellationRows.get(doc.data().bookingID) || [])[0]);
      const customerName = await resolveCustomerName(data.userID);
      const row = withRefundAliases({ ...data, refundRequestID: data.refundRequestID || doc.id, customerName });

      if (["Pending", "Approved"].includes(data.status) && data.paymentID) {
        try {
          const pSnap = await db.collection("payments").where("paymentID", "==", data.paymentID).limit(1).get();
          if (!pSnap.empty) {
            const payment = await hydratePaymentData(pSnap.docs[0].data(), pSnap.docs[0].id);
            // A staff discount on this payment, and where its money stands (processing at PayMongo, failed ...), so the
            // two ways of giving money back are visible side by side instead of in two separate screens.
            const dr = await getDiscountRefundState(payment, pSnap.docs[0].id);
            // (A ledger discount is not a refund in flight: it is held and returns with the deposit, so nothing to show here.)
            if (dr && !(dr.view && dr.view.ledger)) row.discount = { amount: Number(payment.discountAmount) || 0, reason: payment.discountReason || "", refund: dr };
            row.paidWith = paidWithOf(payment);   // how the customer paid, per phase (the screen shows it; QR Ph is hand-back only)
            if (data.status !== "Pending") return row;
            const policy = policyForRequest(data, payment);
            const plan = computeRefundPlan(payment, { forfeit: policy ? policy.forfeit : 0 });
            row.planPreview = {
              total: plan.total,
              onlineAmount: plan.total - plan.manualAmount,
              manualAmount: plan.manualAmount,
              qrphAmount: plan.qrphAmount,                   // the part of manualAmount that is hand-back only because it was paid by QR Ph
              heldCredit: plan.heldCredit,                   // discount credit held for the customer: already paid by them, so it is inside `total`
              unrefundableAmount: plan.unrefundableAmount,   // paid online, no PayMongo payment id on record
              bookingPaid: plan.grossPaid,
              grossPaid: plan.grossPaid,                   // old name, same value, until the web apps read bookingPaid
              forfeit: plan.forfeit,                       // deposit kept under the 48-hour policy
              tier: policy ? policy.tier : null,           // "full" | "late" | "no_show" | null (no policy snapshot)
              hoursBeforePickup: policy ? policy.hoursBeforePickup : null,
              parts: plan.parts.map((p) => ({ kind: p.kind, amount: p.amount })),
            };
          }
        } catch (e) { /* preview is best-effort */ }
      }
      return row;
    })
  );

  const hydrated = (await hydrateRefundRequests(requests)).map(withRefundAliases);   // parts / manualRefund / unrefundable from the rows

  hydrated.sort((a, b) => {
    const aT = a.createdAt?.toDate ? a.createdAt.toDate() : new Date(a.createdAt);
    const bT = b.createdAt?.toDate ? b.createdAt.toDate() : new Date(b.createdAt);
    return bT - aT;
  });

  return hydrated;
};

// What refunding this booking right now would look like — same computation
// getAllRefundRequests() already does for a Pending request's planPreview,
// pulled out so the fleet status-change modal can show a real ₱ figure on
// each booking's Refund row before staff stage it. alreadyRefunded flags the
// data-mismatch case (payment says Refunded, booking never got cancelled to
// match) so the UI can show it distinctly instead of a confusing ₱0 button.
export const getBookingRefundPreview = async (bookingID) => {
  const paymentSnap = await db.collection("payments").where("bookingID", "==", bookingID).limit(1).get();
  // No payment doc at all → nothing to refund; confirming just cancels the booking.
  if (paymentSnap.empty) return { total: 0, onlineAmount: 0, manualAmount: 0, alreadyRefunded: false, noPayment: true, existingRequest: null };
  const payment = await hydratePaymentData(paymentSnap.docs[0].data(), paymentSnap.docs[0].id);
  if (lower(payment.status) === "refunded") {
    return { total: 0, onlineAmount: 0, manualAmount: 0, alreadyRefunded: true, noPayment: false, existingRequest: null };
  }
  // The customer already filed their own request — confirming from the fleet
  // flow approves THAT request (see staffRefundBooking) instead of stopping.
  const open = await findOpenRefundRequest(payment.paymentID || paymentSnap.docs[0].id).catch(() => null);
  const existingRequest = open ? { id: open.id, status: open.status } : null;
  const plan = computeRefundPlan(payment);
  const outstandingDiscountRefund = payment.discountAmount > 0 && !payment.refundIssued ? plan.breakdown.refundDue : 0;
  const total = plan.total + outstandingDiscountRefund;
  return { total, onlineAmount: plan.total - plan.manualAmount, manualAmount: plan.manualAmount + outstandingDiscountRefund, unrefundableAmount: plan.unrefundableAmount, alreadyRefunded: false, noPayment: false, existingRequest };
};

// What actually happened the last time staff ran a refund/cancel against
// this booking — used by getResolvedBookingsForCar() (services/fleet/
// fleet.service.js) to label a booking in the "Already resolved" section.
// staffRefundBooking()/staffCancelWithNoRefund() write a refundRequests doc (source: "staff") for every outcome
// except "no_payment" (no payment, so nothing to describe). The two labels the document does not store are derived
// here: "deposit_forfeited" = nothing_owed with returnDeposit:false, and "no_payment" = no refund doc and no payment.
export const getStaffRefundOutcome = async (bookingID) => {
  // Two equality filters, no orderBy — avoids needing a composite Firestore
  // index. In practice there's only ever one of these per booking (once
  // resolved, the booking's "cancelled" and this never runs again for it),
  // but sort in memory just in case there's somehow more than one.
  const snap = await db.collection("refundRequests")
    .where("bookingID", "==", bookingID)
    .where("source", "==", "staff")
    .get();
  if (snap.empty) {
    // A customer-submitted request that staff approved through the fleet flow
    // isn't source:"staff" — still report it so the "Already resolved" list
    // shows a real outcome instead of a bare "Resolved".
    const anySnap = await db.collection("refundRequests").where("bookingID", "==", bookingID).get();
    const done = anySnap.docs.map((d) => d.data()).find((r) => ["Approved", "Refunded"].includes(r.status));
    if (done) return { outcome: "refunded", amount: amountOf(done) };
    const paySnap = await db.collection("payments").where("bookingID", "==", bookingID).limit(1).get();
    return paySnap.empty ? { outcome: "no_payment", amount: 0 } : { outcome: null, amount: 0 };
  }
  const docs = snap.docs.map((d) => d.data());
  docs.sort((a, b) => {
    const aT = a.createdAt?.toDate ? a.createdAt.toDate() : new Date(a.createdAt);
    const bT = b.createdAt?.toDate ? b.createdAt.toDate() : new Date(b.createdAt);
    return bT - aT;
  });
  const latest = docs[0];
  const outcome = latest.outcome === "nothing_owed" && latest.returnDeposit === false ? "deposit_forfeited" : (latest.outcome || null);
  return { outcome, amount: amountOf(latest) };
};

// One PayMongo refund against one payment. Returns the PayMongo refund id.
export const createPaymongoRefund = async ({ paymongoPaymentID, amount, reason }) => {
  let response;
  try {
    response = await fetch(`${PAYMONGO_V1}/refunds`, {
      method: "POST",
      headers: paymongoHeaders(),
      body: JSON.stringify({
        data: {
          attributes: {
            amount: Math.round((amount || 0) * 100),
            payment_id: paymongoPaymentID,
            reason: "requested_by_customer",
            notes: reason || undefined,
          },
        },
      }),
    });
  } catch (networkErr) {
    console.error("[REFUND] PayMongo request failed:", networkErr.message);
    throw fail("Could not reach PayMongo. Please try again.", 502);
  }

  const data = await response.json();
  if (!response.ok) {
    console.error("[REFUND] PayMongo rejected the refund:", data);
    throw fail(data?.errors?.[0]?.detail || "PayMongo rejected the refund.", 400);
  }
  const id = data?.data?.id;
  if (!id) throw fail("PayMongo accepted the refund but returned no refund id.", 502);
  return id;
};

// Cancels the booking a refund was approved for. Only bookings that haven't
// started ("to pay"/"upcoming"): an ongoing/completed trip is never silently
// cancelled by a refund. Same two writes the admin's own cancel does (status +
// bookingSession). Returns { cancelled, driverID }.
const cancelBookingForRefund = async (bookingID, reason, processedBy = null) => {
  if (!bookingID) return { cancelled: false, driverID: null };
  let ref = db.collection("bookings").doc(bookingID);
  let snap = await ref.get();
  if (!snap.exists) {
    const q = await db.collection("bookings").where("bookingID", "==", bookingID).limit(1).get();
    if (q.empty) return { cancelled: false, driverID: null };
    ref = q.docs[0].ref; snap = q.docs[0];
  }
  const b = snap.data();
  if (!["to pay", "upcoming"].includes(lower(b.status))) {
    return { cancelled: false, driverID: await resolveCurrentDriverID(b, snap.id), status: b.status };
  }
  // The reason lives in cancellationRequests (a row with cancelledBy), not on the booking.
  const cancelBatch = db.batch();
  cancelBatch.update(ref, { status: "cancelled", updatedAt: new Date() });
  recordDirectCancellation(b.bookingID || snap.id, { userID: b.userID || null, reason, cancelledBy: inferCancelledBy(reason), processedBy }, cancelBatch);
  await cancelBatch.commit();
  try {
    const session = await getSessionByBookingID(bookingID);
    if (session) await markSessionCancelled(session.ref.id);
  } catch (err) {
    console.error("[REFUND] failed to sync bookingSession on cancel:", err.message);
  }
  // Read the driver BEFORE the assignment is closed (a closed row no longer counts as current),
  // then close it -- the other cancel paths (updateBooking, approveCancellationRequest) already do,
  // this one used to leave the row "assigned" on a cancelled booking.
  const driverID = await resolveCurrentDriverID(b, snap.id);
  completeActiveAssignment(b.bookingID || snap.id).catch((err) =>
    console.error("[REFUND] failed to close driver assignment on cancel:", err.message)
  );
  return { cancelled: true, driverID };
};

// Resolves true only if the notification was actually written (or an identical
// active one already existed); false if there was nobody to notify or the write
// failed. Never throws — a notification problem must not fail the refund action
// itself. Nothing is stored about whether the customer was told: it is not data about the refund.
// renotify: if an active card of this type already exists for the booking, bump it
// (new message, unread again) instead of silently dropping the new one — e.g. a
// second rejection after the customer re-requested a refund.
const notifyCustomer = async (userID, bookingID, type, title, message, { renotify = false } = {}) => {
  if (!userID) return false;
  try {
    await createNotification({ type, refID: bookingID || null, refCollection: "bookings", title, message, userID, renotify });
    return true;
  } catch (err) {
    console.error(`[REFUND] failed to notify customer (${type}):`, err.message);
    return false;
  }
};
// Emails the customer that their booking was cancelled with no money returned.
// Best-effort — a missing address or a send failure never fails the cancellation.
const emailCustomerCancelled = async (userID, bookingID, reason, refundNote = "") => {
  try {
    const { email, name } = await resolveCustomerContact(userID);
    if (!email) return;
    sendCancellationEmail({ toEmail: email, toName: name, bookingID, reason, refundNote })
      .catch((err) => console.error("[REFUND] cancellation email failed:", err.message));
  } catch (err) { console.error("[REFUND] cancellation email lookup failed:", err.message); }
};

// resolve customer email + display name for the refund email — mirrors
// resolveCustomerName's fallback chain (userDetails first/last name, then
// the "user" collection doc), since the email only lives on the latter.
// Exported too: getCarBookingsForStatusChange() (services/fleet/fleet.
// service.js) uses it to show "who booked" on the per-booking confirm
// modal in Fleet.jsx, since bookings only carry a userID.
export const resolveCustomerContact = async (userID) => {
  if (!userID) return { email: null, name: "—" };
  try {
    let name = "—";
    const detailsSnap = await db.collection("userDetails").where("userID", "==", userID).limit(1).get();
    if (!detailsSnap.empty) {
      const { firstName = "", lastName = "" } = detailsSnap.docs[0].data();
      const fullName = [firstName, lastName].filter(Boolean).join(" ").trim();
      if (fullName) name = fullName;
    }
    const userDoc = await db.collection("user").doc(userID).get();
    if (!userDoc.exists) return { email: null, name };
    const { email = null, username = "" } = userDoc.data();
    if (name === "—") name = username || email || "—";
    return { email, name };
  } catch {
    return { email: null, name: "—" };
  }
};

// ─────────────────────────────────────────────────────────────────────────────
// Approve a refund request.
//
//   1. Claim the request (Pending only, one admin at a time).
//   2. Recompute the plan from the payment AS IT STANDS NOW — everything the
//      customer has paid, split into:
//        parts[]       one PayMongo refund per online charge (PayMongo can only
//                      return up to what it received on each payment_id)
//        manualAmount  what PayMongo can't return — balance staff collected in
//                      person, a cash deposit, or a charge whose id is unknown.
//                      Staff hand it back and mark it issued (markManualRefundIssued).
//   3. Create the PayMongo refunds.
//   4. Mark the request "Approved", cancel the booking, tell the customer.
//
// "Refunded" (and the payment flipping to Refunded) happens LATER: when every
// PayMongo part has settled (customer backend's refund webhook) AND any manual
// portion is marked issued.
// ─────────────────────────────────────────────────────────────────────────────
export const approveRefundRequest = async (refundRequestID, adminUserID, { cancelReason, skipDriverNotify = false, waiveForfeit = false, waiveReason = "", reason = "" } = {}) => {
  const reqRef = db.collection("refundRequests").doc(refundRequestID);
  // The staff's reason for approving: an optional note, or the waive reason when the forfeit is waived.
  const decisionReason = String(reason || waiveReason || "").trim();

  // ── 1. claim ──
  const claimed = await db.runTransaction(async (t) => {
    const snap = await t.get(reqRef);
    if (!snap.exists) throw fail("Refund request not found.", 404);
    const r = snap.data();
    if (r.status !== "Pending") throw fail(`Refund request is already ${r.status}.`, 409);
    if (isLocked(r)) throw fail("This refund is already being processed by another admin. Refresh in a moment.", 409);
    t.update(reqRef, { approvalLockedAt: new Date() });
    return r;
  });
  const cancelRow = await getCancellationInfoForBooking(claimed.bookingID).catch(() => null);
  const refundRequest = withCancellationInfo(claimed, cancelRow);
  const releaseLock = () => reqRef.update({ approvalLockedAt: admin.firestore.FieldValue.delete() }).catch(() => {});

  try {
    // ── 2. the plan, from the payment as it is now ──
    const paymentSnap = await db.collection("payments").where("paymentID", "==", refundRequest.paymentID).limit(1).get();
    if (paymentSnap.empty) throw fail("Underlying payment record not found.", 404);
    const payment = await hydratePaymentData(paymentSnap.docs[0].data(), paymentSnap.docs[0].id);

    const payStatus = lower(payment.status);
    if (payStatus === "refunded") throw fail("This payment has already been refunded.", 409);
    if (!["paid", "approved"].includes(payStatus)) throw fail(`This payment is "${payment.status}" — only a paid payment can be refunded.`, 400);

    // A staff discount on this payment is money going back to the customer too. While PayMongo is still processing it
    // (or after it failed) the customer's real balance is unsettled, so approving now could leave them short.
    const discountRefund = await getDiscountRefundState(payment, paymentSnap.docs[0].id);

    // A discount given on a fully paid booking is HELD for the customer. It is money they already paid, so computeRefundPlan
    // counts it with the rest of what they paid and it goes back inside this refund (closed in the ledger in the approval
    // batch below). Nothing to block here, and nothing is deducted for the discount.
    // (Only a LEGACY discount refund can be in flight here: a held credit is never refunded on the spot.)
    if (discountRefund && !(discountRefund.view && discountRefund.view.ledger) && discountRefund.state === "processing") {
      throw fail(`A ${peso(discountRefund.amount)} discount refund is still processing at PayMongo for this booking. Wait for it to finish, then approve this request.`, 409);
    }
    if (discountRefund && !(discountRefund.view && discountRefund.view.ledger) && discountRefund.state === "failed") {
      throw fail(`The ${peso(discountRefund.amount)} discount refund for this booking failed at PayMongo. Retry it from the Payments page first, then approve this request.`, 409);
    }

    // ── 48-hour policy: the tier comes from when the customer ASKED, not now ──
    if (waiveForfeit && !String(waiveReason || "").trim()) throw fail("A reason is required to waive the deposit forfeit.", 400);
    const policy  = policyForRequest(refundRequest, payment, { waiveForfeit });
    const forfeit = policy ? policy.forfeit : 0;

    // A rental that has already started (or finished) can't be refunded by
    // approving a request — the car has been used.
    const bookingNow = await findBooking(refundRequest.bookingID);
    if (bookingNow && ["ongoing", "completed"].includes(lower(bookingNow.status))) {
      throw fail(`This booking is already ${bookingNow.status} — a refund can't be approved for a rental that has started. Reject the request instead.`, 409);
    }

    const plan = computeRefundPlan(payment, { forfeit });
    // Everything was paid online but no PayMongo payment id is on record: there is nothing PayMongo can return,
    // and it must NOT be turned into a hand-back. Say exactly that instead of "nothing to refund".
    if (plan.total <= 0 && plan.unrefundableAmount > 0) {
      throw fail(
        `${peso(plan.unrefundableAmount)} was paid online but its PayMongo payment ID is not on record. ${PAYMENT_ID_MISSING_NOTE} ` +
        "Nothing can be refunded for this request — fix the payment record (or refund it from the PayMongo dashboard), or reject the request.",
        400
      );
    }
    if (plan.total <= 0) {
      throw fail(
        forfeit > 0
          ? `Nothing to refund: the customer's payment only covers the ${peso(forfeit)} non-refundable deposit (requested ${policy.tier === "no_show" ? "after the pickup time" : policy.fromFlag ? "inside the 48-hour cut-off" : "under 48 hours before pickup"}). Reject this request, or waive the forfeit.`
          : "There is nothing to refund on this payment.",
        400
      );
    }

    // ── 3. PayMongo refunds, one per online charge ──
    const parts = [];
    for (const part of plan.parts) {
      try {
        const paymongoRefundID = await createPaymongoRefund({
          paymongoPaymentID: part.paymongoPaymentID,
          amount: part.amount,
          reason: refundRequest.customerReason,
        });
        parts.push({ kind: part.kind, paymongoPaymentID: part.paymongoPaymentID, amount: part.amount, paymongoRefundID, status: "pending" });
      } catch (e) {
        if (parts.length === 0) throw e; // nothing went out — request stays Pending, staff can just retry
        // An earlier part is ALREADY refunded at PayMongo and can't be rolled
        // back. Record exactly what happened so it isn't lost, and mark the
        // request Failed so staff finish it by hand instead of it looking untouched.
        const failedAt = new Date();
        const failedBatch = db.batch();
        failedBatch.update(reqRef, {
          status: "Failed",
          processedBy: adminUserID,
          updatedAt: failedAt,
          approvalLockedAt: admin.firestore.FieldValue.delete(),
        });
        // The rows ARE the record of which parts already went out -- written in the same commit as the status.
        await writeRefundEntries(refundRequestID, {
          request: { ...refundRequest, refundRequestID: refundRequest.refundRequestID || refundRequestID, status: "Failed", processedBy: adminUserID, processedAt: failedAt, updatedAt: failedAt },
          parts: [...parts, { kind: part.kind, paymongoPaymentID: part.paymongoPaymentID, amount: part.amount, paymongoRefundID: null, status: "failed", error: e.message }],
        }, { batch: failedBatch });
        await failedBatch.commit();
        auditSafe({
          action: "update",
          description: `Refund ${refundRequestID}: the ${part.kind} refund failed at PayMongo (${e.message}) AFTER ${parts.length} earlier part(s) had already been refunded — needs manual follow-up.`,
          userID: adminUserID,
          bookingID: refundRequest.bookingID,
          paymentID: refundRequest.paymentID,
          refundRequestID,
        });
        throw fail(`Part of the refund went through at PayMongo, but the ${part.kind} refund failed: ${e.message}. The request is marked Failed — please finish the remainder manually.`, 502);
      }
    }

    // ── 4. approved ──
    const onlineAmount = plan.total - plan.manualAmount;
    const manualRefund = plan.manualAmount > 0
      ? { amount: plan.manualAmount, issued: false, issuedBy: null, issuedAt: null, method: null }
      : null;
    const now = new Date();

    const approvedFields = {
      status: "Approved",
      toRefundAmount: plan.total,
      // onlineAmount / manualAmount are NOT stored: they are the sums of the request's "out" rows in paymentEntries
      // (hydrateRefundRequest derives them for readers). A waived forfeit stores only the boolean; its amount is the
      // deposit that was not kept and the staff reason is in the audit log line written below.
      bookingPaid: plan.grossPaid,
      depositForfeited: forfeit,
      forfeitWaived: !!(policy && policy.waived),
      ...(decisionReason && canWriteDecisionReason(claimed, cancelRow) ? { reason: decisionReason } : {}),
      updatedAt: now,
    };
    // Who approved and when are not stored on the refund request: the booking's cancellation row carries them
    // (cancelBookingForRefund writes processedBy there). The "out" rows still get them -- they are passed to the
    // rows' writer below, which is the only thing that reads them from the request.
    const approvedBy = { processedBy: adminUserID, processedAt: now };
    // parts / manualRefund / unrefundable go ONLY to paymentEntries ("out" rows), committed together with the
    // status change. Strict: if the rows can't be written the request stays Pending-with-lock, never "Approved"
    // without the PayMongo refund ids.
    const approveBatch = db.batch();
    approveBatch.update(reqRef, { ...approvedFields, approvalLockedAt: admin.firestore.FieldValue.delete(), processedBy: adminUserID, ...dropOldRefundNames() });
    const creditReturned = closeHeldCreditInBatch(approveBatch, paymentSnap.docs[0].ref, payment, {
      refundRequestID, bookingID: refundRequest.bookingID, paymentID: refundRequest.paymentID, userID: refundRequest.userID,
      processedBy: adminUserID, at: now,
    });   // approval done: the lock field is removed, not left as null
    await writeRefundEntries(refundRequestID, {
      request: { ...refundRequest, ...approvedFields, ...approvedBy, refundRequestID: refundRequest.refundRequestID || refundRequestID },
      parts, manualRefund, unrefundable: plan.unrefundable,
    }, { batch: approveBatch });
    await approveBatch.commit();

    // Tell the customer straight away — BEFORE the deposit update and the booking
    // cancel below. The PayMongo refund has already gone out, so a failure in those
    // later steps must never leave the customer without an answer. (This replaces the
    // old daily customer-backend cron that used to sweep up missed notifications.)
    await notifyCustomer(
      refundRequest.userID, refundRequest.bookingID, "refund_approved", "Refund Approved",
      `Your refund of ${peso(plan.total)} has been approved. ${returnRouteSentence({ onlineAmount, manualAmount: plan.manualAmount, qrphAmount: plan.qrphAmount })}`
      + (forfeit > 0 ? ` Your ${peso(forfeit)} deposit was kept under our 48-hour cancellation policy.` : "")
      + unrefundableSentence(plan.unrefundableAmount),
      { renotify: true }
    );

    await markDepositAfterRefund(paymentSnap.docs[0].ref, payment, forfeit);

    // Decision: the booking is cancelled at APPROVAL. Staff have decided this trip
    // isn't happening, so the car is released straight away; a PayMongo hiccup is
    // a technical retry, not a reason to keep the trip alive.
    const cancel = await cancelBookingForRefund(refundRequest.bookingID, cancelReason || "Cancelled: refund approved.", adminUserID);

    // A driver already assigned to this booking shouldn't find out secondhand.
    if (cancel.cancelled && cancel.driverID && !skipDriverNotify) {
      createNotification({
        type: "refund_request", refID: refundRequestID, refCollection: "refundRequests",
        title: "Booking cancelled — refund approved",
        message: `A booking you were assigned to (${refundRequest.bookingID}) was cancelled because its refund was approved.`,
        userID: cancel.driverID,
      }).catch((err) => console.error("[REFUND] Failed to notify assigned driver:", err.message));
    }

    auditSafe({
      action: "update",
      description: `Refund ${refundRequestID} APPROVED for ${peso(plan.total)}${creditReturned > 0 ? ` (includes ${peso(creditReturned)} held discount credit)` : ""} (${peso(onlineAmount)} via PayMongo in ${parts.length} refund(s)${manualRefund ? `, ${peso(plan.manualAmount)} to hand back manually` : ""})${plan.unrefundableAmount > 0 ? ` — ${peso(plan.unrefundableAmount)} NOT refunded: ${PAYMENT_ID_MISSING_NOTE}` : ""}${policy ? ` — 48-hour policy: ${policy.tier}${policy.hoursBeforePickup !== null ? ` (requested ${policy.hoursBeforePickup}h before pickup)` : ""}, ${forfeit > 0 ? `${peso(forfeit)} deposit kept` : policy.waived ? `${peso(policy.waivedAmount)} deposit forfeit WAIVED by staff: ${String(waiveReason).trim()}` : "nothing kept"}` : ""}. Booking ${refundRequest.bookingID}: ${cancel.cancelled ? "cancelled" : `left as ${cancel.status || "unchanged"}`}.`,
      userID: adminUserID,
      bookingID: refundRequest.bookingID,
      paymentID: refundRequest.paymentID,
      refundRequestID,
    });

    // Resolved here directly rather than left to a Firestore watcher — this backend
    // runs as a Vercel serverless function, so a background listener isn't reliable.
    resolveNotification("refund_request", refundRequestID)
      .catch((err) => console.error("[REFUND] Failed to resolve notification:", err.message));

    return { ...refundRequest, status: "Approved", toRefundAmount: plan.total, amount: plan.total, onlineAmount, manualAmount: plan.manualAmount, unrefundableAmount: plan.unrefundableAmount, bookingPaid: plan.grossPaid, grossPaid: plan.grossPaid, depositForfeited: forfeit, parts, manualRefund, bookingCancelled: cancel.cancelled };
  } catch (err) {
    await releaseLock(); // safe even if an update above already cleared it
    throw err;
  }
};

// Cancels a booking with nothing left to actually refund — either its
// payment was already refunded earlier (a data mismatch: the payment side
// finished but the booking never got cancelled to match — this is what
// Fleet.jsx's status-change flow runs into and surfaces), or genuinely
// nothing was ever collected. Same cancel + bell notification either way,
// just no PayMongo call, no email (nothing happened to their money worth
// emailing about), and no transaction log (that ledger is money-movement
// only — the audit log below is what records this instead).
const staffCancelWithNoRefund = async (bookingID, booking, payment, reason, staffUserID, outcome, contextLabel = "car status change", skipDriverNotify = false, extra = {}) => {
  const userID = payment?.userID || booking.userID || null;
  const now = new Date();

  // A booking with NO payment record has no refund to describe, so no refundRequests doc is written for it: the
  // staff cancellation row (written by cancelBookingForRefund below) already marks it resolved, and
  // getStaffRefundOutcome() reads "no_payment" back from the missing payment. Every other no-money case keeps a doc,
  // because the "Already resolved" list and a retry look it up. "outcome" is only ever "refunded" | "already_refunded" |
  // "nothing_owed" on the document: a kept deposit is nothing_owed + returnDeposit:false (extra), and the
  // "deposit_forfeited" label is derived when it is read back. The label still drives the messages below.
  if (outcome !== "no_payment") {
    const refundRequestRef = db.collection("refundRequests").doc();
    await refundRequestRef.set({
      refundRequestID: refundRequestRef.id,
      bookingID,
      paymentID: payment?.paymentID || null,
      // userID / reason live on the cancellation row cancelBookingForRefund writes below; the doc keeps only the refund's own fields.
      source: "staff",
      outcome: outcome === "deposit_forfeited" ? "nothing_owed" : outcome,
      ...extra,
      toRefundAmount: 0,
      status: "Refunded", // nothing left to do — no manual portion to issue later
      createdAt: now,
      updatedAt: now,
    });
  }

  const cancel = await cancelBookingForRefund(bookingID, `Cancelled by staff: ${reason}`, staffUserID);

  await notifyCustomer(
    userID, bookingID, "booking_cancelled", "Booking Cancelled",
    outcome === "deposit_forfeited"
      ? `Your booking was cancelled: ${reason}. Your payment only covered the non-refundable deposit, so there is nothing to refund.`
      : outcome === "already_refunded"
      ? `Your booking was cancelled: ${reason}. This booking's payment had already been refunded, so no new refund was needed.`
      : outcome === "no_payment"
        ? `Your booking was cancelled: ${reason}. No payment had been recorded for it, so there is nothing to refund.`
        : `Your booking was cancelled: ${reason}.`
  );
  emailCustomerCancelled(
    userID, bookingID, reason,
    outcome === "deposit_forfeited" ? "Your payment only covered the non-refundable deposit, so there is nothing to refund."
    : outcome === "already_refunded" ? "This booking's payment had already been refunded earlier, so no new refund was needed."
    : outcome === "no_payment"     ? "No payment had been recorded for this booking, so there is nothing to refund."
    : "Nothing had been paid for this booking, so there is nothing to refund."
  );

  if (cancel.driverID && !skipDriverNotify) {
    createNotification({
      type: "refund_request", refID: bookingID, refCollection: "bookings",
      title: "Booking cancelled",
      message: `A booking you were assigned to (${bookingID}) was cancelled by staff: ${reason}.`,
      userID: cancel.driverID,
    }).catch((err) => console.error("[REFUND] Failed to notify assigned driver:", err.message));
  }

  auditSafe({
    action: "update",
    description: outcome === "deposit_forfeited"
      ? `Booking ${bookingID} cancelled as a no-show — the payment only covered the non-refundable deposit, so nothing to refund. ${contextLabel[0].toUpperCase() + contextLabel.slice(1)}: ${reason}.`
      : outcome === "already_refunded"
      ? `Booking ${bookingID} cancelled — its payment was already refunded earlier but the booking itself hadn't been. ${contextLabel[0].toUpperCase() + contextLabel.slice(1)}: ${reason}.`
      : outcome === "no_payment"
        ? `Booking ${bookingID} cancelled — no payment record was found for it, so nothing to refund. ${contextLabel[0].toUpperCase() + contextLabel.slice(1)}: ${reason}.`
        : `Booking ${bookingID} cancelled — nothing had been paid, so nothing to refund. ${contextLabel[0].toUpperCase() + contextLabel.slice(1)}: ${reason}.`,
    userID: staffUserID,
    bookingID,
    paymentID: payment?.paymentID || null,
  });

  return { outcome, bookingID, toRefundAmount: 0, amount: 0, manualAmount: 0, bookingCancelled: cancel.cancelled };
};

// ─────────────────────────────────────────────────────────────────────────────
// Staff-initiated refund for ONE booking — used when a car is being switched
// to Maintenance/Inactive and has an upcoming booking sitting on it (see
// Fleet.jsx's status-change flow, which calls this in a loop, one booking at
// a time, stopping at the first failure — see changeCarStatus()). Unlike
// approveRefundRequest() above, there's no customer-submitted request behind
// this: staff are the ones forcing the cancellation, so this creates the
// refundRequests record AND resolves it in the same call, starting straight
// at "Approved" — there's no review step to sit in "Pending" for. This is
// the one deliberate exception to refundRequest.model.js's "admin never
// creates" note; the doc it writes carries source: "staff" so it's easy to
// tell apart from a customer-submitted one in the Refund Requests list.
//
// Returns { outcome, bookingID, amount, manualAmount, bookingCancelled }.
// outcome is one of:
//   "refunded"        — real money moved (PayMongo and/or a manual/cash
//                        portion still to be handed back in person)
//   "already_refunded"— the payment was already Refunded but the booking
//                        wasn't cancelled to match; just closes that gap
//   "nothing_owed"     — genuinely nothing had been collected; cancel only
// Only "refunded" sends the customer an email and writes a transactionLogs
// entry — the other two are anomalies (see notes in Fleet.jsx), not real
// money movement, so they're bell + audit log only.
//
// Always a FULL refund of whatever's been collected — no cancellation fee,
// since this is the business forcing the cancellation, not the customer's
// choice — and that includes any outstanding discount spillover the
// customer is still separately owed (see applyDiscount()'s refundDue) that
// hadn't been handed back yet; that gets folded into the manual amount here
// and the payment's refundIssued flag gets set so the old discount-
// correction page doesn't also try to pay it out later.
//
// Only ever called for an "upcoming" booking (never "ongoing" — the car's
// already with the customer by then, and cancelBookingForRefund() below
// won't cancel anything past "upcoming" anyway).
// ─────────────────────────────────────────────────────────────────────────────
// ─────────────────────────────────────────────────────────────────────────────
// REWORKED to follow approveRefundRequest()'s setup (claim/lock → plan →
// PayMongo parts → save → cancel → notify), so a fleet batch can no longer
// leave a half-done refund behind:
//
//   • The refundRequests doc is created FIRST (deterministic id per booking,
//     status "Pending" + approvalLockedAt) in a transaction, BEFORE PayMongo is
//     called. A double-submit gets a clean 409, and the doc always exists for
//     the refund webhook / staff to find — no orphaned PayMongo refunds.
//   • If the FIRST PayMongo part fails nothing moved → the placeholder doc is
//     deleted and a retry starts clean. If a LATER part fails, the doc is saved
//     as "Failed" with the parts that went through (same as approve).
//   • Retrying after the refund went through but the booking cancel failed
//     RESUMES (cancel + notify) instead of hitting the misleading "customer's
//     side" 409 — the doc is already "Approved".
//   • paymentID falls back to the payment doc id (Firestore rejects undefined,
//     which used to throw AFTER PayMongo had already refunded).
//   • No "_staff" total transaction log any more — the refund webhook logs each
//     PayMongo part and markManualRefundIssued() logs the manual part, so the
//     old total log double-counted the ledger. Same as approve.
//
// Returns { outcome, bookingID, amount, onlineAmount, manualAmount,
// manualRefund, bookingCancelled } exactly as before.
// ─────────────────────────────────────────────────────────────────────────────

// Everything AFTER the money is committed: cancel the booking, tell the
// customer/driver, audit. Safe to run twice: the notifications go out only when THIS call is the one that
// cancelled the booking (cancel.cancelled), so a second run finds it already cancelled and sends nothing.
// This is also what a retry runs when the first attempt died between "refund saved" and "booking cancelled"
// (it throws before notifying, so the retry is the first and only time the customer is told).
// If the booking was cancelled by someone else in between, nobody is re-notified here (accepted trade-off:
// a missed message is better than a duplicate email, and the cancel path itself notifies).
// onlineAmount / manualAmount are derived by the caller (first run) or by hydrateRefundRequest (retry).
// A staff refund keeps who / why / the customer on its cancellationRequests row (doc ID = the booking key), not on the
// refund doc: the row is written in the same step as the placeholder, before any money moves, and the final
// "booking cancelled" write (recordDirectCancellation) replaces it. Refund docs from before this change still carry
// the fields, so they win when present.
const cancelRowRef = (bookingID) => db.collection("cancellationRequests").doc(String(bookingID));

const staffRefundContext = async (r) => {
  let { userID, reason, processedBy } = r;
  if (!reason || !userID || !processedBy) {
    const snap = await cancelRowRef(r.bookingID).get();
    const row = snap.exists && snap.data().refundRequestID === r.refundRequestID ? snap.data() : {};
    userID = userID || row.userID || null;
    reason = reason || row.reason || "";
    processedBy = processedBy || row.processedBy || null;
  }
  return { userID, reason: reason || "Staff cancellation", processedBy };
};

// Abort cleanup: the placeholder refund is being deleted, so its early row goes too. Only ever deletes OUR early row
// (same refundRequestID, not a finished cancellation).
const dropEarlyCancelRow = async (bookingID, refundRequestID) => {
  try {
    const ref = cancelRowRef(bookingID);
    const snap = await ref.get();
    if (snap.exists && snap.data().refundRequestID === refundRequestID && !snap.data().cancelledBy) await ref.delete();
  } catch (e) { console.error("[REFUND] could not remove the early cancellation row:", e.message); }
};

const finishStaffRefund = async (r) => {
  const { userID, reason, processedBy } = await staffRefundContext(r);
  const refundTotal = amountOf(r);
  let cancel;
  try {
    cancel = await cancelBookingForRefund(r.bookingID, `Cancelled by staff: ${reason}`, processedBy || null);
  } catch (e) {
    throw fail(`The refund for ${r.bookingID} went through, but cancelling the booking failed: ${e.message}. Retry to finish — the refund will NOT be sent again.`, 502);
  }

  if (cancel.cancelled) {
    const manualAmount = Number(r.manualAmount) || 0;
    const onlineAmount = Number(r.onlineAmount) || 0;

    await notifyCustomer(
      userID, r.bookingID, "refund_approved", "Booking Cancelled — Refund Approved",
      `Your booking was cancelled: ${reason}. A refund of ${peso(refundTotal)} has been approved. ${returnRouteSentence({ onlineAmount, manualAmount })}`
      + (Number(r.depositForfeited) > 0 ? ` Your ${peso(r.depositForfeited)} deposit was kept because the pickup did not happen (no-show).` : "")
      + unrefundableSentence(r.unrefundableAmount)
    );

    const { email: customerEmail, name: customerName } = await resolveCustomerContact(userID);
    if (customerEmail) {
      sendRefundEmail({
        toEmail: customerEmail,
        toName: customerName,
        bookingID: r.bookingID,
        amount: refundTotal,
        manualAmount,
        depositForfeited: Number(r.depositForfeited) || 0,
        reason: reason,
      }).catch((err) => console.error("[REFUND] staff refund email failed:", err.message));
    }

    if (cancel.cancelled && cancel.driverID && !r.skipDriverNotify) {
      createNotification({
        type: "refund_request", refID: r.refundRequestID, refCollection: "refundRequests",
        title: "Booking cancelled",
        message: `A booking you were assigned to (${r.bookingID}) was cancelled by staff: ${reason}.`,
        userID: cancel.driverID,
      }).catch((err) => console.error("[REFUND] Failed to notify assigned driver:", err.message));
    }

    auditSafe({
      action: "update",
      description: `Refund ${r.refundRequestID}: booking ${r.bookingID} cancelled and ${peso(refundTotal)} refunded — ${r.contextLabel || "car status change"}: ${reason}.`,
      userID: processedBy || null,
      bookingID: r.bookingID,
      paymentID: r.paymentID,
      refundRequestID: r.refundRequestID,
    });
  }

  return {
    outcome: "refunded",
    bookingID: r.bookingID,
    toRefundAmount: refundTotal,
    amount: refundTotal,
    onlineAmount: r.onlineAmount,
    manualAmount: r.manualAmount,
    manualRefund: r.manualRefund || null,
    unrefundableAmount: Number(r.unrefundableAmount) || 0,   // paid online, no PayMongo payment ID on record
    paymentID: r.paymentID || null,
    refundRequestID: r.refundRequestID || null,
    bookingCancelled: cancel.cancelled,
  };
};

export const staffRefundBooking = async (bookingID, reason, staffUserID, opts = {}) => {
  const contextLabel = opts.contextLabel || "car status change";
  const skipDriverNotify = !!opts.skipDriverNotify; // the caller (admin Bookings flow) notifies driver + staff itself
  const startNotes = opts.notes || "Staff-initiated: car marked Maintenance/Inactive with an upcoming booking on it.";
  // true only for a no-show: the customer's deposit is kept and the rest refunded.
  // Every other staff cancellation is the business's doing → full refund, no forfeit.
  const forfeitDeposit = !!opts.forfeitDeposit;
  if (!bookingID) throw fail("bookingID is required.", 400);
  if (!reason || !reason.trim()) throw fail("A reason is required.", 400);

  const bookingSnap = await db.collection("bookings").where("bookingID", "==", bookingID).limit(1).get();
  if (bookingSnap.empty) throw fail("Booking not found.", 404);
  const booking = bookingSnap.docs[0].data();
  // "to pay" is allowed too (admin Bookings page): it has no money collected, so it
  // just falls through to the nothing-owed / no-payment cancel paths below.
  if (!["upcoming", "to pay"].includes(lower(booking.status))) {
    throw fail(`This booking is "${booking.status}", not upcoming — it can't be refunded through this flow.`, 409);
  }

  // One deterministic doc per booking — this is what makes the claim below a
  // real lock and lets a retry find what the previous attempt already did.
  const refundRequestID = `staff_${String(bookingID).replace(/[^A-Za-z0-9_-]/g, "_")}`;
  const reqRef = db.collection("refundRequests").doc(refundRequestID);

  // ── Retry of an attempt that already got past PayMongo ──
  const existingSnap = await reqRef.get();
  if (existingSnap.exists) {
    const e = await hydrateOne(existingSnap.data(), refundRequestID);
    if (["Approved", "Refunded"].includes(e.status) && e.outcome === "refunded") {
      return finishStaffRefund({ ...e, refundRequestID, contextLabel, skipDriverNotify }); // money already moved — just finish the cancel
    }
    if (e.status === "Failed") {
      throw fail(
        `A previous refund attempt for ${bookingID} failed part-way at PayMongo (${(e.parts || []).filter((p) => p.paymongoRefundID).length} part(s) already refunded). Finish it manually from the Refund Requests page — retrying here would refund those parts again.`,
        409
      );
    }
    // status "Pending": an earlier attempt crashed before PayMongo finished; the claim below re-checks the lock.
  }

  const paymentSnap = await db.collection("payments").where("bookingID", "==", bookingID).limit(1).get();
  // No payment record at all → nothing to refund, so cancel the booking
  // instead of stopping the whole status change on it.
  if (paymentSnap.empty) {
    return staffCancelWithNoRefund(bookingID, booking, { paymentID: null, userID: booking.userID || null }, reason, staffUserID, "no_payment", contextLabel, skipDriverNotify);
  }
  const paymentRef = paymentSnap.docs[0].ref;
  const payment = await hydratePaymentData(paymentSnap.docs[0].data(), paymentSnap.docs[0].id);
  const paymentID = payment.paymentID || paymentSnap.docs[0].id; // never undefined — Firestore rejects it
  const payStatus = lower(payment.status);

  // Data mismatch: payment's already Refunded, booking never got cancelled
  // to match. Nothing left to refund — just close the booking out.
  if (payStatus === "refunded") {
    return staffCancelWithNoRefund(bookingID, booking, { ...payment, paymentID }, reason, staffUserID, "already_refunded", contextLabel, skipDriverNotify);
  }

  // The customer already has their own request open for this payment — resolve
  // that one instead of racing it with a second PayMongo refund. (Our own
  // placeholder doesn't count.)
  const openCustomerRequestRaw = await findOpenRefundRequest(paymentID);
  const openCustomerRequest = openCustomerRequestRaw ? { ...(await hydrateOne(openCustomerRequestRaw, openCustomerRequestRaw.id)), id: openCustomerRequestRaw.id } : openCustomerRequestRaw;
  if (openCustomerRequest && openCustomerRequest.id !== refundRequestID) {
    const cancelReason = `Cancelled by staff: ${reason}`;

    // Still waiting on review → approve it right here (same PayMongo + cancel +
    // notify path as the Refund Requests page), instead of stopping the batch.
    if (openCustomerRequest.status === "Pending") {
      // Staff are forcing this cancellation, so the customer's 48-hour forfeit (if their
      // request carries one) is waived — they get everything back.
      const approved = await approveRefundRequest(openCustomerRequest.id, staffUserID, { cancelReason, skipDriverNotify, waiveForfeit: true, waiveReason: cancelReason });
      return {
        outcome: "refunded",
        approvedExisting: true,
        bookingID,
        toRefundAmount: approved.amount,
        amount: approved.amount,
        onlineAmount: approved.onlineAmount,
        manualAmount: approved.manualAmount,
        manualRefund: approved.manualRefund || null,
        bookingCancelled: approved.bookingCancelled,
      };
    }

    // Already "Approved" but the booking is still upcoming → the refund itself
    // went through earlier and only the cancel is missing. Finish just that;
    // never refund again.
    const cancel = await cancelBookingForRefund(bookingID, cancelReason, staffUserID);
    auditSafe({
      action: "update",
      description: `Booking ${bookingID} cancelled — its customer refund request ${openCustomerRequest.id} was already approved. ${contextLabel[0].toUpperCase() + contextLabel.slice(1)}: ${reason}.`,
      userID: staffUserID, bookingID, paymentID, refundRequestID: openCustomerRequest.id,
    });
    return {
      outcome: "refunded",
      approvedExisting: true,
      bookingID,
      toRefundAmount: amountOf(openCustomerRequest),
      amount: amountOf(openCustomerRequest),
      onlineAmount: openCustomerRequest.onlineAmount || 0,
      manualAmount: openCustomerRequest.manualAmount || 0,
      manualRefund: openCustomerRequest.manualRefund || null,
      bookingCancelled: cancel.cancelled,
    };
  }

  const userID = payment.userID || booking.userID || null;
  // No-show only: the deposit is forfeited (capped at what was paid); the pickup
  // has passed so the policy tier is always "no_show" here.
  const noShowPolicy = forfeitDeposit
    ? getRefundPolicy(payment, { pickupAt: resolvePickupAt(booking), requestedAt: new Date() })
    : null;
  const forfeit = noShowPolicy ? noShowPolicy.forfeit : 0;
  const plan = computeRefundPlan(payment, { forfeit });
  const outstandingDiscountRefund = payment.discountAmount > 0 && !payment.refundIssued ? plan.breakdown.refundDue : 0;
  const totalToRefund = plan.total + outstandingDiscountRefund;

  // Everything the customer paid is the non-refundable deposit → nothing to send back.
  if (totalToRefund === 0 && forfeit > 0) {
    await markDepositAfterRefund(paymentRef, payment, forfeit);
    return staffCancelWithNoRefund(bookingID, booking, { ...payment, paymentID }, reason, staffUserID, "deposit_forfeited", contextLabel, skipDriverNotify, { depositForfeited: forfeit, bookingPaid: plan.grossPaid, returnDeposit: false });
  }

  // Everything the customer paid was ONLINE but no PayMongo payment id is on record: nothing can be refunded
  // through PayMongo, and it must not be quietly cancelled as "nothing paid" or turned into a hand-back.
  // Same precedent as the "needs manual review" stop below: staff fix the record, or cancel without a refund.
  if (totalToRefund === 0 && plan.unrefundableAmount > 0) {
    throw fail(
      `${peso(plan.unrefundableAmount)} was paid online but its PayMongo payment ID is not on record. ${PAYMENT_ID_MISSING_NOTE} ` +
      "Fix the payment record (or refund it from the PayMongo dashboard), or cancel this booking without a refund.",
      409
    );
  }

  // Genuinely nothing collected (still Pending, etc.) — cancel only.
  if (totalToRefund === 0) {
    return staffCancelWithNoRefund(bookingID, booking, { ...payment, paymentID }, reason, staffUserID, "nothing_owed", contextLabel, skipDriverNotify);
  }

  if (!["paid", "approved"].includes(payStatus)) {
    throw fail(`This payment is "${payment.status}" with ${peso(totalToRefund)} apparently owed — needs manual review before this can be refunded automatically.`, 409);
  }

  const onlineAmount = plan.total - plan.manualAmount;
  // The cash/manual bucket also carries any outstanding discount spillover,
  // since PayMongo has no way to return that part either.
  const manualAmount = plan.manualAmount + outstandingDiscountRefund;

  // ── 1. claim: create the doc BEFORE touching PayMongo, one at a time ──
  const claimedAt = new Date();
  await db.runTransaction(async (t) => {
    const snap = await t.get(reqRef);
    const cancelRef = cancelRowRef(bookingID);
    const cancelSnap = await t.get(cancelRef);
    if (snap.exists) {
      const r = snap.data();
      if (r.status !== "Pending") throw fail(`Refund for this booking is already ${r.status}.`, 409);
      if (isLocked(r)) throw fail("This booking's refund is already being processed. Refresh in a moment.", 409);
      t.update(reqRef, { approvalLockedAt: claimedAt });
    } else {
      // Who / why lives on the cancellation row. It has refundRequestID and no cancelledBy / status, so it is not a
      // finished cancellation and not a mid-trip request until the cancel step replaces it.
      if (!cancelSnap.exists) {
        t.set(cancelRef, {
          cancellationRequestID: cancelRef.id,
          refundRequestID,
          bookingID,
          userID,
          reason,
          notes: startNotes,
          processedBy: staffUserID || null,
          createdAt: claimedAt,
        });
      }
      t.set(reqRef, {
        refundRequestID,
        bookingID,
        paymentID,
        source: "staff",
        outcome: "refunded",
        toRefundAmount: totalToRefund,
        bookingPaid: plan.grossPaid,
        depositForfeited: forfeit,
        returnDeposit: forfeit === 0,   // false only for a no-show where the deposit is kept
        status: "Pending",
        approvalLockedAt: claimedAt,
        createdAt: claimedAt,
        updatedAt: claimedAt,
      });
    }
  });

  const parts = [];
  let approvedSaved = false; // once true the doc is "Approved" and must never be deleted
  try {
    // ── 2. PayMongo refunds, one per online charge ──
    for (const part of plan.parts) {
      try {
        const paymongoRefundID = await createPaymongoRefund({
          paymongoPaymentID: part.paymongoPaymentID,
          amount: part.amount,
          reason,
        });
        parts.push({ kind: part.kind, paymongoPaymentID: part.paymongoPaymentID, amount: part.amount, paymongoRefundID, status: "pending" });
      } catch (e) {
        if (parts.length === 0) {
          // Nothing went out — drop the placeholder so a retry starts clean.
          await reqRef.delete().catch(() => {});
          await dropEarlyCancelRow(bookingID, refundRequestID);
          auditSafe({
            action: "update",
            description: `Staff refund for booking ${bookingID} failed at PayMongo for the ${part.kind} part (${e.message}). Nothing was refunded.`,
            userID: staffUserID, bookingID, paymentID,
          });
          const err = fail(`Refund failed: ${e.message}`, 502);
          err.handled = true;
          throw err;
        }
        // An earlier part is ALREADY refunded at PayMongo and can't be undone —
        // record exactly what happened and mark Failed (same as approve).
        const failedAt = new Date();
        const failedBatch = db.batch();
        failedBatch.update(reqRef, {
          status: "Failed",
          updatedAt: failedAt,
          approvalLockedAt: admin.firestore.FieldValue.delete(),
        });
        await writeRefundEntries(refundRequestID, {
          request: { refundRequestID, bookingID, paymentID, userID, status: "Failed", processedBy: staffUserID || null, processedAt: failedAt, createdAt: claimedAt, updatedAt: failedAt },
          parts: [...parts, { kind: part.kind, paymongoPaymentID: part.paymongoPaymentID, amount: part.amount, paymongoRefundID: null, status: "failed", error: e.message }],
        }, { batch: failedBatch });
        await failedBatch.commit();
        auditSafe({
          action: "update",
          description: `Staff refund ${refundRequestID}: the ${part.kind} refund failed at PayMongo (${e.message}) AFTER ${parts.length} earlier part(s) had already been refunded — needs manual follow-up.`,
          userID: staffUserID, bookingID, paymentID, refundRequestID,
        });
        const err = fail(`Part of the refund went through at PayMongo, but the ${part.kind} refund failed: ${e.message}. Marked Failed — please finish the remainder manually from the Refund Requests page.`, 502);
        err.handled = true;
        throw err;
      }
    }

    // ── 3. approved — PayMongo has the refunds; the webhook finishes them ──
    const manualRefund = manualAmount > 0
      ? { amount: manualAmount, issued: false, issuedBy: null, issuedAt: null, method: null }
      : null;
    const now = new Date();
    const staffApprovedFields = {
      status: "Approved",
      toRefundAmount: totalToRefund,
      bookingPaid: plan.grossPaid,
      depositForfeited: forfeit,
      updatedAt: now,
    };
    // Same rule as approveRefundRequest: the rows are the record, committed with the status, strict.
    const staffApproveBatch = db.batch();
    staffApproveBatch.update(reqRef, { ...staffApprovedFields, approvalLockedAt: admin.firestore.FieldValue.delete(), ...dropOldRefundNames() });
    closeHeldCreditInBatch(staffApproveBatch, paymentRef, payment, {
      refundRequestID, bookingID, paymentID, userID, processedBy: staffUserID || null, at: now,
    });   // a placeholder from before the rename may still carry the old names
    await writeRefundEntries(refundRequestID, {
      request: { refundRequestID, bookingID, paymentID, userID, ...staffApprovedFields, processedBy: staffUserID || null, processedAt: now, createdAt: claimedAt },   // the entry rows still record who / when
      parts, manualRefund, unrefundable: plan.unrefundable,
    }, { batch: staffApproveBatch });
    await staffApproveBatch.commit();
    approvedSaved = true;

    // Discount spillover is folded into this refund now, so
    // correctIssuedDiscount() must not also try to pay it later.
    await paymentRef.update({
      updatedAt: now,
      ...(outstandingDiscountRefund > 0 ? { refundIssued: true } : {}),
    });
    await markDepositAfterRefund(paymentRef, payment, forfeit);

    // ── 4. cancel the booking + notify (also what a retry re-runs) ──
    return await finishStaffRefund({
      refundRequestID, bookingID, paymentID, userID, reason,
      toRefundAmount: totalToRefund, onlineAmount, manualAmount, manualRefund, unrefundableAmount: plan.unrefundableAmount, contextLabel, skipDriverNotify,
      depositForfeited: forfeit,
      processedBy: staffUserID || null,
    });
  } catch (err) {
    // Unexpected failure (not one handled above): never leave the lock held.
    if (!err.handled && !approvedSaved) {
      if (parts.length === 0) { await reqRef.delete().catch(() => {}); await dropEarlyCancelRow(bookingID, refundRequestID); }   // nothing moved — retry starts clean
      else await reqRef.update({ approvalLockedAt: admin.firestore.FieldValue.delete() }).catch(() => {});  // parts went out but weren't saved yet
    }
    // approvedSaved: doc is already "Approved" — a retry resumes the cancel/notify.
    throw err;
  }
};

// ─────────────────────────────────────────────────────────────────────────────
// Staff confirm they physically handed back the part PayMongo can't return
// (balance collected in person, a cash deposit, …). This is what lets a request
// reach "Refunded" when it has a manual portion.
// ─────────────────────────────────────────────────────────────────────────────
export const markManualRefundIssued = async (refundRequestID, issuedBy, method = "Cash", referenceNumber = null) => {
  if (!PAYMENT_METHODS.includes(method)) {
    throw fail(`method must be one of: ${PAYMENT_METHODS.join(", ")}.`, 400);
  }
  // Optional: a GCash / bank reference for the hand-back. "", "N/A", "—" count as none.
  const refNo = nullIfSentinel(referenceNumber);
  if (refNo && refNo.length > 100) throw fail("Reference number is too long (100 characters max).", 400);
  const reqRef = db.collection("refundRequests").doc(refundRequestID);
  const entryCol = db.collection(ENTRY_COLLECTION);
  const manualRef = entryCol.doc(`${refundRequestID}_manual`);

  // The hand-back lives in the "out" row <id>_manual (paymentEntries), not on the request. The row is read and
  // flipped inside the transaction so two staff can't both mark it. Nothing is written to manualRefund on the
  // request any more: hydrate lets the row win over any leftover legacy field on the document.
  const outcome = await db.runTransaction(async (t) => {
    const snap = await t.get(reqRef);
    if (!snap.exists) throw fail("Refund request not found.", 404);
    const r = snap.data();
    if (r.status !== "Approved") throw fail(`Only an Approved refund can be marked as handed back (this one is ${r.status}).`, 409);

    const rowSnap = await t.get(entryCol.where("refundReqID", "==", refundRequestID));
    const rows = rowSnap.docs
      .map((d) => ({ id: d.id, ...d.data() }))
      .filter((e) => e.direction === "out");
    const manualRow = rows.find((e) => e.source === "in_person") || null;

    // The rows are the only source -- nothing is read from manualRefund / parts on the request document.
    const manualAmount = Number(manualRow?.amount) || 0;
    if (!manualRow || !(manualAmount > 0)) throw fail("This refund has no manual portion to hand back.", 400);
    if (manualRow.status === "success") throw fail("This has already been marked as handed back.", 409);

    const now = new Date();
    const manualRefund = { amount: manualAmount, issued: true, issuedBy: issuedBy || null, issuedAt: now, method, referenceNumber: refNo };
    // Finished only if every PayMongo part has already settled. Otherwise the
    // customer-backend webhook completes it when the last part lands.
    const finalize = rows
      .filter((e) => e.source === "online" && e.status !== "unrefundable")
      .every((e) => e.status === "success");

    t.update(reqRef, {
      updatedAt: now,
      ...(finalize ? { status: "Refunded", refundedAt: now } : {}),
    });
    t.update(manualRef, {
      status: "success", method: normalizeMethod(method).method, referenceNumber: refNo,
      processedBy: issuedBy || null, processedAt: now, settledAt: manualRow.settledAt || now, updatedAt: now,
    });
    return {
      request: { ...r, manualRefund, status: finalize ? "Refunded" : r.status },
      finalize,
    };
  });

  const r = outcome.request;

  createTransactionLog({
    bookingID: r.bookingID,
    paymentID: r.paymentID,
    refundReqID: refundRequestID,
    userID: r.userID,
    type: "Refund",
    amount: r.manualRefund.amount,
    status: "Refunded",
    paymentMethod: method,
    referenceNumber: refNo,
    description: `${peso(r.manualRefund.amount)} handed back to the customer in person (the part PayMongo couldn't return) for booking ${r.bookingID}.`,
    performedBy: issuedBy || "—",
    logID: `${refundRequestID}_manual`,
  });

  auditSafe({
    action: "update",
    description: `Refund ${refundRequestID}: ${peso(r.manualRefund.amount)} marked as handed back to the customer via ${method}${refNo ? ` (ref ${refNo})` : ""}.${outcome.finalize ? " Refund complete." : " Waiting on PayMongo to settle the remaining part(s)."}`,
    userID: issuedBy || null,
    bookingID: r.bookingID,
    paymentID: r.paymentID,
    refundRequestID,
  });

  if (outcome.finalize) {
    const now = new Date();
    if (r.paymentID) {
      const pSnap = await db.collection("payments").where("paymentID", "==", r.paymentID).limit(1).get();
      if (!pSnap.empty) await pSnap.docs[0].ref.update({ status: "Refunded", updatedAt: now });
    }
    await notifyCustomer(r.userID, r.bookingID, "refund_completed", "Refund Completed", `Your refund of ${peso(amountOf(r))} has been returned.`);
  }

  return { ...r, refundCompleted: outcome.finalize };
};

// ─────────────────────────────────────────────────────────────────────────────
// Reject a refund request — purely local, never touches PayMongo, and leaves
// the booking and payment exactly as they were.
// ─────────────────────────────────────────────────────────────────────────────
export const rejectRefundRequest = async (refundRequestID, adminUserID, reasonInput) => {
  const rejectReason = String(reasonInput || "").trim();
  const reqRef = db.collection("refundRequests").doc(refundRequestID);

  const cancelRow = await (async () => {
    const pre = await reqRef.get();
    return pre.exists ? getCancellationInfoForBooking(pre.data().bookingID).catch(() => null) : null;
  })();
  const claimedRequest = await db.runTransaction(async (t) => {
    const snap = await t.get(reqRef);
    if (!snap.exists) throw fail("Refund request not found.", 404);
    const r = snap.data();
    if (r.status !== "Pending") throw fail(`Refund request is already ${r.status}.`, 409);
    // Approval keeps the status "Pending" while it talks to PayMongo, so without this
    // a reject could slip in mid-approval — and the approval would then overwrite it
    // AFTER the money had already gone out.
    if (isLocked(r)) throw fail("This refund is being approved right now. Refresh in a moment.", 409);
    const now = new Date();
    // The status, who rejected it and why are the refund's own. (The cancellation row only keeps what the customer filled in.)
    // One field for the staff's reason: `reason`. An old document that still holds the customer's words in `reason`
    // keeps them, and the staff's reason goes to the old `rejectReason` instead.
    const reasonFields = canWriteDecisionReason(r, cancelRow)
      ? { reason: rejectReason || null, rejectReason: admin.firestore.FieldValue.delete() }
      : { rejectReason: rejectReason || null };
    t.update(reqRef, { status: "Rejected", processedBy: adminUserID, ...reasonFields, updatedAt: now });
    return r;
  });
  const refundRequest = withCancellationInfo(claimedRequest, cancelRow);
  await recordRefundRejection(refundRequest.bookingID, {
    refundRequestID, userID: refundRequest.userID || null, reason: refundRequest.customerReason, notes: refundRequest.notes,
  });

  createTransactionLog({
    bookingID: refundRequest.bookingID,
    paymentID: refundRequest.paymentID,
    refundReqID: refundRequestID,
    userID: refundRequest.userID,
    type: "Refund",
    amount: amountOf(refundRequest),
    status: "Rejected",
    description: rejectReason
      ? `Refund request rejected: ${rejectReason}`
      : `Refund request rejected.`,
    performedBy: adminUserID,
    logID: `${refundRequestID}_rejected`,
  });

  auditSafe({
    action: "update",
    description: `Refund ${refundRequestID} REJECTED (${peso(amountOf(refundRequest))})${rejectReason ? `: ${rejectReason}` : ""}.`,
    userID: adminUserID,
    bookingID: refundRequest.bookingID,
    paymentID: refundRequest.paymentID,
    refundRequestID,
  });

  await notifyCustomer(
    refundRequest.userID, refundRequest.bookingID, "refund_rejected", "Refund Rejected",
    rejectReason ? `Your refund request was rejected: ${rejectReason} Your booking will continue as scheduled.` : "Your refund request was rejected. Your booking will continue as scheduled.",
    { renotify: true }
  );

  resolveNotification("refund_request", refundRequestID)
    .catch((err) => console.error("[REFUND] Failed to resolve notification:", err.message));

  // If this booking has a driver assigned, let them know the refund tied
  // to it was rejected — they may be mid-handling something related
  // (e.g. holding cash, coordinating with the customer) and shouldn't
  // find out secondhand.
  if (refundRequest.bookingID) {
    db.collection("bookings").doc(refundRequest.bookingID).get()
      .then(async (bookingSnap) => {
        const driverID = bookingSnap.exists ? await resolveCurrentDriverID(bookingSnap.data(), bookingSnap.id) : null;
        if (!driverID) return;
        return createNotification({
          type: "refund_request",
          refID: refundRequestID,
          refCollection: "refundRequests",
          title: "Refund request rejected",
          message: rejectReason
            ? `The refund request for your booking was rejected: ${rejectReason}`
            : `The refund request for your booking was rejected.`,
          userID: driverID,
        });
      })
      .catch((err) => console.error("[REFUND] Failed to notify assigned driver:", err.message));
  }

  return { ...refundRequest, status: "Rejected", reason: rejectReason || "", rejectReason: rejectReason || null };
};

// ─────────────────────────────────────────────────────────────────────────────
// ADMIN "Refund & Cancel" / "Cancel only" from the Bookings page.
//
// Keyed by the booking's Firestore doc id (what Bookings.jsx has on each row).
// Only bookings that haven't started ("to pay"/"upcoming") — same rule as
// cancelBookingForRefund(). An ongoing trip that the customer wants to end goes
// through the cancellation-request flow instead.
//
//   refund: true  → staffRefundBooking(): PayMongo refund(s) for every online
//                   charge, cash/in-person part queued as a manual hand-back,
//                   booking → "cancelled", bookingSession closed, customer
//                   notified + emailed, audit logged. Full refund, no fee.
//   refund: false → cancel only; money is NOT returned (audit says how much
//                   was kept). Blocked while a customer refund request is open
//                   so the two can't contradict each other.
// ─────────────────────────────────────────────────────────────────────────────
const loadBookingByDocID = async (docID) => {
  const ref = db.collection("bookings").doc(docID);
  const snap = await ref.get();
  if (!snap.exists) throw fail("Booking not found.", 404);
  const booking = snap.data();
  return { ref, booking, bookingID: booking.bookingID || docID };
};

// Tells everyone who needs to know that an admin cancelled a booking:
//   • the assigned driver — ONLY if the booking has one (chauffeur bookings);
//     the user doc is checked first so a stale/deleted driverID is skipped
//   • every other Owner / Admin / Supervisor — so the team isn't surprised by
//     a booking vanishing. The person who did it is left out.
// Best-effort: a failed notification never fails the cancellation itself.
const notifyAdminCancellation = async ({ docID, bookingID, driverID, customerUserID, reason, actorID, refundedAmount = 0, retainedAmount = 0 }) => {
  const money = refundedAmount > 0 ? ` ${peso(refundedAmount)} refunded.`
              : retainedAmount > 0 ? ` No refund issued (${peso(retainedAmount)} kept).`
              : "";

  if (driverID) {
    try {
      const driverDoc = await db.collection("user").doc(driverID).get();
      if (driverDoc.exists) {
        await createNotification({
          type: "booking_cancelled", refID: docID, refCollection: "bookings",
          title: "Trip cancelled",
          message: `Booking ${bookingID}, which you were assigned to, was cancelled by an admin: ${reason}. You no longer need to do this trip.`,
          userID: driverID,
        });
      }
    } catch (err) { console.error("[REFUND] Failed to notify assigned driver:", err.message); }
  }

  try {
    const [staffSnap, { name: customerName }] = await Promise.all([
      db.collection("user").where("roleID", "in", [ROLE_IDS.OWNER, ROLE_IDS.ADMIN, ROLE_IDS.SUPERVISOR]).get(),
      resolveCustomerContact(customerUserID),
    ]);
    await Promise.all(
      staffSnap.docs
        .filter((d) => d.id !== actorID)
        .map((d) => createNotification({
          type: "booking_cancelled", refID: docID, refCollection: "bookings",
          title: "Booking cancelled by admin",
          message: `Booking ${bookingID} (${customerName}) was cancelled: ${reason}.${money}`,
          userID: d.id,
        }).catch((err) => console.error("[REFUND] Failed to notify staff member:", err.message)))
    );
  } catch (err) { console.error("[REFUND] Failed to notify staff:", err.message); }
};

export const getAdminBookingRefundPreview = async (docID) => {
  const { booking, bookingID } = await loadBookingByDocID(docID);
  const status = lower(booking.status);
  const eligible = ["to pay", "upcoming"].includes(status);
  const preview = await getBookingRefundPreview(bookingID);

  // What marking this booking as a NO-SHOW would do (deposit kept, rest refunded).
  // pickupPassed is judged by the server (Manila-correct) — the no-show option is
  // only offered once the pickup time has actually passed.
  let noShow = null;
  if (status === "upcoming") {
    const pickupAt = resolvePickupAt(booking);
    const pickupPassed = !!pickupAt && pickupAt.getTime() <= Date.now();
    const pSnap = await db.collection("payments").where("bookingID", "==", bookingID).limit(1).get();
    const payment = pSnap.empty ? null : await hydratePaymentData(pSnap.docs[0].data(), pSnap.docs[0].id);
    if (payment && lower(payment.status) !== "refunded") {
      const gross   = computeRefundPlan(payment).grossPaid;
      const forfeit = Math.min(getDepositAmount(payment), gross);
      const plan    = computeRefundPlan(payment, { forfeit });
      noShow = { pickupPassed, pickupAt, bookingPaid: gross, grossPaid: gross, forfeit, total: plan.total, onlineAmount: plan.total - plan.manualAmount, manualAmount: plan.manualAmount, unrefundableAmount: plan.unrefundableAmount };
    } else {
      noShow = { pickupPassed, pickupAt, bookingPaid: 0, grossPaid: 0, forfeit: 0, total: 0, onlineAmount: 0, manualAmount: 0 };
    }
  }
  return { bookingID, status: booking.status, eligible, ...preview, noShow };
};

export const adminCancelBooking = async (docID, { refund = true, reason } = {}, adminUserID = null) => {
  const cleanReason = String(reason || "").trim();
  if (!cleanReason) throw fail("A reason is required.", 400);

  const { booking, bookingID } = await loadBookingByDocID(docID);
  if (!["to pay", "upcoming"].includes(lower(booking.status))) {
    throw fail(`This booking is "${booking.status}". Only "to pay" or "upcoming" bookings can be cancelled here — an ongoing trip needs a cancellation request.`, 409);
  }

  if (refund) {
    const result = await staffRefundBooking(bookingID, cleanReason, adminUserID, {
      contextLabel: "admin cancellation",
      notes: "Admin-initiated: booking cancelled and refunded from the Bookings page.",
      skipDriverNotify: true, // notified once, below, together with the rest of the team
    });
    if (result.bookingCancelled) {
      await notifyAdminCancellation({
        docID, bookingID, driverID: await resolveCurrentDriverID(booking, docID), customerUserID: booking.userID,
        reason: cleanReason, actorID: adminUserID, refundedAmount: result.amount || 0,
      });
    }
    return result;
  }

  // ── cancel only, no refund ──
  const paymentSnap = await db.collection("payments").where("bookingID", "==", bookingID).limit(1).get();
  let retained = 0;
  let keepDeposit = null;   // set when the held deposit has to be closed as kept, once the booking is cancelled
  if (!paymentSnap.empty) {
    const payment = await hydratePaymentData(paymentSnap.docs[0].data(), paymentSnap.docs[0].id);
    const paymentID = payment.paymentID || paymentSnap.docs[0].id;
    const open = await findOpenRefundRequest(paymentID).catch(() => null);
    if (open) {
      throw fail("The customer has an open refund request for this booking. Approve or reject it from the Refund Requests page first.", 409);
    }
    if (lower(payment.status) !== "refunded") {
      const plan = computeRefundPlan(payment);
      // A discount credit held for the customer is money they paid on top of what they owe, and the only way it goes back is
      // with a settlement (a completed trip) or inside a refund. This booking will never be completed, so cancelling it without
      // a refund would leave that money held for good. Refund-and-cancel returns it; there is no "keep it" option here.
      if (plan.heldCredit > 0) {
        throw fail(
          `This booking holds ${peso(plan.heldCredit)} of discount credit that belongs to the customer, and it can only go back inside a refund. ` +
          "Use \"Refund & cancel\" instead of cancelling without a refund.",
          409
        );
      }
      retained = plan.total;
      keepDeposit = { ref: paymentSnap.docs[0].ref, payment };
    }
  }

  const cancel = await cancelBookingForRefund(bookingID, `Cancelled by admin: ${cleanReason}`, adminUserID);
  if (!cancel.cancelled) throw fail(`Booking could not be cancelled (status is "${cancel.status || booking.status}").`, 409);

  // Nothing is going back, so the held security deposit is kept: close it as forfeited. Left "Held" it would look like money
  // still owed to the customer, and settlement only runs for a completed trip, so nothing would ever close it. Done only
  // once the booking is really cancelled, so a failed cancel never forfeits a deposit.
  if (keepDeposit) await markDepositAfterRefund(keepDeposit.ref, keepDeposit.payment, getDepositAmount(keepDeposit.payment));

  await notifyCustomer(
    booking.userID, bookingID, "booking_cancelled", "Booking Cancelled",
    `Your booking was cancelled: ${cleanReason}.${retained > 0 ? " No refund was issued for this cancellation." : ""}`
  );
  emailCustomerCancelled(
    booking.userID, bookingID, cleanReason,
    retained > 0 ? "No refund was issued for this cancellation." : ""
  );
  await notifyAdminCancellation({
    docID, bookingID, driverID: (await resolveCurrentDriverID(booking, docID)) || cancel.driverID || null, customerUserID: booking.userID,
    reason: cleanReason, actorID: adminUserID, retainedAmount: retained,
  });
  auditSafe({
    action: "update",
    description: `Booking ${bookingID} cancelled by admin WITHOUT a refund${retained > 0 ? ` (${peso(retained)} retained)` : ""}: ${cleanReason}.`,
    userID: adminUserID, bookingID,
  });
  return { outcome: "cancelled_no_refund", bookingID, amount: 0, retainedAmount: retained, bookingCancelled: true };
};

// ─────────────────────────────────────────────────────────────────────────────
// ADMIN "Mark as no-show" from the Bookings page.
//
// For an UPCOMING booking whose pickup time has passed without the customer
// showing up (the T&C: "No-show on pickup date — deposit forfeited"). The
// customer's deposit is KEPT and everything else they paid (rental, fees, any
// balance) is refunded — same money flow as staffRefundBooking(), with the
// forfeit applied. If the customer had already asked for a refund after the
// pickup time, that request is a no-show too and is handled from the Refund
// Requests page, so this is blocked while one is open (they can't contradict
// each other).
// ─────────────────────────────────────────────────────────────────────────────
export const markBookingNoShow = async (docID, { reason } = {}, adminUserID = null) => {
  const cleanReason = String(reason || "").trim() || "No-show: the customer did not pick up the vehicle.";

  const { booking, bookingID } = await loadBookingByDocID(docID);
  if (lower(booking.status) !== "upcoming") {
    throw fail(`This booking is "${booking.status}". Only an upcoming booking can be marked as a no-show.`, 409);
  }

  const pickupAt = resolvePickupAt(booking);
  if (!pickupAt) throw fail("This booking has no pickup time, so it can't be judged as a no-show.", 400);
  if (pickupAt.getTime() > Date.now()) {
    throw fail(`The pickup time (${pickupAt.toLocaleString("en-PH", { timeZone: "Asia/Manila" })}) hasn't passed yet — a no-show can only be recorded after it.`, 409);
  }

  const paymentSnap = await db.collection("payments").where("bookingID", "==", bookingID).limit(1).get();
  if (!paymentSnap.empty) {
    const payment = paymentSnap.docs[0].data();
    const open = await findOpenRefundRequest(payment.paymentID || paymentSnap.docs[0].id).catch(() => null);
    if (open) {
      throw fail("The customer has an open refund request for this booking. Approve or reject it from the Refund Requests page first (a request made after the pickup time is already treated as a no-show).", 409);
    }
  }

  const result = await staffRefundBooking(bookingID, cleanReason, adminUserID, {
    contextLabel: "no-show",
    notes: "Admin-initiated: marked as a no-show after the pickup time passed — deposit forfeited, everything else refunded.",
    skipDriverNotify: true, // notified once, below, together with the rest of the team
    forfeitDeposit: true,
  });

  if (result.bookingCancelled) {
    await notifyAdminCancellation({
      docID, bookingID, driverID: await resolveCurrentDriverID(booking, docID), customerUserID: booking.userID,
      reason: cleanReason, actorID: adminUserID, refundedAmount: result.amount || 0,
      retainedAmount: result.amount > 0 ? 0 : (result.depositForfeited || 0),
    });
  }
  return result;
};
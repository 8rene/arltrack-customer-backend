// Approves a GRACE-WINDOW refund request inside the customer backend, so the customer backend never has to call the admin
// backend. (A request made within the grace window of paying the deposit is approved by the system, with no staff review.)
//
// This is the customer-side counterpart of approveRefundRequest() in the admin backend
// (services/refundRequest/refundRequest.service.js), with ONE difference: it NEVER calls PayMongo. The online parts are only
// RECORDED (pending, no PayMongo id yet) together with a `sendAfter` (the next Manila midnight), and the admin backend's
// cron (runScheduledRefunds) sends them after that time, exactly as for any scheduled refund. Everything else is the same:
//   1. claim the request (Pending only, one at a time)
//   2. one batch: request -> Approved, the "out" rows in paymentEntries, held discount credit closed
//   3. tell the customer, settle the deposit, cancel the booking, audit log
//
// KEEP IN SYNC with approveRefundRequest() in the admin backend: the rows and the request fields written here are what the
// admin cron, the hand-back flow and the dashboard read. Only a request made inside the grace window comes through here;
// every other request still waits for staff.
const admin = require("firebase-admin");
const { db } = require("../../config/firebaseConnection/firebase");
const { makeEntriesDb } = require("./paymentEntries.core");
const { getRefundSchedule, nextManilaMidnight, PAYMENT_ID_MISSING_NOTE } = require("./paymentBreakdown.util");
const { getDiscountFigures, closeCreditInRefund, DISCOUNT_PHASES } = require("./discountLedger.util");
const { getDepositView } = require("./depositView.util");
const { cancelBookingAfterRefund } = require("../bookings/bookingStatus.util");
const { createNotification } = require("../../services/notification/notification.service");
const { recordAudit } = require("../auditLogs/auditLogs.util");

const { writeRefundEntries } = makeEntriesDb(db);

const ENTRY_COLLECTION = "paymentEntries";
const APPROVAL_LOCK_MS = 2 * 60 * 1000;   // same as the admin backend: a stuck claim frees itself after 2 minutes
const SYSTEM_USER = "system";

const AUTO_APPROVE_REASON = "Auto-approved: requested within 2 hours of paying the deposit.";
const AUTO_CANCEL_REASON = "Cancelled: refund requested within the 2-hour grace window.";

const peso = (n) => `₱${Number(n || 0).toLocaleString()}`;
const toDateSafe = (v) => (v && v.toDate ? v.toDate() : v ? new Date(v) : null);
const fmtManilaDate = (d) => toDateSafe(d)
  ? toDateSafe(d).toLocaleDateString("en-PH", { timeZone: "Asia/Manila", month: "long", day: "numeric", year: "numeric" })
  : "the next day";

// Same wording as the admin backend.
const unrefundableSentence = (amount) =>
  Number(amount) > 0
    ? ` ${peso(amount)} could not be refunded automatically because its payment record is incomplete — please contact support about it.`
    : "";

// A grace-window refund with an online part is always scheduled, so this is only the in-store-only wording.
const returnRouteSentence = ({ onlineAmount = 0, manualAmount = 0, qrphAmount = 0 }) => {
  if (manualAmount > 0 && !(onlineAmount > 0)) {
    return `${qrphAmount > 0 ? "Payments made by QR Ph can't be refunded online. " : ""}Please visit our store to collect your ${peso(manualAmount)} refund.`;
  }
  return "Please allow up to 24 hours for PayMongo to process it — we'll notify you once it has been returned.";
};

// A discount given on a fully paid booking is HELD for the customer; it goes back INSIDE this refund (the plan already counts
// it). Closes it in the ledger in the SAME batch that approves the refund. Returns the credit it closed (0 when none).
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
    refundReqID: refundRequestID,
    penaltyID: null,
    direction: "internal",
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

// The held security deposit is no longer "Held" once the refund is approved: it went back with the refund ("Refunded"). A
// grace-window refund returns the deposit, so nothing is forfeited here. A failure never blocks the approval.
const markDepositReturned = async (paymentRef, payment) => {
  const dep = getDepositView(payment);
  if (!dep || dep.status !== "Held") return;
  const now = new Date();
  try {
    await paymentRef.update({
      securityDeposit: dep.amount,
      depositStatus: "Refunded",
      depositSettledAt: now,
      deposit: admin.firestore.FieldValue.delete(),
      updatedAt: now,
    });
  } catch (err) {
    console.error("[REFUND] failed to update the deposit status:", err.message);
  }
};

/**
 * Approves a freshly created grace-window refund request. Never calls PayMongo.
 *   refundRequestID  the refundRequests document id (status "Pending")
 *   refundRequest    the document as it was created (the customer backend just wrote it)
 *   payment          the hydrated payment the plan was computed from
 *   paymentRef       the payment's Firestore document reference
 *   plan / policy    from computeRefundQuote, at the moment the customer asked
 *   userID           the customer
 * Throws if the request could not be approved (it is left Pending for staff, and the lock is released).
 * Returns { sendAfter, onlineAmount, manualAmount, bookingCancelled }.
 */
const approveGraceWindowRefund = async ({ refundRequestID, refundRequest, payment, paymentRef, plan, policy, userID }) => {
  const reqRef = db.collection("refundRequests").doc(refundRequestID);

  // ── 1. claim ──
  await db.runTransaction(async (t) => {
    const snap = await t.get(reqRef);
    if (!snap.exists) throw new Error("Refund request not found.");
    const r = snap.data();
    if (r.status !== "Pending") throw new Error(`Refund request is already ${r.status}.`);
    const lockedAt = toDateSafe(r.approvalLockedAt);
    if (lockedAt && Date.now() - lockedAt.getTime() < APPROVAL_LOCK_MS) throw new Error("This refund is already being processed.");
    t.update(reqRef, { approvalLockedAt: new Date() });
  });
  const releaseLock = () => reqRef.update({ approvalLockedAt: admin.firestore.FieldValue.delete() }).catch(() => {});

  try {
    const now = new Date();
    if (!(plan.total > 0)) throw new Error("Nothing to refund.");

    // ── 2. the money is only RECORDED here: online parts wait for the cron ──
    // A same-day partial refund is scheduled by getRefundSchedule. Any other online part is scheduled for the next Manila
    // midnight too: this backend never sends to PayMongo itself, and an Approved request with no sendAfter would never be sent.
    const parts = plan.parts.map((part) => ({ kind: part.kind, paymongoPaymentID: part.paymongoPaymentID, amount: part.amount, paymongoRefundID: null, status: "pending" }));
    const schedule = getRefundSchedule(payment, plan, now);
    const sendAfter = parts.length > 0 ? (schedule.sendAfter || nextManilaMidnight(now)) : null;

    const onlineAmount = plan.total - plan.manualAmount;
    const manualRefund = plan.manualAmount > 0
      ? { amount: plan.manualAmount, issued: false, issuedBy: null, issuedAt: null, method: null }
      : null;

    const approvedFields = {
      status: "Approved",
      toRefundAmount: plan.total,
      bookingPaid: plan.grossPaid,
      depositForfeited: policy.forfeit || 0,
      gatewayFeeKept: plan.gatewayFeeKept,
      forfeitWaived: false,
      ...(sendAfter ? { sendAfter, scheduledAt: now } : {}),
      reason: AUTO_APPROVE_REASON,
      updatedAt: now,
    };

    // One batch: if the rows can't be written the request stays Pending, never "Approved" without its rows.
    const batch = db.batch();
    batch.update(reqRef, { ...approvedFields, approvalLockedAt: admin.firestore.FieldValue.delete(), processedBy: SYSTEM_USER });
    const creditReturned = closeHeldCreditInBatch(batch, paymentRef, payment, {
      refundRequestID, bookingID: refundRequest.bookingID, paymentID: refundRequest.paymentID, userID,
      processedBy: SYSTEM_USER, at: now,
    });
    await writeRefundEntries(refundRequestID, {
      request: { ...refundRequest, userID, ...approvedFields, processedBy: SYSTEM_USER, processedAt: now, refundRequestID },
      parts, manualRefund, unrefundable: plan.unrefundable,
    }, { batch });
    await batch.commit();

    // ── 3. after the approval is saved, nothing below may fail the approval ──
    try {
      await createNotification({
        type: "refund_approved",
        refID: refundRequest.bookingID || null,
        refCollection: "bookings",
        title: "Refund Approved",
        message: `Your refund of ${peso(plan.total)} has been approved. ${sendAfter
          ? `${schedule.deferred ? "Because your payment was made today, " : ""}${peso(onlineAmount)} will be sent to your original payment method on ${fmtManilaDate(sendAfter)}.${plan.manualAmount > 0 ? ` Please visit our store to collect the other ${peso(plan.manualAmount)}.` : ""}`
          : returnRouteSentence({ onlineAmount, manualAmount: plan.manualAmount, qrphAmount: plan.qrphAmount })}`
          + unrefundableSentence(plan.unrefundableAmount),
        userID,
      });
    } catch (err) {
      console.error("[REFUND] failed to notify the customer:", err.message);
    }

    await markDepositReturned(paymentRef, payment);

    // The booking is cancelled at approval, same as when staff approve: the car is released straight away.
    let bookingCancelled = false;
    try {
      bookingCancelled = await cancelBookingAfterRefund(refundRequest.bookingID, AUTO_CANCEL_REASON);
    } catch (err) {
      console.error("[REFUND] failed to cancel the booking after the auto-approval:", err.message);
    }

    recordAudit({
      action: "update",
      description: `Refund ${refundRequestID} AUTO-APPROVED for ${peso(plan.total)}${creditReturned > 0 ? ` (includes ${peso(creditReturned)} held discount credit)` : ""} (${peso(onlineAmount)} ${sendAfter ? `SCHEDULED for PayMongo after ${fmtManilaDate(sendAfter)}` : "online"} in ${parts.length} refund(s)${manualRefund ? `, ${peso(plan.manualAmount)} to hand back manually` : ""})${plan.unrefundableAmount > 0 ? ` — ${peso(plan.unrefundableAmount)} NOT refunded: ${PAYMENT_ID_MISSING_NOTE}` : ""} — requested inside the grace window, nothing kept. Booking ${refundRequest.bookingID}: ${bookingCancelled ? "cancelled" : "NOT cancelled (staff must check it)"}.`,
      userID: SYSTEM_USER,
      bookingID: refundRequest.bookingID,
      paymentID: refundRequest.paymentID,
      refundRequestID,
    });

    return { sendAfter, onlineAmount, manualAmount: plan.manualAmount, bookingCancelled };
  } catch (err) {
    await releaseLock();   // safe even if the batch already cleared it
    throw err;
  }
};

module.exports = { approveGraceWindowRefund, AUTO_APPROVE_REASON, AUTO_CANCEL_REASON };
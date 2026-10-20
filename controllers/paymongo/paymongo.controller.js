const { db } = require("../../config/firebaseConnection/firebase");
const { computePaymentSplit } = require("../../utils/pricing");
const { recordAudit } = require("../../utils/auditLogs/auditLogs.util");
const { recordTransactionLog } = require("../../utils/transactionLogs/transactionLogs.util");
const { BOOKING_STATUS, enforceToPayValidity, promoteBookingToUpcoming, cancelBookingAfterRefund, isDepositPaid } = require("../../utils/bookings/bookingStatus.util");
const { createNotification, notifyStaff, resolveNotification } = require("../../services/notification/notification.service");
const { axios, PAYMONGO_V1, paymongoHeaders, channelLabel } = require("../../utils/payments/paymongoClient.util");
const { settlePhasePayment, verifyAndSettlePayment, phaseOf, isPhasePaid } = require("../../utils/payments/settlePayment.util");
const { computeRefundQuote, resolvePickupAt, getPaymentBreakdown } = require("../../utils/payments/paymentBreakdown.util");
const { chargeFromPaymentResource, pickPaidPayment, feeFromRefundResource, retainedFeeShare } = require("../../utils/payments/paymongoFee.util");
const { syncPaymentEntries, syncRefundEntries, hydratePaymentData, hydrateRefundRequests } = require("../../utils/payments/paymentEntries.util");
const { createPendingRefundRow, attachRefundRowInfo } = require("../../utils/bookings/cancellationRequests.util");
const { QRPH_BOOKING_NOTICE, qrphRefundNotice } = require("../../utils/payments/refundNotice.util");
const { sessionIDForPayment, phaseForSession, findPaymentSnapBySessionID } = require("../../utils/payments/paymentSession.util");

const { handlePenaltyWebhookPaid } = require("./penaltyPayment.controller");

const lower = (v) => String(v || "").toLowerCase();

// Base URL of your frontend, e.g. https://arltrack.com — used to build success_url/cancel_url.
// MUST be set in production: if it's missing the redirect after paying goes to
// localhost and the status poll never runs (the webhook is then the only thing
// that can confirm the payment).
const FRONTEND_URL = process.env.FRONTEND_URL || "http://localhost:3000";
if (!process.env.FRONTEND_URL) {
  console.warn("[paymongo] FRONTEND_URL is not set — checkout return URLs will point at http://localhost:3000.");
}

// Maps our internal paymentMethod key -> PayMongo payment_method_types
const CHANNEL_MAP = {
  gcash: ["gcash"],
  maya:  ["paymaya"],
  qrph:  ["qrph"],
};

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/paymongo/create-link
//
// Creates a PayMongo Checkout Session for a booking (v2 API — supports
// success_url/cancel_url so the customer is redirected back to our app
// after paying, instead of staying on PayMongo's own success page).
// ─────────────────────────────────────────────────────────────────────────────
const createPaymentLink = async (req, res) => {
  const userID = req.user.userID;
  // NOTE: `amount` used to be trusted straight from the client (the browser
  // ran getPayNow() and sent the peso figure directly) — meaning anyone
  // could open devtools and check out for ₱20 instead of the real total.
  // It is intentionally no longer read from the request body: the charge
  // amount is now always derived below from the payment doc's own stored
  // grandTotal + methodOfPayment.
  // `description` is intentionally NOT read from the body any more — the checkout
  // line-item name is built on the server (below), so a client can't put arbitrary
  // text in front of the payer on PayMongo's hosted page.
  const { bookingID, paymentID, paymentMethod } = req.body;

  if (!bookingID || !paymentID) {
    return res.status(400).json({ message: "bookingID and paymentID are required." });
  }

  const paymentMethodTypes = CHANNEL_MAP[paymentMethod] || ["qrph"];
  // QR Ph can't be refunded online (PayMongo refuses it): the customer is told BEFORE they pay that a refund is collected in store.
  const isQrph = paymentMethodTypes.length === 1 && paymentMethodTypes[0] === "qrph";
  const qrphNotice = isQrph ? { notice: QRPH_BOOKING_NOTICE, refundInStoreOnly: true } : {};

  try {
    // 1. Verify the payment doc belongs to this user
    const paymentSnap = await db.collection("payments")
      .where("paymentID", "==", paymentID)
      .where("userID", "==", userID)
      .limit(1)
      .get();

    if (paymentSnap.empty) {
      return res.status(404).json({ message: "Payment record not found or access denied." });
    }

    const paymentDoc = paymentSnap.docs[0];
    // Read through paymentEntries: "staff collected the balance in person" (balanceCollected) is no longer stored on
    // the payment document, and this is the guard that stops the customer paying that balance a second time online.
    // No fallback to the bare document on purpose -- if the rows can't be read, don't open a checkout.
    const payment    = await hydratePaymentData(paymentDoc.data(), paymentDoc.id);

    // ── Only allow starting payment/confirmation if the booking's own
    // schedule is still valid (hasn't passed its 12h "to pay" window, and
    // its start date/time hasn't already gone by). This is enforced HERE
    // rather than after the fact — once PayMongo has actually charged the
    // customer there's no clean way to "un-charge" them, so the gate has
    // to sit in front of checkout, not behind it. If it's gone stale, this
    // cancels it in the same step (self-heal — see enforceToPayValidity)
    // instead of leaving it dangling as "to pay" for the next cron sweep.
    const bookingSnap = await db.collection("bookings").where("bookingID", "==", bookingID).limit(1).get();
    if (bookingSnap.empty) {
      return res.status(404).json({ message: "Booking not found." });
    }
    const booking = bookingSnap.docs[0].data();

    if (booking.status === BOOKING_STATUS.TO_PAY) {
      const stillValidStatus = await enforceToPayValidity(bookingID, booking);
      if (stillValidStatus === BOOKING_STATUS.UPCOMING) {
        // The stale-check discovered PayMongo already has this payment — it was
        // settled just now. Nothing left to pay; don't open a second checkout.
        return res.status(200).json({
          message: "This payment was already received — no need to pay again.",
          alreadyPaid: true,
          bookingID,
          phase: "deposit",
        });
      }
      if (stillValidStatus !== BOOKING_STATUS.TO_PAY) {
        return res.status(400).json({
          message: "This booking's schedule is no longer valid and it has been cancelled. Please make a new booking.",
        });
      }
    } else if (booking.status !== BOOKING_STATUS.UPCOMING) {
      // Not "to pay" and not already "upcoming" (e.g. cancelled/completed) —
      // there's nothing left here to pay for.
      return res.status(400).json({ message: "This booking can no longer be paid for." });
    }

    // Server-computed charge amount — the only amount PayMongo ever sees.
    //
    // Two-phase payment: "deposit" (the default — payNow, 50% for Partial /
    // 100% for Full) and, for Partial only, "balance" (the remaining 50%,
    // only payable once the deposit has actually cleared). phase comes from
    // the request body and defaults to "deposit" so any existing caller
    // that doesn't send it keeps behaving exactly as before.
    const phase      = req.body.phase === "balance" ? "balance" : "deposit";
    const isPartial  = String(payment.methodOfPayment).toLowerCase() === "partial";

    let amountToCharge;
    if (phase === "balance") {
      if (!isPartial) {
        return res.status(400).json({ message: "This booking doesn't have a separate balance payment." });
      }
      if (payment.status !== "paid") {
        return res.status(400).json({ message: "Please complete the deposit payment first." });
      }
      if (payment.balanceStatus === "paid") {
        return res.status(400).json({ message: "The balance has already been paid." });
      }
      if (payment.balanceCollected) {
        return res.status(400).json({ message: "The balance has already been collected in person." });
      }
      // Charge what is ACTUALLY still owed -- after any staff discount -- not the stored balanceAmount.
      // That field is a snapshot from booking time, before any discount existed, so charging it would
      // take the full balance and then hand the discount back by hand. The breakdown also covers older
      // Partial bookings that predate balanceAmount.
      const owedNow = Math.round(getPaymentBreakdown(payment).balance * 100) / 100;
      if (!(owedNow > 0)) {
        return res.status(400).json({ message: "There is no balance left to pay." });
      }
      amountToCharge = owedNow;
    } else {
      // Never open a second checkout for a deposit that's already been paid —
      // that is exactly how a customer ends up paying twice.
      if (["paid", "approved"].includes(lower(payment.status))) {
        return res.status(400).json({ message: "This booking's payment has already been received.", alreadyPaid: true });
      }
      const { payNow } = computePaymentSplit(payment.amount, payment.methodOfPayment, payment.securityDeposit);
      amountToCharge = payNow;
    }

    const amountInCentavos = Math.round(amountToCharge * 100);
    if (isNaN(amountInCentavos) || amountInCentavos < 2000) {
      return res.status(400).json({ message: "Amount must be at least ₱20.00." });
    }

    // An earlier checkout for this SAME phase may already exist. Before handing
    // that link back (or making a new one) ask PayMongo what happened to it:
    //   • it was actually PAID (webhook missed) → settle it now, don't charge again
    //   • PayMongo can't be reached              → refuse rather than risk a 2nd charge
    //   • still open                             → reuse the same link
    //   • expired                                → fall through and create a fresh session
    const phaseStatus = phase === "balance" ? payment.balanceStatus : payment.status;
    const existingSessionID = payment.currentPhase === phase && phaseStatus === "pending" ? await sessionIDForPayment(paymentDoc, phase) : null;
    if (existingSessionID) {
      const v = await verifyAndSettlePayment(paymentDoc, { source: "pay-now" });
      if (v.settled || v.alreadyPaid) {
        return res.status(200).json({
          message: "This payment was already received — no need to pay again.",
          alreadyPaid: true,
          bookingID,
          phase,
        });
      }
      if (!v.checked) {
        return res.status(503).json({
          message: "We couldn't confirm your earlier payment attempt with PayMongo just now. Please wait a moment and try again — this protects you from being charged twice.",
        });
      }
      if (!v.expired) {
        return res.status(200).json({
          message:     "Payment link already exists.",
          checkoutUrl: payment.checkoutUrl,
          linkID:      existingSessionID,
          ...qrphNotice,
        });
      }
      // expired → create a new session below
    }

    // 2. Build return URLs — success_url carries paymentID so the frontend
    //    can immediately poll /paymongo/status/:paymentID on return.
    const successUrl = `${FRONTEND_URL}/payment-return?paymentID=${paymentID}&bookingID=${bookingID}`;
    // Cancelling at PayMongo lands on My Bookings, where the unpaid booking sits
    // in the To Pay tab with a Pay Now button (Booking.jsx never read the old
    // /booking?step=4&paymentID=… params, so the customer used to land on a blank form).
    const cancelUrl   = `${FRONTEND_URL}/my-bookings?tab=to-pay`;

    // 3. Create PayMongo Checkout Session (v2)
    const sessionPayload = {
      data: {
        attributes: {
          line_items: [
            {
              name:     `ARLTrack Booking #${payment.bookingID || bookingID}${phase === "balance" ? " (Balance)" : ""}`,
              amount:   amountInCentavos,
              currency: "PHP",
              quantity: 1,
            },
          ],
          payment_method_types: paymentMethodTypes,
          success_url:          successUrl,
          cancel_url:           cancelUrl,
          reference_number:     paymentID, // easiest way to match it back in the webhook
        },
      },
    };

    const pmRes = await axios.post(
      `${PAYMONGO_V1}/checkout_sessions`,
      sessionPayload,
      { headers: paymongoHeaders() }
    );

    const sessionData = pmRes.data.data;
    const sessionID    = sessionData.id;
    const checkoutUrl  = sessionData.attributes.checkout_url;

    // 4. Save checkoutUrl to Firestore (the sessionID goes on the paymentEntries row below)
    await paymentDoc.ref.update({
      checkoutUrl,
      currentPhase:      phase,
      ...(phase === "balance" ? { balanceStatus: "pending" } : {}),
      updatedAt: new Date(),
    });

    // Record this attempt as a paymentEntries row (pending until PayMongo confirms it). The channel and the amount
    // this checkout really charges (a staff discount can make it lower than the stored balanceAmount) go to the
    // row only -- they are handed to the sync and never written on the payment document. Never throws.
    await syncPaymentEntries(paymentDoc.id, {
      fields: {
        paymongoChannel: paymentMethodTypes[0],
        paymongoTransactions: [{
          phase,
          amount:  amountToCharge,
          channel: paymentMethodTypes[0],
          source:  "online",
          status:  "pending",
          sessionID,
        }],
      },
    });

    return res.status(200).json({
      message: "Payment link created.",
      checkoutUrl,
      linkID: sessionID,
      ...qrphNotice,
    });

  } catch (error) {
    console.error("createPaymentLink error:", error?.response?.data || error.message);
    return res.status(500).json({ message: "Failed to create payment link. Please try again." });
  }
};

// ─────────────────────────────────────────────────────────────────────────────
// Refund results (payment.refund.updated)
//
// A refund can now have SEVERAL parts — one PayMongo refund per online charge
// (deposit + balance), plus an optional manual/in-person portion staff hand back
// themselves. Each part is an "out" row in paymentEntries (<refundRequestID>_part<n>,
// referenceNumber = the PayMongo refund id); the request is
// only "Refunded" once every part succeeded AND any manual portion is marked
// issued (admin: markManualRefundIssued). Runs in a transaction so two parts
// reporting at the same moment can't overwrite each other. Idempotent.
// ─────────────────────────────────────────────────────────────────────────────
// refundFee: the fee PayMongo reports on this refund, in pesos (null when it reports none). It is written on the settled "out" row
// as transactionFee, only on success and never over a fee already saved. The charge's own fee is saved elsewhere (settlePayment).
const feeOnSuccess = (rowStatus, current, refundFee) =>
  rowStatus === "success" && refundFee !== null && refundFee !== undefined && (current === undefined || current === null)
    ? { transactionFee: refundFee } : {};

// PayMongo's refund object has no fee field, so when it reports none the fee is taken from the charge being refunded: the charge's
// "in" row (matched by the pay_... id on the refund) already holds PayMongo's real fee for it (saved when it was paid). The refund
// gets its share of that fee (see retainedFeeShare). null when the charge row / fee is not there. Never guessed.
const retainedFeeForRefund = async ({ paymongoPaymentID, refundAmount }) => {
  if (!paymongoPaymentID) return null;
  const snap = await db.collection("paymentEntries").where("referenceNumber", "==", paymongoPaymentID).where("direction", "==", "in").limit(1).get();
  if (snap.empty) return null;
  const c = snap.docs[0].data();
  return retainedFeeShare({ chargeAmount: c.amount, chargeFee: c.transactionFee, refundAmount });
};

// A refund request no longer stores userID (it is on the cancellation row that carries refundRequestID). Old docs still do.
const resolveRefundUserID = async (r) => {
  if (r.userID) return r.userID;
  try {
    const row = await db.collection("cancellationRequests").where("refundRequestID", "==", r.refundRequestID).limit(1).get();
    if (!row.empty && row.docs[0].data().userID) return row.docs[0].data().userID;
    if (r.paymentID) {
      const pay = await db.collection("payments").where("paymentID", "==", r.paymentID).limit(1).get();
      if (!pay.empty) return pay.docs[0].data().userID || null;
    }
  } catch (e) {
    console.error("[PayMongo Webhook] could not resolve the customer for refund", r.refundRequestID, e.message);
  }
  return null;
};

const applyRefundPartResult = async ({ refundID, refundStatus, refundFee = null, paymongoPaymentID = null, refundAmount = null }) => {
  if (refundStatus === "succeeded" && (refundFee === null || refundFee === undefined)) {
    try { refundFee = await retainedFeeForRefund({ paymongoPaymentID, refundAmount }); }
    catch (e) { console.error("[PayMongo Webhook] could not work out the fee for refund", refundID, e.message); refundFee = null; }
  }
  // The re_... id is the referenceNumber of the refund's "out" row in paymentEntries; that row points at the request.
  let snap = { empty: true };
  const entrySnap = await db.collection("paymentEntries").where("referenceNumber", "==", refundID).where("direction", "==", "out").limit(1).get();
  const entryReqID = entrySnap.empty ? null : entrySnap.docs[0].data().refundReqID;

  // A staff-discount spillover refunded online is an "out" row with phase "discount" and NO refund request
  // (refundReqID null). There is nothing to look up: settle the row itself. Never downgrades a success.
  if (!entrySnap.empty && entrySnap.docs[0].data().phase === "discount") {
    const rowRef = entrySnap.docs[0].ref;
    const rowStatus = refundStatus === "succeeded" ? "success" : "failed";
    const out = await db.runTransaction(async (t) => {
      const cur = await t.get(rowRef);
      const d = cur.data();
      if (d.status === rowStatus || d.status === "success") return { skip: true };
      const at = new Date();
      t.update(rowRef, {
        status: rowStatus,
        settledAt: rowStatus === "success" ? (d.settledAt || at) : null,
        transactionErrorNote: rowStatus === "failed" ? "PayMongo reported the discount refund as failed." : null,
        ...feeOnSuccess(rowStatus, d.transactionFee, refundFee),
        updatedAt: at,
      });
      return { row: d, wasFailed: d.status === "failed" };
    });
    if (out.skip) return { found: true, skipped: true };
    recordTransactionLog({
      logID: `${out.row.paymentID}_discount_${refundID}`,
      bookingID: out.row.bookingID, paymentID: out.row.paymentID, userID: out.row.userID || null,
      type: "Refund", amount: out.row.amount || 0,
      status: rowStatus === "success" ? "Refunded" : "Failed",
      paymentMethod: "PayMongo", referenceNumber: refundID,
      description: rowStatus === "success"
        ? "Discount refund confirmed by PayMongo."
        : "PayMongo reported the discount refund as failed.",
    });

    // Keep the payment in step with the row. applyDiscount() marked it refundIssued when it sent the refund to PayMongo,
    // so a FAILED refund would otherwise look done: staff would never be told and could not hand the money back in
    // store (markRefundIssued refuses a payment that is already refundIssued). Failed -> it is owed again, exactly like
    // an in-store discount refund; a late success after a failure puts it back.
    try {
      const paySnap = out.row.paymentID
        ? await db.collection("payments").where("paymentID", "==", out.row.paymentID).limit(1).get()
        : { empty: true };
      if (!paySnap.empty) {
        if (rowStatus === "failed") {
          await paySnap.docs[0].ref.update({ refundIssued: false, refundDue: Number(out.row.amount) || 0, updatedAt: new Date() });
          await notifyStaff({
            type: "refund_due",
            refID: out.row.bookingID,
            refCollection: "bookings",
            title: "Refund due to customer",
            message: `The online refund of \u20b1${(Number(out.row.amount) || 0).toLocaleString()} for the discount on booking ${out.row.bookingID} failed. It needs to be returned to the customer in store.`,
          });
        } else if (out.wasFailed) {
          await paySnap.docs[0].ref.update({ refundIssued: true, refundDue: 0, updatedAt: new Date() });
          await resolveNotification("refund_due", out.row.bookingID);
        }
      }
    } catch (e) {
      console.error("[PayMongo Webhook] failed to sync the payment after a discount refund result:", e.message);
    }
    return { found: true, discount: true };
  }

  // A payout sent back online with NO refund request: the security deposit (phase "deposit_return") or the discount credit
  // held for the customer (phase "discount_return", see discountLedger.js). The admin writes each as its own "out" row, so
  // each is settled on its own. Same idea as the discount branch above: settle the row itself, never downgrade a
  // success. Failed -> staff are told to retry it or hand it back in store (the Refunds page has both buttons).
  const payoutPhase = !entrySnap.empty ? entrySnap.docs[0].data().phase : null;
  if (payoutPhase === "deposit_return" || payoutPhase === "discount_return") {
    const isCredit = payoutPhase === "discount_return";
    const word = isCredit ? "discount" : "deposit";
    const rowRef = entrySnap.docs[0].ref;
    const rowStatus = refundStatus === "succeeded" ? "success" : "failed";
    const out = await db.runTransaction(async (t) => {
      const cur = await t.get(rowRef);
      const d = cur.data();
      if (d.status === rowStatus || d.status === "success") return { skip: true };
      const at = new Date();
      t.update(rowRef, {
        status: rowStatus,
        settledAt: rowStatus === "success" ? (d.settledAt || at) : null,
        transactionErrorNote: rowStatus === "failed" ? `PayMongo reported the ${word} refund as failed.` : null,
        ...feeOnSuccess(rowStatus, d.transactionFee, refundFee),
        updatedAt: at,
      });
      return { row: d, wasFailed: d.status === "failed" };
    });
    if (out.skip) return { found: true, skipped: true };
    const row = out.row;
    const amt = Number(row.amount) || 0;
    recordTransactionLog({
      // Same logID the in-store path uses, so a payout is only ever logged as returned once. A failure gets its own id
      // so it can never block the success that follows a retry.
      logID: rowStatus === "success"
        ? (isCredit ? `${row.paymentID}_discount_returned` : `${row.paymentID}_deposit_settled`)
        : `${row.paymentID}_${payoutPhase}_failed_${refundID}`,
      bookingID: row.bookingID, paymentID: row.paymentID, userID: row.userID || null,
      type: isCredit ? "Discount" : "DepositReturn", amount: amt,
      status: rowStatus === "success" ? "Success" : "Failed",
      paymentMethod: "PayMongo", referenceNumber: refundID,
      description: rowStatus === "success"
        ? (isCredit ? "Discount credit return confirmed by PayMongo." : "Security deposit return confirmed by PayMongo.")
        : (isCredit ? "PayMongo reported the discount credit return as failed." : "PayMongo reported the security deposit return as failed."),
    });
    if (rowStatus === "success") {
      // The "refund due" alert is per booking. Only clear it when the booking's OTHER payout (the deposit when this is the
      // discount, or the discount when this is the deposit) is not still failed, or its alert would be lost.
      let otherStillFailed = false;
      try {
        const sib = await db.collection("paymentEntries").where("paymentID", "==", row.paymentID).where("direction", "==", "out").get();
        const millis = (v) => { const dt = v && v.toDate ? v.toDate() : v ? new Date(v) : null; return dt && !isNaN(dt) ? dt.getTime() : 0; };
        const newest = {};
        sib.docs.forEach((doc) => {
          const e = doc.data();
          if (e.phase !== "deposit_return" && e.phase !== "discount_return") return;
          const at = millis(e.createdAt || e.processedAt);
          if (!newest[e.phase] || at >= newest[e.phase].at) newest[e.phase] = { at, status: e.status };
        });
        otherStillFailed = Object.entries(newest).some(([phase, v]) => phase !== payoutPhase && v.status === "failed");
      } catch (e) { /* best-effort: worst case the alert stays up until staff clear it */ otherStillFailed = true; }
      if (!otherStillFailed) await resolveNotification("refund_due", row.bookingID).catch(() => {});
      if (row.userID) {
        await createNotification({
          type: "refund_completed",
          userID: row.userID,
          dedupeKey: `${payoutPhase}:${refundID}`,   // the deposit and the discount can both come back on one booking
          refID: row.bookingID || null,
          title: isCredit ? "Discount Returned" : "Deposit Returned",
          message: isCredit
            ? `Your discount of \u20b1${amt.toLocaleString()} has been returned to your original payment method.`
            : `Your security deposit of \u20b1${amt.toLocaleString()} has been returned to your original payment method.`,
        }).catch((e) => console.error(`[PayMongo Webhook] failed to write the ${word}-returned notification:`, e.message));
      }
    } else {
      await notifyStaff({
        type: "refund_due",
        refID: row.bookingID,
        refCollection: "bookings",
        title: isCredit ? "Discount return needs follow-up" : "Deposit return needs follow-up",
        message: `PayMongo could not complete the online return of the \u20b1${amt.toLocaleString()} ${word} for booking ${row.bookingID}. Retry it or hand it back in store from the Refunds page.`,
      }).catch((e) => console.error(`[PayMongo Webhook] failed to notify staff about a failed ${word} return:`, e.message));
      // The customer is told too, once (the row only moves to failed once). Staff retry it or hand it back in store.
      if (row.userID) {
        await createNotification({
          type: "refund_failed",
          userID: row.userID,
          dedupeKey: `${payoutPhase}:${refundID}`,
          refID: row.bookingID || null,
          title: isCredit ? "Discount return delayed" : "Deposit return delayed",
          message: `We couldn't send your \u20b1${amt.toLocaleString()} ${word} back to your original payment method. Our team will follow up to return it another way.`,
        }).catch((e) => console.error(`[PayMongo Webhook] failed to write the ${word}-return-failed notification:`, e.message));
      }
    }
    recordAudit({
      action: "update",
      description: rowStatus === "success"
        ? `${isCredit ? "Discount" : "Deposit"} return of \u20b1${amt.toLocaleString()} confirmed by PayMongo for booking ${row.bookingID}.`
        : `PayMongo reported the ${word} return of \u20b1${amt.toLocaleString()} as failed for booking ${row.bookingID}.`,
      userID: row.userID || null,
      bookingID: row.bookingID || null,
      paymentID: row.paymentID || null,
    });
    return isCredit ? { found: true, discountReturn: true } : { found: true, depositReturn: true };
  }
  if (entryReqID) {
    const byEntry = await db.collection("refundRequests").doc(entryReqID).get();
    if (byEntry.exists) snap = { empty: false, docs: [byEntry] };
  }
  if (snap.empty) snap = await db.collection("refundRequests").where("paymongoRefundID", "==", refundID).limit(1).get(); // legacy single-refund requests
  if (snap.empty) {
    console.warn("[PayMongo Webhook] payment.refund.updated — no matching refundRequest for refundID:", refundID);
    return { found: false };
  }

  const reqRef     = snap.docs[0].ref;
  const partStatus = refundStatus === "succeeded" ? "succeeded" : "failed";

  const outcome = await db.runTransaction(async (t) => {
    const s2 = await t.get(reqRef);
    const r  = s2.data();

    // The parts live in paymentEntries ("out" rows), not on the request. All reads come before any write.
    const rowsSnap = await t.get(db.collection("paymentEntries").where("refundReqID", "==", r.refundRequestID || reqRef.id));
    const outRows  = rowsSnap.docs.filter((d) => d.data().direction === "out");
    const partRows  = outRows.filter((d) => d.data().source === "online" && d.data().status !== "unrefundable");
    const manualRow = outRows.find((d) => d.data().source === "in_person");
    const target    = partRows.find((d) => d.data().referenceNumber === refundID);

    if (target) {
      const rowStatus = partStatus === "succeeded" ? "success" : "failed";
      const td = target.data();
      if (td.status === rowStatus) return { skip: true }; // duplicate delivery

      const statuses          = partRows.map((d) => (d.id === target.id ? rowStatus : d.data().status));
      const anyFailed         = statuses.some((s) => s === "failed");
      const allSucceeded      = statuses.every((s) => s === "success");
      const manualOutstanding = !!(manualRow && manualRow.data().status !== "success");
      const newStatus = anyFailed ? "Failed" : (allSucceeded && !manualOutstanding ? "Refunded" : r.status);
      const at = new Date();

      t.update(target.ref, { status: rowStatus, settledAt: rowStatus === "success" ? (td.settledAt || at) : null, ...feeOnSuccess(rowStatus, td.transactionFee, refundFee), updatedAt: at });
      t.update(reqRef, { status: newStatus, updatedAt: at });
      return {
        request:   { ...r, status: newStatus },
        part:      { kind: td.phase, amount: td.amount },
        finalized: newStatus === "Refunded" && r.status !== "Refunded",
        failedNow: newStatus === "Failed"   && r.status !== "Failed",
      };
    }

    // No row carries this refund id: a request that was never migrated to paymentEntries. Fall back to the
    // request's own parts[]. Requests created before multi-part refunds have no parts[] — treat the
    // single paymongoRefundID as one part covering the whole amount.
    const parts = Array.isArray(r.parts) && r.parts.length
      ? r.parts.map((x) => ({ ...x }))
      : [{ kind: "deposit", paymongoRefundID: r.paymongoRefundID, amount: Number(r.amount ?? r.toRefundAmount) || 0, status: "pending" }];

    const idx = parts.findIndex((x) => x.paymongoRefundID === refundID);
    if (idx < 0) return { skip: true };
    if (parts[idx].status === partStatus) return { skip: true }; // duplicate delivery
    parts[idx].status = partStatus;

    const anyFailed         = parts.some((x) => x.status === "failed");
    const allSucceeded      = parts.every((x) => x.status === "succeeded");
    const manualOutstanding = !!(r.manualRefund && !r.manualRefund.issued);
    const newStatus = anyFailed ? "Failed" : (allSucceeded && !manualOutstanding ? "Refunded" : r.status);

    t.update(reqRef, { parts, status: newStatus, updatedAt: new Date() });
    return {
      legacy:    true,
      request:   { ...r, parts, status: newStatus },
      part:      parts[idx],
      finalized: newStatus === "Refunded" && r.status !== "Refunded",
      failedNow: newStatus === "Failed"   && r.status !== "Failed",
    };
  });

  if (outcome.skip) return { found: true, skipped: true };
  if (outcome.legacy) {
    await syncRefundEntries(reqRef.id); // un-migrated request: derive its "out" rows now. Never throws.
    // The derived row has no fee yet: save this refund's fee on it (same rule as feeOnSuccess: success only, never over a saved fee).
    if (partStatus === "succeeded" && refundFee !== null && refundFee !== undefined) {
      try {
        const rs = await db.collection("paymentEntries").where("referenceNumber", "==", refundID).where("direction", "==", "out").limit(1).get();
        if (!rs.empty && (rs.docs[0].data().transactionFee === undefined || rs.docs[0].data().transactionFee === null)) {
          await rs.docs[0].ref.update({ transactionFee: refundFee, updatedAt: new Date() });
        }
      } catch (e) { console.error("[PayMongo Webhook] could not save the fee on the migrated refund row:", e.message); }
    }
  }
  const { request: r, part } = outcome;
  const now = new Date();
  const customerID = await resolveRefundUserID(r);

  recordTransactionLog({
    logID: `${r.refundRequestID}_refund_${refundID}`,
    bookingID: r.bookingID,
    paymentID: r.paymentID,
    refundReqID: r.refundRequestID,
    userID: customerID || null,
    type: "Refund",
    amount: part.amount || 0,
    status: partStatus === "succeeded" ? "Refunded" : "Failed",
    paymentMethod: "PayMongo",
    referenceNumber: refundID,
    description: partStatus === "succeeded"
      ? `Refund of the ${part.kind || "payment"} charge confirmed by PayMongo.`
      : `PayMongo reported the refund of the ${part.kind || "payment"} charge as failed.`,
  });

  if (outcome.finalized) {
    if (r.paymentID) {
      const paymentSnap = await db.collection("payments").where("paymentID", "==", r.paymentID).limit(1).get();
      if (!paymentSnap.empty) await paymentSnap.docs[0].ref.update({ status: "Refunded", updatedAt: now }); // when it completed is NOT stored on the payment: it is the latest settledAt of the request's "out" rows (admin derives it)
    }
    // Approval already cancels the booking; this only matters for requests
    // approved before that rule existed. No-op if already cancelled/started.
    await cancelBookingAfterRefund(r.bookingID, "Cancelled: refund completed.").catch(() => {});

    recordAudit({
      action: "update",
      description: `Refund ${r.refundRequestID} completed — ₱${Number(r.toRefundAmount ?? r.amount ?? 0).toLocaleString()} returned for payment ${r.paymentID}.`,
      userID: customerID || null,
      bookingID: r.bookingID || null,
      paymentID: r.paymentID,
      refundRequestID: r.refundRequestID,
    });
    if (customerID) {
      await createNotification({
        type: "refund_completed",
        userID: customerID,
        refID: r.bookingID || null,
        title: "Refund Completed",
        message: `Your refund of ₱${Number(r.toRefundAmount ?? r.amount ?? 0).toLocaleString()} has been returned.`,
      }).catch((e) => console.error("[PayMongo Webhook] failed to write refund_completed notification:", e.message));
    }
  } else if (partStatus === "failed") {
    recordAudit({
      action: "update",
      description: `Refund ${r.refundRequestID}: PayMongo reported the ${part.kind || ""} refund as failed.`,
      userID: customerID || null,
      bookingID: r.bookingID || null,
      paymentID: r.paymentID,
      refundRequestID: r.refundRequestID,
    });
    if (outcome.failedNow && customerID) {
      await createNotification({
        type: "refund_failed",
        userID: customerID,
        refID: r.bookingID || null,
        title: "Refund Failed",
        message: `Your approved refund of ₱${Number(r.toRefundAmount ?? r.amount ?? 0).toLocaleString()} could not be completed by PayMongo. Please contact support.`,
      }).catch((e) => console.error("[PayMongo Webhook] failed to write refund_failed notification:", e.message));
    }
  }

  return { found: true, finalized: !!outcome.finalized };
};

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/paymongo/webhook
//
// Subscribe to `checkout_session.payment.paid` in your PayMongo dashboard
// (Settings → Webhooks) — this replaces the old `payment.paid` event since
// we moved from Links to Checkout Sessions.
// ─────────────────────────────────────────────────────────────────────────────
const handleWebhook = async (req, res) => {
  const webhookSecret = process.env.PAYMONGO_WEBHOOK_SECRET;

  // The secret is REQUIRED. Without it there is nothing to verify the request
  // against, and this endpoint has no auth middleware (PayMongo calls it
  // directly) — so a forged POST could mark any pending payment "paid" for free.
  // Refuse instead of silently skipping verification. (PayMongo retries on a
  // non-2xx, so a real event isn't lost once the secret is set.)
  if (!webhookSecret) {
    console.error("PayMongo webhook: PAYMONGO_WEBHOOK_SECRET is not set — rejecting request.");
    return res.status(503).json({ message: "Webhook not configured." });
  }

  const sigHeader = req.headers["paymongo-signature"];

  // Whenever a webhook secret IS configured, a signature header is
  // mandatory — not optional. The old check here was
  // `if (webhookSecret && sigHeader)`, which only ran verification when
  // BOTH were present. That meant anyone could skip verification
  // entirely just by leaving the Paymongo-Signature header off their
  // request — this endpoint has no auth middleware (PayMongo calls it
  // directly), so a forged POST with a real paymentID could mark any
  // pending payment "paid" for free. Failing closed here (reject when
  // secret is set but header is missing) closes that gap.
  if (webhookSecret && !sigHeader) {
    console.warn("PayMongo webhook: missing signature header while a webhook secret is configured — rejecting.");
    return res.status(400).json({ message: "Missing signature." });
  }

  if (webhookSecret && sigHeader) {
    const crypto = require("crypto");
    const parts  = {};
    sigHeader.split(",").forEach(part => {
      const [k, v] = part.split("=");
      parts[k] = v;
    });

    // Must sign the EXACT bytes PayMongo sent — re-stringifying the parsed
    // req.body can produce different key order/spacing and will silently
    // never match. req.rawBody is captured by the express.json({ verify })
    // hook in index.js; fall back to JSON.stringify only if that's missing.
    const rawBody = req.rawBody ? req.rawBody.toString("utf8") : JSON.stringify(req.body);
    const toSign  = `${parts.t}.${rawBody}`;
    const hmac    = crypto.createHmac("sha256", webhookSecret).update(toSign).digest("hex");

    // Constant-time comparison — a plain `===` bails out at the first
    // differing character, so how long the check takes leaks how many
    // leading hex characters an attacker's guess got right. That's a
    // narrow, largely theoretical attack over a network (a lot of
    // requests needed per character), but timingSafeEqual closes it for
    // free. It throws on mismatched buffer lengths instead of returning
    // false, so length is checked first — a missing/malformed `te`/`li`
    // segment just fails the comparison instead of crashing the request.
    const safeEqual = (a, b) => {
      if (typeof a !== "string" || typeof b !== "string") return false;
      const bufA = Buffer.from(a, "utf8");
      const bufB = Buffer.from(b, "utf8");
      if (bufA.length !== bufB.length) return false;
      return crypto.timingSafeEqual(bufA, bufB);
    };
    const isValid = safeEqual(hmac, parts.te) || safeEqual(hmac, parts.li);

    if (!isValid) {
      console.warn("PayMongo webhook: invalid signature");
      return res.status(400).json({ message: "Invalid signature." });
    }
  }

  const event     = req.body;
  const eventType = event?.data?.attributes?.type;
  const session    = event?.data?.attributes?.data; // checkout_session object

  console.log("[PayMongo Webhook] event type:", eventType);

  if (!eventType || !session) {
    return res.status(200).json({ received: true });
  }

  try {
    // We set reference_number = paymentID when creating the session
    const paymentID = session?.attributes?.reference_number;
    const sessionID = session?.id;

    // Penalty checkouts carry reference_number = "PENCO-…" — they have no payments doc, so route them separately.
    if (typeof paymentID === "string" && paymentID.startsWith("PENCO-")) {
      if (eventType === "checkout_session.payment.paid") await handlePenaltyWebhookPaid({ checkoutID: paymentID, session });
      return res.status(200).json({ received: true });
    }

    if (eventType === "checkout_session.payment.paid") {
      let paymentSnap;
      if (paymentID) {
        paymentSnap = await db.collection("payments").where("paymentID", "==", paymentID).limit(1).get();
      } else if (sessionID) {
        paymentSnap = await findPaymentSnapBySessionID(sessionID);
      }

      if (!paymentSnap || paymentSnap.empty) {
        console.warn("[PayMongo Webhook] no matching payment found. sessionID:", sessionID, "paymentID:", paymentID);
        return res.status(200).json({ received: true });
      }

      const paymentDoc = paymentSnap.docs[0];
      // The phase comes from WHICH checkout paid, not from the payment's current phase (see phaseForSession).
      const phase      = (await phaseForSession(paymentDoc, sessionID)) || phaseOf(paymentDoc.data());

      // The checkout_session payload embeds the underlying PayMongo payment
      // under attributes.payments — that payment's own id (not the session id)
      // is what the Refunds API needs.
      const paymentResource   = pickPaidPayment(session?.attributes?.payments);
      const paymongoPaymentID = paymentResource?.id || null;
      // PayMongo's own transaction fee for this charge (fee / net_amount on the same object).
      const charge = chargeFromPaymentResource(paymentResource);

      // settlePhasePayment is transactional + idempotent: if the status poll
      // (or the stale-check) already settled this phase it returns
      // { alreadyPaid: true } and does nothing — no duplicate logs/notifications.
      const result = await settlePhasePayment({ paymentRef: paymentDoc.ref, phase, paymongoPaymentID, source: "webhook", charge });
      console.log(`[PayMongo Webhook] ${phase} payment ${result.settled ? "settled" : "already settled"} for booking:`, paymentDoc.data().bookingID, "paymongoPaymentID:", paymongoPaymentID);

      return res.status(200).json({ received: true });
    }

    // ACK all other event types (e.g. checkout_session.payment.failed, if you enable it)
    if (eventType === "checkout_session.payment.failed") {
      const now = new Date();
      let paymentSnap;
      if (paymentID) {
        paymentSnap = await db.collection("payments").where("paymentID", "==", paymentID).limit(1).get();
      } else if (sessionID) {
        paymentSnap = await findPaymentSnapBySessionID(sessionID);
      }
      if (paymentSnap && !paymentSnap.empty) {
        const failedDoc     = paymentSnap.docs[0];
        const failedPayment = failedDoc.data();
        const phase         = (await phaseForSession(failedDoc, sessionID)) || phaseOf(failedPayment);

        // A "failed" event can arrive after the customer already retried
        // successfully on the same checkout page — never downgrade a paid phase.
        if (isPhasePaid(failedPayment, phase)) return res.status(200).json({ received: true });

        if (phase === "balance") {
          // The deposit is real money already collected — a failed BALANCE attempt
          // never affects the booking, it just needs another try.
          await failedDoc.ref.update({
            balanceStatus: "failed",   // the row's "failed" status is derived from this by the sync below
            updatedAt: now,
          });
          await syncPaymentEntries(failedDoc.id);
          if (failedPayment.userID) {
            await createNotification({
              type: "payment_failed",
              userID: failedPayment.userID,
              refID: failedPayment.bookingID || null,
              title: "Payment Failed",
              message: "Your balance payment could not be processed. You can try again from My Bookings, or pay the balance at pickup.",
            }).catch((e) => console.error("[PayMongo Webhook] failed to write payment_failed notification:", e.message));
          }
        } else {
          // Deposit attempt failed. The booking REMAINS "to pay" and the payment
          // stays "pending" so the customer can retry — on the same checkout
          // page or via Pay Now. (Cancelling here used to strand customers who
          // simply mistyped a step, and a retry that then succeeded arrived for
          // an already-cancelled booking.) The 12-hour window still cleans it up
          // if it's never paid.
          await failedDoc.ref.update({ lastPaymentFailedAt: now, updatedAt: now });
          if (failedPayment.userID) {
            await createNotification({
              type: "payment_failed",
              userID: failedPayment.userID,
              refID: failedPayment.bookingID || null,
              title: "Payment Failed",
              message: "Your payment could not be processed. Your booking is still reserved — open My Bookings › To Pay to try again. Unpaid bookings are cancelled automatically after 12 hours.",
            }).catch((e) => console.error("[PayMongo Webhook] failed to write payment_failed notification:", e.message));
          }
        }
      }
      return res.status(200).json({ received: true });
    }

    // ─────────────────────────────────────────────────────────────────────
    // payment.refund.updated — PayMongo confirming a refund we created (via the
    // Refunds API from the admin backend after an admin approves a
    // RefundRequest) has settled, one way or another.
    // NOTE: the actual event name PayMongo sends is "payment.refund.updated"
    // (per their webhook docs — "refund.updated" on its own does not exist
    // and will never match, silently leaving requests stuck on "Approved").
    // The refund object's own `payment_id` field is what we'd match on,
    // but we actually match by the refund's own `id` since that's what
    // the admin backend stores on the RefundRequest right after creating
    // it — NOT paymentID/sessionID like the events above, since this
    // event isn't about the checkout_session at all.
    // ─────────────────────────────────────────────────────────────────────
    if (eventType === "payment.refund.updated") {
      const refund       = event?.data?.attributes?.data; // refund object
      const refundStatus = refund?.attributes?.status;    // pending | succeeded | failed
      const refundID     = refund?.id;

      if (!refundID || !refundStatus) {
        console.warn("[PayMongo Webhook] payment.refund.updated missing refund id/status.");
        return res.status(200).json({ received: true });
      }
      // Only act on terminal states — "pending" just means still processing.
      if (refundStatus !== "succeeded" && refundStatus !== "failed") {
        return res.status(200).json({ received: true });
      }
      await applyRefundPartResult({
        refundID, refundStatus,
        refundFee: feeFromRefundResource(refund),                                    // null: PayMongo puts no fee on a refund
        paymongoPaymentID: refund?.attributes?.payment_id || null,                   // the charge this refund returns money from
        refundAmount: Number.isFinite(Number(refund?.attributes?.amount)) ? Number(refund.attributes.amount) / 100 : null,
      });
      return res.status(200).json({ received: true });
    }

    return res.status(200).json({ received: true });

  } catch (error) {
    // Reaching this point means the event passed signature verification but we then FAILED to
    // process it (Firestore error, a bug...). Answering 200 here told PayMongo "got it", so it
    // never retried — a payment could be taken and never recorded. A non-2xx makes PayMongo
    // deliver the event again. Safe to repeat: settlePhasePayment is transactional + idempotent,
    // and the cases that need no action (unknown event, no matching payment, already settled)
    // all return 200 explicitly above and never reach this catch.
    console.error("handleWebhook error:", error.message);
    return res.status(500).json({ received: false, message: "Webhook processing failed; please retry." });
  }
};

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/paymongo/status/:paymentID
// ─────────────────────────────────────────────────────────────────────────────
const getPaymentStatus = async (req, res) => {
  const userID    = req.user.userID;
  const { paymentID } = req.params;

  if (!paymentID) {
    return res.status(400).json({ message: "paymentID is required." });
  }

  try {
    const snap = await db.collection("payments")
      .where("paymentID", "==", paymentID)
      .where("userID", "==", userID)
      .limit(1)
      .get();

    if (snap.empty) {
      return res.status(404).json({ message: "Payment not found." });
    }

    const doc         = snap.docs[0];
    const p           = doc.data();
    const phase       = phaseOf(p);
    const phaseStatus = phase === "balance" ? p.balanceStatus : p.status;

    if (isPhasePaid(p, phase)) {
      return res.status(200).json({ status: "paid", bookingID: p.bookingID, phase });
    }

    // Poll on the CURRENT phase's own status (the generic `status` stays "paid"
    // forever once the deposit clears). verifyAndSettlePayment asks PayMongo and,
    // if the customer did pay, settles it through the same transactional path the
    // webhook uses — so whichever of the two wins the race, the other is a no-op.
    if (phaseStatus === "pending" && await sessionIDForPayment(doc, phase)) {
      const v = await verifyAndSettlePayment(doc, { source: "status-poll" });
      if (v.settled || v.alreadyPaid) {
        return res.status(200).json({ status: "paid", bookingID: p.bookingID, phase });
      }
      return res.status(200).json({
        status: phaseStatus,
        bookingID: p.bookingID,
        checkoutUrl: p.checkoutUrl || null,
        phase,
        expired: !!v.expired,
        verified: !!v.checked,
      });
    }

    return res.status(200).json({
      status:      phaseStatus,
      bookingID:   p.bookingID,
      checkoutUrl: p.checkoutUrl || null,
      phase,
    });

  } catch (error) {
    console.error("getPaymentStatus error:", error.message);
    return res.status(500).json({ message: "Failed to fetch payment status." });
  }
};

const VALID_REFUND_REASONS = [
  "Cancelled trip",
  "Overcharged",
  "Service issue",
  "Duplicate payment",
  "Other",
];

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/paymongo/refunds
// Customer submits a refund request for one of their own paid payments. This
// only writes a Pending refundRequests doc; nothing is sent to PayMongo until
// staff approve it in the admin app.
//
// The refund covers EVERYTHING the customer has paid (deposit + any balance,
// whether that balance went through PayMongo or staff collected it in person) —
// computeRefundPlan() works out how much PayMongo can return and how much staff
// hand back themselves. Only bookings that haven't started ("upcoming") can be
// refunded; an unpaid ("to pay") booking has nothing to refund and is simply
// cancelled instead.
// ─────────────────────────────────────────────────────────────────────────────
const peso = (n) => `₱${Number(n || 0).toLocaleString()}`;

// An open (Pending/Approved) refund request for this payment, if any.
// Pass a Firestore transaction as `tx` to do the read inside it.
const findOpenRefundRequest = async (paymentID, tx = null) => {
  const query = db.collection("refundRequests")
    .where("paymentID", "==", paymentID)
    .where("status", "in", ["Pending", "Approved"])
    .limit(1);
  const snap = tx ? await tx.get(query) : await query.get();
  return snap.empty ? null : snap.docs[0].data();
};

// A refund request staff already rejected is final: the customer can't file another one for the same payment.
// (A "Failed" request -- the PayMongo refund itself errored -- is not a decision, so that one can still be retried.)
const findRejectedRefundRequest = async (paymentID) => {
  const snap = await db.collection("refundRequests")
    .where("paymentID", "==", paymentID)
    .where("status", "==", "Rejected")
    .limit(1)
    .get();
  return snap.empty ? null : snap.docs[0].data();
};

// Loads + validates everything a refund quote needs. Shared by requestRefund
// (which creates the request) and previewRefund (which shows the customer the
// amount first). Returns { error: { status, message } } or { payment, booking }.
const loadRefundContext = async (userID, paymentID) => {
  const paymentSnap = await db.collection("payments")
    .where("paymentID", "==", paymentID)
    .where("userID", "==", userID)
    .limit(1)
    .get();

  if (paymentSnap.empty) {
    return { error: { status: 404, message: "Payment not found or access denied." } };
  }

  // The refund plan needs the PayMongo payment ids / channel, which live in paymentEntries rows now.
  const payment = await hydratePaymentData(paymentSnap.docs[0].data(), paymentSnap.docs[0].id);

  // "paid" = confirmed through PayMongo, "Approved" = confirmed by staff (cash).
  if (!["paid", "approved"].includes(lower(payment.status))) {
    return { error: { status: 400, message: "Only paid payments can be refunded." } };
  }

  if (await findRejectedRefundRequest(paymentID)) {
    return { error: { status: 403, message: "Your refund request for this booking was already rejected, so it can't be requested again. Please contact support if you need help." } };
  }

  // ── The booking must not have started ──
  const bookingSnap = await db.collection("bookings").where("bookingID", "==", payment.bookingID).limit(1).get();
  if (bookingSnap.empty) {
    return { error: { status: 404, message: "Booking not found for this payment." } };
  }
  const booking = bookingSnap.docs[0].data();
  let bookingStatus = booking.status;
  if (bookingStatus === BOOKING_STATUS.TO_PAY && isDepositPaid(payment)) {
    // Booking created under the older rule (deposit paid but still "to pay") — heal it first.
    const promo = await promoteBookingToUpcoming(payment.bookingID);
    bookingStatus = promo.bookingStatus || bookingStatus;
  }
  if (bookingStatus !== BOOKING_STATUS.UPCOMING) {
    const msg = bookingStatus === BOOKING_STATUS.ONGOING
      ? "A refund can't be requested once the rental has started. Please contact support."
      : bookingStatus === BOOKING_STATUS.CANCELLED
        ? "This booking is already cancelled."
        : "Refunds can only be requested for upcoming bookings.";
    return { error: { status: 400, message: msg } };
  }

  return { payment, booking };
};

// What a refund requested at `requestedAt` is worth under the 48-hour policy
// (Terms & Conditions → Cancellation & Refund Policy):
//   48 hours or more before pickup  → everything paid is refunded
//   under 48 hours / after pickup   → everything paid EXCEPT the deposit
// The timing is judged by when the customer ASKS, never when staff approve.
const quoteCustomerRefund = (payment, booking, requestedAt) => {
  const pickupAt = resolvePickupAt(booking);
  // The 2-hour "booked by mistake" grace runs from when the deposit was paid (the booking only becomes real then);
  // older payments without that timestamp fall back to when the booking was created.
  const bookedAt = payment.paidAt || booking.createdAt || null;
  const { policy, plan } = computeRefundQuote(payment, { pickupAt, requestedAt, bookedAt });
  return { policy, plan, pickupAt };
};

const nothingToRefundMessage = (policy, plan) =>
  plan.unrefundableAmount > 0 && plan.total <= 0
    ? `We couldn't find the payment reference for ${peso(plan.unrefundableAmount)} of this payment, so it can't be refunded automatically. Please contact support and we'll sort it out.`
  : policy.forfeit > 0 && plan.grossPaid > 0
    ? `There's nothing to refund: because the pickup is less than ${policy.windowHours} hours away (or has passed), your ${peso(policy.forfeit)} deposit is non-refundable and your payment only covers that.`
    : "There's nothing to refund on this payment.";

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/paymongo/refunds/preview/:paymentID
// Shows the customer EXACTLY what a refund would be if they asked right now
// (tier, deposit kept, amount returned), before they submit anything.
// The server's clock is the only one that counts — the number shown here is
// the number requestRefund() will lock in if they submit.
// ─────────────────────────────────────────────────────────────────────────────
const previewRefund = async (req, res) => {
  const userID = req.user.userID;
  const { paymentID } = req.params;

  try {
    const ctx = await loadRefundContext(userID, paymentID);
    if (ctx.error) return res.status(ctx.error.status).json({ eligible: false, message: ctx.error.message });

    if (await findOpenRefundRequest(paymentID)) {
      return res.status(200).json({ eligible: false, message: "A refund request for this payment is already in progress." });
    }

    const requestedAt = new Date();
    const { policy, plan, pickupAt } = quoteCustomerRefund(ctx.payment, ctx.booking, requestedAt);

    return res.status(200).json({
      eligible: plan.total > 0,
      message: plan.total > 0 ? null : nothingToRefundMessage(policy, plan),
      tier: policy.tier,                           // "full" | "late" | "no_show"
      graceApplied: !!policy.graceApplied,         // asked within graceHours of booking: deposit goes back even though it's "late"
      graceHours: policy.graceHours,
      windowHours: policy.windowHours,             // 48
      hoursBeforePickup: policy.hoursBeforePickup, // null when the pickup time is unknown
      pickupAt,
      fullRefundUntil: policy.fullRefundUntil || null,
      grossPaid: plan.grossPaid,                   // everything paid
      depositAmount: policy.depositAmount,
      depositForfeited: policy.forfeit,            // kept (0 for a full refund)
      refundAmount: plan.total,                    // what the customer gets back
      onlineAmount: plan.total - plan.manualAmount,
      manualAmount: plan.manualAmount,
      unrefundableAmount: plan.unrefundableAmount, // paid online but no payment reference on record
      heldCredit: plan.heldCredit,                 // a discount held for the customer: money they already paid, so it is inside refundAmount
      qrphAmount: plan.qrphAmount,                 // the part paid by QR Ph: PayMongo can't refund it, so it is collected in store
      inStoreOnly: plan.qrphAmount > 0,
      notice: plan.qrphAmount > 0 ? qrphRefundNotice(plan.qrphAmount) : null,
      unknownTiming: policy.unknownTiming,
      asOf: requestedAt,
    });
  } catch (error) {
    console.error("previewRefund error:", error.message);
    return res.status(500).json({ message: "Failed to calculate the refund." });
  }
};

const requestRefund = async (req, res) => {
  const userID = req.user.userID;
  const { paymentID, reason, notes } = req.body;

  if (!paymentID || !reason) {
    return res.status(400).json({ message: "paymentID and reason are required." });
  }
  if (!VALID_REFUND_REASONS.includes(reason)) {
    return res.status(400).json({ message: "Invalid reason." });
  }

  try {
    const ctx = await loadRefundContext(userID, paymentID);
    if (ctx.error) return res.status(ctx.error.status).json({ message: ctx.error.message });
    const { payment, booking } = ctx;

    if (await findOpenRefundRequest(paymentID)) {
      return res.status(409).json({ message: "A refund request for this payment is already in progress." });
    }

    // The moment the customer asked — set by the SERVER, so it can't be spoofed.
    // This is what the 48-hour window is measured from; approving later never changes it.
    const now = new Date();
    const { policy, plan, pickupAt } = quoteCustomerRefund(payment, booking, now);
    if (plan.total <= 0) {
      return res.status(400).json({ message: nothingToRefundMessage(policy, plan) });
    }
    const refundRef = db.collection("refundRequests").doc();
    // Who asked and why (userID / reason / notes) live on the pending cancellation row, not on the refund doc.
    // parts[] / manualRefund / unrefundable[] are written as "out" rows in paymentEntries on staff approval, and
    // onlineAmount / manualAmount are derived from them.
    const refundRequest = {
      refundRequestID: refundRef.id,
      bookingID: payment.bookingID || null,
      paymentID,
      toRefundAmount: plan.total,                // what the customer gets back: everything paid, minus the deposit if it's under 48 hours
      bookingPaid: plan.grossPaid,               // everything the customer had paid
      returnDeposit: !(policy.forfeit > 0),      // the 48-hour verdict, locked at the moment of the request: false = the deposit is kept
      depositGraceApplied: !!policy.graceApplied, // true = under 48h, but asked within the grace window so the deposit goes back
      depositForfeited: policy.forfeit,          // kept from the refund (0 when the deposit goes back)
      status: "Pending",
      createdAt: now,                            // the moment the customer asked (server time) -- the 48-hour window is measured from it
      updatedAt: now,
    };
    // The "already in progress?" check above is only a cheap early exit. Two requests that arrive at
    // the same moment (double-click, retry, script) can BOTH pass it before either has written
    // anything, which created two Pending requests for one payment. So the check is repeated INSIDE
    // a transaction together with the write: Firestore lets one through, and the other re-runs,
    // sees the first one's request and is turned away.
    const created = await db.runTransaction(async (tx) => {
      if (await findOpenRefundRequest(paymentID, tx)) return false; // reads first...
      tx.set(refundRef, refundRequest);                              // ...then writes
      createPendingRefundRow(refundRef.id, { bookingID: payment.bookingID || null, userID, reason, notes: notes || "", createdAt: now }, tx);
      return true;
    });
    if (!created) {
      return res.status(409).json({ message: "A refund request for this payment is already in progress." });
    }

    const tierNote = policy.graceApplied
      ? ` (under ${policy.windowHours}h before pickup, but asked within ${policy.graceHours}h of booking; deposit returned)`
      : policy.forfeit > 0
      ? ` (${policy.tier === "no_show" ? "after pickup time" : `under ${policy.windowHours}h before pickup`}; ${peso(policy.forfeit)} deposit withheld)`
      : "";

    recordAudit({
      action: "create",
      description: `Refund requested by customer for payment ${paymentID}: ${peso(plan.total)} of ${peso(plan.grossPaid)} paid${tierNote} (reason: ${reason}).`,
      userID,
      bookingID: payment.bookingID || null,
      paymentID,
      refundRequestID: refundRef.id,
    });

    // One notification PER staff member, each with their own userID — the admin
    // bell only shows notifications addressed to the signed-in staff member, so
    // the previous single userID-less doc was never shown to anyone.
    await notifyStaff({
      type: "refund_request",
      refID: refundRef.id,
      refCollection: "refundRequests",
      title: "Refund Request",
      message: `A refund request for ${peso(plan.total)} is awaiting review${tierNote}.`,
    });

    return res.status(201).json({
      message: policy.forfeit > 0
        ? `Refund request sent. Because it was made ${policy.tier === "no_show" ? "after your pickup time" : `less than ${policy.windowHours} hours before pickup`}, your ${peso(policy.forfeit)} deposit is non-refundable. ${peso(plan.total)} will be returned once it's reviewed.`
        : "Refund request sent. We'll notify you once it's reviewed.",
      ...(plan.qrphAmount > 0 ? { notice: qrphRefundNotice(plan.qrphAmount), inStoreOnly: true, qrphAmount: plan.qrphAmount } : {}),
      ...(plan.unrefundableAmount > 0 ? { warning: `${peso(plan.unrefundableAmount)} of this payment has no payment reference on record and can't be refunded automatically — our staff will review it.` } : {}),
      // The stored doc is slimmer now; the response still carries what the customer app showed before.
      refundRequest: { ...refundRequest, userID, reason, notes: notes || "", amount: plan.total, grossPaid: plan.grossPaid },
    });
  } catch (error) {
    console.error("requestRefund error:", error.message);
    return res.status(500).json({ message: "Failed to submit refund request." });
  }
};

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/paymongo/refunds/mine
// Lists the logged-in customer's own refund requests (newest first).
// ─────────────────────────────────────────────────────────────────────────────
// userID is no longer on every refund doc (staff-created and newer requests keep it on the cancellation row), so a
// customer's refunds are found through their payments too. Old docs that still carry userID match either way.
const loadMyRefunds = async (userID) => {
  const docs = new Map();
  const byUser = await db.collection("refundRequests").where("userID", "==", userID).get();
  byUser.forEach((d) => docs.set(d.id, d));
  const paySnap = await db.collection("payments").where("userID", "==", userID).get();
  const paymentIDs = [...new Set(paySnap.docs.map((d) => d.data().paymentID || d.id))];
  for (let i = 0; i < paymentIDs.length; i += 30) {
    const s = await db.collection("refundRequests").where("paymentID", "in", paymentIDs.slice(i, i + 30)).get();
    s.forEach((d) => docs.set(d.id, d));
  }
  // parts[] / manualRefund / unrefundable[] are rebuilt from the refund's paymentEntries rows; who / why / the decision
  // come from the cancellation row. amount / grossPaid are the old names of toRefundAmount / bookingPaid.
  const hydrated = await hydrateRefundRequests([...docs.values()].map((d) => d.data()));
  return (await attachRefundRowInfo(hydrated)).map((r) => ({ ...r, amount: r.amount ?? r.toRefundAmount, grossPaid: r.grossPaid ?? r.bookingPaid }));
};

const getMyRefundRequests = async (req, res) => {
  const userID = req.user.userID;

  try {
    const requests = (await loadMyRefunds(userID))
      .sort((a, b) => {
        const aT = a.createdAt?.toDate ? a.createdAt.toDate() : new Date(a.createdAt);
        const bT = b.createdAt?.toDate ? b.createdAt.toDate() : new Date(b.createdAt);
        return bT - aT;
      });

    return res.status(200).json({ data: requests });
  } catch (error) {
    console.error("getMyRefundRequests error:", error.message);
    return res.status(500).json({ message: "Failed to fetch refund requests." });
  }
};

module.exports = { createPaymentLink, handleWebhook, getPaymentStatus, requestRefund, previewRefund, getMyRefundRequests };
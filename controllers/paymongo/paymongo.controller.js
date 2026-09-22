const { db } = require("../../config/firebaseConnection/firebase");
const { computePaymentSplit } = require("../../utils/pricing");
const { recordAudit } = require("../../utils/auditLogs/auditLogs.util");
const { recordTransactionLog } = require("../../utils/transactionLogs/transactionLogs.util");
const { BOOKING_STATUS, enforceToPayValidity, promoteBookingToUpcoming, cancelBookingAfterRefund, isDepositPaid } = require("../../utils/bookings/bookingStatus.util");
const { createNotification, notifyStaff } = require("../../services/notification/notification.service");
const { axios, PAYMONGO_V1, paymongoHeaders, channelLabel } = require("../../utils/payments/paymongoClient.util");
const { settlePhasePayment, verifyAndSettlePayment, phaseOf, isPhasePaid } = require("../../utils/payments/settlePayment.util");
const { computeRefundPlan } = require("../../utils/payments/paymentBreakdown.util");

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
  const { bookingID, paymentID, description, paymentMethod } = req.body;

  if (!bookingID || !paymentID) {
    return res.status(400).json({ message: "bookingID and paymentID are required." });
  }

  const paymentMethodTypes = CHANNEL_MAP[paymentMethod] || ["qrph"];

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
    const payment    = paymentDoc.data();

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
      // Older Partial bookings predate the balanceAmount field — derive it.
      amountToCharge = Number(payment.balanceAmount)
        || Math.max(0, (Number(payment.amount) || 0) - computePaymentSplit(payment.amount, payment.methodOfPayment).payNow);
    } else {
      // Never open a second checkout for a deposit that's already been paid —
      // that is exactly how a customer ends up paying twice.
      if (["paid", "approved"].includes(lower(payment.status))) {
        return res.status(400).json({ message: "This booking's payment has already been received.", alreadyPaid: true });
      }
      const { payNow } = computePaymentSplit(payment.amount, payment.methodOfPayment);
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
    if (payment.paymongoSessionID && payment.currentPhase === phase && phaseStatus === "pending") {
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
          linkID:      payment.paymongoSessionID,
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
              name:     description || `ARLTrack Booking #${bookingID}${phase === "balance" ? " (Balance)" : ""}`,
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

    // 4. Save sessionID + checkoutUrl to Firestore
    await paymentDoc.ref.update({
      paymongoSessionID: sessionID,
      paymongoChannel:   paymentMethodTypes[0],
      checkoutUrl,
      currentPhase:      phase,
      ...(phase === "balance" ? { balanceStatus: "pending" } : {}),
      updatedAt: new Date(),
    });

    return res.status(200).json({
      message: "Payment link created.",
      checkoutUrl,
      linkID: sessionID,
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
// themselves. refundRequests.parts[] tracks each PayMongo refund; the request is
// only "Refunded" once every part succeeded AND any manual portion is marked
// issued (admin: markManualRefundIssued). Runs in a transaction so two parts
// reporting at the same moment can't overwrite each other. Idempotent.
// ─────────────────────────────────────────────────────────────────────────────
const applyRefundPartResult = async ({ refundID, refundStatus }) => {
  let snap = await db.collection("refundRequests").where("paymongoRefundIDs", "array-contains", refundID).limit(1).get();
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
    // Requests created before multi-part refunds have no parts[] — treat the
    // single paymongoRefundID as one part covering the whole amount.
    const parts = Array.isArray(r.parts) && r.parts.length
      ? r.parts.map((x) => ({ ...x }))
      : [{ kind: "deposit", paymongoRefundID: r.paymongoRefundID, amount: Number(r.amount) || 0, status: "pending" }];

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
      request:   { ...r, parts, status: newStatus },
      part:      parts[idx],
      finalized: newStatus === "Refunded" && r.status !== "Refunded",
      failedNow: newStatus === "Failed"   && r.status !== "Failed",
    };
  });

  if (outcome.skip) return { found: true, skipped: true };
  const { request: r, part } = outcome;
  const now = new Date();

  recordTransactionLog({
    logID: `${r.refundRequestID}_refund_${refundID}`,
    bookingID: r.bookingID,
    paymentID: r.paymentID,
    refundRequestID: r.refundRequestID,
    userID: r.userID || null,
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
      if (!paymentSnap.empty) await paymentSnap.docs[0].ref.update({ status: "Refunded", refundedAt: now, updatedAt: now });
    }
    // Approval already cancels the booking; this only matters for requests
    // approved before that rule existed. No-op if already cancelled/started.
    await cancelBookingAfterRefund(r.bookingID, "Cancelled: refund completed.").catch(() => {});

    recordAudit({
      action: "update",
      description: `Refund ${r.refundRequestID} completed — ₱${Number(r.amount || 0).toLocaleString()} returned for payment ${r.paymentID}.`,
      userID: r.userID || null,
      bookingID: r.bookingID || null,
      paymentID: r.paymentID,
      refundRequestID: r.refundRequestID,
    });
    if (r.userID) {
      await createNotification({
        type: "refund_completed",
        userID: r.userID,
        refID: r.bookingID || null,
        title: "Refund Completed",
        message: `Your refund of ₱${Number(r.amount || 0).toLocaleString()} has been returned.`,
      }).catch((e) => console.error("[PayMongo Webhook] failed to write refund_completed notification:", e.message));
    }
  } else if (partStatus === "failed") {
    recordAudit({
      action: "update",
      description: `Refund ${r.refundRequestID}: PayMongo reported the ${part.kind || ""} refund as failed.`,
      userID: r.userID || null,
      bookingID: r.bookingID || null,
      paymentID: r.paymentID,
      refundRequestID: r.refundRequestID,
    });
    if (outcome.failedNow && r.userID) {
      await createNotification({
        type: "refund_failed",
        userID: r.userID,
        refID: r.bookingID || null,
        title: "Refund Failed",
        message: `Your approved refund of ₱${Number(r.amount || 0).toLocaleString()} could not be completed by PayMongo. Please contact support.`,
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

    if (eventType === "checkout_session.payment.paid") {
      let paymentSnap;
      if (paymentID) {
        paymentSnap = await db.collection("payments").where("paymentID", "==", paymentID).limit(1).get();
      } else if (sessionID) {
        paymentSnap = await db.collection("payments").where("paymongoSessionID", "==", sessionID).limit(1).get();
      }

      if (!paymentSnap || paymentSnap.empty) {
        console.warn("[PayMongo Webhook] no matching payment found. sessionID:", sessionID, "paymentID:", paymentID);
        return res.status(200).json({ received: true });
      }

      const paymentDoc = paymentSnap.docs[0];
      const phase      = phaseOf(paymentDoc.data());

      // The checkout_session payload embeds the underlying PayMongo payment
      // under attributes.payments — that payment's own id (not the session id)
      // is what the Refunds API needs.
      const paymongoPaymentID = (session?.attributes?.payments || [])[0]?.id || null;

      // settlePhasePayment is transactional + idempotent: if the status poll
      // (or the stale-check) already settled this phase it returns
      // { alreadyPaid: true } and does nothing — no duplicate logs/notifications.
      const result = await settlePhasePayment({ paymentRef: paymentDoc.ref, phase, paymongoPaymentID, source: "webhook" });
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
        paymentSnap = await db.collection("payments").where("paymongoSessionID", "==", sessionID).limit(1).get();
      }
      if (paymentSnap && !paymentSnap.empty) {
        const failedDoc     = paymentSnap.docs[0];
        const failedPayment = failedDoc.data();
        const phase         = phaseOf(failedPayment);

        // A "failed" event can arrive after the customer already retried
        // successfully on the same checkout page — never downgrade a paid phase.
        if (isPhasePaid(failedPayment, phase)) return res.status(200).json({ received: true });

        if (phase === "balance") {
          // The deposit is real money already collected — a failed BALANCE attempt
          // never affects the booking, it just needs another try.
          await failedDoc.ref.update({ balanceStatus: "failed", updatedAt: now });
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
      await applyRefundPartResult({ refundID, refundStatus });
      return res.status(200).json({ received: true });
    }

    return res.status(200).json({ received: true });

  } catch (error) {
    console.error("handleWebhook error:", error.message);
    return res.status(200).json({ received: true });
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
    if (phaseStatus === "pending" && p.paymongoSessionID) {
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
    const paymentSnap = await db.collection("payments")
      .where("paymentID", "==", paymentID)
      .where("userID", "==", userID)
      .limit(1)
      .get();

    if (paymentSnap.empty) {
      return res.status(404).json({ message: "Payment not found or access denied." });
    }

    const payment = paymentSnap.docs[0].data();

    // "paid" = confirmed through PayMongo, "Approved" = confirmed by staff (cash).
    if (!["paid", "approved"].includes(lower(payment.status))) {
      return res.status(400).json({ message: "Only paid payments can be refunded." });
    }

    // ── The booking must not have started ──
    const bookingSnap = await db.collection("bookings").where("bookingID", "==", payment.bookingID).limit(1).get();
    if (bookingSnap.empty) {
      return res.status(404).json({ message: "Booking not found for this payment." });
    }
    let bookingStatus = bookingSnap.docs[0].data().status;
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
      return res.status(400).json({ message: msg });
    }

    const existingSnap = await db.collection("refundRequests")
      .where("paymentID", "==", paymentID)
      .where("status", "in", ["Pending", "Approved"])
      .limit(1)
      .get();
    if (!existingSnap.empty) {
      return res.status(409).json({ message: "A refund request for this payment is already in progress." });
    }

    const plan = computeRefundPlan(payment);
    if (plan.total <= 0) {
      return res.status(400).json({ message: "There's nothing to refund on this payment." });
    }
    const onlineAmount = plan.total - plan.manualAmount;

    const refundRef = db.collection("refundRequests").doc();
    const now = new Date();
    const refundRequest = {
      refundRequestID: refundRef.id,
      bookingID: payment.bookingID || null,
      paymentID,
      userID,
      reason,
      notes: notes || "",
      amount: plan.total,          // everything paid (deposit + balance), net of any staff discount
      onlineAmount,                // returned through PayMongo
      manualAmount: plan.manualAmount, // handed back by staff (balance collected in person, cash, etc.)
      status: "Pending",
      paymongoRefundID: null,      // legacy: first PayMongo refund id (set on approval)
      paymongoRefundIDs: [],       // every PayMongo refund id (set on approval)
      parts: [],                   // per-charge refund tracking (set on approval)
      manualRefund: null,          // { amount, issued, ... } (set on approval)
      processedBy: null,
      processedAt: null,
      rejectReason: null,
      createdAt: now,
      updatedAt: now,
    };
    await refundRef.set(refundRequest);

    recordAudit({
      action: "create",
      description: `Refund requested by customer for payment ${paymentID}: ₱${plan.total.toLocaleString()} (reason: ${reason}).`,
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
      message: `A refund request for ₱${plan.total.toLocaleString()} is awaiting review.`,
    });

    return res.status(201).json({
      message: "Refund request sent. We'll notify you once it's reviewed.",
      refundRequest,
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
const getMyRefundRequests = async (req, res) => {
  const userID = req.user.userID;

  try {
    const snap = await db.collection("refundRequests")
      .where("userID", "==", userID)
      .get();

    const requests = snap.docs
      .map(d => d.data())
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

module.exports = { createPaymentLink, handleWebhook, getPaymentStatus, requestRefund, getMyRefundRequests };

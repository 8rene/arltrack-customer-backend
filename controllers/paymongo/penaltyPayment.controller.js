const { db } = require("../../config/firebaseConnection/firebase");
const { axios, PAYMONGO_V1, paymongoHeaders, retrieveCheckoutSession } = require("../../utils/payments/paymongoClient.util");
const { CHECKOUTS, listUnpaidForBooking, unpaidTotal, settlePenaltyCheckout, owedOn, listPendingCheckouts } = require("../../utils/payments/penaltyPayment.util");

const { getSystemSettings, computePenaltyCheckoutFees } = require("../../utils/pricing");

const FRONTEND_URL = process.env.FRONTEND_URL || "http://localhost:3000";

// Same channels the booking checkout offers.
const CHANNEL_MAP = { gcash: ["gcash"], maya: ["paymaya"], qrph: ["qrph"] };
const MIN_CENTAVOS = 2000; // PayMongo minimum: ₱20.00

const newCheckoutID = () => `PENCO-${db.collection(CHECKOUTS).doc().id}`;

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/paymongo/penalty/create-link   { bookingID, paymentMethod }
//
// Opens a PayMongo checkout for everything this booking's customer still owes
// in confirmed penalties. The amount is computed here, never read from the body.
//
// The customer also pays the online payment (gateway) fee on it. Each penalty carries the gatewayFeeRate that was in
// System Settings when it was created, and is charged at that rate on what it still owes (a penalty from before
// the rate was saved uses the current setting). The fee is a SEPARATE line on the checkout and is not part of
// the penalty: the penalty's own amount / paidAmount only ever move by the penalty money (see settlePenaltyCheckout).
//   checkout.amount         = what the customer is charged in total (penaltyAmount + gatewayFee)
//   checkout.penaltyAmount  = the penalty money inside it
//   checkout.gatewayFee     = the online payment fee inside it
//   checkout.lines          = [{ penaltyID, amount, rate, fee }] per penalty, so settlement gives each its own fee
//   checkout.gatewayFeeRate = the one % every line shares (null when the penalties were created at different rates)
// ─────────────────────────────────────────────────────────────────────────────
const createPenaltyPaymentLink = async (req, res) => {
  const userID = req.user.userID;
  const { bookingID, paymentMethod } = req.body;
  if (!bookingID) return res.status(400).json({ message: "bookingID is required." });

  const channel = CHANNEL_MAP[paymentMethod] || CHANNEL_MAP.qrph;

  try {
    const bookingSnap = await db.collection("bookings").where("bookingID", "==", bookingID).limit(1).get();
    if (bookingSnap.empty) return res.status(404).json({ message: "Booking not found." });
    if (bookingSnap.docs[0].data().userID !== userID) {
      return res.status(403).json({ message: "This booking does not belong to your account." });
    }

    // An earlier attempt may exist. Ask PayMongo what happened to it before
    // opening another one — it may already be paid (webhook slow) and we must
    // never charge twice.
    const pendingSnap = await db.collection(CHECKOUTS)
      .where("bookingID", "==", bookingID).where("userID", "==", userID).where("status", "==", "pending").get();
    for (const d of pendingSnap.docs) {
      const c = d.data();
      const v = await retrieveCheckoutSession(c.sessionID);
      if (!v.ok) {
        return res.status(503).json({ message: "We couldn't confirm your earlier payment attempt with PayMongo just now. Please wait a moment and try again — this protects you from being charged twice." });
      }
      if (v.paid) {
        await settlePenaltyCheckout({ checkoutRef: d.ref, paymongoPaymentID: v.paymongoPaymentID, charge: v.charge, source: "pay-now" });
      } else if (v.expired) {
        await d.ref.update({ status: "expired", updatedAt: new Date() });
      }
    }

    const unpaid = await listUnpaidForBooking(userID, bookingID);
    const penaltyAmount = unpaidTotal(unpaid);
    if (!(penaltyAmount > 0)) {
      return res.status(200).json({ message: "There's nothing left to pay on this booking's penalties.", alreadyPaid: true, bookingID });
    }
    const settings = await getSystemSettings();
    const fee = computePenaltyCheckoutFees(
      unpaid.map((p) => ({ penaltyID: p.penaltyID || p._ref.id, owed: owedOn(p), gatewayFeeRate: p.gatewayFeeRate })),
      settings.gatewayFeePercent
    );
    const amount = fee.total;                       // what the customer is actually charged
    const centavos = Math.round(amount * 100);
    if (centavos < MIN_CENTAVOS) {
      return res.status(400).json({ message: "Online payment needs at least ₱20.00. Please pay this small balance in store." });
    }

    // Reuse a still-open link for the same amount instead of piling up sessions.
    const open = await db.collection(CHECKOUTS)
      .where("bookingID", "==", bookingID).where("userID", "==", userID).where("status", "==", "pending").get();
    const reusable = open.docs.map((d) => d.data()).find((c) => num2(c.amount) === amount && c.channel === channel[0]);
    if (reusable) {
      return res.status(200).json({
        message: "Payment link already exists.", checkoutUrl: reusable.checkoutUrl, checkoutID: reusable.checkoutID,
        amount, penaltyAmount: fee.penaltyAmount, gatewayFee: fee.gatewayFee, gatewayFeeRate: fee.gatewayFeeRate,
      });
    }

    const checkoutID = newCheckoutID();
    const pmRes = await axios.post(`${PAYMONGO_V1}/checkout_sessions`, {
      data: { attributes: {
        line_items: [
          { name: `ARLTrack Booking #${bookingID} (Penalty)`, amount: Math.round(fee.penaltyAmount * 100), currency: "PHP", quantity: 1 },
          ...(fee.gatewayFee > 0
            ? [{ name: fee.gatewayFeeRate ? `Online payment fee (${fee.gatewayFeeRate}%)` : "Online payment fee", amount: Math.round(fee.gatewayFee * 100), currency: "PHP", quantity: 1 }]
            : []),
        ],
        payment_method_types: channel,
        success_url: `${FRONTEND_URL}/payment-return?penaltyCheckoutID=${checkoutID}&bookingID=${bookingID}`,
        cancel_url:  `${FRONTEND_URL}/my-bookings?tab=history`,
        reference_number: checkoutID,   // webhook matches on this (PENCO- prefix = penalty checkout)
      } },
    }, { headers: paymongoHeaders() });

    const session = pmRes.data.data;
    const checkoutUrl = session.attributes.checkout_url;
    const now = new Date();
    await db.collection(CHECKOUTS).doc(checkoutID).set({
      checkoutID, bookingID, userID, amount, channel: channel[0],
      penaltyAmount: fee.penaltyAmount, gatewayFee: fee.gatewayFee, gatewayFeeRate: fee.gatewayFeeRate, lines: fee.lines,
      sessionID: session.id, checkoutUrl, status: "pending",
      createdAt: now, updatedAt: now,
    });

    return res.status(200).json({
      message: "Payment link created.", checkoutUrl, checkoutID,
      amount, penaltyAmount: fee.penaltyAmount, gatewayFee: fee.gatewayFee, gatewayFeeRate: fee.gatewayFeeRate,
    });
  } catch (error) {
    console.error("createPenaltyPaymentLink error:", error?.response?.data || error.message);
    return res.status(500).json({ message: "Failed to create payment link. Please try again." });
  }
};
const num2 = (v) => Math.round((Number(v) || 0) * 100) / 100;

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/paymongo/penalty/status/:checkoutID
// The return page polls this; if PayMongo says it's paid we settle it here
// (same transactional path as the webhook, so whichever lands first wins).
// ─────────────────────────────────────────────────────────────────────────────
const getPenaltyPaymentStatus = async (req, res) => {
  const userID = req.user.userID;
  const { checkoutID } = req.params;
  try {
    const ref = db.collection(CHECKOUTS).doc(checkoutID);
    const snap = await ref.get();
    if (!snap.exists || snap.data().userID !== userID) {
      return res.status(404).json({ message: "Payment not found." });
    }
    const c = snap.data();
    if (c.status === "paid") return res.status(200).json({ status: "paid", bookingID: c.bookingID });
    if (c.status === "expired") return res.status(200).json({ status: "failed", bookingID: c.bookingID });

    const v = await retrieveCheckoutSession(c.sessionID);
    if (v.ok && v.paid) {
      await settlePenaltyCheckout({ checkoutRef: ref, paymongoPaymentID: v.paymongoPaymentID, charge: v.charge, source: "status-poll" });
      return res.status(200).json({ status: "paid", bookingID: c.bookingID });
    }
    if (v.ok && v.expired) {
      await ref.update({ status: "expired", updatedAt: new Date() });
      return res.status(200).json({ status: "failed", bookingID: c.bookingID });
    }
    return res.status(200).json({ status: "pending", bookingID: c.bookingID, verified: !!v.ok });
  } catch (error) {
    console.error("getPenaltyPaymentStatus error:", error.message);
    return res.status(500).json({ message: "Failed to fetch payment status." });
  }
};

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/paymongo/penalty/outstanding
// Unpaid confirmed penalties per booking, for the customer's History tab
// (one request instead of one per booking card).
// ─────────────────────────────────────────────────────────────────────────────
const getMyOutstandingPenalties = async (req, res) => {
  try {
    const snap = await db.collection("penalties")
      .where("userID", "==", req.user.userID).where("status", "==", "Confirmed").get();
    const settings = await getSystemSettings();
    const byBooking = {};
    const feeByBooking = {};
    snap.docs.forEach((d) => {
      const p = d.data();
      const owed = owedOn(p);
      if (owed > 0 && p.bookingID) {
        byBooking[p.bookingID] = Math.round(((byBooking[p.bookingID] || 0) + owed) * 100) / 100;
        // that penalty's own online payment fee (its saved rate, else the current setting)
        const f = computePenaltyCheckoutFees([{ penaltyID: p.penaltyID || d.id, owed, gatewayFeeRate: p.gatewayFeeRate }], settings.gatewayFeePercent);
        feeByBooking[p.bookingID] = Math.round(((feeByBooking[p.bookingID] || 0) + f.gatewayFee) * 100) / 100;
      }
    });
    const total = Math.round(Object.values(byBooking).reduce((s, n) => s + n, 0) * 100) / 100;
    // Bookings whose penalty the customer has already opened a checkout for but not finished paying.
    const openCheckouts = await listPendingCheckouts(req.user.userID);
    const pendingByBooking = {};
    Object.keys(byBooking).forEach((id) => { if (openCheckouts[id]) pendingByBooking[id] = true; });
    // The online payment fee is added at checkout. feeByBooking = that fee per booking (each penalty at its own saved
    // rate), so the app can show "₱100 + ₱5 online payment fee" before the customer taps pay.
    return res.status(200).json({ data: { byBooking, feeByBooking, pendingByBooking, total } });
  } catch (error) {
    console.error("getMyOutstandingPenalties error:", error.message);
    return res.status(500).json({ message: "Failed to load outstanding penalties." });
  }
};

// Called by the main webhook for checkout_session.payment.paid events whose
// reference_number starts with "PENCO-". Never throws.
const handlePenaltyWebhookPaid = async ({ checkoutID, session }) => {
  const { pickPaidPayment, chargeFromPaymentResource } = require("../../utils/payments/paymongoFee.util");
  const ref = db.collection(CHECKOUTS).doc(checkoutID);
  const resource = pickPaidPayment(session?.attributes?.payments);
  const r = await settlePenaltyCheckout({
    checkoutRef: ref, paymongoPaymentID: resource?.id || null,
    charge: chargeFromPaymentResource(resource), source: "webhook",
  });
  console.log(`[PayMongo Webhook] penalty checkout ${checkoutID} ${r.settled ? "settled" : r.alreadyPaid ? "already settled" : "not found"}`);
};

module.exports = { createPenaltyPaymentLink, getPenaltyPaymentStatus, getMyOutstandingPenalties, handlePenaltyWebhookPaid };
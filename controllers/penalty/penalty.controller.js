const { db } = require("../../config/firebaseConnection/firebase");
const { axios, PAYMONGO_V1, paymongoHeaders, retrieveCheckoutSession } = require("../../utils/payments/paymongoClient.util");
const {
  listUnpaidForBooking, unpaidTotal, owedOn, listPendingCheckouts, listPendingGroups, getGroupRows,
  writePendingPenaltyRows, cancelPendingGroup, settlePenaltyCheckout,
  heldDepositCoverForBooking, heldDepositCoverByBooking, planOnlinePayment,
} = require("../../utils/payments/penaltyPayment.util");

const { getSystemSettings } = require("../../utils/pricing");

const FRONTEND_URL = process.env.FRONTEND_URL || "http://localhost:3000";

// Same channels the booking checkout offers.
const CHANNEL_MAP = { gcash: ["gcash"], maya: ["paymaya"], qrph: ["qrph"] };
const MIN_CENTAVOS = 2000; // PayMongo minimum: ₱20.00

// PayMongo channel -> the method code stored on a paymentEntries row
const METHOD_OF_CHANNEL = { gcash: "gcash", paymaya: "maya", qrph: "qrph" };

// One checkout = one groupID shared by the pending penalty rows it creates (also the PayMongo reference_number).
const newGroupID = () => `PENCO-${db.collection("paymentEntries").doc().id}`;
const round2 = (v) => Math.round((Number(v) || 0) * 100) / 100;

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/paymongo/penalty/create-link   { bookingID, paymentMethod }
//
// Opens a PayMongo checkout for what this booking's customer still has to pay ONLINE in confirmed penalties. The amount
// is computed here, never read from the body.
//
// A security deposit that is still Held pays the penalties first (staff settle it), and money taken from the deposit has
// no online payment fee, so only what the deposit does NOT cover is charged here, and only that part carries the fee.
// Once the deposit is not held any more (already settled and returned, refunded, waived, forfeited, none recorded) every
// unpaid penalty is charged here, fee included. See planOnlinePayment() in penaltyPayment.util.js.
//
// Nothing is stored in a separate collection: opening the checkout writes one PENDING paymentEntries row per
// penalty (phase "penalty", source "online", the PayMongo sessionID, a shared groupID). The webhook or the
// status poll flips them to "success" and moves penalties.paidAmount / gatewayFeePaid (see settlePenaltyCheckout).
//
// The customer also pays the online payment (gateway) fee on THAT amount. Each penalty carries the gatewayFeeRate that was
// in System Settings when it was created, and is charged at that rate on the part of it paid online (a penalty from
// before the rate was saved uses the current setting). The fee is a SEPARATE line on the checkout and is not part of
// the penalty: a row's amount / the penalty's paidAmount only ever move by the penalty money.
// The fee is only charged on a penalty that is HIGHER than PENALTY_FEE_MIN_AMOUNT (₱1,000, utils/pricing.js); a penalty of
// that amount or less is paid online with no fee.
//   amount         = what the customer is charged in total (penaltyAmount + gatewayFee)
//   penaltyAmount  = the penalty money inside it (the sum of the rows' amounts)
//   gatewayFee     = the online payment fee inside it
//   gatewayFeeRate = the one % every penalty shares (null when they were created at different rates)
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
    const live = [];   // earlier checkouts that are still open: { group, checkoutUrl }
    for (const g of await listPendingGroups(userID, { bookingID })) {
      if (!g.sessionID) continue;
      const v = await retrieveCheckoutSession(g.sessionID);
      if (!v.ok) {
        return res.status(503).json({ message: "We couldn't confirm your earlier payment attempt with PayMongo just now. Please wait a moment and try again — this protects you from being charged twice." });
      }
      if (v.paid) {
        await settlePenaltyCheckout({ groupID: g.groupID, paymongoPaymentID: v.paymongoPaymentID, charge: v.charge, source: "pay-now" });
      } else if (v.expired) {
        await cancelPendingGroup(g.groupID);
      } else {
        live.push({ group: g, checkoutUrl: v.checkoutUrl || null });
      }
    }

    const unpaid = await listUnpaidForBooking(userID, bookingID);
    if (!(unpaidTotal(unpaid) > 0)) {
      return res.status(200).json({ message: "There's nothing left to pay on this booking's penalties.", alreadyPaid: true, bookingID });
    }
    const settings = await getSystemSettings();
    const fee = planOnlinePayment(unpaid, {
      depositCover: await heldDepositCoverForBooking(bookingID),
      fallbackPercent: settings.gatewayFeePercent,
    });
    if (!(fee.onlineDue > 0)) {
      // The held deposit covers all of it: nothing to pay online, so no checkout and no fee.
      return res.status(400).json({
        message: "Your security deposit covers these penalties, so there's nothing to pay online. They are deducted from the deposit when your booking is settled, with no online payment fee.",
        coveredByDeposit: true, bookingID,
      });
    }
    const amount = fee.total;                       // what the customer is actually charged
    const centavos = Math.round(amount * 100);
    if (centavos < MIN_CENTAVOS) {
      return res.status(400).json({ message: "Online payment needs at least ₱20.00. Please pay this small balance in store." });
    }

    // Reuse a still-open link for the same amount instead of piling up sessions.
    const method = METHOD_OF_CHANNEL[channel[0]];
    const reusable = live.find((x) => x.checkoutUrl && round2(x.group.penaltyAmount) === round2(fee.penaltyAmount) && x.group.method === method);
    if (reusable) {
      return res.status(200).json({
        message: "Payment link already exists.", checkoutUrl: reusable.checkoutUrl, checkoutID: reusable.group.groupID,
        amount, penaltyAmount: fee.penaltyAmount, gatewayFee: fee.gatewayFee, gatewayFeeRate: fee.gatewayFeeRate,
      });
    }

    const groupID = newGroupID();
    const pmRes = await axios.post(`${PAYMONGO_V1}/checkout_sessions`, {
      data: { attributes: {
        line_items: [
          { name: `ARLTrack Booking #${bookingID} (Penalty)`, amount: Math.round(fee.penaltyAmount * 100), currency: "PHP", quantity: 1 },
          ...(fee.gatewayFee > 0
            ? [{ name: fee.gatewayFeeRate ? `Online payment fee (${fee.gatewayFeeRate}%)` : "Online payment fee", amount: Math.round(fee.gatewayFee * 100), currency: "PHP", quantity: 1 }]
            : []),
        ],
        payment_method_types: channel,
        success_url: `${FRONTEND_URL}/payment-return?penaltyGroupID=${groupID}&bookingID=${bookingID}`,
        cancel_url:  `${FRONTEND_URL}/my-bookings?tab=history`,
        reference_number: groupID,   // webhook matches on this (PENCO- prefix = penalty checkout) and finds the rows by groupID
      } },
    }, { headers: paymongoHeaders() });

    const session = pmRes.data.data;
    const checkoutUrl = session.attributes.checkout_url;
    await writePendingPenaltyRows({ unpaid, lines: fee.lines, userID, groupID, sessionID: session.id, channel: channel[0] });

    return res.status(200).json({
      message: "Payment link created.", checkoutUrl, checkoutID: groupID,
      amount, penaltyAmount: fee.penaltyAmount, gatewayFee: fee.gatewayFee, gatewayFeeRate: fee.gatewayFeeRate,
    });
  } catch (error) {
    console.error("createPenaltyPaymentLink error:", error?.response?.data || error.message);
    return res.status(500).json({ message: "Failed to create payment link. Please try again." });
  }
};

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/paymongo/penalty/status/:groupID
// The return page polls this; if PayMongo says it's paid we settle it here
// (same transactional path as the webhook, so whichever lands first wins).
// ─────────────────────────────────────────────────────────────────────────────
const getPenaltyPaymentStatus = async (req, res) => {
  const userID = req.user.userID;
  const groupID = req.params.groupID || req.params.checkoutID;
  try {
    const rows = await getGroupRows(groupID);
    if (!rows.length || rows[0].userID !== userID) {
      return res.status(404).json({ message: "Payment not found." });
    }
    const bookingID = rows[0].bookingID;
    const pending = rows.filter((r) => r.status === "pending");
    if (!pending.length) {
      // Nothing left to settle: paid if any row took money, otherwise it expired / failed.
      return res.status(200).json({ status: rows.some((r) => r.status === "success") ? "paid" : "failed", bookingID });
    }

    const v = await retrieveCheckoutSession(pending[0].sessionID);
    if (v.ok && v.paid) {
      await settlePenaltyCheckout({ groupID, paymongoPaymentID: v.paymongoPaymentID, charge: v.charge, source: "status-poll" });
      return res.status(200).json({ status: "paid", bookingID });
    }
    if (v.ok && v.expired) {
      await cancelPendingGroup(groupID);
      return res.status(200).json({ status: "failed", bookingID });
    }
    return res.status(200).json({ status: "pending", bookingID, verified: !!v.ok });
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
    // A held deposit pays penalties first (no fee); only the rest is paid online and carries the fee.
    let covers = {};
    try { covers = await heldDepositCoverByBooking(req.user.userID); }
    catch (e) { console.warn("getMyOutstandingPenalties: could not read deposits:", e.message); }
    const docsByBooking = {};
    snap.docs.forEach((d) => {
      const p = { ...d.data(), id: d.id };
      if (owedOn(p) > 0 && p.bookingID) (docsByBooking[p.bookingID] ||= []).push(p);
    });
    const byBooking = {};          // all unpaid penalty money (it is what blocks a new booking)
    const coveredByBooking = {};   // what a held deposit will pay at settlement (no fee)
    const onlineDueByBooking = {}; // penalty money to pay online
    const feeByBooking = {};       // the online payment fee on that
    const payableByBooking = {};   // onlineDue + fee: what the checkout charges
    Object.entries(docsByBooking).forEach(([bookingID, docs]) => {
      const plan = planOnlinePayment(docs, { depositCover: covers[bookingID] || 0, fallbackPercent: settings.gatewayFeePercent });
      byBooking[bookingID] = plan.unpaidTotal;
      coveredByBooking[bookingID] = plan.coveredByDeposit;
      onlineDueByBooking[bookingID] = plan.onlineDue;
      feeByBooking[bookingID] = plan.gatewayFee;
      payableByBooking[bookingID] = plan.total;
    });
    const total = Math.round(Object.values(byBooking).reduce((s, n) => s + n, 0) * 100) / 100;
    // Bookings whose penalty the customer has already opened a checkout for but not finished paying.
    const openCheckouts = await listPendingCheckouts(req.user.userID);
    const pendingByBooking = {};
    Object.keys(byBooking).forEach((id) => { if (openCheckouts[id]) pendingByBooking[id] = true; });
    // The online payment fee is added at checkout, on the part the deposit does not cover. feeByBooking = that fee per
    // booking (each penalty at its own saved rate), so the app can show "₱100 + ₱5 online payment fee" before paying.
    return res.status(200).json({ data: { byBooking, coveredByBooking, onlineDueByBooking, feeByBooking, payableByBooking, pendingByBooking, total } });
  } catch (error) {
    console.error("getMyOutstandingPenalties error:", error.message);
    return res.status(500).json({ message: "Failed to load outstanding penalties." });
  }
};

// Called by the main webhook for checkout_session.payment.paid events whose
// reference_number starts with "PENCO-". Never throws.
const handlePenaltyWebhookPaid = async ({ checkoutID, session }) => {
  const { pickPaidPayment, chargeFromPaymentResource } = require("../../utils/payments/paymongoFee.util");
  const resource = pickPaidPayment(session?.attributes?.payments);
  const r = await settlePenaltyCheckout({
    groupID: checkoutID, paymongoPaymentID: resource?.id || null,
    charge: chargeFromPaymentResource(resource), source: "webhook",
  });
  console.log(`[PayMongo Webhook] penalty checkout ${checkoutID} ${r.settled ? "settled" : r.alreadyPaid ? "already settled" : "not found"}`);
};

module.exports = { createPenaltyPaymentLink, getPenaltyPaymentStatus, getMyOutstandingPenalties, handlePenaltyWebhookPaid };
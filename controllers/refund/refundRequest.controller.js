const { db } = require("../../config/firebaseConnection/firebase");
const { createRefundRequest } = require("../../models/refund/refundRequest.model");

const VALID_REASONS = [
  "Cancelled trip",
  "Overcharged",
  "Service issue",
  "Duplicate payment",
  "Other",
];

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/refunds
// Customer submits a refund request for one of their own paid payments.
// This is the "Confirm & Send" step — creates a Pending RefundRequest.
// It does NOT touch PayMongo directly; that only happens once an admin
// approves it (see admin backend).
// ─────────────────────────────────────────────────────────────────────────────
const requestRefund = async (req, res) => {
  const userID = req.user.userID;
  const { paymentID, reason, notes } = req.body;

  if (!paymentID || !reason) {
    return res.status(400).json({ message: "paymentID and reason are required." });
  }
  if (!VALID_REASONS.includes(reason)) {
    return res.status(400).json({ message: "Invalid reason." });
  }

  try {
    // 1. Verify the payment belongs to this user and is actually paid
    const paymentSnap = await db.collection("payments")
      .where("paymentID", "==", paymentID)
      .where("userID", "==", userID)
      .limit(1)
      .get();

    if (paymentSnap.empty) {
      return res.status(404).json({ message: "Payment not found or access denied." });
    }

    const paymentDoc = paymentSnap.docs[0];
    const payment    = paymentDoc.data();

    if (payment.status !== "paid") {
      return res.status(400).json({ message: "Only paid payments can be refunded." });
    }
    if (!payment.paymongoPaymentID) {
      // This payment was settled before the webhook fix that captures the
      // real PayMongo payment id — flag it clearly instead of silently
      // creating a request that can never actually be refunded via PayMongo.
      return res.status(400).json({
        message: "This payment can't be auto-refunded yet — please contact support.",
      });
    }

    // 2. Prevent duplicate active requests for the same payment
    const existingSnap = await db.collection("refundRequests")
      .where("paymentID", "==", paymentID)
      .where("status", "in", ["Pending", "Approved"])
      .limit(1)
      .get();

    if (!existingSnap.empty) {
      return res.status(409).json({ message: "A refund request for this payment is already in progress." });
    }

    // 3. Create the refund request
    const refundRef = db.collection("refundRequests").doc();
    const refundRequest = createRefundRequest(refundRef.id, {
      bookingID: payment.bookingID,
      paymentID,
      userID,
      reason,
      notes: notes || "",
      amount: payment.amount || 0,
    });

    await refundRef.set(refundRequest);

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
// GET /api/refunds/mine
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
      .sort((a, b) => (b.createdAt?.toDate?.() || b.createdAt) - (a.createdAt?.toDate?.() || a.createdAt));

    return res.status(200).json({ data: requests });
  } catch (error) {
    console.error("getMyRefundRequests error:", error.message);
    return res.status(500).json({ message: "Failed to fetch refund requests." });
  }
};

module.exports = { requestRefund, getMyRefundRequests, VALID_REASONS };

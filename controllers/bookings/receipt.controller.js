const { db } = require("../../config/firebaseConnection/firebase");
const { isPhasePaid, chargedAmountFor } = require("../../utils/payments/settlePayment.util");
const { buildAndSendReceipt } = require("../../utils/receipt/receipt.util");

// ─────────────────────────────────────────────────────────────────────────────
// Manual "Email my receipt" button (My Bookings / Booking Details) — reuses
// buildAndSendReceipt(), the SAME function the automatic post-payment flow
// calls in settlePhasePayment(), so a resend looks identical to the
// original. Resends one email per phase the customer has actually paid
// (deposit only, or deposit + balance) — never invents a receipt for a
// phase that hasn't been paid yet.
// ─────────────────────────────────────────────────────────────────────────────
const resendReceipt = async (req, res) => {
  try {
    const { bookingID } = req.params;
    if (!bookingID) {
      return res.status(400).json({ message: "Missing bookingID." });
    }

    // Ownership check — same pattern as the rest of this app (see
    // controllers/user/user.controller.js): a customer can only ever
    // resend a receipt for their OWN booking, never someone else's by
    // guessing/enumerating bookingIDs.
    const bSnap = await db.collection("bookings").where("bookingID", "==", bookingID).limit(1).get();
    if (bSnap.empty) {
      return res.status(404).json({ message: "Booking not found." });
    }
    const booking = bSnap.docs[0].data();
    if (booking.userID !== req.user.userID) {
      return res.status(403).json({ message: "You don't have permission to access this booking." });
    }

    const pSnap = await db.collection("payments").where("bookingID", "==", bookingID).limit(1).get();
    if (pSnap.empty) {
      return res.status(404).json({ message: "No payment found for this booking yet." });
    }
    const payment = pSnap.docs[0].data();

    // Resend for every phase actually paid so far — never a phase that's
    // still pending (nothing to receipt yet for that one).
    const phasesToSend = ["deposit", "balance"].filter((phase) => isPhasePaid(payment, phase));
    if (phasesToSend.length === 0) {
      return res.status(400).json({ message: "This booking doesn't have a completed payment yet." });
    }

    const results = await Promise.all(phasesToSend.map((phase) => {
      const paymongoPaymentID = phase === "balance"
        ? (payment.balancePaymongoPaymentID || payment.paymongoPaymentID)
        : (payment.depositPaymongoPaymentID || payment.paymongoPaymentID);
      const charged = chargedAmountFor(payment, phase);
      return buildAndSendReceipt({ payment, phase, charged, paymongoPaymentID });
    }));

    const failed = results.filter((r) => !r.success);
    if (failed.length === results.length) {
      // Every attempt failed — this IS worth surfacing to the customer,
      // unlike the automatic (best-effort, silent) path, since they
      // explicitly asked for this one and are waiting on it.
      return res.status(500).json({ message: "Couldn't send the receipt email. Please try again in a bit." });
    }

    return res.status(200).json({
      message: phasesToSend.length > 1
        ? "Receipts sent to your email."
        : "Receipt sent to your email.",
      sent: results.length - failed.length,
      failed: failed.length,
    });
  } catch (err) {
    console.error("resendReceipt error:", err.message);
    return res.status(500).json({ message: "Server error. Please try again." });
  }
};

module.exports = { resendReceipt };

const { db } = require("../../config/firebaseConnection/firebase");
const { isPhasePaid, chargedAmountFor } = require("../../utils/payments/settlePayment.util");
const { buildAndSendCombinedReceipt } = require("../../utils/receipt/receipt.util");

const RESEND_COOLDOWN_MS = 5 * 60 * 1000; // 5 minutes between clicks, per booking

// ─────────────────────────────────────────────────────────────────────────────
// Manual "Email my receipt" button (My Bookings / Booking Details) — always
// sends exactly ONE email per click, covering every phase the customer has
// actually paid so far (deposit only, or deposit + balance combined into
// one receipt with one row each) — never invents a receipt for a phase
// that hasn't been paid yet, and never splits a resend into multiple
// emails the way the automatic post-payment notifications do.
//
// Rate-limited to one click every 5 minutes per booking (enforced here in
// the payment doc itself via lastReceiptSentAt, not just disabled on the
// button — a disabled button is only a UI nicety, the real limit has to
// live server-side or a page refresh / direct API call would bypass it).
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
    const paymentDoc = pSnap.docs[0];
    const payment    = paymentDoc.data();

    // Cooldown — refuse if the last send was under 5 minutes ago.
    const lastSentAt = payment.lastReceiptSentAt?.toDate
      ? payment.lastReceiptSentAt.toDate()
      : (payment.lastReceiptSentAt ? new Date(payment.lastReceiptSentAt) : null);
    if (lastSentAt) {
      const elapsedMs = Date.now() - lastSentAt.getTime();
      if (elapsedMs < RESEND_COOLDOWN_MS) {
        const retryAfterSeconds = Math.ceil((RESEND_COOLDOWN_MS - elapsedMs) / 1000);
        return res.status(429).json({
          message: `Please wait ${Math.ceil(retryAfterSeconds / 60)} more minute(s) before requesting another receipt.`,
          retryAfterSeconds,
        });
      }
    }

    // Resend for every phase actually paid so far — never a phase that's
    // still pending (nothing to receipt yet for that one).
    const phasesToSend = ["deposit", "balance"].filter((phase) => isPhasePaid(payment, phase));
    if (phasesToSend.length === 0) {
      return res.status(400).json({ message: "This booking doesn't have a completed payment yet." });
    }

    const phases = phasesToSend.map((phase) => {
      const paymongoPaymentID = phase === "balance"
        ? (payment.balancePaymongoPaymentID || payment.paymongoPaymentID)
        : (payment.depositPaymongoPaymentID || payment.paymongoPaymentID);
      const charged = chargedAmountFor(payment, phase);
      return { phase, charged, paymongoPaymentID };
    });

    const result = await buildAndSendCombinedReceipt({ payment, phases });

    if (!result.success) {
      // This IS worth surfacing to the customer, unlike the automatic
      // (best-effort, silent) path, since they explicitly asked for this
      // one and are waiting on it.
      return res.status(500).json({ message: "Couldn't send the receipt email. Please try again in a bit." });
    }

    // Start the cooldown from THIS successful send — set regardless of
    // whether a later request would find nothing new to send, since a
    // click that actually emailed something is what should be throttled.
    const now = new Date();
    await paymentDoc.ref.update({ lastReceiptSentAt: now });

    return res.status(200).json({
      message: "Receipt sent to your email.",
      sent: 1,
      failed: 0,
      nextAllowedAt: new Date(now.getTime() + RESEND_COOLDOWN_MS).toISOString(),
    });
  } catch (err) {
    console.error("resendReceipt error:", err.message);
    return res.status(500).json({ message: "Server error. Please try again." });
  }
};

module.exports = { resendReceipt };

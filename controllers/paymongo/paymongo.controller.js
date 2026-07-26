const axios = require("axios");
const { db } = require("../../config/firebaseConnection/firebase");

// ─── PayMongo base config ────────────────────────────────────────────────────
const PAYMONGO_SECRET = process.env.PAYMONGO_SECRET_KEY;
// Per PayMongo's current API reference (Create/Retrieve a Checkout Session),
// checkout_sessions live under v1, not v2 — this was previously wrong here
// and silently broke the status poll (see getPaymentStatus below).
const PAYMONGO_V1      = "https://api.paymongo.com/v1";

// Base URL of your frontend, e.g. https://arltrack.com — used to build success_url/cancel_url
const FRONTEND_URL = process.env.FRONTEND_URL || "http://localhost:3000";

const paymongoHeaders = () => ({
  "Content-Type":  "application/json",
  "Authorization": `Basic ${Buffer.from(PAYMONGO_SECRET + ":").toString("base64")}`,
});

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
  const { bookingID, paymentID, amount, description, paymentMethod } = req.body;

  if (!bookingID || !paymentID || !amount) {
    return res.status(400).json({ message: "bookingID, paymentID, and amount are required." });
  }

  const paymentMethodTypes = CHANNEL_MAP[paymentMethod] || ["qrph"];

  const amountInCentavos = Math.round(Number(amount) * 100);
  if (isNaN(amountInCentavos) || amountInCentavos < 2000) {
    return res.status(400).json({ message: "Amount must be at least ₱20.00." });
  }

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

    // Prevent duplicate sessions if one already exists and is still pending
    if (payment.paymongoSessionID && payment.status === "pending") {
      return res.status(200).json({
        message:     "Payment link already exists.",
        checkoutUrl: payment.checkoutUrl,
        linkID:      payment.paymongoSessionID,
      });
    }

    // 2. Build return URLs — success_url carries paymentID so the frontend
    //    can immediately poll /paymongo/status/:paymentID on return.
    const successUrl = `${FRONTEND_URL}/payment-return?paymentID=${paymentID}&bookingID=${bookingID}`;
    const cancelUrl   = `${FRONTEND_URL}/booking?step=4&paymentID=${paymentID}`;

    // 3. Create PayMongo Checkout Session (v2)
    const sessionPayload = {
      data: {
        attributes: {
          line_items: [
            {
              name:     description || `ARLTrack Booking #${bookingID}`,
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
// POST /api/paymongo/webhook
//
// Subscribe to `checkout_session.payment.paid` in your PayMongo dashboard
// (Settings → Webhooks) — this replaces the old `payment.paid` event since
// we moved from Links to Checkout Sessions.
// ─────────────────────────────────────────────────────────────────────────────
const handleWebhook = async (req, res) => {
  const webhookSecret = process.env.PAYMONGO_WEBHOOK_SECRET;

  const sigHeader = req.headers["paymongo-signature"];
  if (webhookSecret && sigHeader) {
    const crypto = require("crypto");
    const parts  = {};
    sigHeader.split(",").forEach(part => {
      const [k, v] = part.split("=");
      parts[k] = v;
    });

    const rawBody = JSON.stringify(req.body);
    const toSign  = `${parts.t}.${rawBody}`;
    const hmac    = crypto.createHmac("sha256", webhookSecret).update(toSign).digest("hex");
    const isValid = hmac === parts.te || hmac === parts.li;

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
      const now = new Date();

      let paymentSnap;
      if (paymentID) {
        paymentSnap = await db.collection("payments")
          .where("paymentID", "==", paymentID)
          .limit(1)
          .get();
      } else if (sessionID) {
        paymentSnap = await db.collection("payments")
          .where("paymongoSessionID", "==", sessionID)
          .limit(1)
          .get();
      }

      if (!paymentSnap || paymentSnap.empty) {
        console.warn("[PayMongo Webhook] no matching payment found. sessionID:", sessionID, "paymentID:", paymentID);
        return res.status(200).json({ received: true });
      }

      const paymentDoc = paymentSnap.docs[0];
      const payment    = paymentDoc.data();
      const bID        = payment.bookingID;

      await paymentDoc.ref.update({ status: "paid", paidAt: now, updatedAt: now });

      if (bID) {
        console.log("[PayMongo Webhook] ✅ Payment settled for booking:", bID);
      }

      return res.status(200).json({ received: true });
    }

    // ACK all other event types (e.g. checkout_session.payment.failed, if you enable it)
    if (eventType === "checkout_session.payment.failed") {
      const now = new Date();
      let paymentSnap;
      if (paymentID) {
        paymentSnap = await db.collection("payments")
          .where("paymentID", "==", paymentID)
          .limit(1)
          .get();
      } else if (sessionID) {
        paymentSnap = await db.collection("payments")
          .where("paymongoSessionID", "==", sessionID)
          .limit(1)
          .get();
      }
      if (paymentSnap && !paymentSnap.empty) {
        await paymentSnap.docs[0].ref.update({ status: "failed", updatedAt: now });
      }
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

    const p = snap.docs[0].data();

    if (p.status === "pending" && p.paymongoSessionID) {
      try {
        const pmRes = await axios.get(
          `${PAYMONGO_V1}/checkout_sessions/${p.paymongoSessionID}`,
          { headers: paymongoHeaders() }
        );
        const payments = pmRes.data?.data?.attributes?.payments || [];
        const paid = payments.some(pay => pay.attributes?.status === "paid");

        if (paid && p.status !== "paid") {
          const now = new Date();
          await snap.docs[0].ref.update({ status: "paid", paidAt: now, updatedAt: now });

          return res.status(200).json({ status: "paid", bookingID: p.bookingID });
        }
        return res.status(200).json({ status: p.status, bookingID: p.bookingID });
      } catch (e) {
        // Previously swallowed silently, which is exactly why a real failure
        // here (e.g. the v1/v2 endpoint mismatch this fixes) went unnoticed
        // and just looked like "payment stuck pending" forever. Log it so a
        // future failure here is actually visible, then fall through to the
        // last-known Firestore status rather than erroring the request.
        console.error(
          "getPaymentStatus: PayMongo checkout_sessions lookup failed —",
          e?.response?.status, e?.response?.data || e.message
        );
      }
    }

    return res.status(200).json({
      status:      p.status,
      bookingID:   p.bookingID,
      checkoutUrl: p.checkoutUrl || null,
    });

  } catch (error) {
    console.error("getPaymentStatus error:", error.message);
    return res.status(500).json({ message: "Failed to fetch payment status." });
  }
};

module.exports = { createPaymentLink, handleWebhook, getPaymentStatus };
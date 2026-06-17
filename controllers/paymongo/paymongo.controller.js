const axios = require("axios");
const { db } = require("../../config/firebaseConnection/firebase");

// ─── PayMongo base config ────────────────────────────────────────────────────
const PAYMONGO_SECRET = process.env.PAYMONGO_SECRET_KEY;
const PAYMONGO_BASE   = "https://api.paymongo.com/v1";

const paymongoHeaders = () => ({
  "Content-Type":  "application/json",
  "Authorization": `Basic ${Buffer.from(PAYMONGO_SECRET + ":").toString("base64")}`,
});

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/paymongo/create-link
//
// Creates a PayMongo Payment Link for a booking.
// Body: { bookingID, paymentID, amount, description }
//
// Flow:
//   1. Validate booking + payment exist and belong to the requesting user.
//   2. Create a PayMongo payment link via API.
//   3. Store the paymongoLinkID + checkout URL on the payments doc.
//   4. Return the checkout URL so the frontend can redirect the user.
// ─────────────────────────────────────────────────────────────────────────────
const createPaymentLink = async (req, res) => {
  const userID = req.user.userID;
  const { bookingID, paymentID, amount, description } = req.body;

  if (!bookingID || !paymentID || !amount) {
    return res.status(400).json({ message: "bookingID, paymentID, and amount are required." });
  }

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

    // Prevent duplicate payment links if one already exists and is still pending
    if (payment.paymongoLinkID && payment.status === "pending") {
      return res.status(200).json({
        message:     "Payment link already exists.",
        checkoutUrl: payment.checkoutUrl,
        linkID:      payment.paymongoLinkID,
      });
    }

    // 2. Create PayMongo payment link
    const linkPayload = {
      data: {
        attributes: {
          amount:      amountInCentavos,
          currency:    "PHP",
          description: description || `ARLTrack Booking #${bookingID}`,
          remarks:     `bookingID:${bookingID}|paymentID:${paymentID}`,
          // Restrict to QRPH only (your active channel). Add "gcash","paymaya","card" later when enabled.
          payment_method_types: ["qrph"],
        },
      },
    };

    const pmRes = await axios.post(
      `${PAYMONGO_BASE}/links`,
      linkPayload,
      { headers: paymongoHeaders() }
    );

    const linkData    = pmRes.data.data;
    const linkID      = linkData.id;
    const checkoutUrl = linkData.attributes.checkout_url;

    // 3. Save linkID + checkoutUrl to Firestore
    await paymentDoc.ref.update({
      paymongoLinkID: linkID,
      checkoutUrl,
      updatedAt: new Date(),
    });

    return res.status(200).json({
      message: "Payment link created.",
      checkoutUrl,
      linkID,
    });

  } catch (error) {
    console.error("createPaymentLink error:", error?.response?.data || error.message);
    return res.status(500).json({ message: "Failed to create payment link. Please try again." });
  }
};


// ─────────────────────────────────────────────────────────────────────────────
// POST /api/paymongo/webhook
//
// PayMongo sends events here. Register this URL in your PayMongo dashboard
// under Developers → Webhooks.
//
// Handles:
//   - payment.paid   → mark payment as "paid", booking as "confirmed"
//   - payment.failed → mark payment as "failed"
//
// PayMongo signs the request with a secret; validate it using the webhook
// secret you get from the dashboard (store as PAYMONGO_WEBHOOK_SECRET in .env).
// ─────────────────────────────────────────────────────────────────────────────
const handleWebhook = async (req, res) => {
  const webhookSecret = process.env.PAYMONGO_WEBHOOK_SECRET;

  // ── Signature validation ──────────────────────────────────────────────────
  // PayMongo sends: paymongo-signature header = "t=<timestamp>,te=<hash>,li=<hash>"
  const sigHeader = req.headers["paymongo-signature"];
  if (webhookSecret && sigHeader) {
    const crypto = require("crypto");
    const parts  = {};
    sigHeader.split(",").forEach(part => {
      const [k, v] = part.split("=");
      parts[k] = v;
    });

    const rawBody    = JSON.stringify(req.body);
    const toSign     = `${parts.t}.${rawBody}`;
    const hmac       = crypto.createHmac("sha256", webhookSecret).update(toSign).digest("hex");
    const isValid    = hmac === parts.te || hmac === parts.li;

    if (!isValid) {
      console.warn("PayMongo webhook: invalid signature");
      return res.status(400).json({ message: "Invalid signature." });
    }
  }

  // ── Parse event ──────────────────────────────────────────────────────────
  const event     = req.body;
  const eventType = event?.data?.attributes?.type;
  const resource  = event?.data?.attributes?.data;

  console.log("[PayMongo Webhook] event type:", eventType);

  if (!eventType || !resource) {
    return res.status(200).json({ received: true }); // ACK but ignore unknown shapes
  }

  try {
    // Extract bookingID + paymentID from the remarks field we set on link creation
    // remarks format: "bookingID:<id>|paymentID:<id>"
    const remarks   = resource?.attributes?.payments?.[0]?.attributes?.billing?.remarks
                   || resource?.attributes?.description
                   || "";

    const bmatch = remarks.match(/bookingID:([^|]+)/);
    const pmatch = remarks.match(/paymentID:([^|]+)/);

    const bookingID = bmatch?.[1];
    const paymentID = pmatch?.[1];

    // Also try matching via paymongoLinkID stored in Firestore (fallback)
    const linkID = resource?.id;

    // ── payment.paid ─────────────────────────────────────────────────────────
    if (eventType === "payment.paid") {
      const now = new Date();

      let paymentSnap;
      if (paymentID) {
        paymentSnap = await db.collection("payments")
          .where("paymentID", "==", paymentID)
          .limit(1)
          .get();
      } else if (linkID) {
        paymentSnap = await db.collection("payments")
          .where("paymongoLinkID", "==", linkID)
          .limit(1)
          .get();
      }

      if (!paymentSnap || paymentSnap.empty) {
        console.warn("[PayMongo Webhook] payment.paid: no matching payment found. linkID:", linkID, "paymentID:", paymentID);
        return res.status(200).json({ received: true });
      }

      const paymentDoc = paymentSnap.docs[0];
      const payment    = paymentDoc.data();
      const bID        = bookingID || payment.bookingID;

      // Update payment status
      await paymentDoc.ref.update({
        status:    "paid",
        paidAt:    now,
        updatedAt: now,
      });

      // Update booking status to confirmed
      if (bID) {
        const bookingSnap = await db.collection("bookings")
          .where("bookingID", "==", bID)
          .limit(1)
          .get();

        if (!bookingSnap.empty) {
          await bookingSnap.docs[0].ref.update({
            status:    "confirmed",
            updatedAt: now,
          });
          console.log("[PayMongo Webhook] ✅ Booking confirmed:", bID);
        }
      }

      return res.status(200).json({ received: true });
    }

    // ── payment.failed ───────────────────────────────────────────────────────
    if (eventType === "payment.failed") {
      const now = new Date();

      let paymentSnap;
      if (paymentID) {
        paymentSnap = await db.collection("payments")
          .where("paymentID", "==", paymentID)
          .limit(1)
          .get();
      } else if (linkID) {
        paymentSnap = await db.collection("payments")
          .where("paymongoLinkID", "==", linkID)
          .limit(1)
          .get();
      }

      if (!paymentSnap || paymentSnap.empty) {
        return res.status(200).json({ received: true });
      }

      await paymentSnap.docs[0].ref.update({
        status:    "failed",
        updatedAt: now,
      });

      console.log("[PayMongo Webhook] ❌ Payment failed. paymentID:", paymentID || linkID);
      return res.status(200).json({ received: true });
    }

    // ACK all other event types
    return res.status(200).json({ received: true });

  } catch (error) {
    console.error("handleWebhook error:", error.message);
    // Always return 200 to PayMongo so it doesn't retry indefinitely
    return res.status(200).json({ received: true });
  }
};


// ─────────────────────────────────────────────────────────────────────────────
// GET /api/paymongo/status/:paymentID
//
// Polls the status of a PayMongo link from the Firestore payments doc.
// Frontend calls this after the user returns from the PayMongo checkout page.
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

    // Optionally re-check with PayMongo API if status is still pending + linkID exists
    if (p.status === "pending" && p.paymongoLinkID) {
      try {
        const pmRes  = await axios.get(
          `${PAYMONGO_BASE}/links/${p.paymongoLinkID}`,
          { headers: paymongoHeaders() }
        );
        const pmStatus = pmRes.data?.data?.attributes?.status;
        // PayMongo link statuses: unpaid | paid | archived
        if (pmStatus === "paid" && p.status !== "paid") {
          const now = new Date();
          await snap.docs[0].ref.update({ status: "paid", paidAt: now, updatedAt: now });

          // Also confirm the booking
          const bSnap = await db.collection("bookings")
            .where("bookingID", "==", p.bookingID)
            .limit(1).get();
          if (!bSnap.empty) {
            await bSnap.docs[0].ref.update({ status: "confirmed", updatedAt: now });
          }

          return res.status(200).json({ status: "paid", bookingID: p.bookingID });
        }
        return res.status(200).json({ status: pmStatus || p.status, bookingID: p.bookingID });
      } catch (e) {
        // Fall through to Firestore status if PayMongo API call fails
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

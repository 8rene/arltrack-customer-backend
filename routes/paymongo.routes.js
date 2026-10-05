const express = require("express");
const router  = express.Router();

const { createPaymentLink, handleWebhook, getPaymentStatus, requestRefund, previewRefund, getMyRefundRequests } = require("../controllers/paymongo/paymongo.controller");
const verifyToken = require("../middlewares/auth.middleware");

// Create a PayMongo payment link for a booking
router.post("/create-link",        verifyToken, createPaymentLink);

// Webhook — no auth (PayMongo calls this directly; validated by signature)
router.post("/webhook",            handleWebhook);

// Poll payment status (called by frontend after user returns from checkout)
router.get("/status/:paymentID",   verifyToken, getPaymentStatus);

// Refund requests ("Confirm & Send" from the customer side)
router.get("/refunds/preview/:paymentID", verifyToken, previewRefund); // what a refund would be right now (48-hour policy)
router.post("/refunds",            verifyToken, requestRefund);
router.get("/refunds/mine",        verifyToken, getMyRefundRequests);

module.exports = router;

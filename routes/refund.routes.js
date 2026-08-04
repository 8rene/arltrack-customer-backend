const express = require("express");
const router  = express.Router();

const { requestRefund, getMyRefundRequests } = require("../controllers/refund/refundRequest.controller");
const verifyToken = require("../middlewares/auth.middleware");

// Submit a refund request ("Confirm & Send")
router.post("/",      verifyToken, requestRefund);

// List the logged-in customer's own refund requests
router.get("/mine",   verifyToken, getMyRefundRequests);

module.exports = router;

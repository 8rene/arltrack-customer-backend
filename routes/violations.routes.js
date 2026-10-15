const express = require("express");
const router  = express.Router();
const verifyToken = require("../middlewares/auth.middleware");
const rateLimit   = require("../middlewares/rateLimit.middleware");
const { reportViolation, getBookingViolations } = require("../controllers/violations/violations.controller");

router.post("/report", verifyToken, rateLimit({ windowMs: 10 * 60 * 1000, max: 10, keyPrefix: "violation-report" }), reportViolation);
router.get("/booking/:bookingID", verifyToken, getBookingViolations);

module.exports = router;

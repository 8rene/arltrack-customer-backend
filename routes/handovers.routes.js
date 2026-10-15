const express = require("express");
const router  = express.Router();
const verifyToken = require("../middlewares/auth.middleware");
const rateLimit   = require("../middlewares/rateLimit.middleware");
const { getHandover, signHandover } = require("../controllers/handovers/handovers.controller");

router.get("/:bookingID", verifyToken, getHandover);
router.post("/:bookingID/sign", verifyToken, rateLimit({ windowMs: 10 * 60 * 1000, max: 15, keyPrefix: "handover-sign" }), signHandover);

module.exports = router;

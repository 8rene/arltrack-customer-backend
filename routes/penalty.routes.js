const express = require("express");
const router  = express.Router();

const { getMyBookingPenalties } = require("../controllers/penalty/penalty.controller");
const verifyToken = require("../middlewares/auth.middleware");

router.get("/:bookingID/penalties", verifyToken, getMyBookingPenalties);

module.exports = router;
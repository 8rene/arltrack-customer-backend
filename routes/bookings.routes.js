const express = require("express");
const router  = express.Router();

const { createBooking, getUserBookings, cancelBooking, checkCodingRule } = require("../controllers/bookings/bookings.controller");
const verifyToken = require("../middlewares/auth.middleware");

router.post("/create",              verifyToken, createBooking);
router.get("/user/:userID",         verifyToken, getUserBookings);
router.patch("/:bookingID/cancel",  verifyToken, cancelBooking);
router.post("/check-coding",        checkCodingRule);   // no auth needed — called before login check

module.exports = router;

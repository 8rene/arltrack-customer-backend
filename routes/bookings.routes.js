const express = require("express");
const router  = express.Router();

const { createBooking, getUserBookings, cancelBooking, requestCancellation, checkCodingRule, getBookingQuote } = require("../controllers/bookings/bookings.controller");
const { getBookingTraceback, getBookingDetails } = require("../controllers/bookings/bookingSessions.controller");
const verifyToken = require("../middlewares/auth.middleware");

router.post("/create",                        verifyToken, createBooking);
router.get("/user/:userID",                   verifyToken, getUserBookings);
router.patch("/:bookingID/cancel",            verifyToken, cancelBooking);
router.patch("/:bookingID/request-cancellation", verifyToken, requestCancellation); // ongoing bookings only — needs admin approval
router.post("/check-coding",        checkCodingRule);   // no auth needed — called before login check
router.post("/quote",               getBookingQuote);   // no auth needed — pricing preview only, writes nothing
router.get("/:bookingID/details",   verifyToken, getBookingDetails);
router.get("/:bookingID/traceback", verifyToken, getBookingTraceback);

module.exports = router;
const express = require("express");
const router = express.Router();

const { signup, checkAvailability, checkReferralCode } = require("../controllers/auth/signup.controller");
const { login }   = require("../controllers/auth/login.controller");
const { sendOTP, verifyOTP } = require("../controllers/auth/otp.controller");
const { resetPassword } = require("../controllers/auth/resetPassword.controller"); // ← NEW
const { googleLogin } = require("../controllers/auth/google.controller"); // ← add
const { logout } = require("../controllers/auth/logout.controller"); // ← NEW
const validateSignup = require("../middlewares/signup.middleware");
const validateLogin  = require("../middlewares/login.middleware");
const verifyToken    = require("../middlewares/auth.middleware");
const rateLimit      = require("../middlewares/rateLimit.middleware");

// GET /api/auth/check-availability?email=x&phone=x&username=x
router.get("/check-availability", checkAvailability);
// GET /api/auth/check-referral?code=ARL-XXXXXXXX  (used live by the signup form)
// Public endpoint that confirms a code and returns the referrer's username, so it's
// rate-limited (30 lookups / 10 min / IP) to make guessing codes impractical.
router.get("/check-referral",     rateLimit({ windowMs: 10 * 60 * 1000, max: 30, keyPrefix: "check-referral" }), checkReferralCode);
router.post("/signup",            validateSignup, signup);
router.post("/login",             validateLogin,  login);
router.post("/send-otp",          sendOTP);
router.post("/verify-otp",        verifyOTP);
router.post("/reset-password",    resetPassword); // ← NEW
router.post("/google",            googleLogin); // ← add
router.post("/logout",            verifyToken, logout); // ← NEW

module.exports = router;

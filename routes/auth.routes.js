const express = require("express");
const router = express.Router();

const { signup, checkAvailability } = require("../controllers/auth/signup.controller");
const { login }   = require("../controllers/auth/login.controller");
const { sendOTP } = require("../controllers/auth/otp.controller");
const validateSignup = require("../middlewares/signup.middleware");
const validateLogin  = require("../middlewares/login.middleware");

// GET /api/auth/check-availability?email=x&phone=x&username=x
router.get("/check-availability", checkAvailability);
router.post("/signup",            validateSignup, signup);
router.post("/login",             validateLogin,  login);
router.post("/send-otp",          sendOTP);

module.exports = router;

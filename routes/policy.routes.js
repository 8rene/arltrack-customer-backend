const express = require("express");
const router  = express.Router();
const { getPolicySettings } = require("../controllers/policy/policy.controller");

// Public: the T&C / Booking Guidelines pages are readable without logging in.
router.get("/", getPolicySettings);

module.exports = router;

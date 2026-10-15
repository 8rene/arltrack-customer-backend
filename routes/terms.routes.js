const express = require("express");
const router = express.Router();
const { getActive, getVersion } = require("../controllers/terms/terms.controller");

router.get("/active",        getActive);
router.get("/version/:hash", getVersion);

module.exports = router;

const express = require("express");
const router = express.Router();
const { getActive, getVersion } = require("../controllers/terms/terms.controller");

router.post("/active",       getActive);
router.post("/version/:id",  getVersion);

module.exports = router;

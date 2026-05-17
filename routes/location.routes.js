const express = require("express");
const router  = express.Router();

const {
  getRegions,
  getProvinces,
  getMunicipalities,
  getBarangays,
} = require("../controllers/location/location.controller");

router.get("/regions",        getRegions);
router.get("/provinces",      getProvinces);
router.get("/municipalities", getMunicipalities);
router.get("/barangays",      getBarangays);

module.exports = router;

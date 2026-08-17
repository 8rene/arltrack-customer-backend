const express = require("express");
const router  = express.Router();

const {
  getRegions,
  getProvinces,
  getMunicipalities,
  getBarangays,
  getPostalCode,
  getStoreLocation,
} = require("../controllers/location/location.controller");

router.get("/regions",        getRegions);
router.get("/provinces",      getProvinces);
router.get("/municipalities", getMunicipalities);
router.get("/barangays",      getBarangays);
router.get("/postal-code",    getPostalCode);
router.get("/store",          getStoreLocation);

module.exports = router;
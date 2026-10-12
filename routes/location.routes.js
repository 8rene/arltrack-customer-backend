const express = require("express");
const router  = express.Router();

const {
  getRegions,
  getProvinces,
  getMunicipalities,
  getBarangays,
  getPostalCode,
  getStoreLocation,
  getServiceArea,
  checkServiceArea,
} = require("../controllers/location/location.controller");

router.get("/regions",        getRegions);
router.get("/provinces",      getProvinces);
router.get("/municipalities", getMunicipalities);
router.get("/barangays",      getBarangays);
router.get("/postal-code",    getPostalCode);
router.get("/store",          getStoreLocation);
router.get("/service-area",   getServiceArea);
router.get("/service-area/check", checkServiceArea);

module.exports = router;

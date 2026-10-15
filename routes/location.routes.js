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

router.post("/regions",        getRegions);
router.post("/provinces",      getProvinces);
router.post("/municipalities", getMunicipalities);
router.post("/barangays",      getBarangays);
router.post("/postal-code",    getPostalCode);
router.post("/store",          getStoreLocation);
router.post("/service-area",   getServiceArea);
router.post("/service-area/check", checkServiceArea);

module.exports = router;

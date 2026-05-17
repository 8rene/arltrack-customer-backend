const express = require("express");
const router  = express.Router();

const { getServices, getServiceTypes, getCarBookings } = require("../controllers/services/services.controller");

router.get("/",                      getServices);
router.get("/types",                 getServiceTypes);
router.get("/car-bookings/:carID",   getCarBookings);

module.exports = router;

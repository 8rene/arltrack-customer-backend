const express      = require("express");
const router       = express.Router();
const { verifyToken } = require("../middlewares/auth.middleware");

const { getServices, getServiceTypes, getCarBookings } = require("../controllers/services/services.controller");

router.get("/",                                  getServices);
router.get("/types",                             getServiceTypes);
router.get("/car-bookings/:carID", verifyToken,  getCarBookings);

module.exports = router;

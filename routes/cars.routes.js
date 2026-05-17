const express = require("express");
const router  = express.Router();

const { getAllCars, getFeaturedCars, getCarDetails } = require("../controllers/cars/cars.controller");

router.get("/all",         getAllCars);
router.get("/featured",    getFeaturedCars);
router.get("/:carID/details", getCarDetails);

module.exports = router;

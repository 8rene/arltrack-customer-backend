const express = require("express");
const router  = express.Router();

const { getAllCars, getFeaturedCars, getCarDetails } = require("../controllers/cars/cars.controller");

router.post("/all",        getAllCars);
router.post("/featured",   getFeaturedCars);
router.post("/:carID/details", getCarDetails);

module.exports = router;

const express = require("express");
const router  = express.Router();
const { createReview, updateReview, getUserReviews } = require("../controllers/reviews/reviews.controller");
const verifyToken = require("../middlewares/auth.middleware");

router.post("/create",           verifyToken, createReview);
router.put("/:reviewID",         verifyToken, updateReview);
router.get("/user/:userID",      verifyToken, getUserReviews);

module.exports = router;

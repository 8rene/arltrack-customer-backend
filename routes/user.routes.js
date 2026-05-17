const express = require("express");
const router  = express.Router();

const {
  getUserDetails,
  updateUserDetails,
  getFullProfile,
  updateFullProfile,
  updateAvatar,
} = require("../controllers/user/user.controller");
const verifyToken = require("../middlewares/auth.middleware");

router.get("/details/:userID",        verifyToken, getUserDetails);
router.put("/details/:userID",        verifyToken, updateUserDetails);
router.get("/profile/:userID",        verifyToken, getFullProfile);
router.put("/profile/:userID",        verifyToken, updateFullProfile);
router.post("/profile/:userID/avatar", verifyToken, updateAvatar);

module.exports = router;

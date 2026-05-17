const express = require("express");
const router  = express.Router();

const { updateUserStatus, getAllUsers } = require("../controllers/admin/admin.controller");
const verifyToken = require("../middlewares/auth.middleware");
const verifyAdmin = require("../middlewares/admin.middleware");

// All admin routes require: valid JWT + admin role
router.use(verifyToken, verifyAdmin);

// GET  /api/admin/users                  — list all users
router.get("/users", getAllUsers);

// PUT  /api/admin/user/:userID/status    — change user status (triggers email on unlock)
router.put("/user/:userID/status", updateUserStatus);

module.exports = router;

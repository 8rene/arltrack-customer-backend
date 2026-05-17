require("dotenv").config();

const express = require("express");
const cors = require("cors");

const { db } = require("./config/firebaseConnection/firebase");
const authRoutes     = require("./routes/auth.routes");
const servicesRoutes = require("./routes/services.routes");
const carsRoutes     = require("./routes/cars.routes");
const userRoutes     = require("./routes/user.routes");
const bookingsRoutes = require("./routes/bookings.routes");
const reviewsRoutes  = require("./routes/reviews.routes");
const locationRoutes = require("./routes/location.routes");
const adminRoutes    = require("./routes/admin.routes");

const app = express();

app.use(cors());
app.use(express.json({ limit: "20mb" }));
app.use(express.urlencoded({ limit: "20mb", extended: true }));

// Routes
app.use("/api/auth",     authRoutes);
app.use("/api/services", servicesRoutes);
app.use("/api/cars",     carsRoutes);
app.use("/api/user",     userRoutes);
app.use("/api/bookings", bookingsRoutes);
app.use("/api/reviews",  reviewsRoutes);
app.use("/api/location", locationRoutes);
app.use("/api/admin",    adminRoutes);

// Firebase connection test
const testFirebaseConnection = async () => {
  try {
    const snapshot = await db.collection("user").limit(1).get();
    console.log("✅ Firebase Connected! Docs found:", snapshot.size);
  } catch (error) {
    console.error("❌ Firebase NOT Connected:", error.message);
  }
};

testFirebaseConnection();

const PORT = process.env.PORT || 5000;
app.listen(PORT, () => {
  console.log(`🚀 Server running on port ${PORT}`);
});

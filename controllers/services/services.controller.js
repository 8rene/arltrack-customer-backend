const { db } = require("../../config/firebaseConnection/firebase");
const { BOOKING_STATUS } = require("../../utils/bookings/bookingStatus.util");

// Firestore Admin SDK Timestamps serialize over res.json() as a plain
// { _seconds, _nanoseconds } object (their own toJSON()) — NOT an ISO
// string. `new Date({_seconds:...})` on the frontend silently produces
// an Invalid Date (no error thrown), which then turns into a "NaN-NaN-NaN"
// calendar key in Booking.jsx's getDateStatuses() and is never matched
// against any real day. Always convert to a real Date/ISO string before
// putting a Firestore timestamp field in an API response.
const toISO = (value) => {
  if (!value) return null;
  if (typeof value.toDate === "function") return value.toDate().toISOString(); // Firestore Timestamp
  if (value instanceof Date) return value.toISOString();
  return value; // already a string/number — leave as-is
};

// GET /api/services/types — returns only serviceType names (no carID)
const getServiceTypes = async (req, res) => {
  try {
    const snap = await db.collection("serviceType").get();
    const types = snap.docs.map((doc) => ({
      serviceID:   doc.id,
      serviceType: doc.data().serviceType || "",
    })).filter((s) => s.serviceType).sort((a, b) => a.serviceType.localeCompare(b.serviceType));
    return res.status(200).json(types);
  } catch (error) {
    console.error("getServiceTypes error:", error);
    return res.status(500).json({ message: "Failed to fetch service types." });
  }
};

// GET /api/services/car-bookings/:carID — returns booked time windows AND
// scheduled-maintenance days for availability checking. The car's own
// `status` field is never used for this — a car flagged "Maintenance" in
// Fleet.jsx still needs to be bookable on every day that isn't actually
// covered by one of its own carMaintenance records. Only "Scheduled"
// maintenance blocks a day; "Completed"/"Cancelled" records don't (see
// admin-backend's maintenance.model.js for why "In Progress"/"Overdue"
// were dropped from the status list).
// NOTE: intentionally omits bookingID and userID — only time/status data is needed by the client
const getCarBookings = async (req, res) => {
  const { carID } = req.params;
  try {
    const [bookingSnap, maintSnap, completedSnap] = await Promise.all([
      db.collection("bookings")
        .where("carID", "==", carID)
        .where("status", "in", [BOOKING_STATUS.TO_PAY, BOOKING_STATUS.UPCOMING, BOOKING_STATUS.ONGOING])
        .get(),
      db.collection("carMaintenance")
        .where("carID", "==", carID)
        .where("status", "==", "Scheduled")
        .get(),
      // Recently-completed bookings still carry a 1-day post-rental
      // turnaround buffer (see the availability guard in
      // bookings.controller.js, which now enforces this the same day the
      // booking is marked returned — no more waiting on
      // jobs/postRentalMaintenance.job.js's once-a-day cron). Only the last
      // 2 days are worth fetching: anything older can't possibly still be
      // inside a 1-day buffer window. Needs a composite index on
      // (carID ASC, status ASC, updatedAt ASC) — Firestore will prompt for
      // it on first run if missing.
      db.collection("bookings")
        .where("carID", "==", carID)
        .where("status", "==", BOOKING_STATUS.COMPLETED)
        .where("updatedAt", ">=", new Date(Date.now() - 2 * 24 * 60 * 60 * 1000))
        .get()
        .catch((err) => {
          console.warn("[getCarBookings] completed-bookings buffer query failed (missing index?):", err.message);
          return { docs: [] };
        }),
    ]);

    const bookings = bookingSnap.docs.map((doc) => {
      const d = doc.data();
      return {
        // bookingID intentionally excluded — not needed by client and avoids ID enumeration
        status:        d.status || BOOKING_STATUS.TO_PAY,
        startDateTime: toISO(d.startDateTime),
        endDateTime:   toISO(d.endDateTime),
      };
    });

    // Sent as their own "completed" entries — Booking.jsx's getDateStatuses()
    // only greys the single day AFTER endDateTime for these (the rental
    // window itself is in the past and doesn't need marking).
    const completedBookings = completedSnap.docs.map((doc) => {
      const d = doc.data();
      return {
        status:        BOOKING_STATUS.COMPLETED,
        startDateTime: toISO(d.startDateTime),
        endDateTime:   toISO(d.endDateTime),
      };
    });

    // Each maintenance record blocks just its own single day —
    // maintenanceDate has no separate end date in the data model.
    const maintenanceDays = maintSnap.docs
      .map((doc) => doc.data().maintenanceDate)
      .filter(Boolean)
      .map((d) => ({
        status:        "maintenance",
        startDateTime: toISO(d),
        endDateTime:   toISO(d),
      }));

    return res.status(200).json([...bookings, ...completedBookings, ...maintenanceDays]);
  } catch (error) {
    console.error("getCarBookings error:", error);
    return res.status(500).json({ message: "Failed to fetch car bookings." });
  }
};

const getServices = async (req, res) => {
  try {
    // 1. Fetch all service types
    const serviceSnap = await db.collection("serviceType").get();
    const services = serviceSnap.docs.map((doc) => ({
      serviceID:   doc.id,
      serviceType: doc.data().serviceType || "",
      carIDs:      doc.data().carID || [],    // array of carIDs
    }));

    // 2. Collect all unique carIDs across all services
    const allCarIDs = [...new Set(services.flatMap((s) => s.carIDs))];

    if (allCarIDs.length === 0) {
      return res.status(200).json(
        services.map((s) => ({ ...s, vehicles: [] }))
      );
    }

    // 3. Fetch all needed car documents
    const carDocs = await Promise.all(
      allCarIDs.map((id) => db.collection("cars").doc(id).get())
    );

    // Build a map: carID → { brandID, modelID }
    const carMap = {};
    const brandIDs = new Set();
    const modelIDs = new Set();

    carDocs.forEach((doc) => {
      if (doc.exists) {
        const d = doc.data();
        carMap[doc.id] = { brandID: d.brandID, modelID: d.modelID };
        if (d.brandID) brandIDs.add(d.brandID);
        if (d.modelID) modelIDs.add(d.modelID);
      }
    });

    // 4. Fetch all needed brand documents
    const brandDocs = await Promise.all(
      [...brandIDs].map((id) => db.collection("brand").doc(id).get())
    );
    const brandMap = {};
    brandDocs.forEach((doc) => {
      if (doc.exists) brandMap[doc.id] = doc.data().brandName || "";
    });

    // 5. Fetch all needed model documents
    const modelDocs = await Promise.all(
      [...modelIDs].map((id) => db.collection("model").doc(id).get())
    );
    const modelMap = {};
    modelDocs.forEach((doc) => {
      if (doc.exists) modelMap[doc.id] = doc.data().modelName || "";
    });

    // 6. Build final response — resolve each carID to "BrandName ModelName"
    const result = services.map((s) => ({
      serviceID:   s.serviceID,
      serviceType: s.serviceType,
      vehicles: s.carIDs.map((carID) => {
        const car   = carMap[carID];
        if (!car) return null;
        const brand = brandMap[car.brandID] || "";
        const model = modelMap[car.modelID] || "";
        return `${brand} ${model}`.trim();
      }).filter(Boolean),
    }));

    return res.status(200).json(result);

  } catch (error) {
    console.error("getServices error:", error);
    return res.status(500).json({ message: "Failed to fetch services." });
  }
};

module.exports = { getServices, getServiceTypes, getCarBookings };

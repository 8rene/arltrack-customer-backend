const { db } = require("../../config/firebaseConnection/firebase");

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

// GET /api/services/car-bookings/:carID — returns booked time windows for availability checking
// NOTE: intentionally omits bookingID and userID — only time/status data is needed by the client
const getCarBookings = async (req, res) => {
  const { carID } = req.params;
  try {
    const snap = await db.collection("bookings")
      .where("carID", "==", carID)
      .where("status", "in", ["pending", "confirmed", "active"])
      .get();

    const bookings = snap.docs.map((doc) => {
      const d = doc.data();
      return {
        // bookingID intentionally excluded — not needed by client and avoids ID enumeration
        status:        d.status        || "pending",
        startDateTime: d.startDateTime || null,
        endDateTime:   d.endDateTime   || null,
      };
    });

    return res.status(200).json(bookings);
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

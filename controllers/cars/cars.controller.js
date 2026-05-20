const { db } = require("../../config/firebaseConnection/firebase");

// Helper: resolve car details (brand, model, primary image, all pricing)
const resolveCarDetails = async (carID, carData, brandMap, modelMap) => {
  const brand = brandMap[carData.brandID] || "";
  const model = modelMap[carData.modelID] || "";

  // Fetch primary image
  let imageURL = "";
  try {
    const imgSnap = await db
      .collection("carImages")
      .where("carID", "==", carID)
      .where("isPrimary", "==", true)
      .limit(1)
      .get();
    if (!imgSnap.empty) {
      imageURL = imgSnap.docs[0].data().imageURL || "";
    }
  } catch (_) {}

  // Fetch all pricing for this car
  let pricing = [];
  try {
    const priceSnap = await db
      .collection("carPricing")
      .where("carID", "==", carID)
      .get();
    if (!priceSnap.empty) {
      pricing = priceSnap.docs
        .map((d) => ({ durationType: d.data().durationType, price: d.data().price }))
        .sort((a, b) => a.price - b.price);
    }
  } catch (_) {}

  return {
    carID,
    name:             `${brand} ${model}`.trim(),
    brandName:        brand,
    modelName:        model,
    bodyType:         carData.bodyType         || "",
    color:            carData.color            || "",
    fuelType:         carData.fuelType         || "",
    transmission:     carData.transmission     || "",
    seatingCapacity:  carData.seatingCapacity  || 0,
    shortDescription: carData.shortDescription || "",
    longDescription:  carData.longDescription  || "",
    plateNumber:      carData.plateNumber      || "",
    year:             carData.year             || "",
    status:           carData.status           || "",
    imageURL,
    pricing,
    startingPrice:    pricing.length ? pricing[0].price        : null,
    durationType:     pricing.length ? pricing[0].durationType : null,
  };
};

// GET /api/cars/all — returns every car with full details
const getAllCars = async (req, res) => {
  try {
    const carsSnap = await db.collection("cars").get();

    if (carsSnap.empty) {
      return res.status(200).json([]);
    }

    // Collect all brandIDs and modelIDs
    const brandIDs = new Set();
    const modelIDs = new Set();
    const carsRaw  = [];

    carsSnap.docs.forEach((doc) => {
      const d = doc.data();
      carsRaw.push({ id: doc.id, data: d });
      if (d.brandID) brandIDs.add(d.brandID);
      if (d.modelID) modelIDs.add(d.modelID);
    });

    // Batch-fetch brands and models
    const [brandDocs, modelDocs] = await Promise.all([
      Promise.all([...brandIDs].map((id) => db.collection("brand").doc(id).get())),
      Promise.all([...modelIDs].map((id) => db.collection("model").doc(id).get())),
    ]);

    const brandMap = {};
    brandDocs.forEach((d) => { if (d.exists) brandMap[d.id] = d.data().brandName || ""; });

    const modelMap = {};
    modelDocs.forEach((d) => { if (d.exists) modelMap[d.id] = d.data().modelName || ""; });

    // Resolve full details for every car in parallel
    const resolved = await Promise.all(
      carsRaw.map(({ id, data }) => resolveCarDetails(id, data, brandMap, modelMap))
    );

    return res.status(200).json(resolved);

  } catch (error) {
    console.error("getAllCars error:", error);
    return res.status(500).json({ message: "Failed to fetch cars." });
  }
};

// GET /api/cars/featured
const getFeaturedCars = async (req, res) => {
  try {
    // 1. Get all cars first to know valid carIDs (Firestore `in` needs explicit IDs)
    const carsSnap = await db.collection("cars").get();
    if (carsSnap.empty) {
      return res.status(200).json({ mostReviewed: [], mostBooked: [] });
    }

    const carDataMap = {};
    const brandIDs   = new Set();
    const modelIDs   = new Set();
    const allCarIDs  = [];

    carsSnap.docs.forEach((doc) => {
      carDataMap[doc.id] = doc.data();
      allCarIDs.push(doc.id);
      if (doc.data().brandID) brandIDs.add(doc.data().brandID);
      if (doc.data().modelID) modelIDs.add(doc.data().modelID);
    });

    // 2. Query only reviews and bookings for known cars (max 30 per `in` query — safe for a car fleet)
    const carIDChunks = [];
    for (let i = 0; i < allCarIDs.length; i += 30) {
      carIDChunks.push(allCarIDs.slice(i, i + 30));
    }

    const [reviewsDocs, bookingsDocs] = await Promise.all([
      Promise.all(carIDChunks.map(chunk =>
        db.collection("reviews").where("carID", "in", chunk).get()
      )),
      Promise.all(carIDChunks.map(chunk =>
        db.collection("bookings").where("carID", "in", chunk).get()
      )),
    ]);

    const reviewCount  = {};
    const bookingCount = {};

    reviewsDocs.flat().forEach(snap =>
      snap.docs.forEach(doc => {
        const cid = doc.data().carID;
        if (cid) reviewCount[cid] = (reviewCount[cid] || 0) + 1;
      })
    );
    bookingsDocs.flat().forEach(snap =>
      snap.docs.forEach(doc => {
        const cid = doc.data().carID;
        if (cid) bookingCount[cid] = (bookingCount[cid] || 0) + 1;
      })
    );

    const top3Reviewed = Object.entries(reviewCount)
      .sort((a, b) => b[1] - a[1]).slice(0, 3).map(([id]) => id);
    const top3Booked   = Object.entries(bookingCount)
      .sort((a, b) => b[1] - a[1]).slice(0, 3).map(([id]) => id);

    const featuredIDs = [...new Set([...top3Reviewed, ...top3Booked])];
    if (featuredIDs.length === 0) {
      return res.status(200).json({ mostReviewed: [], mostBooked: [] });
    }

    // 3. Resolve brand/model names
    const [brandDocs, modelDocs] = await Promise.all([
      Promise.all([...brandIDs].map((id) => db.collection("brand").doc(id).get())),
      Promise.all([...modelIDs].map((id) => db.collection("model").doc(id).get())),
    ]);

    const brandMap = {};
    brandDocs.forEach((d) => { if (d.exists) brandMap[d.id] = d.data().brandName || ""; });
    const modelMap = {};
    modelDocs.forEach((d) => { if (d.exists) modelMap[d.id] = d.data().modelName || ""; });

    // 4. Resolve full car details for featured cars only
    const resolvedMap = {};
    await Promise.all(
      featuredIDs.filter((id) => carDataMap[id]).map(async (id) => {
        resolvedMap[id] = await resolveCarDetails(id, carDataMap[id], brandMap, modelMap);
      })
    );

    const mostReviewed = top3Reviewed
      .filter((id) => resolvedMap[id])
      .map((id) => ({ ...resolvedMap[id], reviewCount: reviewCount[id] || 0 }));

    const mostBooked = top3Booked
      .filter((id) => resolvedMap[id])
      .map((id) => ({ ...resolvedMap[id], bookingCount: bookingCount[id] || 0 }));

    return res.status(200).json({ mostReviewed, mostBooked });

  } catch (error) {
    console.error("getFeaturedCars error:", error);
    return res.status(500).json({ message: "Failed to fetch featured cars." });
  }
};

// GET /api/cars/:carID/details — returns car info + all bookings + all reviews
const getCarDetails = async (req, res) => {
  const { carID } = req.params;
  if (!carID) return res.status(400).json({ message: "carID is required." });

  try {
    // 1. Get car document
    const carDoc = await db.collection("cars").doc(carID).get();
    if (!carDoc.exists) return res.status(404).json({ message: "Car not found." });

    const carData = carDoc.data();

    // 2. Fetch brand/model
    const [brandDoc, modelDoc] = await Promise.all([
      carData.brandID ? db.collection("brand").doc(carData.brandID).get() : Promise.resolve(null),
      carData.modelID ? db.collection("model").doc(carData.modelID).get() : Promise.resolve(null),
    ]);
    const brandMap = {};
    const modelMap = {};
    if (brandDoc?.exists) brandMap[carData.brandID] = brandDoc.data().brandName || "";
    if (modelDoc?.exists) modelMap[carData.modelID] = modelDoc.data().modelName || "";

    const carResolved = await resolveCarDetails(carID, carData, brandMap, modelMap);

    // 3. Fetch all bookings for this car
    const bookingsSnap = await db.collection("bookings").where("carID", "==", carID).get();
    const bookings = bookingsSnap.docs.map((doc) => {
      const b = doc.data();
      return {
        bookingID:     b.bookingID     || doc.id,
        userID:        b.userID        || "",
        serviceType:   b.serviceType   || "",
        startDateTime: b.startDateTime || null,
        endDateTime:   b.endDateTime   || null,
        totalDays:     b.totalDays     || 1,
        modeOfDriving: b.modeOfDriving || "",
        status:        b.status        || "pending",
        createdAt:     b.createdAt     || null,
      };
    });

    // Sort bookings by createdAt descending (latest first)
    bookings.sort((a, b) => {
      const ta = a.createdAt?._seconds ? a.createdAt._seconds : (a.createdAt?.toDate ? a.createdAt.toDate().getTime() / 1000 : 0);
      const tb = b.createdAt?._seconds ? b.createdAt._seconds : (b.createdAt?.toDate ? b.createdAt.toDate().getTime() / 1000 : 0);
      return tb - ta;
    });

    // 4. Fetch all reviews for this car
    const reviewsSnap = await db.collection("reviews").where("carID", "==", carID).get();
    const reviews = reviewsSnap.docs.map((doc) => {
      const r = doc.data();
      return {
        reviewID:  doc.id,
        userID:    r.userID    || "",
        rating:    r.rating    || 0,
        comment:   r.comment   || "",
        createdAt: r.createdAt || null,
      };
    });

    // Sort reviews by createdAt descending
    reviews.sort((a, b) => {
      const ta = a.createdAt?._seconds ? a.createdAt._seconds : 0;
      const tb = b.createdAt?._seconds ? b.createdAt._seconds : 0;
      return tb - ta;
    });

    return res.status(200).json({
      car:           carResolved,
      bookings,
      bookingCount:  bookings.length,
      reviews,
      reviewCount:   reviews.length,
    });

  } catch (error) {
    console.error("getCarDetails error:", error);
    return res.status(500).json({ message: "Failed to fetch car details." });
  }
};

module.exports = { getAllCars, getFeaturedCars, getCarDetails };

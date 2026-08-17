const { db } = require("../../config/firebaseConnection/firebase");
const usePostalPH = require("use-postal-ph").default || require("use-postal-ph");

// In-memory cache — location data almost never changes.
// Cache is cleared only on server restart/cold start (acceptable on Vercel).
const cache = {
  regions:        null,
  provinces:      {},   // keyed by regionID
  municipalities: {},   // keyed by provinceID
  barangays:      {},   // keyed by municipalityID
};

// Separate, short-lived cache for the store location — unlike the PSGC
// data above, this CAN change any time an admin edits it on the admin
// app's Settings page, so it isn't cached indefinitely. A short TTL still
// avoids hitting Firestore on every single Booking.jsx/BookingDetails.jsx
// page load, while keeping an admin's edit visible within a minute
// without needing a redeploy or server restart.
let storeLocationCache = null;
let storeLocationCacheAt = 0;
const STORE_LOCATION_CACHE_TTL_MS = 60 * 1000;

/**
 * GET /api/location/regions
 * Returns all regions from Firestore.
 */
const getRegions = async (req, res) => {
  try {
    if (cache.regions) return res.json(cache.regions);

    const snapshot = await db.collection("regions").get();
    const regions = snapshot.docs.map((doc) => ({
      regionID:   doc.data().regionID,
      regionName: doc.data().regionName,
    }));
    regions.sort((a, b) => a.regionName.localeCompare(b.regionName));

    cache.regions = regions;
    res.json(regions);
  } catch (error) {
    console.error("getRegions error:", error);
    res.status(500).json({ error: "Failed to fetch regions" });
  }
};

/**
 * GET /api/location/provinces?regionID=xxx
 * Returns all provinces for a given region.
 */
const getProvinces = async (req, res) => {
  const { regionID } = req.query;
  if (!regionID) return res.status(400).json({ error: "regionID is required" });

  try {
    if (cache.provinces[regionID]) return res.json(cache.provinces[regionID]);

    const snapshot = await db
      .collection("provinces")
      .where("regionID", "==", regionID)
      .get();

    const provinces = snapshot.docs.map((doc) => ({
      provinceID:   doc.data().provinceID,
      provinceName: doc.data().provinceName,
      regionID:     doc.data().regionID,
    }));
    provinces.sort((a, b) => a.provinceName.localeCompare(b.provinceName));

    cache.provinces[regionID] = provinces;
    res.json(provinces);
  } catch (error) {
    console.error("getProvinces error:", error);
    res.status(500).json({ error: "Failed to fetch provinces" });
  }
};

/**
 * GET /api/location/municipalities?provinceID=xxx
 * Returns all municipalities for a given province.
 */
const getMunicipalities = async (req, res) => {
  const { provinceID } = req.query;
  if (!provinceID) return res.status(400).json({ error: "provinceID is required" });

  try {
    if (cache.municipalities[provinceID]) return res.json(cache.municipalities[provinceID]);

    const snapshot = await db
      .collection("municipalities")
      .where("provinceID", "==", provinceID)
      .get();

    const municipalities = snapshot.docs.map((doc) => ({
      municipalityID:   doc.data().municipalityID,
      municipalityName: doc.data().municipalityName,
      provinceID:       doc.data().provinceID,
    }));
    municipalities.sort((a, b) => a.municipalityName.localeCompare(b.municipalityName));

    cache.municipalities[provinceID] = municipalities;
    res.json(municipalities);
  } catch (error) {
    console.error("getMunicipalities error:", error);
    res.status(500).json({ error: "Failed to fetch municipalities" });
  }
};

/**
 * GET /api/location/barangays?municipalityID=xxx
 * Returns all barangays for a given municipality.
 */
const getBarangays = async (req, res) => {
  const { municipalityID } = req.query;
  if (!municipalityID) return res.status(400).json({ error: "municipalityID is required" });

  try {
    if (cache.barangays[municipalityID]) return res.json(cache.barangays[municipalityID]);

    const snapshot = await db
      .collection("barangays")
      .where("municipalityID", "==", municipalityID)
      .get();

    const barangays = snapshot.docs.map((doc) => ({
      barangayID:     doc.data().barangayID,
      barangayName:   doc.data().barangayName,
      municipalityID: doc.data().municipalityID,
    }));
    barangays.sort((a, b) => a.barangayName.localeCompare(b.barangayName));

    cache.barangays[municipalityID] = barangays;
    res.json(barangays);
  } catch (error) {
    console.error("getBarangays error:", error);
    res.status(500).json({ error: "Failed to fetch barangays" });
  }
};

/**
 * GET /api/location/postal-code?municipality=xxx&barangay=yyy
 * Looks up the postal/ZIP code, preferring barangay-level precision when
 * available (mainly NCR, where each barangay/district has its own code)
 * and falling back to the municipality/city-wide code otherwise.
 * Used to auto-fill the Postal Code field once a Barangay is selected
 * during registration — the value stays editable on the frontend.
 */
const postalPH = usePostalPH();

// PSGC names sometimes wrap the city name ("City of Malolos", "Taguig City")
// while the postal dataset stores it plain ("Malolos", "Taguig City" as location).
// This tries a few reasonable variants before giving up.
const stripCityWrapping = (name) =>
  name.replace(/^city of\s+/i, "").replace(/\s+city$/i, "").trim();

const lookupMunicipalityCode = (rawName) => {
  const name = rawName.trim();
  if (!name) return null;

  // 1. Direct municipality/town match (covers most provinces)
  let result = postalPH.fetchDataLists({ municipality: name });
  if (result?.data?.length === 1) return result.data[0].post_code;

  // 2. Retry without "City of " / " City" wrapping
  const stripped = stripCityWrapping(name);
  if (stripped !== name) {
    result = postalPH.fetchDataLists({ municipality: stripped });
    if (result?.data?.length === 1) return result.data[0].post_code;
  }

  // 3. NCR-style cities are split into many district post offices —
  //    match by "location" and prefer the Central Post Office (CPO) entry
  for (const candidate of [name, stripped]) {
    result = postalPH.fetchDataLists({ location: candidate });
    if (result?.data?.length) {
      const cpo = result.data.find((d) => /cpo/i.test(d.municipality));
      return (cpo || result.data[0]).post_code;
    }
  }

  return null;
};

const lookupBarangayCode = (municipalityName, barangayName) => {
  const city     = municipalityName.trim();
  const barangay = barangayName.trim();
  if (!city || !barangay) return null;

  // Barangay/district-level entries live under `municipality` scoped to a
  // `location` (city) in this dataset — try both the raw and de-wrapped
  // city name so "City of Manila" / "Manila" both work as the scope.
  for (const cityCandidate of [city, stripCityWrapping(city)]) {
    const result = postalPH.fetchDataLists({ location: cityCandidate, municipality: barangay });
    if (result?.data?.length === 1) return result.data[0].post_code;
  }
  return null;
};

const getPostalCode = async (req, res) => {
  const { municipality, barangay } = req.query;
  if (!municipality) return res.status(400).json({ error: "municipality is required" });

  try {
    const postCode =
      (barangay && lookupBarangayCode(municipality, barangay)) ??
      lookupMunicipalityCode(municipality);

    if (postCode == null) return res.json({ postalCode: "", found: false });

    res.json({ postalCode: String(postCode), found: true });
  } catch (error) {
    console.error("getPostalCode error:", error);
    res.status(500).json({ error: "Failed to look up postal code" });
  }
};

/**
 * GET /api/location/store
 * Returns the in-store pickup location (name + coordinates), configured
 * by an Owner/Admin on the admin app's Settings page → Store Location &
 * Name. Reads the same `systemSettings` Firestore collection the admin
 * backend writes to directly — same Firebase project, no admin-backend
 * round trip needed.
 *
 * { storeName: "", storeLat: null, storeLng: null } (all unset/null) means
 * no store location has been configured yet — the customer app's
 * "Pick up in-store" option should stay hidden in that case, exactly like
 * the old STORE_CONFIGURED env-var check it replaces.
 */
const getStoreLocation = async (req, res) => {
  try {
    const now = Date.now();
    if (storeLocationCache && now - storeLocationCacheAt < STORE_LOCATION_CACHE_TTL_MS) {
      return res.json(storeLocationCache);
    }

    const snapshot = await db
      .collection("systemSettings")
      .orderBy("createdAt", "desc")
      .limit(1)
      .get();

    const doc = snapshot.empty ? {} : snapshot.docs[0].data();
    const result = {
      storeName: doc.storeName || "",
      storeLat: typeof doc.storeLat === "number" ? doc.storeLat : null,
      storeLng: typeof doc.storeLng === "number" ? doc.storeLng : null,
    };

    storeLocationCache = result;
    storeLocationCacheAt = now;
    res.json(result);
  } catch (error) {
    console.error("getStoreLocation error:", error);
    // Fail safe rather than fail loud — a broken store-location lookup
    // shouldn't block the whole booking page from loading. The frontend
    // treats this the same as "not configured" (hides the in-store option).
    res.json({ storeName: "", storeLat: null, storeLng: null });
  }
};

module.exports = { getRegions, getProvinces, getMunicipalities, getBarangays, getPostalCode, getStoreLocation };
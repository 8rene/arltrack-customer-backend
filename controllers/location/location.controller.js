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
 * GET /api/location/postal-code?municipality=xxx
 * Looks up the postal/ZIP code for a given municipality/city name.
 * Used to auto-fill the Postal Code field once a Municipality/City is
 * selected during registration or profile editing — the value stays
 * editable on the frontend since some areas span more than one code.
 */
const postalPH = usePostalPH();

// PSGC names sometimes wrap the city name ("City of Malolos", "Taguig City")
// while the postal dataset stores it plain ("Malolos", "Taguig City" as location).
// This tries a few reasonable variants before giving up.
const stripCityWrapping = (name) =>
  name.replace(/^city of\s+/i, "").replace(/\s+city$/i, "").trim();

const lookupPostalCode = (rawName) => {
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

const getPostalCode = async (req, res) => {
  const { municipality } = req.query;
  if (!municipality) return res.status(400).json({ error: "municipality is required" });

  try {
    const postCode = lookupPostalCode(municipality);
    if (postCode == null) return res.json({ postalCode: "", found: false });

    res.json({ postalCode: String(postCode), found: true });
  } catch (error) {
    console.error("getPostalCode error:", error);
    res.status(500).json({ error: "Failed to look up postal code" });
  }
};

module.exports = { getRegions, getProvinces, getMunicipalities, getBarangays, getPostalCode };

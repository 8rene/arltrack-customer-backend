const { db } = require("../../config/firebaseConnection/firebase");

/**
 * GET /api/location/regions
 * Returns all regions from Firestore.
 */
const getRegions = async (req, res) => {
  try {
    const snapshot = await db.collection("regions").get();
    const regions = snapshot.docs.map((doc) => ({
      regionID: doc.data().regionID,
      regionName: doc.data().regionName,
    }));
    regions.sort((a, b) => a.regionName.localeCompare(b.regionName));
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
    const snapshot = await db
      .collection("provinces")
      .where("regionID", "==", regionID)
      .get();

    const provinces = snapshot.docs.map((doc) => ({
      provinceID: doc.data().provinceID,
      provinceName: doc.data().provinceName,
      regionID: doc.data().regionID,
    }));
    provinces.sort((a, b) => a.provinceName.localeCompare(b.provinceName));
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
    const snapshot = await db
      .collection("municipalities")
      .where("provinceID", "==", provinceID)
      .get();

    const municipalities = snapshot.docs.map((doc) => ({
      municipalityID: doc.data().municipalityID,
      municipalityName: doc.data().municipalityName,
      provinceID: doc.data().provinceID,
    }));
    municipalities.sort((a, b) => a.municipalityName.localeCompare(b.municipalityName));
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
    const snapshot = await db
      .collection("barangays")
      .where("municipalityID", "==", municipalityID)
      .get();

    const barangays = snapshot.docs.map((doc) => ({
      barangayID: doc.data().barangayID,
      barangayName: doc.data().barangayName,
      municipalityID: doc.data().municipalityID,
    }));
    barangays.sort((a, b) => a.barangayName.localeCompare(b.barangayName));
    res.json(barangays);
  } catch (error) {
    console.error("getBarangays error:", error);
    res.status(500).json({ error: "Failed to fetch barangays" });
  }
};

module.exports = { getRegions, getProvinces, getMunicipalities, getBarangays };

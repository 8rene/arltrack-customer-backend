const { db } = require("../../config/firebaseConnection/firebase");

// ─────────────────────────────────────────────────────────────
// GET /api/user/details/:userID
// ─────────────────────────────────────────────────────────────
const getUserDetails = async (req, res) => {
  const { userID } = req.params;
  try {
    const [userDoc, detailsDoc] = await Promise.all([
      db.collection("user").doc(userID).get(),
      db.collection("userDetails").doc(userID).get(),
    ]);
    if (!userDoc.exists) return res.status(404).json({ message: "User not found." });
    const user    = userDoc.data();
    const details = detailsDoc.exists ? detailsDoc.data() : {};
    return res.status(200).json({
      userID,
      email:        user.email        || "",
      phone:        user.phone        || "",
      username:     user.username     || "",
      profileImage: user.profileImage || "",
      roleID:       user.roleID       || "",
      isVerified:   user.isVerified   || false,
      firstName:    details.firstName  || "",
      lastName:     details.lastName   || "",
      middleName:   details.middleName || "",
      suffix:       details.suffix     || "",
      birthDate:    details.birthDate  || "",
    });
  } catch (error) {
    console.error("getUserDetails error:", error);
    return res.status(500).json({ message: "Failed to fetch user details." });
  }
};

// ─────────────────────────────────────────────────────────────
// PUT /api/user/details/:userID
// ─────────────────────────────────────────────────────────────
const updateUserDetails = async (req, res) => {
  const { userID } = req.params;
  const { firstName, lastName, middleName, suffix, birthDate } = req.body;
  if (!firstName && !lastName)
    return res.status(400).json({ message: "At least firstName or lastName is required." });
  try {
    await db.collection("userDetails").doc(userID).set(
      { firstName: firstName || "", lastName: lastName || "", middleName: middleName || "",
        suffix: suffix || "", birthDate: birthDate || "", updatedAt: new Date() },
      { merge: true }
    );
    return res.status(200).json({ message: "User details updated." });
  } catch (error) {
    console.error("updateUserDetails error:", error);
    return res.status(500).json({ message: "Failed to update user details." });
  }
};

// ─────────────────────────────────────────────────────────────
// GET /api/user/profile/:userID — full profile (queries by userID field)
// ─────────────────────────────────────────────────────────────
const getFullProfile = async (req, res) => {
  const { userID } = req.params;
  try {
    // Fetch user, userDetails (stored by userID as doc id)
    const [userDoc, detailsDoc] = await Promise.all([
      db.collection("user").doc(userID).get(),
      db.collection("userDetails").doc(userID).get(),
    ]);

    if (!userDoc.exists) return res.status(404).json({ message: "User not found." });

    // Query userAddress and userDocument collections by userID field
    const [addressSnap, documentSnap] = await Promise.all([
      db.collection("userAddress").where("userID", "==", userID).get(),
      db.collection("userDocument").where("userID", "==", userID).get(),
    ]);

    const user    = userDoc.data();
    const details = detailsDoc.exists ? detailsDoc.data() : {};

    // Map all addresses
    const addresses = addressSnap.docs.map(doc => ({
      userAddressID: doc.id,
      ...doc.data(),
    }));

    // Map all documents
    const documents = documentSnap.docs.map(doc => ({
      userDocumentID: doc.id,
      ...doc.data(),
    }));

    // Primary address = isDefault true, or first one
    const primaryAddress = addresses.find(a => a.isDefault) || addresses[0] || {};

    // Primary document = first one (usually only one)
    const primaryDocument = documents[0] || {};

    return res.status(200).json({
      // user
      userID,
      email:             user.email             || "",
      phone:             user.phone             || "",
      username:          user.username          || "",
      profileImageUrl:   user.profileImageUrl   || user.profileImage || "",
      roleID:            user.roleID            || "",
      isVerified:        user.isVerified        || false,
      status:            user.status            || "",
      // userDetails
      firstName:         details.firstName      || "",
      lastName:          details.lastName       || "",
      middleName:        details.middleName     || "",
      suffix:            details.suffix         || "",
      birthDate:         details.birthDate      || "",
      // primary address (flat — for profile page display)
      userAddressID:     primaryAddress.userAddressID || "",
      province:          primaryAddress.province      || "",
      city:              primaryAddress.city          || "",
      municipality:      primaryAddress.municipality  || "",
      barangay:          primaryAddress.barangay      || "",
      street:            primaryAddress.street        || "",
      postalCode:        primaryAddress.postalCode    || "",
      zipCode:           primaryAddress.zipCode       || "",
      village:           primaryAddress.village       || "",
      isDefault:         primaryAddress.isDefault     || false,
      // all addresses array
      addresses,
      // primary document (flat) — isVerified lives on user collection, not userDocument
      userDocumentID:    primaryDocument.userDocumentID   || "",
      documentType:      primaryDocument.documentType     || "",
      documentNumber:    primaryDocument.documentNumber   || "",
      documentImageUrl:  primaryDocument.documentImageUrl || "",
      driverLicenseUrl:  primaryDocument.driverLicenseUrl || "",
      governmentIdUrl:   primaryDocument.governmentIdUrl  || "",
      selfieWithIdUrl:   primaryDocument.selfieWithIdUrl  || "",
      governmentIdType:  primaryDocument.governmentIdType || "",
      documentVerified:  user.isVerified                  || false, // sourced from user collection
      // all documents array
      documents,
    });
  } catch (error) {
    console.error("getFullProfile error:", error);
    return res.status(500).json({ message: "Failed to fetch profile." });
  }
};

// ─────────────────────────────────────────────────────────────
// PUT /api/user/profile/:userID — per-field update
// Accepts any subset of fields; updates the right collection
// ─────────────────────────────────────────────────────────────
const updateFullProfile = async (req, res) => {
  const { userID } = req.params;
  const {
    // user
    phone, username, profileImageUrl,
    // userDetails
    firstName, lastName, middleName, suffix, birthDate,
    // userAddress (include userAddressID to update specific doc)
    userAddressID,
    province, city, municipality, barangay, street, postalCode, village,
  } = req.body;

  try {
    const now   = new Date();
    const batch = db.batch();

    // — user fields —
    const userFields = {};
    if (phone           !== undefined) userFields.phone           = phone;
    if (username        !== undefined) userFields.username        = username;
    if (profileImageUrl !== undefined) userFields.profileImageUrl = profileImageUrl;
    if (Object.keys(userFields).length) {
      userFields.updatedAt = now;
      batch.set(db.collection("user").doc(userID), userFields, { merge: true });
    }

    // — userDetails fields —
    const detailFields = {};
    if (firstName  !== undefined) detailFields.firstName  = firstName;
    if (lastName   !== undefined) detailFields.lastName   = lastName;
    if (middleName !== undefined) detailFields.middleName = middleName;
    if (suffix     !== undefined) detailFields.suffix     = suffix;
    if (birthDate  !== undefined) detailFields.birthDate  = birthDate;
    if (Object.keys(detailFields).length) {
      detailFields.userID    = userID;
      detailFields.updatedAt = now;
      batch.set(db.collection("userDetails").doc(userID), detailFields, { merge: true });
    }

    // — userAddress fields —
    const addrFields = {};
    if (province     !== undefined) addrFields.province     = province;
    if (city         !== undefined) addrFields.city         = city;
    if (municipality !== undefined) addrFields.municipality = municipality;
    if (barangay     !== undefined) addrFields.barangay     = barangay;
    if (street       !== undefined) addrFields.street       = street;
    if (postalCode   !== undefined) { addrFields.postalCode = postalCode; addrFields.zipCode = postalCode; }
    if (village      !== undefined) addrFields.village      = village;

    if (Object.keys(addrFields).length) {
      addrFields.userID    = userID;
      addrFields.updatedAt = now;
      // Update the specific address doc if ID given, else query for user's address
      if (userAddressID) {
        batch.set(db.collection("userAddress").doc(userAddressID), addrFields, { merge: true });
      } else {
        // Try to find existing address doc for user
        const existingSnap = await db.collection("userAddress").where("userID", "==", userID).limit(1).get();
        if (!existingSnap.empty) {
          batch.set(existingSnap.docs[0].ref, addrFields, { merge: true });
        } else {
          // Create new address doc
          addrFields.isDefault = true;
          addrFields.createdAt = now;
          batch.set(db.collection("userAddress").doc(), addrFields);
        }
      }
    }

    await batch.commit();
    return res.status(200).json({ message: "Profile updated successfully." });
  } catch (error) {
    console.error("updateFullProfile error:", error);
    return res.status(500).json({ message: "Failed to update profile." });
  }
};

// ─────────────────────────────────────────────────────────────
// POST /api/user/profile/:userID/avatar — upload profile photo URL
// (Expects { profileImageUrl } in body after client uploads to storage)
// ─────────────────────────────────────────────────────────────
const updateAvatar = async (req, res) => {
  const { userID } = req.params;
  const { profileImageUrl } = req.body;
  if (!profileImageUrl)
    return res.status(400).json({ message: "profileImageUrl is required." });
  try {
    await db.collection("user").doc(userID).set(
      { profileImageUrl, updatedAt: new Date() },
      { merge: true }
    );
    return res.status(200).json({ message: "Avatar updated.", profileImageUrl });
  } catch (error) {
    console.error("updateAvatar error:", error);
    return res.status(500).json({ message: "Failed to update avatar." });
  }
};

module.exports = { getUserDetails, updateUserDetails, getFullProfile, updateFullProfile, updateAvatar };

const createUserAddress = (userID, data = {}) => ({
  userID,
  region:       data.region       || "",
  province:     data.province     || "",
  city:         data.city         || "",
  municipality: data.municipality || "",
  barangay:     data.barangay     || "",
  street:       data.street       || "",
  postalCode:   data.postalCode   || "",
  createdAt:    new Date(),
});

module.exports = createUserAddress;

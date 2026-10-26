const createUserAddress = (userID, data = {}) => ({
  userID,
  region:       data.region       || "",
  province:     data.province     || "",
  city:         data.city         || "",
  municipality: data.municipality || "",
  barangay:     data.barangay     || "",
  street:       data.street       || "",
  // zipCode is the only postal field now. postalCode was merged into it; data.postalCode is still read
  // so an older client that sends it does not lose the value.
  zipCode:      data.zipCode      || data.postalCode || "",
  createdAt:    new Date(),
});

module.exports = createUserAddress;
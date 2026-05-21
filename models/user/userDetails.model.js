const createUserDetails = (userID, data = {}) => ({
  userID,
  firstName:  data.firstName  || "",
  middleName: data.middleName || "",
  lastName:   data.lastName   || "",
  suffix:     data.suffix     || "",
  birthDate:  data.birthDate  || data.birthdate || "",
  createdAt:  new Date(),
});

module.exports = createUserDetails;

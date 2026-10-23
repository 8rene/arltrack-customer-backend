// Shape only, limited to the fields the customer backend READS (admin owns and writes this collection).

// serviceType/{serviceTypeID} -- bookings.serviceTypeID points here
const ServiceType = {
  serviceType: "",    // display name
  carID: [],          // array of carIDs offered for this service
};

module.exports = { ServiceType };

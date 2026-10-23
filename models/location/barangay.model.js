// Shape only, limited to the fields the customer backend READS (admin owns and writes this collection).

// barangays/{id}
const Barangay = { barangayID: "", barangayName: "", municipalityID: "" };

module.exports = { Barangay };

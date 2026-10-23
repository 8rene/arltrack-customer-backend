// Shape only, limited to the fields the customer backend READS (admin owns and writes this collection).

// municipalities/{id}
const Municipality = { municipalityID: "", municipalityName: "", provinceID: "" };

module.exports = { Municipality };

// Customer side of the pickup handover signature.
//   GET  /api/handovers/:bookingID        eligibility, the statements to sign, and the signed record (if any)
//   POST /api/handovers/:bookingID/sign   the renter signs at pickup
// One record per booking: `handovers/{bookingID}`. Staff check the renter's licence against the
// uploaded photo in the admin app and fill in verifiedAt / verifiedByUserID / licenseChecked /
// conditionNotes on the same doc (see docs/violations-and-handover-contract.md).
//
// !! The wording of HANDOVER_STATEMENTS is a DRAFT — have a lawyer review it, and bump
// !! HANDOVER_STATEMENTS_VERSION whenever it changes (the signed record stores the exact text).
const { db } = require("../../config/firebaseConnection/firebase");
const { notifyStaff } = require("../../services/notification/notification.service");
const { BOOKING_STATUS } = require("../../utils/bookings/bookingStatus.util");
const { loadOwnedBooking, realWindow, toISO } = require("../../utils/bookings/ownedBooking.util");

const HANDOVER_STATEMENTS_VERSION = "2026-10-14";
const HANDOVER_OPENS_HOURS_BEFORE = 24;
const MAX_ADDITIONAL_DRIVERS = 3;

const handoverStatements = (selfDrive) => [
  ...(selfDrive ? ["I am the renter named on this booking, and only the drivers listed here will drive the vehicle."] : []),
  "The pickup details of my booking are correct.",
  "I understand that I am responsible for traffic violations, fines, and charges during the rental period, as set out in the Terms & Conditions.",
  "I understand that Number Coding and other traffic restrictions may apply at the places I travel, and that the schedule shown by the booking system is a guide only.",
];

const normName = (s) =>
  String(s || "").normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase().replace(/[^a-z\s]/g, " ").replace(/\s+/g, " ").trim();

// The typed name must contain the account holder's first AND last name (any order, any middle
// names) — so it is the account holder signing. If the profile has no name on file, fall back
// to "at least two words".
const nameMatchesAccount = (typed, details) => {
  const t = normName(typed).split(" ").filter(Boolean);
  if (t.length < 2) return false;
  const first = normName(details?.firstName), last = normName(details?.lastName);
  if (!first || !last) return true;
  const has = (token) => token.split(" ").every((p) => t.includes(p));
  return has(first) && has(last);
};

const displayName = (details) =>
  [details?.firstName, details?.middleName, details?.lastName, details?.suffix].map((x) => String(x || "").trim()).filter(Boolean).join(" ");

const last4 = (s) => { const t = String(s || "").replace(/\s+/g, ""); return t ? t.slice(-4) : null; };

// Can the renter sign right now?  { eligible, reason, opensAt }
const handoverEligibility = (booking, existing, now = new Date()) => {
  if (existing) return { eligible: false, reason: "signed", opensAt: null };
  const w = realWindow(booking);
  if (booking.status === BOOKING_STATUS.UPCOMING) {
    if (!w) return { eligible: false, reason: "unavailable", opensAt: null };
    const opensAt = new Date(w.start.getTime() - HANDOVER_OPENS_HOURS_BEFORE * 3600 * 1000);
    if (now < opensAt) return { eligible: false, reason: "opens", opensAt };
    if (now > w.end)   return { eligible: false, reason: "ended", opensAt };
    return { eligible: true, reason: null, opensAt };
  }
  if (booking.status === BOOKING_STATUS.ONGOING) return { eligible: true, reason: null, opensAt: null };
  return { eligible: false, reason: "unavailable", opensAt: null };
};

const customerHandoverView = (d) => d && ({
  status:      d.status,
  signedName:  d.signedName,
  signedAt:    toISO(d.signedAt),
  drivers:     (d.drivers || []).map((x) => ({ fullName: x.fullName, role: x.role, licenseLast4: last4(x.licenseNumber) })),
  verifiedAt:  toISO(d.verifiedAt),
});

const loadDetails = async (userID) => {
  const doc = await db.collection("userDetails").doc(userID).get();
  return doc.exists ? doc.data() : null;
};

const getHandover = async (req, res) => {
  try {
    const userID = req.user?.userID;
    const booking = await loadOwnedBooking(userID, req.params.bookingID);
    if (!booking) return res.status(404).json({ message: "Booking not found." });

    const snap = await db.collection("handovers").doc(booking.bookingID).get();
    const existing = snap.exists ? snap.data() : null;
    const selfDrive = booking.modeOfDriving !== "With Chauffeur";
    const elig = handoverEligibility(booking, existing);
    const details = await loadDetails(userID);

    return res.json({
      status:      booking.status,
      eligible:    elig.eligible,
      reason:      elig.reason,
      opensAt:     toISO(elig.opensAt),
      selfDrive,
      renterName:  displayName(details),
      maxAdditionalDrivers: MAX_ADDITIONAL_DRIVERS,
      statementsVersion: HANDOVER_STATEMENTS_VERSION,
      statements:  handoverStatements(selfDrive),
      handover:    customerHandoverView(existing),
    });
  } catch (error) {
    console.error("getHandover error:", error);
    return res.status(500).json({ message: "Could not load the pickup handover." });
  }
};

class HandoverConflict extends Error {}

const signHandover = async (req, res) => {
  try {
    const userID = req.user?.userID;
    const booking = await loadOwnedBooking(userID, req.params.bookingID);
    if (!booking) return res.status(404).json({ message: "Booking not found." });

    const { signedName, drivers, confirmed, statementsVersion } = req.body || {};
    const selfDrive = booking.modeOfDriving !== "With Chauffeur";

    const ref = db.collection("handovers").doc(booking.bookingID);
    const existingSnap = await ref.get();
    const elig = handoverEligibility(booking, existingSnap.exists ? existingSnap.data() : null);
    if (!elig.eligible) {
      const messages = {
        signed:      "This handover was already signed.",
        opens:       "The pickup handover isn't open yet. It opens 24 hours before pickup.",
        ended:       "The rental period for this booking has ended.",
        unavailable: "The pickup handover isn't available for this booking.",
      };
      return res.status(elig.reason === "signed" ? 409 : 400).json({ message: messages[elig.reason] || messages.unavailable });
    }

    if (confirmed !== true) return res.status(400).json({ message: "Please tick the box to confirm the statements." });
    if (statementsVersion !== HANDOVER_STATEMENTS_VERSION) {
      return res.status(409).json({ message: "The statements were updated. Please read them again.", statementsChanged: true });
    }

    const details = await loadDetails(userID);
    const typed = String(signedName || "").trim().slice(0, 120);
    if (!nameMatchesAccount(typed, details)) {
      return res.status(400).json({ message: "Please type your full name exactly as it appears on your account." });
    }

    // Drivers (self-drive only): the renter is always the first; up to 3 additional drivers,
    // each with a name and licence number so a violation can be traced to the right person.
    const driverList = [];
    if (selfDrive) {
      driverList.push({ fullName: typed, licenseNumber: null, role: "renter" }); // the renter's licence is on file from signup
      const extra = Array.isArray(drivers) ? drivers : [];
      if (extra.length > MAX_ADDITIONAL_DRIVERS) return res.status(400).json({ message: `You can list up to ${MAX_ADDITIONAL_DRIVERS} additional drivers.` });
      for (const d of extra) {
        const fullName = String(d?.fullName || "").trim().slice(0, 80);
        const licenseNumber = String(d?.licenseNumber || "").trim().toUpperCase().slice(0, 30);
        if (!/^[A-Za-zÀ-ÿ][A-Za-zÀ-ÿ .'-]{1,79}$/.test(fullName) || normName(fullName).split(" ").length < 2) {
          return res.status(400).json({ message: "Please enter the full name of each additional driver." });
        }
        if (!/^[A-Z0-9][A-Z0-9 -]{3,29}$/.test(licenseNumber)) {
          return res.status(400).json({ message: `Please enter a valid licence number for ${fullName}.` });
        }
        driverList.push({ fullName, licenseNumber, role: "additional" });
      }
    }

    const now = new Date();
    const record = {
      handoverID:   booking.bookingID,
      bookingID:    booking.bookingID,
      userID,
      carID:        booking.carID || null,
      selfDrive,
      status:       "signed",
      drivers:      driverList,                       // [] for a chauffeured trip
      signedName:   typed,
      signedAt:     now,                              // the SERVER clock
      method:       "typed name + checkbox",
      statementsVersion: HANDOVER_STATEMENTS_VERSION,
      statements:   handoverStatements(selfDrive),    // the exact words that were signed
      bookingTermsVersion: booking.termsVersion || null,
      bookingTermsHash:    booking.termsHash || null,
      // Filled in by staff in the admin app at the counter:
      verifiedAt: null, verifiedByUserID: null, licenseChecked: null, conditionNotes: null,
      createdAt: now,
      updatedAt: now,
    };

    try {
      await db.runTransaction(async (tx) => {
        const cur = await tx.get(ref);
        if (cur.exists) throw new HandoverConflict();   // two taps at once → only one signature is stored
        tx.set(ref, record);
      });
    } catch (e) {
      if (e instanceof HandoverConflict) return res.status(409).json({ message: "This handover was already signed." });
      throw e;
    }

    notifyStaff({
      type: "handover_signed",
      refID: booking.bookingID,
      refCollection: "bookings",
      title: "Pickup handover signed",
      message: `${typed} signed the pickup handover for booking ${booking.bookingID}${selfDrive ? ` (self-drive, ${driverList.length} driver${driverList.length === 1 ? "" : "s"})` : " (with chauffeur)"}.`,
    }).catch((e) => console.error("notifyStaff(handover_signed):", e.message));

    return res.status(201).json({ message: "Handover signed. Thank you.", handover: customerHandoverView(record) });
  } catch (error) {
    console.error("signHandover error:", error);
    return res.status(500).json({ message: "Could not save your signature. Please try again." });
  }
};

module.exports = { getHandover, signHandover };

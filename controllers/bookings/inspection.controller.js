// ─────────────────────────────────────────────────────────────────────────────
// Customer view of a booking's vehicle inspection (the before-pickup and after-return records
// the ARL staff make in the admin app).
//
//   GET /api/bookings/:bookingID/inspection
//
// WHO SEES IT
//   • Only the booking's own customer (a missing booking and someone else's look identical: 404).
//   • Only when NO DRIVER handles the trip: a self-drive booking, or a chauffeur booking that has no driver
//     assigned. With a driver the driver does the handover and sees the inspection in the driver app, so the
//     customer app shows nothing. (This is the same rule the admin app uses to decide who gets the "inspection
//     confirmed" notification: the driver if there is one, otherwise the customer.) The server decides, so an
//     inspection that is not for this customer never leaves the server.
//   • Only for a paid booking (upcoming / ongoing / completed), and only from the same moment the car's
//     plate is revealed (see plateVisibility.util.js) — the exterior photos can show the plate.
//
// WHAT THEY SEE — an explicit whitelist, built field by field (never a copy of the stored documents, so a
// field added to the admin records later is NOT exposed by accident):
//   per phase (before / after):  when it was recorded, the 3 exterior photos, the videos and the additional
//   photos (each with its caption).
//   NOT included: the parts condition (which parts are Good / damaged), the per-part photos (a close-up of a part
//   can show its serial number), car / part ids, serial numbers, prices, who recorded it, edit history, file sizes.
//
// PHOTOS & VIDEOS — each file is returned as a short-lived (1 hour) signed link, not the permanent
// download-token link stored in the admin records, so a link copied out of the page stops working.
// ─────────────────────────────────────────────────────────────────────────────
const admin = require("firebase-admin");
const { db } = require("../../config/firebaseConnection/firebase");
const { loadOwnedBooking, toISO } = require("../../utils/bookings/ownedBooking.util");
const { plateForBooking } = require("../../utils/bookings/plateVisibility.util");

const PHOTO_COLLECTION = { before: "vehicleDocumentationBeforeTrip", after: "vehicleDocumentationAfterTrip" };

// cancellation_request = an ONGOING trip with a pending cancel request, so it counts as ongoing here.
const SHOWN_STATUSES = new Set(["upcoming", "ongoing", "cancellation_request", "completed"]);
const SIGNED_URL_TTL_MS = 60 * 60 * 1000; // 1 hour
const EXTERIOR_FIELDS = [["frontViewUrl", "Front"], ["sideViewUrl", "Side"], ["backViewUrl", "Back"]];

const isSelfDrive = (booking) => /self/i.test(String(booking?.modeOfDriving || ""));

// Is a driver handling this trip? The current driver is the booking's "assigned" row in driverAssignments
// (a legacy booking.driverID is only a fallback) — the same lookup the booking reminders use.
const hasAssignedDriver = async (booking) => {
  const snap = await db.collection("driverAssignments")
    .where("bookingID", "==", booking.bookingID)
    .where("status", "==", "assigned")
    .limit(1)
    .get();
  return !snap.empty || !!booking.driverID;
};

// ── Storage links ────────────────────────────────────────────────────────────
// https://firebasestorage.googleapis.com/v0/b/<bucket>/o/<encoded path>?alt=media&token=…
// https://storage.googleapis.com/<bucket>/<path>
const parseStorageUrl = (url) => {
  if (typeof url !== "string" || !url.startsWith("http")) return null;
  let u;
  try { u = new URL(url); } catch { return null; }
  let m;
  if (u.hostname === "firebasestorage.googleapis.com") {
    m = u.pathname.match(/^\/v0\/b\/([^/]+)\/o\/(.+)$/);
    if (m) return { bucket: m[1], path: decodeURIComponent(m[2]) };
  } else if (u.hostname === "storage.googleapis.com") {
    m = u.pathname.match(/^\/([^/]+)\/(.+)$/);
    if (m) return { bucket: m[1], path: decodeURIComponent(m[2]) };
  }
  return null;
};

// A signed, expiring link to one inspection file. Anything that isn't an inspection file
// (vehicleDocs/…) is never handed out. If signing fails the stored link is used instead, so a photo
// shows up rather than a broken image.
const signUrl = async (url) => {
  const parsed = parseStorageUrl(url);
  if (!parsed || !parsed.path.startsWith("vehicleDocs/")) return null;
  try {
    const [signed] = await admin.storage().bucket(parsed.bucket).file(parsed.path)
      .getSignedUrl({ version: "v4", action: "read", expires: Date.now() + SIGNED_URL_TTL_MS });
    return signed;
  } catch (err) {
    console.error(`[INSPECTION] could not sign ${parsed.path}:`, err.message);
    return url;
  }
};

// ── Reading the stored records ───────────────────────────────────────────────
const secs = (v) => (v?.toDate ? v.toDate().getTime() : v?._seconds ? v._seconds * 1000 : v ? new Date(v).getTime() || 0 : 0);

// Older saves split the photos across several documents for one booking. Fold them into one, oldest → newest
// (the newest non-empty value wins); the videos / additional-photos lists are combined by item id.
const mergePhotoDocs = (snap) => {
  if (!snap || snap.empty) return null;
  const docs = snap.docs.map((d) => d.data()).sort((a, b) => secs(a.updatedAt || a.createdAt) - secs(b.updatedAt || b.createdAt));
  const merged = {};
  docs.forEach((d) => Object.entries(d).forEach(([k, v]) => {
    if (Array.isArray(v)) {
      if (!v.length) return;
      const seen = new Set((merged[k] || []).map((i) => i?.id));
      merged[k] = [...(merged[k] || []), ...v.filter((i) => !seen.has(i?.id))];
      return;
    }
    if (v !== "" && v !== null && v !== undefined) merged[k] = v;
  }));
  merged.__updatedAt = docs.length ? (docs[docs.length - 1].updatedAt || docs[docs.length - 1].createdAt || null) : null;
  return merged;
};

// ── Building what the customer sees ──────────────────────────────────────────
const buildPhase = async (photo) => {
  const videosIn = Array.isArray(photo?.videos) ? photo.videos : [];
  const extraIn  = Array.isArray(photo?.extraPhotos) ? photo.extraPhotos : [];

  const [exteriorRaw, videos, extraPhotos] = await Promise.all([
    Promise.all(EXTERIOR_FIELDS.map(async ([k, label]) => ({ label, url: await signUrl(photo?.[k]) }))),
    Promise.all(videosIn.filter((v) => v && v.url).map(async (v) => ({ id: String(v.id || ""), url: await signUrl(v.url), durationSec: Number(v.durationSec) || null }))),
    Promise.all(extraIn.filter((p) => p && p.url).map(async (p) => ({ id: String(p.id || ""), url: await signUrl(p.url), caption: p.caption ? String(p.caption).slice(0, 60) : "" }))),
  ]);

  const exterior    = exteriorRaw.filter((e) => e.url);
  const videosOut   = videos.filter((v) => v.url);
  const extraOut    = extraPhotos.filter((p) => p.url);
  if (!exterior.length && !videosOut.length && !extraOut.length) return null;

  return {
    recordedAt: toISO(photo?.inspectionConfirmed?.at) || toISO(photo?.__updatedAt),
    exterior,
    videos: videosOut,
    extraPhotos: extraOut,
  };
};

const getBookingInspection = async (req, res) => {
  try {
    const booking = await loadOwnedBooking(req.user?.userID, req.params.bookingID);
    if (!booking) return res.status(404).json({ message: "Booking not found." });

    const status = String(booking.status || "").toLowerCase();
    res.set("Cache-Control", "no-store"); // the signed links expire

    if (!SHOWN_STATUSES.has(status)) return res.json({ applicable: false });
    // With a driver on the trip, the driver handles the handover and sees the inspection in the driver app.
    if (!isSelfDrive(booking) && await hasAssignedDriver(booking)) return res.json({ applicable: false });

    // Same reveal rule as the plate number (2 hours before pickup): the photos can show it. A booking with no driver is
    // treated like a self-drive one here — the chauffeur "plate shows when the driver is on the way" rule can never
    // be met without a driver.
    const reveal = plateForBooking({ ...booking, modeOfDriving: "Self Drive", status: status === "cancellation_request" ? "ongoing" : status }, "X");
    if (!reveal.plateNumber) return res.json({ applicable: false, availableFrom: reveal.plateRevealsAt });

    const id = booking.bookingID;
    const [bPhoto, aPhoto] = await Promise.all([
      db.collection(PHOTO_COLLECTION.before).where("bookingID", "==", id).get(),
      db.collection(PHOTO_COLLECTION.after).where("bookingID", "==", id).get(),
    ]);

    const [before, after] = await Promise.all([
      buildPhase(mergePhotoDocs(bPhoto)),
      buildPhase(mergePhotoDocs(aPhoto)),
    ]);

    return res.json({ applicable: true, before, after, linksExpireInMinutes: SIGNED_URL_TTL_MS / 60000 });
  } catch (error) {
    console.error("getBookingInspection error:", error);
    return res.status(500).json({ message: "Could not load the inspection for this booking." });
  }
};

module.exports = { getBookingInspection, _test: { parseStorageUrl, mergePhotoDocs, isSelfDrive } };
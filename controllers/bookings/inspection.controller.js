// ─────────────────────────────────────────────────────────────────────────────
// Customer view of a booking's vehicle inspection (the before-pickup and after-return records
// the ARL staff make in the admin app).
//
//   GET /api/bookings/:bookingID/inspection
//
// WHO SEES IT
//   • Only the booking's own customer (a missing booking and someone else's look identical: 404).
//   • Only a SELF-DRIVE booking. With a chauffeur the driver does the handover, so the customer app
//     shows nothing — the server decides, so a chauffeur booking's inspection never leaves the server.
//   • Only for a paid booking (upcoming / ongoing / completed), and only from the same moment the car's
//     plate is revealed (see plateVisibility.util.js) — the exterior photos can show the plate.
//
// WHAT THEY SEE — an explicit whitelist, built field by field (never a copy of the stored documents, so a
// field added to the admin records later is NOT exposed by accident):
//   per phase (before / after):  when it was recorded, the overall condition, the parts noted as not-Good
//   (name + status + that part's photo), the 3 exterior photos, the videos and the additional photos.
//   NOT included: car / part ids, serial numbers, who recorded it, edit history, file sizes.
//
// PHOTOS & VIDEOS — each file is returned as a short-lived (1 hour) signed link, not the permanent
// download-token link stored in the admin records, so a link copied out of the page stops working.
// ─────────────────────────────────────────────────────────────────────────────
const admin = require("firebase-admin");
const { db } = require("../../config/firebaseConnection/firebase");
const { loadOwnedBooking, toISO } = require("../../utils/bookings/ownedBooking.util");
const { plateForBooking } = require("../../utils/bookings/plateVisibility.util");

const PHOTO_COLLECTION     = { before: "vehicleDocumentationBeforeTrip", after: "vehicleDocumentationAfterTrip" };
const INVENTORY_COLLECTION = { before: "inventoryBeforeTrip",            after: "inventoryAfterTrip" };

// cancellation_request = an ONGOING trip with a pending cancel request, so it counts as ongoing here.
const SHOWN_STATUSES = new Set(["upcoming", "ongoing", "cancellation_request", "completed"]);
const SIGNED_URL_TTL_MS = 60 * 60 * 1000; // 1 hour
const MAX_DAMAGED_PARTS = 40;

const isSelfDrive = (booking) => /self/i.test(String(booking?.modeOfDriving || ""));

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

const latestInventory = (snap) => {
  if (!snap || snap.empty) return null;
  return snap.docs.map((d) => d.data()).sort((a, b) => secs(b.recordedAt) - secs(a.recordedAt))[0];
};

// "Brake Disc" + type "Brake Parts" -> "brakePartsBrakeDiscUrl" — how the admin app names a part's photo field.
const partNameToFieldKey = (str = "") => {
  const camel = String(str)
    .replace(/[^a-zA-Z0-9 ]/g, "")
    .trim()
    .split(/\s+/)
    .map((w, i) => (i === 0 ? w.toLowerCase() : w.charAt(0).toUpperCase() + w.slice(1).toLowerCase()))
    .join("");
  return camel ? `${camel}Url` : "";
};

// carPartID -> { name, photoKeys[] }, read once per request (the before and after records share parts).
const loadPartInfo = async (partIDs) => {
  const info = new Map();
  const ids = [...new Set(partIDs.filter(Boolean))].slice(0, MAX_DAMAGED_PARTS);
  const partDocs = await Promise.all(ids.map((id) => db.collection("carParts").doc(String(id)).get().catch(() => null)));
  const typeIDs = [...new Set(partDocs.map((d) => d?.exists && d.data().carPartTypeID).filter(Boolean))];
  const typeDocs = await Promise.all(typeIDs.map((id) => db.collection("carPartTypes").doc(String(id)).get().catch(() => null)));
  const typeName = new Map(typeIDs.map((id, i) => [id, typeDocs[i]?.exists ? (typeDocs[i].data().carPartName || "") : ""]));
  ids.forEach((id, i) => {
    const p = partDocs[i]?.exists ? partDocs[i].data() : null;
    if (!p) { info.set(id, { name: "", photoKeys: [] }); return; }
    const combined = `${typeName.get(p.carPartTypeID) || ""} ${p.carPartName || ""}`.trim();
    info.set(id, { name: p.carPartName || "", photoKeys: [partNameToFieldKey(combined), partNameToFieldKey(p.carPartName || id)].filter(Boolean) });
  });
  return info;
};

// ── Building what the customer sees ──────────────────────────────────────────
const buildPhase = async ({ photo, inventory, otherInventory, partInfo, isAfter }) => {
  const videosIn = Array.isArray(photo?.videos) ? photo.videos : [];
  const extraIn  = Array.isArray(photo?.extraPhotos) ? photo.extraPhotos : [];
  const hasMedia = !!(photo && (photo.frontViewUrl || photo.sideViewUrl || photo.backViewUrl || videosIn.length || extraIn.length));
  if (!inventory && !hasMedia) return null;

  const damagedIn = (Array.isArray(inventory?.damageParts) ? inventory.damageParts : [])
    .filter((d) => d && d.status && d.status !== "Good" && d.status !== "New")
    .slice(0, MAX_DAMAGED_PARTS);
  const notedBefore = new Set((Array.isArray(otherInventory?.damageParts) ? otherInventory.damageParts : []).map((d) => d?.carPartID));

  const [front, side, back, videos, extraPhotos, damagedParts] = await Promise.all([
    signUrl(photo?.frontViewUrl), signUrl(photo?.sideViewUrl), signUrl(photo?.backViewUrl),
    Promise.all(videosIn.filter((v) => v && v.url).map(async (v) => ({ id: String(v.id || ""), url: await signUrl(v.url), durationSec: Number(v.durationSec) || null }))),
    Promise.all(extraIn.filter((p) => p && p.url).map(async (p) => ({ id: String(p.id || ""), url: await signUrl(p.url) }))),
    Promise.all(damagedIn.map(async (d) => {
      const info = partInfo.get(d.carPartID) || { name: "", photoKeys: [] };
      const key = info.photoKeys.find((k) => photo?.[k]);
      return {
        name: d.carPartName || info.name || "Part",
        status: String(d.status),
        photoUrl: key ? await signUrl(photo[key]) : null,
        ...(isAfter ? { notedAtPickup: notedBefore.has(d.carPartID) } : {}),
      };
    })),
  ]);

  return {
    recordedAt: toISO(inventory?.recordedAt) || toISO(photo?.__updatedAt),
    // null = the parts condition was never recorded for this phase (don't say "no damage" about it)
    condition: inventory ? (inventory.inventoryOverallStatus === "has damage" ? "has damage" : "good") : null,
    damagedParts,
    exterior: { front, side, back },
    videos: videos.filter((v) => v.url),
    extraPhotos: extraPhotos.filter((p) => p.url),
  };
};

const getBookingInspection = async (req, res) => {
  try {
    const booking = await loadOwnedBooking(req.user?.userID, req.params.bookingID);
    if (!booking) return res.status(404).json({ message: "Booking not found." });

    const status = String(booking.status || "").toLowerCase();
    res.set("Cache-Control", "no-store"); // the signed links expire

    if (!isSelfDrive(booking) || !SHOWN_STATUSES.has(status)) return res.json({ applicable: false });

    // Same reveal rule as the plate number (2 hours before pickup): the photos can show it.
    const reveal = plateForBooking({ ...booking, status: status === "cancellation_request" ? "ongoing" : status }, "X");
    if (!reveal.plateNumber) return res.json({ applicable: false, availableFrom: reveal.plateRevealsAt });

    const id = booking.bookingID;
    const [bPhoto, aPhoto, bInv, aInv] = await Promise.all([
      db.collection(PHOTO_COLLECTION.before).where("bookingID", "==", id).get(),
      db.collection(PHOTO_COLLECTION.after).where("bookingID", "==", id).get(),
      db.collection(INVENTORY_COLLECTION.before).where("bookingID", "==", id).get(),
      db.collection(INVENTORY_COLLECTION.after).where("bookingID", "==", id).get(),
    ]);
    const beforePhoto = mergePhotoDocs(bPhoto), afterPhoto = mergePhotoDocs(aPhoto);
    const beforeInv = latestInventory(bInv),   afterInv = latestInventory(aInv);

    const partInfo = await loadPartInfo([
      ...(beforeInv?.damageParts || []).map((d) => d?.carPartID),
      ...(afterInv?.damageParts  || []).map((d) => d?.carPartID),
    ]);

    const [before, after] = await Promise.all([
      buildPhase({ photo: beforePhoto, inventory: beforeInv, otherInventory: null,      partInfo, isAfter: false }),
      buildPhase({ photo: afterPhoto,  inventory: afterInv,  otherInventory: beforeInv, partInfo, isAfter: true }),
    ]);

    return res.json({ applicable: true, before, after, linksExpireInMinutes: SIGNED_URL_TTL_MS / 60000 });
  } catch (error) {
    console.error("getBookingInspection error:", error);
    return res.status(500).json({ message: "Could not load the inspection for this booking." });
  }
};

module.exports = { getBookingInspection, _test: { parseStorageUrl, mergePhotoDocs, partNameToFieldKey, isSelfDrive } };
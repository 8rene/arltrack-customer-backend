const admin = require("firebase-admin");
const { db } = require("../config/firebaseConnection/firebase");
const { BOOKING_STATUS } = require("../utils/bookings/bookingStatus.util");

// ─────────────────────────────────────────────────────────────────────────────
// Customer-side watcher — same pattern as refundNotifications.job.js: reacts
// to a status change made on the ADMIN side (booking → "completed", set in
// arltrack-admin-backend's updateBooking when staff mark a car Returned)
// without any change needed in the admin backend itself.
//
// What this does: the first time a "completed" booking is seen, schedules a
// 1-day "Post-Rental" carMaintenance record (status: "Scheduled") for the day
// after. "Post-Rental" is already one of the admin app's maintenance BASIS
// options — this just automates creating one instead of it being manual-only.
//
// This isn't just cosmetic: createBooking's availability guard (see
// controllers/bookings/bookings.controller.js) already blocks new bookings
// against any "Scheduled" carMaintenance record for the car, so this record
// actually closes the car for that day server-side — the calendar's 1-day
// "preparation" buffer (Booking.jsx's getDateStatuses) was frontend-only
// before this. It also means the day shows up in the admin app's Maintenance
// list for staff to verify/complete (cleaning, inspection) like any other
// scheduled job.
//
// postRentalMaintenanceScheduled is a plain boolean flag on the booking doc,
// same idempotency pattern as refundNotifications.job.js's customerNotified —
// a booking is only ever scanned/scheduled once.
//
// NOTE on timing: like the other cron jobs in this project, this runs once a
// day on Vercel's Hobby plan (see vercel.json), so there can be a gap of up
// to ~24h between a car being marked Returned and this job actually creating
// the maintenance day. If same-day back-to-back booking abuse turns out to
// be a real problem in practice, this job would need to run more often (a
// paid Vercel plan) or the admin app would need to create the record
// directly at the moment of Return instead of via this watcher.
// ─────────────────────────────────────────────────────────────────────────────
const runPostRentalMaintenance = async () => {
  const snap = await db.collection("bookings")
    .where("status", "==", BOOKING_STATUS.COMPLETED)
    .get();

  let scheduledCount = 0;
  let skippedCount   = 0; // already scheduled on a previous run, or no carID

  for (const doc of snap.docs) {
    const booking = doc.data();
    if (booking.postRentalMaintenanceScheduled) continue; // already handled
    if (!booking.carID) {
      await doc.ref.update({ postRentalMaintenanceScheduled: true });
      skippedCount++;
      continue;
    }

    try {
      // Base the maintenance day on when the booking was actually marked
      // completed (updatedAt), not the originally-scheduled endDateTime —
      // a car can be returned early or late. "completed" bookings can't be
      // edited again after (see admin's updateBooking nonEditable guard),
      // so updatedAt reliably reflects the Return moment.
      const completedAt = booking.updatedAt?.toDate
        ? booking.updatedAt.toDate()
        : new Date(booking.updatedAt || Date.now());
      const postRentalDay = new Date(completedAt);
      postRentalDay.setDate(postRentalDay.getDate() + 1);
      postRentalDay.setHours(0, 0, 0, 0);

      const ref = await db.collection("carMaintenance").add({
        carID:        booking.carID,
        basis:        "Post-Rental",
        services:     [],
        totalCost:    0,
        overrideTotal: null,
        description:  `Auto-scheduled after booking ${booking.bookingID || doc.id} was marked returned — cleaning/inspection before the car is available again.`,
        maintenanceDate:     admin.firestore.Timestamp.fromDate(postRentalDay),
        nextMaintenanceDate: null,
        status:       "Scheduled",
        partsAddressed: [],
        createdAt:    admin.firestore.FieldValue.serverTimestamp(),
        updatedAt:    admin.firestore.FieldValue.serverTimestamp(),
      });
      // Mirror the doc's own ID onto itself — matches the admin app's own
      // convention for this collection (see maintenance.service.js).
      await ref.update({ maintenanceID: ref.id });

      await doc.ref.update({ postRentalMaintenanceScheduled: true });
      scheduledCount++;
    } catch (err) {
      // Best-effort — leave postRentalMaintenanceScheduled unset so a
      // transient failure (e.g. Firestore hiccup) gets retried next run,
      // rather than silently never scheduling this booking's maintenance day.
      console.error(`[CRON] post-rental-maintenance: failed on booking ${booking.bookingID || doc.id}:`, err.message);
    }
  }

  console.log(`[CRON] post-rental-maintenance: ${scheduledCount} maintenance day(s) scheduled, ${skippedCount} skipped.`);
  return { scheduledCount, skippedCount };
};

module.exports = { runPostRentalMaintenance };

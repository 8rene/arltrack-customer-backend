const { db } = require("../config/firebaseConnection/firebase");
const { createNotification } = require("../services/notification/notification.service");

const toDate = (v) => {
  if (!v) return null;
  if (typeof v.toDate === "function") return v.toDate();
  return new Date(v);
};

const fmtDateTime = (d) =>
  d.toLocaleString("en-US", {
    weekday: "short",
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });

// ─────────────────────────────────────────────────────────────────────────────
// Reminders — "Upcoming Booking" ~24h out, "Booking Reminder" ~2h out.
// Only ever looks at "upcoming" bookings — under this app's status model
// (see utils/bookings/bookingStatus.util.js) a booking only reaches
// "upcoming" once it's FULLY paid (promoteBookingToUpcoming), so there's
// no separate payment check needed here the way there used to be.
// createNotification()'s own dedup (active type+refID+userID) means
// running this job every few minutes/hours is safe: once a reminder has
// fired for a booking it won't fire again, even across many cron runs.
// ─────────────────────────────────────────────────────────────────────────────
const runBookingReminders = async () => {
  const now = new Date();
  const snap = await db.collection("bookings").where("status", "==", "upcoming").get();
  const bookings = snap.docs.map((d) => ({ id: d.id, ...d.data() }));

  let upcomingCount = 0;
  let reminderCount = 0;

  for (const b of bookings) {
    const start = toDate(b.startDateTime);
    if (!start || start <= now || !b.userID) continue;

    const hoursUntil = (start - now) / (1000 * 60 * 60);
    const bID = b.bookingID || b.id;

    if (hoursUntil <= 24) {
      const id = await createNotification({
        type: "upcoming_booking",
        userID: b.userID,
        refID: bID,
        title: "Upcoming Booking",
        message: `Your booking is coming up on ${fmtDateTime(start)}. Make sure you're ready!`,
      });
      if (id) upcomingCount++;
    }

    if (hoursUntil <= 2) {
      const id = await createNotification({
        type: "booking_reminder",
        userID: b.userID,
        refID: bID,
        title: "Booking Reminder",
        message: `Reminder: your booking starts at ${fmtDateTime(start)}.`,
      });
      if (id) reminderCount++;
    }
  }

  console.log(`[CRON] booking-reminders: ${upcomingCount} upcoming, ${reminderCount} last-call reminder(s) sent.`);
  return { upcomingCount, reminderCount };
};

module.exports = { runBookingReminders };

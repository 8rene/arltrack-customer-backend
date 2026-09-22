const { db } = require("../config/firebaseConnection/firebase");
const { createNotification } = require("../services/notification/notification.service");

// ─────────────────────────────────────────────────────────────────────────────
// FALLBACK only. The admin app now notifies the customer the moment staff
// Approve/Reject a refund request (admin-backend refundRequest.service.js) and
// stamps customerNotified: true on the request. This job just catches anything
// that didn't get notified that way — e.g. a decision made on an older admin
// deployment — so a customer is never left without an answer. Because it runs on
// a daily cron, on its own it used to mean an approval could reach the customer
// up to a day late.
//
// customerNotified is a plain boolean flag on the refundRequests doc, so a
// request is only ever scanned/notified once.
// ─────────────────────────────────────────────────────────────────────────────
const runRefundNotifications = async () => {
  const snap = await db.collection("refundRequests")
    .where("status", "in", ["Approved", "Rejected"])
    .get();

  let sentCount = 0;

  for (const doc of snap.docs) {
    const r = doc.data();
    if (r.customerNotified) continue; // already handled on a previous run
    if (!r.userID) { await doc.ref.update({ customerNotified: true }); continue; }

    const isApproved = r.status === "Approved";

    const id = await createNotification({
      type: isApproved ? "refund_approved" : "refund_rejected",
      userID: r.userID,
      refID: r.bookingID || null,
      title: isApproved ? "Refund Approved" : "Refund Rejected",
      message: isApproved
        ? `Your refund of ₱${Number(r.amount || 0).toLocaleString()} has been approved and is being processed by PayMongo.`
        : (r.rejectReason ? `Your refund request was rejected: ${r.rejectReason}` : "Your refund request was rejected."),
    });

    // Stamped regardless of whether createNotification actually wrote a
    // fresh doc or hit its own dedup — either way this refund request has
    // been "seen" and shouldn't be re-checked on the next run.
    await doc.ref.update({ customerNotified: true });
    if (id) sentCount++;
  }

  console.log(`[CRON] refund-notifications: ${sentCount} refund decision notification(s) sent.`);
  return { sentCount };
};


module.exports = { runRefundNotifications };

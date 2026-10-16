// PDF for a receipt or a booking statement, drawn from the SAME document object the screen and the email use
// (utils/receipt/receipt.util.js), so all three always show the same numbers.
//
// This REPLACES the old receipt PDF service, which uploaded each PDF to Firebase Storage and made it public.
//
// The PDF is built in memory and streamed to the logged-in owner. It is never uploaded or stored, so there is no file
// to leak and no link to forward.
//
// Amounts are written "PHP 1,500.00": pdfkit's built-in Helvetica has no peso sign.
const PDFDocument = require("pdfkit");

const MARGIN = 48;
const WIDTH = 595.28 - MARGIN * 2;            // A4
const LABEL_W = WIDTH - 150;
const BRAND = "#1e3a8a";

const php = (n) => `PHP ${(Number(n) || 0).toLocaleString("en-PH", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const when = (iso) => { const d = iso ? new Date(iso) : null; return d && !isNaN(d) ? d.toLocaleString("en-PH", { timeZone: "Asia/Manila", dateStyle: "medium", timeStyle: "short" }) : "-"; };
const day = (iso) => { const d = iso ? new Date(iso) : null; return d && !isNaN(d) ? d.toLocaleDateString("en-PH", { timeZone: "Asia/Manila", dateStyle: "medium" }) : null; };
const METHOD = { gcash: "GCash", maya: "Maya", qrph: "QR Ph", cash: "Cash", bank_transfer: "Bank transfer" };
const DEPOSIT_LABEL = { Held: "Still held", Settled: "Settled", Waived: "Waived", Forfeited: "Forfeited", Refunded: "Refunded" };

const detailLine = (l) => [when(l.date), METHOD[l.method] || l.method, l.source === "in_person" ? "In person" : null, l.referenceNumber ? `Ref. ${l.referenceNumber}` : null]
  .filter((v) => v && v !== "-").join("  -  ");

// What a customer reads for money that is not done yet (same wording as the email).
const pendingLabel = (l) => (l.status === "unrefundable" ? "We'll contact you to hand it back" : l.direction === "out" ? "Refund being processed" : "Awaiting confirmation");

// A tiny layout kit on top of pdfkit: every helper moves doc.y down and starts a new page when the next block won't fit.
const kit = (doc) => {
  const ensure = (h) => { if (doc.y + h > doc.page.height - MARGIN - 30) doc.addPage(); };
  const gap = (n = 8) => { doc.y += n; };
  const rule = (color = "#e5e7eb") => { ensure(8); gap(3); doc.moveTo(MARGIN, doc.y).lineTo(MARGIN + WIDTH, doc.y).strokeColor(color).lineWidth(0.7).stroke(); gap(5); };
  const section = (title) => {
    ensure(46); gap(14);
    doc.font("Helvetica-Bold").fontSize(9).fillColor(BRAND).text(title.toUpperCase(), MARGIN, doc.y, { characterSpacing: 1 });
    gap(4);
  };
  // label ... value, value right-aligned; optional small grey line under the label
  const line = (label, value, { bold = false, detail = null, size = 10.5 } = {}) => {
    const lh = doc.font(bold ? "Helvetica-Bold" : "Helvetica").fontSize(size).heightOfString(String(label), { width: LABEL_W });
    const dh = detail ? doc.font("Helvetica").fontSize(8.5).heightOfString(detail, { width: LABEL_W }) : 0;
    ensure(lh + dh + 6);
    const y = doc.y;
    doc.font(bold ? "Helvetica-Bold" : "Helvetica").fontSize(size).fillColor(bold ? "#111827" : "#374151").text(String(label), MARGIN, y, { width: LABEL_W });
    doc.font(bold ? "Helvetica-Bold" : "Helvetica").fontSize(size).fillColor("#111827").text(String(value), MARGIN + LABEL_W, y, { width: WIDTH - LABEL_W, align: "right" });
    if (detail) doc.font("Helvetica").fontSize(8.5).fillColor("#6b7280").text(detail, MARGIN, y + lh, { width: LABEL_W });
    doc.y = y + lh + dh + 4;
  };
  const note = (text, color = "#6b7280", size = 9) => {
    ensure(24);
    doc.font("Helvetica").fontSize(size).fillColor(color).text(text, MARGIN, doc.y, { width: WIDTH });
    gap(2);
  };
  return { ensure, gap, rule, section, line, note };
};

const header = (doc, k, d, subtitle) => {
  doc.font("Helvetica-Bold").fontSize(20).fillColor(BRAND).text(d.business.name, MARGIN, MARGIN, { width: WIDTH });
  const contact = [d.business.address, [d.business.phone, d.business.email].filter(Boolean).join("  -  ")].filter(Boolean);
  contact.forEach((c) => doc.font("Helvetica").fontSize(9).fillColor("#6b7280").text(c, MARGIN, doc.y, { width: WIDTH }));
  k.gap(10);
  doc.font("Helvetica-Bold").fontSize(14).fillColor("#111827").text(d.title, MARGIN, doc.y, { width: WIDTH });
  if (subtitle) doc.font("Helvetica").fontSize(9.5).fillColor("#6b7280").text(subtitle, MARGIN, doc.y, { width: WIDTH });
  k.gap(4);
  k.rule("#9ca3af");
};

const footer = (doc, k, text) => {
  k.gap(10); k.rule();
  k.note(text, "#9ca3af", 8.5);
};

const build = (title, draw) => new Promise((resolve, reject) => {
  const doc = new PDFDocument({ size: "A4", margin: MARGIN, info: { Title: title, Producer: "ARL Car Rental" } });
  const chunks = [];
  doc.on("data", (c) => chunks.push(c));
  doc.on("end", () => resolve(Buffer.concat(chunks)));
  doc.on("error", reject);
  try { draw(doc, kit(doc)); doc.end(); } catch (e) { reject(e); }
});

// ─────────────────────────── receipt ───────────────────────────
const renderReceiptPdf = (r) => build(`${r.title} ${r.receiptNo}`, (doc, k) => {
  const out = r.direction === "out";
  header(doc, k, r, `${r.receiptNo}  -  ${when(r.date)}`);

  const period = day(r.booking?.startDateTime) ? `${day(r.booking.startDateTime)} - ${day(r.booking.endDateTime) || "-"}` : null;
  k.line(out ? "Paid to" : "Received from", r.customer?.name || "-");
  k.line("Booking", r.booking?.bookingID || "-");
  if (r.booking?.vehicle) k.line("Vehicle", r.booking.vehicle);
  if (period) k.line("Rental period", period);

  k.section(out ? "Returned" : "Paid for");
  r.lines.forEach((l) => k.line(l.label, php(l.amount)));
  k.rule();
  k.line(out ? "Total returned" : "Total received", php(r.total), { bold: true, size: 12 });
  if (r.note) { k.gap(4); k.note(r.note); }

  (r.penalties || []).forEach((p, i, all) => {
    k.section(all.length > 1 ? `Penalty ${i + 1}` : "Penalty charges");
    p.items.forEach((it) => k.line(it.description, php(it.amount)));
    if (p.total != null) {
      k.rule();
      k.line("Penalty total", php(p.total));
      if (p.paidBefore > 0) k.line("Paid before", php(p.paidBefore));
      if (p.coveredByDeposit > 0) k.line("Covered by security deposit", php(p.coveredByDeposit));
      k.line("This payment", php(p.thisPayment));
      k.line("Remaining", php(p.remaining), { bold: true });
    }
  });

  if (r.depositSummary) {
    k.section("Security deposit");
    k.line("Deposit held", php(r.depositSummary.held));
    k.line("Used for penalties", php(r.depositSummary.usedForPenalties));
    k.line("Returned to you", php(r.depositSummary.returned), { bold: true });
  }

  k.section("Payment");
  k.line("Method", METHOD[r.method] || r.method || "-");
  k.line("Channel", r.source === "in_person" ? "In person" : "Online");
  if (r.referenceNumber) k.line("Reference no.", r.referenceNumber);

  if (r.summary) {
    k.section("Your booking balance");
    k.line("Booking total", php(r.summary.bookingTotal));
    k.line("Paid to date", php(r.summary.paidToDate));
    k.line("Balance remaining", php(r.summary.balanceAfter), { bold: true });
  }

  footer(doc, k, "This is a system-generated acknowledgment of the transaction above. Please keep it for your records.");
});

// ─────────────────────────── booking statement ───────────────────────────
const renderStatementPdf = (s) => build(`${s.title} ${s.statementNo}`, (doc, k) => {
  const o = s.overall;
  header(doc, k, s, `${s.statementNo}  -  as of ${when(s.asOf)}`);

  const period = day(s.booking.startDateTime) ? `${day(s.booking.startDateTime)} - ${day(s.booking.endDateTime) || "-"}` : null;
  k.line("Customer", s.customer.name || "-");
  k.line("Booking", s.booking.bookingID);
  if (s.booking.vehicle) k.line("Vehicle", s.booking.vehicle);
  if (period) k.line("Rental period", period);

  // 1. payments
  k.section("Payments");
  if (!s.payments.length) k.note("No payments have been recorded yet.");
  s.payments.forEach((l, i) => k.line(`${i + 1}. ${l.label}`, php(l.amount), { detail: detailLine(l) }));
  if (s.charges) {
    k.rule();
    k.line("Booking total", php(s.charges.total));
    if (s.charges.discount > 0) k.line(`Discount applied${s.charges.discountReason ? ` (${s.charges.discountReason})` : ""}`, php(s.charges.discount));
    k.line("Total paid", php(s.paymentTotals.paid));
    k.line("Balance remaining", php(s.paymentTotals.balanceRemaining), { bold: true });
  }

  // pending: listed, never counted
  if (s.pending.length) {
    k.section("Pending - not counted in any total");
    s.pending.forEach((l) => k.line(`${l.label}${l.direction === "out" ? " (money back to you)" : ""}`, php(l.amount), { detail: [pendingLabel(l), detailLine(l)].filter(Boolean).join("  -  ") }));
  }

  // 2. penalties
  k.section("Penalties");
  if (!s.penalties.length) k.note("No penalties on this booking.");
  s.penalties.forEach((p, i) => {
    k.ensure(70);
    k.gap(2);
    doc.font("Helvetica-Bold").fontSize(9.5).fillColor("#374151").text(`Penalty ${i + 1}${p.active ? "" : `  -  ${p.status} (not counted)`}`, MARGIN, doc.y, { width: WIDTH });
    k.gap(2);
    p.items.forEach((it) => k.line(it.description, php(it.amount)));
    k.line("Penalty total", php(p.amount), { bold: !p.active });
    if (p.active) {
      p.payments.forEach((l) => k.line("Paid", php(l.amount), { detail: detailLine(l) }));
      if (p.coveredByDeposit > 0) k.line("Covered by security deposit", php(p.coveredByDeposit));
      k.line("Still owed on this penalty", php(p.outstanding), { bold: true });
    } else if (p.reason) k.note(p.reason);
    k.gap(4);
  });
  if (s.penaltyTotals.count > 0) {
    k.rule("#9ca3af");
    k.line("Total penalties", php(s.penaltyTotals.charged));
    k.line("Paid (cash / online)", php(s.penaltyTotals.paid));
    if (s.penaltyTotals.coveredByDeposit > 0) k.line("Covered by security deposit", php(s.penaltyTotals.coveredByDeposit));
    k.line("Still owed on penalties", php(s.penaltyTotals.outstanding), { bold: true });
  }

  // 3. deposit + refunds
  if (s.deposit) {
    k.section("Security deposit");
    k.line("Deposit held", php(s.deposit.held));
    k.line("Used for penalties", php(s.deposit.usedForPenalties));
    k.line("Returned to you", php(s.deposit.returned));
    if (s.deposit.status) k.line("Status", DEPOSIT_LABEL[s.deposit.status] || s.deposit.status, { bold: true });
  }
  if (s.refunds.length) {
    k.section("Refunds");
    s.refunds.forEach((l) => k.line(l.label, php(l.amount), { detail: detailLine(l) }));
  }

  // 5. overall
  k.section("Overall");
  k.line("Total charges", php(o.totalCharges));
  k.line("Total paid", php(o.paidIn));
  if (o.coveredByDeposit > 0) k.line("Covered by security deposit", php(o.coveredByDeposit));
  if (o.refunded > 0) k.line("Refunded to you", php(o.refunded));
  if (o.depositReturned > 0) k.line("Security deposit returned", php(o.depositReturned));
  k.rule("#9ca3af");
  k.line("Net received", php(o.netReceived));
  k.line("Amount still owed", php(o.stillOwed), { bold: true, size: 12 });

  footer(doc, k, `Statement as of ${when(s.asOf)}. It shows this booking at that moment; later payments or charges are not included. System-generated, not an official receipt.`);
});

module.exports = { renderReceiptPdf, renderStatementPdf };

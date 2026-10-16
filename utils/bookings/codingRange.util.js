// ─────────────────────────────────────────────────────────────────────────────
// Number-coding evaluation for a WHOLE booking window (start → end).
//
// The old check only looked at the weekday of the START date, so a Mon → Fri
// booking was only ever tested against Monday. This walks every Manila
// calendar day the booking touches (first day, middle days and last day alike)
// and tests each one against the rules. The time of day is NOT compared: a day
// with a matching rule is flagged whatever hour the trip starts or ends.
//
// Holidays suspend coding for that one day only (the old code only looked at
// the start date).
//
// Every location is tested (pickup, primary destination, extra stops).
//
// A restriction is returned as a WARNING the customer must acknowledge — we
// can't know when in the booking window they will actually reach a coded city
// (e.g. a Mon -> Fri trip with a Monday rule), so nothing is hard-blocked.
// Set CODING_BLOCK_MAX_HOURS above 0 to hard-block bookings up to that many
// hours long again. It is a plain constant in this file, NOT stored in any
// Firestore collection or model.
//
// Rule days: the admin panel stores dayOfWeek as Mon=1 … Sun=7. (The old
// customer check compared that to JS getDay() 0=Sun…6=Sat, so Sunday rules
// never matched.) Everything here uses Mon=1 … Sun=7.
// ─────────────────────────────────────────────────────────────────────────────

// 0 = never block, always warn. A value above 0 hard-blocks bookings up to that
// many hours long (the old behaviour was 24); longer ones only warn.
const CODING_BLOCK_MAX_HOURS = 0;

// Safety cap — a booking can never legitimately span more days than this
// (bookings of 10+ billable days are rejected elsewhere).
const MAX_DAYS_SCANNED = 31;

const DAY_NAMES = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"];

// Number coding is a Philippine (Asia/Manila, UTC+8, no DST) rule. Always read
// the weekday / minutes / date in Manila time, whatever timezone the server runs in.
const MANILA_OFFSET_MS = 8 * 60 * 60 * 1000;
const toManila = (d) => {
  const m = new Date(d.getTime() + MANILA_OFFSET_MS);
  return {
    dow:  m.getUTCDay(),                              // 0=Sun … 6=Sat
    mins: m.getUTCHours() * 60 + m.getUTCMinutes(),   // minutes from Manila midnight
    day:  m.toISOString().slice(0, 10),               // "YYYY-MM-DD" in Manila
  };
};
const manilaDayRange = (day) => ({
  start: new Date(`${day}T00:00:00.000+08:00`),
  end:   new Date(`${day}T23:59:59.999+08:00`),
});

// City matching. A map pin returns the OpenStreetMap name ("City of Manila"), while
// the admin's rule says "Manila" — an exact string compare silently skipped the rule.
// "base" drops "City of"; "core" also drops the word "city" ("Quezon City" -> "quezon").
const placeBase = (v) => String(v || "").toLowerCase().replace(/\bcity of\b/g, " ").replace(/[^a-z0-9ñ ]+/g, " ").replace(/\s+/g, " ").trim();
const placeCore = (v) => placeBase(v).replace(/\bcity\b/g, " ").replace(/\s+/g, " ").trim();
const cityMatchesRule = (ruleCity, destinationCity, destination) => {
  const ruleBase = placeBase(ruleCity);
  if (!ruleBase) return true;                       // rule applies to every city
  const ruleCore = placeCore(ruleCity);
  const cityCore = placeCore(destinationCity);
  if (cityCore && ruleCore && (cityCore === ruleCore || ruleCore.includes(cityCore) || cityCore.includes(ruleCore))) return true;
  // Also accept the free-text address, so a typed destination still matches
  // when the pin's city name is missing or spelled differently.
  const destBase = placeBase(destination);
  if (!destBase) return false;
  if (destBase.includes(ruleBase)) return true;
  // The rule says "Angeles City" but a typed/searched address reads "Angeles, Central Luzon,
  // Philippines" — it never contains the word "city". Match the rule's core name ("angeles")
  // as a whole word as well, so a trailing "City" on the rule doesn't hide the match.
  return !!ruleCore && (` ${destBase} `).includes(` ${ruleCore} `);
};

// "7:00 AM" → minutes from midnight (null if it can't be parsed)
const parseCodingTime = (t) => {
  if (!t) return null;
  const m = String(t).trim().match(/^(\d{1,2}):(\d{2})\s*(AM|PM)$/i);
  if (!m) return null;
  let h = parseInt(m[1], 10);
  const mn = parseInt(m[2], 10);
  const ap = m[3].toUpperCase();
  if (ap === "PM" && h !== 12) h += 12;
  if (ap === "AM" && h === 12) h = 0;
  return h * 60 + mn;
};

// bannedDigits may be an array of strings/numbers or a single value
const parseBannedDigits = (v) => {
  if (Array.isArray(v)) return v.map(Number).filter((n) => !isNaN(n));
  if (v !== undefined && v !== null) {
    const single = Number(v);
    if (!isNaN(single)) return [single];
  }
  return [];
};

// minutes from midnight → "7:00 AM"
const fmtCodingMins = (mins) => {
  const h = Math.floor(mins / 60), m = mins % 60;
  return `${(h % 12) || 12}:${String(m).padStart(2, "0")} ${h >= 12 ? "PM" : "AM"}`;
};

// Rule day as Mon=1 … Sun=7. Uses dayOfWeek when it is a usable 1-7 number,
// otherwise falls back to the day NAME (same fallback the admin side uses).
const ruleDay = (rule) => {
  const n = Number(rule.dayOfWeek);
  if (n >= 1 && n <= 7) return n;
  const idx = DAY_NAMES.findIndex((x) => x.toLowerCase() === String(rule.dayName || "").trim().toLowerCase());
  return idx === -1 ? NaN : idx + 1;
};

// Every location to check: the pickup (when known), the primary destination
// (always) plus each extra stop that has an address or a city. Extra stops come
// from the client as `codingStops: [{ id, address, city }]` — sanitised and capped here.
const buildCodingLocations = ({ destination, destinationCity, codingStops, pickup, pickupCity }) => {
  const locations = [];
  const pickupText = String(pickup || "").trim().slice(0, 300);
  const pickupCityText = String(pickupCity || "").trim().slice(0, 100);
  if (pickupText || pickupCityText) {
    locations.push({ id: "pickup", label: pickupText || pickupCityText, destination: pickupText, destinationCity: pickupCityText });
  }
  locations.push({ id: "primary", label: destination || destinationCity || "Destination", destination, destinationCity });
  (Array.isArray(codingStops) ? codingStops.slice(0, 10) : []).forEach((s, i) => {
    const address = String((s && s.address) || "").trim().slice(0, 300);
    const city    = String((s && s.city)    || "").trim().slice(0, 100);
    if (!address && !city) return;
    locations.push({
      id: String((s && s.id) || `stop_${i}`).slice(0, 60),
      label: address || city,
      destination: address,
      destinationCity: city,
    });
  });
  return locations;
};

// Manila calendar days (YYYY-MM-DD) from first to last, inclusive.
const manilaDaysBetween = (firstDay, lastDay) => {
  const out = [];
  let t = Date.parse(`${firstDay}T00:00:00Z`);
  const end = Date.parse(`${lastDay}T00:00:00Z`);
  while (t <= end && out.length < MAX_DAYS_SCANNED) {
    out.push(new Date(t).toISOString().slice(0, 10));
    t += 24 * 60 * 60 * 1000;
  }
  return out;
};

/**
 * @param {object}   p
 * @param {object[]} p.rules          codingRules docs
 * @param {Date}     p.startDateTime
 * @param {Date}     p.endDateTime    (falls back to the start when missing)
 * @param {number}   p.lastDigit      last digit of the car's plate
 * @param {object[]} p.locations      from buildCodingLocations()
 * @param {Map<string,string>} [p.holidays]  "YYYY-MM-DD" (Manila) -> holiday name
 * @returns {{ mode: "block"|"warn", hours: number, violations: object[], holidaysSkipped: {date:string,name:string}[] }}
 *   violations: one entry per (day, location, rule) — { id, location, city, date, dayName,
 *   startTime, endTime, bannedDigits, digit }
 */
const evaluateCodingRange = ({ rules, startDateTime, endDateTime, lastDigit, locations, holidays = new Map() }) => {
  const start = toManila(startDateTime);
  const end   = toManila(endDateTime && !isNaN(endDateTime.getTime()) ? endDateTime : startDateTime);
  const hours = Math.max(0, ((endDateTime || startDateTime) - startDateTime) / 3600000);

  const violations = [];
  const holidaysSkipped = [];
  const seen = new Set();

  for (const day of manilaDaysBetween(start.day, end.day < start.day ? start.day : end.day)) {
    if (holidays.has(day)) {
      holidaysSkipped.push({ date: day, name: holidays.get(day) || "Public Holiday" });
      continue;
    }
    const dow = new Date(`${day}T00:00:00Z`).getUTCDay() || 7;          // Mon=1 … Sun=7

    for (const loc of locations) {
      for (const rule of rules) {
        if (ruleDay(rule) !== dow) continue;
        if (rule.city && String(rule.city).trim() !== "" && !cityMatchesRule(rule.city, loc.destinationCity, loc.destination)) continue;

        const rStart = parseCodingTime(rule.startTime);
        const rEnd   = parseCodingTime(rule.endTime);
        if (rStart === null || rEnd === null) continue;
        // No time-of-day test: every booked day that has a matching rule is flagged, even when the
        // trip starts after (or ends before) the coded hours that day. We can't know when the
        // customer will actually be in the coded city, so the whole day counts.
        if (!parseBannedDigits(rule.bannedDigits).includes(lastDigit)) continue;

        const key = `${day}|${loc.id}|${rule.startTime}|${rule.endTime}`;
        if (seen.has(key)) continue;
        seen.add(key);
        violations.push({
          id: loc.id,
          location: loc.label,
          city: rule.city || "",
          date: day,
          dayName: rule.dayName || DAY_NAMES[dow - 1],
          startTime: rule.startTime,
          endTime: rule.endTime,
          bannedDigits: parseBannedDigits(rule.bannedDigits),
          digit: lastDigit,
        });
      }
    }
  }

  violations.sort((a, b) => a.date.localeCompare(b.date) || parseCodingTime(a.startTime) - parseCodingTime(b.startTime));
  return { mode: CODING_BLOCK_MAX_HOURS > 0 && hours <= CODING_BLOCK_MAX_HOURS ? "block" : "warn", hours, violations, holidaysSkipped };
};

const fmtDay = (iso) => {
  const d = new Date(`${iso}T00:00:00Z`);
  return d.toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric", timeZone: "UTC" });
};

// "Mon, Oct 19 — Quezon City 7:00 AM – 10:00 AM, 5:00 PM – 8:00 PM; Tue, …"
const describeViolations = (violations) => {
  const groups = new Map();
  for (const v of violations) {
    const k = `${v.date}|${v.id}`;
    if (!groups.has(k)) groups.set(k, { date: v.date, city: v.city, location: v.location, wins: [] });
    groups.get(k).wins.push(`${v.startTime} – ${v.endTime}`);
  }
  return [...groups.values()]
    .map((g) => `${fmtDay(g.date)} — ${g.city || g.location || "this area"} ${g.wins.join(", ")}`)
    .join("; ");
};

// One user-facing sentence for a hard block.
const codingBlockMessage = ({ lastDigit, violations, windowText }) => {
  const windowPart = windowText ? ` Your booking window (${windowText}) overlaps with ${violations.length > 1 ? "these restrictions" : "this restriction"}.` : "";
  return `This vehicle (plate ending in ${lastDigit}) is not allowed under the Number Coding Scheme: ${describeViolations(violations)}.${windowPart} Please choose a different date, time, or another vehicle.`;
};

// One user-facing sentence for a multi-day warning.
const codingWarningMessage = ({ lastDigit, violations }) =>
  `This vehicle (plate ending in ${lastDigit}) is under the Number Coding Scheme on: ${describeViolations(violations)}. ` +
  `The car must not be driven in those areas during those hours. You can still book, but you'll need to confirm you understand.`;

module.exports = {
  CODING_BLOCK_MAX_HOURS,
  DAY_NAMES,
  toManila,
  manilaDayRange,
  cityMatchesRule,
  parseCodingTime,
  parseBannedDigits,
  fmtCodingMins,
  ruleDay,
  buildCodingLocations,
  evaluateCodingRange,
  describeViolations,
  codingBlockMessage,
  codingWarningMessage,
};
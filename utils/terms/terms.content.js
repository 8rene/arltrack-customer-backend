// ─────────────────────────────────────────────────────────────────────────────
// Terms & Conditions — the ONE canonical text.
//
// Before, the full page (TermsPage.jsx) and the shorter signup modal (TandC.jsx)
// each held their own, different wording. Both now render what this file builds
// (served by GET /api/terms/active), and the booking/signup acceptance records
// store the hash of exactly this rendered text.
//
// !! Wording of the Number Coding and "Traffic Violations, Fines & Charges"
// !! sections is a DRAFT — have a lawyer review it before publishing.
//
// WHEN YOU CHANGE ANY WORDING HERE, BUMP TERMS_TEMPLATE_VERSION. (The hash changes
// on its own too, so customers are asked to re-accept, but the version is the
// human-readable label shown on the page and on booking details.)
// Section numbers are assigned from the position, so inserting a section renumbers
// the ones after it automatically.
// ─────────────────────────────────────────────────────────────────────────────

const TERMS_TEMPLATE_VERSION = "2026-10-14";

const buildTermsSections = ({ depositText, serviceFeePercent, gatewayFeePercent, fullRefundHours }) => [
  {
    title: "Acceptance of Agreement",
    body: "By renting a vehicle from ARL Car Rental, the renter agrees to comply with all terms, policies, and conditions stated in this agreement. These conditions are established to ensure the proper use of rental vehicles and to protect both the renter and the business.",
  },
  {
    title: "Reservation & Booking Policy",
    body: `ARL Car Rental follows a first-come, first-served reservation policy. Reservations are only confirmed once the required deposit or downpayment has been received. A minimum deposit of ${depositText} is required to reserve a vehicle and secure the requested rental date. Pencil bookings or temporary reservations without deposit are not accepted.`,
  },
  {
    title: "Rental Inquiries and Approval",
    body: "Customers may send rental inquiries through the official communication channels of ARL Car Rental. Upon receiving an inquiry, the supervisor verifies the requested rental date, vehicle type, rental duration, and type of service (self-drive or with driver) before approving the booking.",
  },
  {
    title: "Payment Terms",
    highlight: `${serviceFeePercent}% service fee (of the rental fee) · ${gatewayFeePercent}% online payment gateway fee (of the booking total, including the service fee and security deposit)`,
    body: "After reservation approval, the renter must settle the remaining rental balance. Full payment must be completed before the vehicle is released. ARL Car Rental offers promotional discounts for rentals of 5 days or more (5% off) and for two or more vehicles in a single transaction (10% off). Discounts for PWD, Senior Citizen, or other identification cards are not applicable.",
  },
  {
    title: "Cancellation & Refund Policy",
    body: `Renters who wish to cancel must notify ARL Car Rental through official channels as early as possible. The ${fullRefundHours} hours are counted from the moment you send your refund request, not from the moment it is reviewed. Service and gateway fees are refunded together with your booking amount; when a refund falls under the ${fullRefundHours}-hour limit, only the ${depositText} deposit is withheld.`,
    list: [
      { label: `${fullRefundHours} hours or more before pickup`, value: "Full refund of everything you paid" },
      { label: `Less than ${fullRefundHours} hours before pickup`, value: `Everything refunded except the ${depositText} deposit` },
      { label: "No-show on pickup date", value: `${depositText} deposit forfeited; everything else refunded` },
    ],
    footer: `Rescheduling is allowed with at least 24 hours' notice, subject to vehicle availability. The ${depositText} deposit may be applied to the rescheduled booking at management's discretion.`,
  },
  {
    title: "Vehicle Pickup & Customer Identification",
    body: "On the scheduled pickup date, the renter is required to present a valid government-issued identification card to verify identity, confirm booking details, and serve as a security measure. Failure to provide valid identification may result in cancellation without refund of the deposit.",
  },
  {
    title: "Driver Requirements (Self-Drive Rentals)",
    list: [
      { label: "Minimum age", value: "21 years old" },
      { label: "License required", value: "Valid Philippine driver's license" },
      { label: "Primary driver", value: "Only the registered renter may drive" },
      { label: "Unauthorized drivers", value: "Strictly prohibited" },
    ],
  },
  {
    title: "Vehicle Usage & Rental Period",
    body: "The renter agrees to use the vehicle only within the agreed rental period and for lawful purposes. Strictly prohibited: subletting or transferring the vehicle, illegal transport, off-road use (unless authorized in writing), smoking inside the vehicle, and transporting hazardous or prohibited materials. The vehicle must be returned to ARL Car Rental once the rental agreement has ended.",
  },
  {
    title: "Rental Time & Destination Selection",
    body: "The renter is solely responsible for carefully choosing the pickup date, pickup time, and rental duration, and for making sure the selected schedule gives enough time to complete the entire trip, including travel to and from every destination, traffic, rest stops, and possible delays. The destination entered during booking is recorded for documentation and record-keeping purposes only. The ARL booking system does not calculate or estimate travel time or distance based on the selected destination, and an accepted booking does not mean that the chosen schedule is sufficient for the trip. Any time used beyond the agreed return time, including time lost because the schedule was underestimated, is treated as a late return and is charged under Late Return & Penalties.",
  },
  {
    title: "Security Deposit",
    body: "In addition to the reservation deposit, ARL Car Rental may require a separate security deposit prior to vehicle release. The amount depends on the vehicle type and rental duration. It will be refunded in full upon return of the vehicle in satisfactory condition, free of damage, and with no outstanding charges.",
  },
  {
    title: "Accidents & Incidents",
    body: "In the event of an accident or road incident during the rental period, the renter must: immediately stop the vehicle and ensure the safety of all parties; contact ARL Car Rental as soon as possible; file a report with the nearest PNP station and obtain a copy; and not admit fault or make settlements with third parties without prior written consent from ARL Car Rental.",
  },
  {
    title: "Damages & Repair Liability",
    body: "The renter is responsible for any damages that occur during the rental period, whether caused by accident, negligence, or misuse. Charges may apply for major or minor vehicle damages, repair or replacement costs, and administrative fees. ARL Car Rental's assessment of damages shall be final and binding.",
  },
  {
    title: "Fuel Policy",
    body: "ARL Car Rental operates on an unlimited mileage basis. However, fuel and toll fees are the full responsibility of the renter. Vehicles must be returned with the same fuel level as when released. If returned with less fuel, the renter will be charged for the difference at current pump prices plus an administrative handling fee.",
  },
  {
    title: "Late Return & Penalties",
    highlight: "₱100.00 per hour beyond the agreed return time",
    body: "Vehicles must be returned on the agreed date and time. If the vehicle is not returned within 12 hours of the agreed return time without prior communication, ARL Car Rental reserves the right to treat the unit as unreturned and pursue appropriate legal action. Extensions must be confirmed in advance.",
  },
  {
    title: "Number Coding Scheme (Metro Manila – UVVRP)",
    body: "Metro Manila's Number Coding Scheme restricts vehicles by the last digit of the plate number on weekdays, during coding hours set by the MMDA or the local government. Those hours, the cities that apply the scheme, and the days it is suspended (such as holidays, weather suspensions, and advisories) can change at any time. The schedule shown by the booking system is a guide only; it is not a guarantee that a trip is free of coding restrictions, and the renter is responsible for confirming the prevailing schedule with the MMDA or the local government before and during the trip.",
    list: [
      { label: "Monday", value: "Plates ending in 1 or 2" },
      { label: "Tuesday", value: "Plates ending in 3 or 4" },
      { label: "Wednesday", value: "Plates ending in 5 or 6" },
      { label: "Thursday", value: "Plates ending in 7 or 8" },
      { label: "Friday", value: "Plates ending in 9 or 0" },
    ],
    footer: "The usual plate-ending days are shown above for reference. Coding applies at every place the vehicle is driven during the rental period, including stops added after booking and cities passed along the way.",
  },
  {
    title: "Traffic Violations, Fines & Charges",
    body: "The renter is responsible for all traffic and parking violations, penalties, tickets, towing and impound fees, and similar charges incurred while the vehicle is in the renter's possession during the rental period, including violations of the Number Coding Scheme. ARL Car Rental may deduct these charges, together with reasonable administrative costs, from the security deposit and may bill any remaining amount to the renter. Notices received after the rental period for violations committed during it remain the renter's responsibility. The renter agrees that ARL Car Rental may give the renter's name and identification details to the proper authorities to identify the person responsible for a violation, and must report any ticket or notice received promptly and cooperate in contesting it where appropriate.",
    footer: "For rentals with a driver, ARL Car Rental's driver may decline or change a route to avoid entering a restricted area during coding hours, without liability for any resulting delay. The renter remains responsible for violations resulting from the renter's chosen route, schedule, or instructions.",
  },
  {
    title: "Vehicle Security & Renter Responsibility",
    body: "The renter assumes full responsibility for the vehicle and its contents during the entire rental period. ARL Car Rental shall not be held liable for any loss of personal belongings left inside the vehicle. Failure to return the vehicle or intentional damage may result in legal action under applicable Philippine laws.",
  },
  {
    title: "Force Majeure",
    body: "Neither party shall be held liable for failure or delay in fulfilling obligations due to circumstances beyond reasonable control, including natural disasters, typhoons, floods, government-imposed restrictions, road closures, or civil unrest. Both parties shall communicate promptly to agree on a fair resolution.",
  },
  {
    title: "Governing Law & Dispute Resolution",
    body: "This agreement shall be governed by and construed in accordance with the laws of the Republic of the Philippines. Any disputes that cannot be resolved amicably shall be submitted to the proper courts of competent jurisdiction in the city or municipality where ARL Car Rental's principal office is located.",
  },
];
module.exports = { TERMS_TEMPLATE_VERSION, buildTermsSections };

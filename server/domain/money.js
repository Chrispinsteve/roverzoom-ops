// Fare and payout model, mirrored from the RoverZoom rider/driver backend.
//
// SOURCE OF TRUTH: roverzoom/backend/services/fare.js  (multiplierForTime)
//                  roverzoom/backend/services/payout.js (DRIVER_BASE_SHARE)
//
// DANGER: these numbers decide what the console tells you a driver is owed.
// If they drift from the rider/driver backend, the console will report
// confident, wrong money. Every constant below reads the SAME env var the
// source service reads, so a deployment that sets them once keeps both in
// step. `npm run verify:sync` diffs this file against a checkout of the
// rider/driver backend — run it whenever that repo changes.

// --- fare.js mirror --------------------------------------------------------
const FARE_MULTIPLIER_MORNING = Number(process.env.FARE_MULTIPLIER_MORNING) || 0.75; // 25% off, 4-10am
const FARE_MULTIPLIER_DEFAULT = Number(process.env.FARE_MULTIPLIER) || 0.85;         // 15% off otherwise
const MORNING_START_HOUR = 4;
const MORNING_END_HOUR = 10; // [4:00, 10:00) local
const SERVICE_TZ = process.env.SERVICE_TZ || 'America/New_York';

// --- payout.js mirror ------------------------------------------------------
// Driver's share of the STANDARD (pre-discount) fare. The rider's promo comes
// out of platform margin, never the driver's take-home.
const DRIVER_BASE_SHARE = Number(process.env.DRIVER_CUT_PCT) || 0.575;

// Which discount multiplier applied to a ride at this scheduled time.
function multiplierForTime(whenIso) {
  if (!whenIso) return FARE_MULTIPLIER_DEFAULT;
  const d = new Date(whenIso);
  if (isNaN(d.getTime())) return FARE_MULTIPLIER_DEFAULT;
  let hour;
  try {
    const parts = new Intl.DateTimeFormat('en-US', {
      timeZone: SERVICE_TZ, hour: 'numeric', hour12: false,
    }).formatToParts(d);
    hour = Number((parts.find((p) => p.type === 'hour') || {}).value);
  } catch {
    hour = d.getHours();
  }
  if (hour === 24) hour = 0;
  return (hour >= MORNING_START_HOUR && hour < MORNING_END_HOUR)
    ? FARE_MULTIPLIER_MORNING
    : FARE_MULTIPLIER_DEFAULT;
}

function driverPayout(fare, whenIso) {
  const multiplier = multiplierForTime(whenIso) || 1;
  const baseFare = fare / multiplier;
  return round2(baseFare * DRIVER_BASE_SHARE);
}

function round2(n) { return Math.round(n * 100) / 100; }

// Full economics of a single completed ride, as the finance screen shows it.
// `standardFare` is what the ride would have cost with no promo — the number
// the driver is actually paid a share of.
function rideEconomics(booking) {
  const fare = Number(booking.fare) || 0;
  const multiplier = multiplierForTime(booking.scheduled_at) || 1;
  const standardFare = round2(fare / multiplier);
  const driverShare = driverPayout(fare, booking.scheduled_at);
  return {
    fare,                                        // what the rider paid
    standardFare,                                // pre-discount list price
    discount: round2(standardFare - fare),       // promo, absorbed by platform
    discountPct: Math.round((1 - multiplier) * 100),
    driverShare,                                 // what the driver earns
    platformShare: round2(fare - driverShare),   // gross margin after promo
    // A cash ride is collected in hand by the driver, so the platform is OWED
    // its share rather than holding it. complete_booking() records this as a
    // negative 'adjustment' against the driver's card cash-out.
    paymentMethod: booking.payment_method,
    platformOwedByDriver: booking.payment_method === 'cash'
      ? round2(Math.max(fare - driverShare, 0))
      : 0,
  };
}

// Reduces a driver's raw driver_earnings rows into the balances the finance
// screen and the driver's own cash-out both depend on.
//
// The ledger is append-only and mixes: positive 'fare' rows (card and cash),
// 'tip'/'bonus' rows, and negative 'adjustment' rows that claw back the
// platform's commission on cash rides. `paid_out_at` marks a row already
// transferred via Stripe Connect.
function summarizeEarnings(rows) {
  let lifetime = 0;      // everything the driver has earned, all types
  let cashCollected = 0; // fares the driver already took in hand
  let owedToDriver = 0;  // card money not yet transferred
  let paidOut = 0;       // card money already transferred
  let adjustments = 0;   // net of negative commission clawbacks

  for (const row of rows) {
    const amount = Number(row.amount) || 0;
    lifetime += amount;
    if (row.type === 'adjustment') adjustments += amount;
    if (row.payment_method === 'cash' && row.type === 'fare') {
      cashCollected += amount;
      continue; // cash is settled at the curb; it is never part of a cash-out
    }
    if (row.paid_out_at) paidOut += amount;
    else owedToDriver += amount;
  }

  return {
    lifetime: round2(lifetime),
    cashCollected: round2(cashCollected),
    // Cash-out balance nets the commission clawbacks against unpaid card
    // money, exactly as the driver's own earnings screen computes it. It can
    // legitimately go negative when a driver has run mostly cash rides — that
    // means they owe the platform, and it must NOT be clamped to zero here or
    // the console would hide a real debt.
    payable: round2(owedToDriver),
    paidOut: round2(paidOut),
    adjustments: round2(adjustments),
  };
}

module.exports = {
  DRIVER_BASE_SHARE,
  FARE_MULTIPLIER_MORNING,
  FARE_MULTIPLIER_DEFAULT,
  SERVICE_TZ,
  multiplierForTime,
  driverPayout,
  rideEconomics,
  summarizeEarnings,
  round2,
};

#!/usr/bin/env node
//
// Verifies that the domain constants this console duplicates still match the
// rider/driver backend.
//
// WHY THIS EXISTS
// The ops console is a separate service, so it cannot import fare.js or
// payout.js. It mirrors them instead (server/domain/money.js, lifecycle.js).
// A mirror that silently drifts is worse than no mirror: the console would
// report confident, wrong numbers about what drivers are owed.
//
// Usage:
//   npm run verify:sync -- /path/to/roverzoom
//   ROVERZOOM_PATH=/path/to/roverzoom npm run verify:sync
//
// Exits non-zero on a mismatch, so it can gate a deploy in CI.

const fs = require('fs');
const path = require('path');

const root = process.argv[2] || process.env.ROVERZOOM_PATH;

if (!root) {
  console.error(`
Point this at a checkout of the rider/driver app:

  npm run verify:sync -- /path/to/roverzoom

It reads backend/services/fare.js, backend/services/payout.js and
backend/db/schema.sql and checks them against server/domain/.
`);
  process.exit(2);
}

const read = (rel) => {
  const file = path.join(root, rel);
  if (!fs.existsSync(file)) {
    console.error(`✗ Not found: ${file}\n  Is ${root} really the roverzoom repo?`);
    process.exit(2);
  }
  return fs.readFileSync(file, 'utf8');
};

const fare = read('backend/services/fare.js');
const payout = read('backend/services/payout.js');
const schema = read('backend/db/schema.sql');

const ours = require('../domain/money');
const lifecycle = require('../domain/lifecycle');

let failures = 0;
const check = (label, expected, actual) => {
  const ok = String(expected) === String(actual);
  console.log(`${ok ? '✓' : '✗'} ${label}`);
  if (!ok) {
    console.log(`    upstream: ${expected}`);
    console.log(`    console:  ${actual}`);
    failures++;
  }
};

// Pull the literal defaults out of the upstream source.
const num = (source, re) => {
  const m = source.match(re);
  return m ? Number(m[1]) : null;
};

console.log('\nMoney model\n');
check('driver share of standard fare',
  num(payout, /DRIVER_BASE_SHARE\s*=\s*Number\(process\.env\.DRIVER_CUT_PCT\)\s*\|\|\s*([\d.]+)/),
  ours.DRIVER_BASE_SHARE);

check('morning fare multiplier',
  num(fare, /FARE_MULTIPLIER_MORNING\s*=\s*Number\(process\.env\.FARE_MULTIPLIER_MORNING\)\s*\|\|\s*([\d.]+)/),
  ours.FARE_MULTIPLIER_MORNING);

check('default fare multiplier',
  num(fare, /FARE_MULTIPLIER_DEFAULT\s*=\s*Number\(process\.env\.FARE_MULTIPLIER\)\s*\|\|\s*([\d.]+)/),
  ours.FARE_MULTIPLIER_DEFAULT);

// The morning discount window decides which multiplier a ride gets, so a
// change here silently reprices every early booking.
check('morning window start hour', num(fare, /MORNING_START_HOUR\s*=\s*(\d+)/), 4);
check('morning window end hour', num(fare, /MORNING_END_HOUR\s*=\s*(\d+)/), 10);

console.log('\nRide lifecycle\n');

// Every status the BOOKINGS table will accept must be one the console can
// render. Anchored on the named constraint: `drivers`, `ride_offers` and
// `driver_payouts` each have their own `status` CHECK, and a looser pattern
// happily scoops up their values too.
const bookingsCheck = schema.match(
  /bookings_status_check\s*\n?\s*CHECK \(status IN \(([\s\S]*?)\)\)/
);
if (!bookingsCheck) {
  console.log('✗ could not find bookings_status_check in schema.sql — has the constraint been renamed?');
  failures++;
}
const upstreamStatuses = new Set(
  bookingsCheck ? [...bookingsCheck[1].matchAll(/'([a-z_]+)'/g)].map((m) => m[1]) : []
);

const missing = [...upstreamStatuses].filter((s) => !lifecycle.RIDE_STATUSES.includes(s));
const extra = lifecycle.RIDE_STATUSES.filter((s) => !upstreamStatuses.has(s));

if (missing.length) {
  console.log(`✗ statuses in the database the console cannot render: ${missing.join(', ')}`);
  failures++;
} else {
  console.log('✓ every database ride status is handled');
}
if (extra.length) {
  console.log(`  note: console knows statuses not found upstream: ${extra.join(', ')}`);
}

console.log(
  failures === 0
    ? '\nIn sync.\n'
    : `\n${failures} mismatch${failures > 1 ? 'es' : ''}. Update server/domain/ to match, then re-run.\n`
);
process.exit(failures === 0 ? 0 : 1);

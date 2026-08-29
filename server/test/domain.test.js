// Domain guarantees. These encode the promises the console makes about money,
// trust and privacy — the three places a mistake hurts someone real.
process.env.SUPABASE_URL = process.env.SUPABASE_URL || 'https://test.supabase.co';
process.env.SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || 'test-key';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const money = require('../domain/money');
const trust = require('../domain/trust');
const lifecycle = require('../domain/lifecycle');
const attention = require('../domain/attention');
const roles = require('../lib/roles');
const { riderContact, maskPhone } = require('../lib/redact');
const docs = require('../lib/documents');
const funnel = require('../domain/funnel');

// --- money -----------------------------------------------------------------

test('driver take-home is identical across promo tiers (payout.js contract)', () => {
  // The same $100 standard fare, sold at 25% off and at 15% off. payout.js
  // pays a share of the STANDARD fare, so the driver must earn the same
  // either way — the promo comes out of platform margin.
  const morning = money.rideEconomics({ fare: 75, scheduled_at: '2026-08-28T12:00:00Z', payment_method: 'card' });
  const evening = money.rideEconomics({ fare: 85, scheduled_at: '2026-08-28T22:00:00Z', payment_method: 'card' });

  assert.equal(morning.standardFare, 100);
  assert.equal(evening.standardFare, 100);
  assert.equal(morning.driverShare, 57.5);
  assert.equal(evening.driverShare, 57.5);
  assert.equal(morning.driverShare, evening.driverShare);
  // The platform, not the driver, absorbs the deeper discount.
  assert.ok(morning.platformShare < evening.platformShare);
});

test('driverPayout matches the 57.5%-of-standard model exactly', () => {
  assert.equal(money.DRIVER_BASE_SHARE, 0.575);
  assert.equal(money.driverPayout(85, '2026-08-28T22:00:00Z'), 57.5);
});

test('a cash ride records the commission the driver owes back', () => {
  const cash = money.rideEconomics({ fare: 85, scheduled_at: '2026-08-28T22:00:00Z', payment_method: 'cash' });
  assert.equal(cash.platformOwedByDriver, 27.5);
  assert.equal(money.round2(cash.driverShare + cash.platformOwedByDriver), 85);
});

test('a negative cash-out balance is reported, never clamped to zero', () => {
  // A driver who ran mostly cash owes the platform. Hiding that would make the
  // console under-report a real debt.
  const summary = money.summarizeEarnings([
    { amount: 57.5, type: 'fare', payment_method: 'cash', paid_out_at: null },
    { amount: -27.5, type: 'adjustment', payment_method: 'cash', paid_out_at: null },
  ]);
  assert.equal(summary.payable, -27.5);
  assert.equal(summary.cashCollected, 57.5);
});

test('cash fares never enter the cash-out balance', () => {
  const summary = money.summarizeEarnings([
    { amount: 40, type: 'fare', payment_method: 'cash', paid_out_at: null },
  ]);
  assert.equal(summary.payable, 0);
  assert.equal(summary.cashCollected, 40);
});

// --- trust -----------------------------------------------------------------

test('an auto-activated, never-reviewed driver reads as critical', () => {
  // This is the live default: handle_new_driver() sets status 'active' with
  // nobody having looked. The console must never call that state healthy.
  const standing = trust.trustStanding(
    { status: 'active', profile_completed_at: '2026-08-01T00:00:00Z' },
    { app_metadata: {} }
  );
  assert.equal(standing.key, 'unvetted_driving');
  assert.equal(standing.risk, 'critical');
});

test('a driver is cleared only when all four factors hold', () => {
  const base = { status: 'active', profile_completed_at: '2026-08-01T00:00:00Z' };
  const meta = { app_metadata: { screening_status: 'clear', rz_review: { state: 'approved' } } };
  assert.equal(trust.trustStanding(base, meta).key, 'cleared');

  // Drop each factor in turn; none of them may be optional.
  assert.notEqual(trust.trustStanding({ ...base, status: 'suspended' }, meta).key, 'cleared');
  assert.notEqual(trust.trustStanding({ ...base, profile_completed_at: null }, meta).key, 'cleared');
  assert.notEqual(trust.trustStanding(base, { app_metadata: { rz_review: { state: 'approved' } } }).key, 'cleared');
  assert.notEqual(trust.trustStanding(base, { app_metadata: { screening_status: 'clear' } }).key, 'cleared');
});

test('a screening-flagged driver is called out specifically', () => {
  const standing = trust.trustStanding(
    { status: 'active', profile_completed_at: '2026-08-01T00:00:00Z' },
    { app_metadata: { screening_status: 'consider', rz_review: { state: 'approved' } } }
  );
  assert.equal(standing.key, 'screening_consider');
  assert.equal(standing.risk, 'critical');
});

test('review state cannot be forged through user-controlled metadata', () => {
  // app_metadata is server-only, but guard the parse anyway: an unknown value
  // must degrade to 'unreviewed', never be trusted through.
  const review = trust.readReview({ app_metadata: { rz_review: { state: 'super_approved' } } });
  assert.equal(review.state, 'unreviewed');
});

// --- permissions -----------------------------------------------------------

test('permissions deny by default', () => {
  assert.deepEqual(roles.permissionsFor(null), []);
  assert.deepEqual(roles.permissionsFor('superuser'), []);
  assert.equal(roles.roleOf({ app_metadata: {} }), null);
  assert.equal(roles.roleOf({ app_metadata: { rz_admin_role: 'wizard' } }), null);
  assert.equal(roles.can(null, 'rides.read'), false);
});

test('finance can never read rider contact details', () => {
  assert.equal(roles.can('finance', 'finance.payout'), true);
  assert.equal(roles.can('finance', 'riders.pii'), false);
});

test('only trust and owner may vet drivers', () => {
  for (const role of roles.ROLE_KEYS) {
    const expected = role === 'owner' || role === 'trust';
    assert.equal(roles.can(role, 'drivers.review'), expected, `${role} drivers.review`);
  }
});

test('viewer has no PII and no mutating permission', () => {
  const mutating = ['rides.cancel', 'rides.reassign', 'dispatch.assign', 'drivers.review', 'drivers.suspend', 'finance.payout', 'admins.manage'];
  for (const p of [...mutating, 'riders.pii']) {
    assert.equal(roles.can('viewer', p), false, `viewer must not have ${p}`);
  }
});

// --- redaction -------------------------------------------------------------

test('rider PII is redacted at the serialization boundary', () => {
  const booking = { rider_name: 'Maria Gonzalez', rider_phone: '+1 (561) 555-0142', rider_email: 'maria.g@example.com' };

  const open = riderContact(booking, true);
  assert.equal(open.rider_phone, '+1 (561) 555-0142');
  assert.equal(open.pii_redacted, false);

  const closed = riderContact(booking, false);
  assert.equal(closed.pii_redacted, true);
  assert.equal(closed.rider_name, 'Maria G.');
  assert.ok(!closed.rider_phone.includes('561'), 'area code must not leak');
  assert.ok(closed.rider_phone.endsWith('0142'), 'last 4 kept for identification');
  assert.ok(!closed.rider_email.includes('maria.g'), 'local part must not leak');
});

test('redaction handles missing and malformed values', () => {
  assert.equal(maskPhone(null), null);
  assert.equal(maskPhone('12'), '•••');
  const empty = riderContact({ rider_name: null, rider_phone: null, rider_email: null }, false);
  assert.equal(empty.rider_name, null);
});

// --- lifecycle -------------------------------------------------------------

test('a trip in progress cannot be canceled', () => {
  assert.equal(lifecycle.isCancelable('in_progress'), false);
  assert.equal(lifecycle.isCancelable('completed'), false);
  assert.equal(lifecycle.isCancelable('arrived'), true);
});

test('the timeline is built in real chronological order', () => {
  const events = lifecycle.buildTimeline({
    created_at: '2026-08-28T10:00:00Z',
    accepted_at: '2026-08-28T10:05:00Z',
    started_at: '2026-08-28T10:20:00Z',
    completed_at: '2026-08-28T10:45:00Z',
  });
  assert.deepEqual(events.map((e) => e.status), ['confirmed', 'driver_assigned', 'in_progress', 'completed']);
});

test('a cancellation appears in the timeline with its actor and reason', () => {
  const events = lifecycle.buildTimeline({
    created_at: '2026-08-28T10:00:00Z',
    canceled_at: '2026-08-28T10:10:00Z',
    canceled_by: 'rider',
    cancel_reason: 'changed plans',
  });
  const cancel = events.find((e) => e.status === 'canceled');
  assert.equal(cancel.by, 'rider');
  assert.equal(cancel.reason, 'changed plans');
});

// --- attention -------------------------------------------------------------

test('a manual-dispatch ride is always critical and names its reference', () => {
  const feed = attention.buildFeed({
    now: '2026-08-28T14:00:00Z',
    bookings: [{ id: '1', reference: 'RZ-AAAAA', status: 'manual_dispatch_required', driver_id: null, scheduled_at: '2026-08-28T13:52:00Z' }],
    drivers: [],
  });
  assert.equal(feed.counts.critical, 1);
  assert.equal(feed.items[0].reference, 'RZ-AAAAA');
  assert.equal(feed.items[0].action, 'assign');
});

test('critical items always outrank warnings', () => {
  const feed = attention.buildFeed({
    now: '2026-08-28T14:00:00Z',
    bookings: [
      { id: '1', reference: 'RZ-WARN', status: 'in_progress', driver_id: 'd', started_at: '2026-08-28T13:00:00Z', duration_minutes: 20 },
      { id: '2', reference: 'RZ-CRIT', status: 'confirmed', driver_id: null, scheduled_at: '2026-08-28T13:30:00Z' },
    ],
    drivers: [],
  });
  assert.equal(feed.items[0].severity, 'critical');
  assert.equal(feed.items[0].reference, 'RZ-CRIT');
});

test('a quiet board produces an empty feed', () => {
  // "Nothing needs you" has to be a real, reachable answer or operators stop
  // trusting the feed entirely.
  const feed = attention.buildFeed({
    now: '2026-08-28T14:00:00Z',
    bookings: [{ id: '1', reference: 'RZ-OK', status: 'in_progress', driver_id: 'd', started_at: '2026-08-28T13:55:00Z', duration_minutes: 30 }],
    drivers: [{ standing: { key: 'cleared' } }],
  });
  assert.equal(feed.counts.total, 0);
});


// --- identity documents ----------------------------------------------------

test('a public photo URL is passed through, never re-signed', async () => {
  const url = 'https://x.supabase.co/storage/v1/object/public/driver-photos/a/photo.jpg';
  const resolved = await docs.resolveOne('photo', url);
  assert.equal(resolved.kind, 'public');
  assert.equal(resolved.url, url);
  assert.equal(resolved.present, true);
});

test('a missing document is reported as missing, not as an error', async () => {
  const resolved = await docs.resolveOne('license', null);
  assert.equal(resolved.present, false);
  assert.equal(resolved.kind, 'missing');
  assert.equal(resolved.url, null);
});

test('storage paths normalize regardless of how they were written', () => {
  const bucket = 'driver-documents';
  // The upstream app writes `${driverId}/${type}-${Date.now()}.jpg`.
  assert.equal(docs.normalizePath('abc/license-1.jpg', bucket), 'abc/license-1.jpg');
  // Defensive: a value that already carries the bucket prefix must not become
  // driver-documents/driver-documents/... and 404 on signing.
  assert.equal(docs.normalizePath('driver-documents/abc/license-1.jpg', bucket), 'abc/license-1.jpg');
  assert.equal(docs.normalizePath('/abc/license-1.jpg', bucket), 'abc/license-1.jpg');
});

test('a raw storage path is never mistaken for a usable URL', () => {
  assert.equal(docs.isAbsoluteUrl('abc/license-1738.jpg'), false);
  assert.equal(docs.isAbsoluteUrl('https://x.supabase.co/a.jpg'), true);
});

test('licence and insurance resolve against the private bucket', () => {
  // The whole reason signing is needed: these two are NOT in the public bucket.
  assert.equal(docs.BUCKETS.license, 'driver-documents');
  assert.equal(docs.BUCKETS.insurance, 'driver-documents');
  assert.notEqual(docs.BUCKETS.photo, docs.BUCKETS.license);
});

test('presence view leaks no path and no URL', () => {
  const items = docs.presenceForDriver({
    photo_url: 'https://x/y.jpg',
    license_photo_url: 'abc/license-1.jpg',
    insurance_photo_url: null,
  });
  const serialized = JSON.stringify(items);
  assert.ok(!serialized.includes('abc/license-1.jpg'), 'storage path must not appear');
  assert.ok(!serialized.includes('https://x/y.jpg'), 'URL must not appear');
  assert.deepEqual(items.map((i) => i.present), [true, true, false]);
});

test('only vetting roles may view identity documents', () => {
  for (const role of roles.ROLE_KEYS) {
    const expected = role === 'owner' || role === 'trust';
    assert.equal(roles.can(role, 'drivers.documents'), expected, `${role} drivers.documents`);
  }
  // Being able to browse drivers must NOT imply seeing their licence.
  assert.equal(roles.can('dispatcher', 'drivers.read'), true);
  assert.equal(roles.can('dispatcher', 'drivers.documents'), false);
});


// --- provisional authorization ---------------------------------------------
// The whole safety property is the EXPIRY. These tests exist so nobody can
// later "simplify" the grant into an unbounded flag without a test failing.

const DRIVER = { status: 'active', profile_completed_at: '2026-08-28T00:00:00Z' };
const NOW = Date.parse('2026-08-29T12:00:00Z');
const withGrant = (p) => ({ app_metadata: { rz_review: { state: 'approved' }, ...(p ? { rz_provisional: p } : {}) } });

test('without a grant, an unscreened driver is critical', () => {
  const s = trust.trustStanding(DRIVER, withGrant(null), NOW);
  assert.equal(s.key, 'unvetted_driving');
  assert.equal(s.risk, 'critical');
});

test('a live grant downgrades critical to warn, never to healthy', () => {
  const s = trust.trustStanding(DRIVER, withGrant({ until: '2026-09-23T12:00:00Z', by: 'ops@rz.com' }), NOW);
  assert.equal(s.key, 'provisional');
  // Explicitly NOT 'active'. An accepted risk is still a risk, and the console
  // must keep saying so for the whole window.
  assert.equal(s.risk, 'warn');
  assert.notEqual(s.key, 'cleared');
});

test('an expired grant returns the driver to critical automatically', () => {
  const s = trust.trustStanding(DRIVER, withGrant({ until: '2026-08-28T12:00:00Z', by: 'ops@rz.com' }), NOW);
  assert.equal(s.key, 'unvetted_driving');
  assert.equal(s.risk, 'critical');
});

test('a grant never satisfies the screening factor', () => {
  const f = trust.trustFactors(DRIVER, withGrant({ until: '2026-09-23T12:00:00Z' }), NOW);
  assert.equal(f.provisionallyAuthorized, true);
  assert.equal(f.screeningClear, false, 'a grant must never be mistaken for a clear check');
  assert.equal(trust.isFullyVetted(f), false);
});

test('a malformed or open-ended grant is ignored', () => {
  for (const bad of [{}, { until: null }, { until: 'not-a-date' }]) {
    const p = trust.readProvisional(withGrant(bad), NOW);
    assert.equal(p.active, false, `${JSON.stringify(bad)} must not authorize anyone`);
  }
});

test('days remaining counts down and floors at expiry', () => {
  const live = trust.readProvisional(withGrant({ until: '2026-09-01T12:00:00Z' }), NOW);
  assert.equal(live.daysLeft, 3);
  const gone = trust.readProvisional(withGrant({ until: '2026-08-01T12:00:00Z' }), NOW);
  assert.equal(gone.daysLeft, 0);
  assert.equal(gone.expired, true);
});

test('a cleared driver is unaffected by a grant', () => {
  const cleared = { app_metadata: { rz_review: { state: 'approved' }, screening_status: 'clear',
    rz_provisional: { until: '2026-09-23T12:00:00Z' } } };
  assert.equal(trust.trustStanding(DRIVER, cleared, NOW).key, 'cleared');
});


// --- funnel ----------------------------------------------------------------

test('the funnel counts sessions, not events', () => {
  // One session firing the same step repeatedly must count once.
  const events = [
    { session_id: 'a', step: 'visit' }, { session_id: 'a', step: 'visit' },
    { session_id: 'a', step: 'visit' }, { session_id: 'b', step: 'visit' },
  ];
  const r = funnel.buildFunnel(events);
  assert.equal(r.totalSessions, 2);
  assert.equal(r.steps[0].sessions, 2);
});

test('the funnel is monotonic — a dropped beacon cannot fake a recovery', () => {
  // This session never reported pickup_set or dropoff_set, but did reach the
  // price. It must still be counted at every earlier step, or the chart would
  // show more people at a later step than the one before it.
  const r = funnel.buildFunnel([
    { session_id: 'a', step: 'visit' },
    { session_id: 'a', step: 'quote_viewed' },
  ]);
  const counts = r.steps.map((s) => s.sessions);
  for (let i = 1; i < counts.length; i++) {
    assert.ok(counts[i] <= counts[i - 1], `step ${i} (${counts[i]}) must not exceed step ${i - 1} (${counts[i - 1]})`);
  }
  assert.equal(r.steps.find((s) => s.key === 'pickup_set').sessions, 1);
});

test('the worst drop-off ignores steps with too small a base', () => {
  // Two sessions, one of which vanishes, is a 50% drop off a base of 2. That
  // must not be reported as an insight.
  const r = funnel.buildFunnel([
    { session_id: 'a', step: 'visit' },
    { session_id: 'b', step: 'visit' },
    { session_id: 'a', step: 'booking_started' },
  ]);
  assert.equal(r.worstDropOff, null);
  assert.equal(r.enoughData, false);
});

test('the funnel flags when there is too little data to trust', () => {
  const few = funnel.buildFunnel(Array.from({ length: 10 }, (_, i) => ({ session_id: 's' + i, step: 'visit' })));
  assert.equal(few.enoughData, false);
  const many = funnel.buildFunnel(Array.from({ length: 40 }, (_, i) => ({ session_id: 's' + i, step: 'visit' })));
  assert.equal(many.enoughData, true);
});

test('unknown steps are ignored rather than corrupting the funnel', () => {
  const r = funnel.buildFunnel([
    { session_id: 'a', step: 'visit' },
    { session_id: 'a', step: 'hacked_step' },
    { session_id: 'b', step: 'not_a_step' },
  ]);
  assert.equal(r.totalSessions, 1, 'a session with only unknown steps must not count');
});

test('conversion is computed from the final step', () => {
  const r = funnel.buildFunnel([
    { session_id: 'a', step: 'visit' }, { session_id: 'a', step: 'booked' },
    { session_id: 'b', step: 'visit' }, { session_id: 'c', step: 'visit' },
    { session_id: 'd', step: 'visit' },
  ]);
  assert.equal(r.booked, 1);
  assert.equal(r.conversionPct, 25);
});

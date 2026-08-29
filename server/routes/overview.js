// The live operations overview: the attention feed plus the handful of
// numbers that describe the shape of the day.
const express = require('express');
const { supabase } = require('../lib/supabase');
const { requireAdmin, requirePermission } = require('../middleware/requireAdmin');
const { withTrust, locationFreshness } = require('../lib/directory');
const { buildFeed, UPCOMING_WINDOW_MIN } = require('../domain/attention');
const { ACTIVE_STATUSES, STATUS_LABEL } = require('../domain/lifecycle');
const { rideEconomics, round2 } = require('../domain/money');

const router = express.Router();

// Start of the current service day in the operating timezone. "Today" for a
// dispatcher means the local calendar day, not a rolling 24 hours and not UTC
// — a ride at 8pm Eastern must not count toward tomorrow.
// How far `tz` is behind UTC at this instant, in ms. Derived by rendering the
// same instant in both zones and diffing, which handles DST automatically.
function tzOffsetMs(instant, tz) {
  const asUTC = new Date(instant.toLocaleString('en-US', { timeZone: 'UTC' }));
  const asTZ = new Date(instant.toLocaleString('en-US', { timeZone: tz }));
  return asUTC.getTime() - asTZ.getTime();
}

function serviceDayStart(tz) {
  const now = new Date();
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit',
  }).formatToParts(now);
  const get = (t) => Number((parts.find((p) => p.type === t) || {}).value);

  // Treat the local calendar date's midnight as a UTC wall time, then shift it
  // by the zone's offset to get the real instant. Deliberately NOT built with
  // `new Date('YYYY-MM-DDT00:00:00')`, which parses in the SERVER's timezone —
  // that made the result depend on where the API happened to be deployed.
  const midnightAsIfUtc = Date.UTC(get('year'), get('month') - 1, get('day'));
  return new Date(midnightAsIfUtc + tzOffsetMs(now, tz)).toISOString();
}

router.get('/overview', requireAdmin, requirePermission('overview.read'), async (req, res) => {
  try {
    const nowIso = new Date().toISOString();
    const tz = process.env.SERVICE_TZ || 'America/New_York';
    const dayStart = serviceDayStart(tz);
    const horizon = new Date(Date.now() + UPCOMING_WINDOW_MIN * 60_000).toISOString();

    const [liveRes, todayRes, driverRes] = await Promise.all([
      // Everything not yet finished that could need attention: live trips,
      // plus anything unassigned inside the look-ahead window.
      supabase.from('bookings').select('*')
        .in('status', [...ACTIVE_STATUSES, 'confirmed', 'dispatching', 'manual_dispatch_required'])
        .lte('scheduled_at', horizon)
        .order('scheduled_at', { ascending: true })
        .limit(500),
      // Completed today, for the money and volume figures.
      supabase.from('bookings').select('fare, scheduled_at, payment_method, status, completed_at')
        .gte('completed_at', dayStart)
        .eq('status', 'completed')
        .limit(2000),
      supabase.from('drivers').select('*').limit(2000),
    ]);

    for (const r of [liveRes, todayRes, driverRes]) if (r.error) throw r.error;

    const live = liveRes.data || [];
    const drivers = await withTrust(driverRes.data || []);
    const driversById = new Map(drivers.map((d) => [d.id, d]));

    // Attach the driver so the feed can judge location freshness on live trips.
    for (const b of live) b._driver = b.driver_id ? driversById.get(b.driver_id) : null;

    const feed = buildFeed({ bookings: live, drivers, now: nowIso });

    // Live ride counts, by state, in lifecycle order.
    const byStatus = {};
    for (const status of ACTIVE_STATUSES) byStatus[status] = 0;
    for (const b of live) if (byStatus[b.status] !== undefined) byStatus[b.status] += 1;

    // Money for the day. Computed from the same model the driver app pays on,
    // so this never disagrees with what a driver sees in their earnings screen.
    let gross = 0, driverShare = 0, platformShare = 0, cash = 0;
    for (const b of todayRes.data || []) {
      const e = rideEconomics(b);
      gross += e.fare;
      driverShare += e.driverShare;
      platformShare += e.platformShare;
      if (e.paymentMethod === 'cash') cash += e.fare;
    }

    const online = drivers.filter((d) => d.is_online);
    const onTrip = new Set(live.filter((b) => ACTIVE_STATUSES.includes(b.status) && b.driver_id).map((b) => b.driver_id));

    res.json({
      generatedAt: nowIso,
      attention: feed,
      live: {
        byStatus,
        labels: STATUS_LABEL,
        activeTotal: Object.values(byStatus).reduce((a, b) => a + b, 0),
        unassignedUpcoming: live.filter((b) => !b.driver_id).length,
      },
      supply: {
        total: drivers.length,
        online: online.length,
        onTrip: onTrip.size,
        // Online, cleared, and not currently carrying anyone.
        availableNow: online.filter((d) => d.standing.key === 'cleared' && !onTrip.has(d.id)).length,
        locationLive: online.filter((d) => locationFreshness(d).state === 'live').length,
      },
      trust: {
        cleared: drivers.filter((d) => d.standing.key === 'cleared').length,
        unvettedDriving: drivers.filter((d) => d.standing.key === 'unvetted_driving').length,
        awaitingReview: drivers.filter((d) => d.standing.key === 'awaiting_review').length,
        flagged: drivers.filter((d) => d.standing.key === 'screening_consider').length,
        suspended: drivers.filter((d) => d.standing.key === 'suspended').length,
      },
      today: {
        since: dayStart,
        timezone: tz,
        completed: (todayRes.data || []).length,
        gross: round2(gross),
        driverShare: round2(driverShare),
        platformShare: round2(platformShare),
        cashCollected: round2(cash),
      },
    });
  } catch (err) {
    console.error('[overview]', err.message);
    res.status(500).json({ error: 'Could not load the operations overview.' });
  }
});

module.exports = router;

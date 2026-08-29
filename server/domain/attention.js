// The attention engine.
//
// A command center's job is not to display numbers. It is to answer one
// question — "what needs me right now?" — and to be trusted when the answer
// is "nothing". Everything here produces a ranked list of concrete, actionable
// situations, each tied to a specific ride or driver an operator can open.
//
// Rules that keep the list trustworthy:
//  1. Every item is ACTIONABLE. If an operator cannot do anything about it,
//     it is a metric, not an alert, and it belongs on a chart instead.
//  2. Every item names its SUBJECT. No "3 rides are late" without saying
//     which three.
//  3. Severity is the same four-level vocabulary used everywhere else.
//     'critical' means a rider or driver is being harmed right now.
//  4. Thresholds are named constants, tunable per market, never magic
//     numbers buried in a comparison.

const { locationFreshness } = require('../lib/directory');

// --- thresholds ------------------------------------------------------------
// Minutes past the scheduled pickup with still no driver attached. A rider is
// standing outside at this point, so it escalates fast.
const UNASSIGNED_LATE_MIN = 5;
const UNASSIGNED_CRITICAL_MIN = 15;

// Minutes a driver has been marked 'arrived' without starting the trip.
// Usually means they cannot find the rider.
const WAITING_AT_PICKUP_MIN = 10;

// Minutes a trip has run past twice its estimated duration. Usually a driver
// forgot to hit complete; occasionally something is genuinely wrong.
const OVERRUN_FACTOR = 2;
const OVERRUN_FLOOR_MIN = 20;

// How far ahead the board looks for rides that still have no driver.
const UPCOMING_WINDOW_MIN = 90;

function minutesBetween(a, b) {
  return Math.round((new Date(a).getTime() - new Date(b).getTime()) / 60000);
}

function item({ severity, kind, title, detail, subjectType, subjectId, reference, sortKey, action }) {
  return { severity, kind, title, detail, subjectType, subjectId, reference, sortKey, action };
}

// Rides that never got a driver, at or past their pickup time.
function strandedRides(bookings, now) {
  const out = [];
  for (const b of bookings) {
    if (b.driver_id) continue;
    if (!['confirmed', 'dispatching', 'manual_dispatch_required'].includes(b.status)) continue;

    const lateBy = minutesBetween(now, b.scheduled_at);

    if (b.status === 'manual_dispatch_required') {
      out.push(item({
        severity: 'critical',
        kind: 'manual_dispatch',
        title: 'Needs manual dispatch',
        detail: lateBy >= 0
          ? `Automated dispatch gave up. Pickup was ${lateBy} min ago.`
          : `Automated dispatch gave up. Pickup in ${Math.abs(lateBy)} min.`,
        subjectType: 'booking', subjectId: b.id, reference: b.reference,
        sortKey: -lateBy, action: 'assign',
      }));
      continue;
    }

    if (lateBy >= UNASSIGNED_CRITICAL_MIN) {
      out.push(item({
        severity: 'critical', kind: 'stranded',
        title: 'Rider stranded, no driver',
        detail: `${lateBy} min past pickup with no driver assigned.`,
        subjectType: 'booking', subjectId: b.id, reference: b.reference,
        sortKey: -lateBy, action: 'assign',
      }));
    } else if (lateBy >= UNASSIGNED_LATE_MIN) {
      out.push(item({
        severity: 'warn', kind: 'late_unassigned',
        title: 'Past pickup, still unassigned',
        detail: `${lateBy} min past pickup. No driver has claimed it.`,
        subjectType: 'booking', subjectId: b.id, reference: b.reference,
        sortKey: -lateBy, action: 'assign',
      }));
    } else if (lateBy >= -UPCOMING_WINDOW_MIN) {
      out.push(item({
        severity: 'neutral', kind: 'upcoming_unassigned',
        title: 'Upcoming, no driver yet',
        detail: `Pickup in ${Math.abs(lateBy)} min.`,
        subjectType: 'booking', subjectId: b.id, reference: b.reference,
        sortKey: -lateBy, action: 'watch',
      }));
    }
  }
  return out;
}

// Live trips that have stopped behaving normally.
function stalledTrips(bookings, now) {
  const out = [];
  for (const b of bookings) {
    if (b.status === 'arrived' && b.arrived_at) {
      const waiting = minutesBetween(now, b.arrived_at);
      if (waiting >= WAITING_AT_PICKUP_MIN) {
        out.push(item({
          severity: waiting >= WAITING_AT_PICKUP_MIN * 2 ? 'critical' : 'warn',
          kind: 'waiting_at_pickup',
          title: 'Driver waiting at pickup',
          detail: `Arrived ${waiting} min ago and the trip has not started. Rider may be a no-show.`,
          subjectType: 'booking', subjectId: b.id, reference: b.reference,
          sortKey: -waiting, action: 'contact',
        }));
      }
    }

    if (b.status === 'in_progress' && b.started_at) {
      const running = minutesBetween(now, b.started_at);
      const expected = Math.max(Number(b.duration_minutes) || 0, OVERRUN_FLOOR_MIN);
      if (running > expected * OVERRUN_FACTOR) {
        out.push(item({
          severity: 'warn', kind: 'trip_overrun',
          title: 'Trip running long',
          detail: `${running} min elapsed against a ${expected} min estimate. Driver may not have completed it.`,
          subjectType: 'booking', subjectId: b.id, reference: b.reference,
          sortKey: -running, action: 'contact',
        }));
      }
    }

    // A driver is committed to this ride but the console has no recent fix
    // for them, so the live map is showing a guess.
    if (['driver_en_route', 'in_progress'].includes(b.status) && b._driver) {
      const fresh = locationFreshness(b._driver, new Date(now).getTime());
      if (fresh.state === 'stale' || fresh.state === 'never') {
        out.push(item({
          severity: 'warn', kind: 'lost_signal',
          title: 'Lost driver location',
          detail: fresh.state === 'never'
            ? 'No location has ever been reported for this driver.'
            : `Last fix ${Math.round(fresh.ageSeconds / 60)} min ago. Map position is stale.`,
          subjectType: 'booking', subjectId: b.id, reference: b.reference,
          sortKey: -(fresh.ageSeconds || 0) / 60, action: 'contact',
        }));
      }
    }
  }
  return out;
}

// Drivers carrying passengers that nobody vetted. This is a standing
// exposure rather than a momentary incident, so it is summarized as ONE item
// rather than flooding the feed with one per driver.
function trustExposure(decoratedDrivers) {
  const out = [];
  const unvetted = decoratedDrivers.filter((d) => d.standing.key === 'unvetted_driving');
  const flagged = decoratedDrivers.filter((d) => d.standing.key === 'screening_consider');

  if (flagged.length) {
    out.push(item({
      severity: 'critical', kind: 'screening_flagged',
      title: `${flagged.length} driver${flagged.length > 1 ? 's' : ''} flagged by screening`,
      detail: 'A background check came back "consider" and the account is still able to take rides.',
      subjectType: 'driver_group', subjectId: 'screening_consider',
      reference: null, sortKey: -1000, action: 'review',
    }));
  }
  if (unvetted.length) {
    out.push(item({
      severity: 'critical', kind: 'unvetted_drivers',
      title: `${unvetted.length} driver${unvetted.length > 1 ? 's' : ''} driving unvetted`,
      detail: 'Signup auto-activates accounts. These can accept rides but no one has approved them.',
      subjectType: 'driver_group', subjectId: 'unvetted_driving',
      reference: null, sortKey: -999, action: 'review',
    }));
  }
  return out;
}

const SEVERITY_RANK = { critical: 0, warn: 1, active: 2, neutral: 3 };

// Assembles the full feed, most urgent first.
function buildFeed({ bookings = [], drivers = [], now = new Date().toISOString() }) {
  const items = [
    ...trustExposure(drivers),
    ...strandedRides(bookings, now),
    ...stalledTrips(bookings, now),
  ];

  items.sort((a, b) => {
    const sa = SEVERITY_RANK[a.severity] ?? 9;
    const sb = SEVERITY_RANK[b.severity] ?? 9;
    if (sa !== sb) return sa - sb;
    return (a.sortKey ?? 0) - (b.sortKey ?? 0);
  });

  return {
    items,
    counts: {
      critical: items.filter((i) => i.severity === 'critical').length,
      warn: items.filter((i) => i.severity === 'warn').length,
      total: items.length,
    },
  };
}

module.exports = {
  buildFeed,
  strandedRides,
  stalledTrips,
  trustExposure,
  UNASSIGNED_LATE_MIN,
  UNASSIGNED_CRITICAL_MIN,
  WAITING_AT_PICKUP_MIN,
  UPCOMING_WINDOW_MIN,
};

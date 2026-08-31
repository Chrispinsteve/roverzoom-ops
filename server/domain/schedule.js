// Schedule conflicts between a driver's rides.
//
// MIRRORS conflictReason() in roverzoom/backend/routes/driver.js, which is
// what stops a DRIVER self-claiming a ride that collides with one they
// already hold. Same maths, same constants, one deliberate difference:
//
//   The driver app treats a conflict as a HARD REFUSAL.
//   The console treats it as a WARNING an operator can override.
//
// That asymmetry is the point. A driver clicking "claim" on their phone has
// no way to know the rider is a regular who waits, or that two pickups share
// a building, or that someone is covering the gap. A dispatcher does. The
// console's job is to tell them exactly how tight it is and then let them
// decide, not to substitute its arithmetic for their knowledge of the road.
//
// Constants are read from the SAME env vars as the driver backend so the two
// cannot silently disagree about what "too tight" means.
const { haversineMiles } = require('./geo');

const DEADHEAD_MPH = Number(process.env.DEADHEAD_MPH) || 30;
const ROAD_FACTOR = 1.3;
const HANDOFF_BUFFER_MIN = Number(process.env.HANDOFF_BUFFER_MIN) || 10;
const DEFAULT_GAP_MIN = Number(process.env.DEFAULT_GAP_MIN) || 20;
const DEFAULT_DURATION_MIN = 30;

// Rides a driver is already committed to. Matches COMMITTED_STATUSES upstream.
const COMMITTED_STATUSES = ['driver_assigned', 'driver_en_route', 'arrived', 'in_progress'];

function tripWindow(b) {
  const start = new Date(b.scheduled_at).getTime();
  const end = start + (Number(b.duration_minutes) || DEFAULT_DURATION_MIN) * 60000;
  return { start, end };
}

// Minutes to drive between two points, including the handoff buffer. null when
// either end has no coordinates — the caller then falls back to DEFAULT_GAP_MIN.
function deadheadMinutes(aLat, aLng, bLat, bLng) {
  if ([aLat, aLng, bLat, bLng].some((v) => v == null)) return null;
  const miles = haversineMiles(Number(aLat), Number(aLng), Number(bLat), Number(bLng)) * ROAD_FACTOR;
  return (miles / DEADHEAD_MPH) * 60 + HANDOFF_BUFFER_MIN;
}

const clock = (ms, tz) =>
  new Date(ms).toLocaleTimeString('en-US', {
    timeZone: tz || process.env.SERVICE_TZ || 'America/New_York',
    hour: 'numeric', minute: '2-digit',
  });

// Structured rather than a sentence, so the console can rank conflicts, show
// the actual shortfall, and let an operator judge "3 minutes short" against
// "40 minutes short" instead of reading the same red text for both.
function conflict(candidate, existing) {
  const N = tripWindow(candidate);
  const E = tripWindow(existing);

  if (N.start < E.end && E.start < N.end) {
    return {
      kind: 'overlap',
      severity: 'critical',
      existingRef: existing.reference || null,
      existingStart: new Date(E.start).toISOString(),
      shortfallMin: Math.ceil((Math.min(N.end, E.end) - Math.max(N.start, E.start)) / 60000),
      label: `Overlaps their ${clock(E.start)} trip`,
      detail: `The two rides run at the same time (${clock(E.start)}–${clock(E.end)}). One driver cannot be on both.`,
    };
  }

  const after = E.end <= N.start;
  const need = after
    ? deadheadMinutes(existing.dropoff_lat, existing.dropoff_lng, candidate.pickup_lat, candidate.pickup_lng)
    : deadheadMinutes(candidate.dropoff_lat, candidate.dropoff_lng, existing.pickup_lat, existing.pickup_lng);

  const gapMs = after ? N.start - E.end : E.start - N.end;
  const gap = gapMs / 60000;
  const required = need == null ? DEFAULT_GAP_MIN : need;

  if (gap < required) {
    const short = Math.ceil(required - gap);
    return {
      kind: 'tight',
      // A few minutes short is a judgement call; half an hour short is not.
      severity: short > 15 ? 'critical' : 'warn',
      existingRef: existing.reference || null,
      existingStart: new Date(E.start).toISOString(),
      gapMin: Math.floor(gap),
      requiredMin: Math.ceil(required),
      shortfallMin: short,
      estimated: need == null,
      label: `${short} min short ${after ? 'after' : 'before'} their ${clock(E.start)} trip`,
      detail: after
        ? `They finish at ${clock(E.end)} and need about ${Math.ceil(required)} min to reach this pickup, but only have ${Math.floor(gap)} min.`
        : `This ride ends at ${clock(N.end)} and they need about ${Math.ceil(required)} min to reach their ${clock(E.start)} pickup, but only have ${Math.floor(gap)} min.`,
    };
  }

  return null;
}

// Every conflict between one candidate ride and a driver's existing commitments,
// worst first.
function conflictsFor(candidateRide, committedRides) {
  const found = [];
  for (const existing of committedRides || []) {
    if (existing.id === candidateRide.id) continue;
    const c = conflict(candidateRide, existing);
    if (c) found.push(c);
  }
  return found.sort((a, b) => {
    if (a.severity !== b.severity) return a.severity === 'critical' ? -1 : 1;
    return (b.shortfallMin || 0) - (a.shortfallMin || 0);
  });
}

module.exports = {
  COMMITTED_STATUSES, DEFAULT_DURATION_MIN,
  tripWindow, deadheadMinutes, conflict, conflictsFor,
};

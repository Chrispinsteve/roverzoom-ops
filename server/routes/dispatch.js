// Manual dispatch: the board of rides no driver has taken, and the controls
// to put one on them.
//
// This closes a real hole. `manual_dispatch_required` is a legal booking
// status in the live schema, but nothing in the rider or driver app can see
// or resolve it — a ride that lands there is invisible until a rider calls.
const express = require('express');
const { supabase } = require('../lib/supabase');
const { requireAdmin, requirePermission } = require('../middleware/requireAdmin');
const { can } = require('../lib/roles');
const { auditor } = require('../lib/audit');
const { riderContact } = require('../lib/redact');
const { withTrust, locationFreshness, invalidate } = require('../lib/directory');
const { haversineMiles, roughMinutesAway } = require('../domain/geo');
const { UNASSIGNED_STATUSES, ACTIVE_STATUSES, STATUS_LABEL, STATUS_SEVERITY } = require('../domain/lifecycle');
const { conflictsFor, COMMITTED_STATUSES } = require('../domain/schedule');

const router = express.Router();

// How far out the board looks. Anything further away is not yet a dispatch
// problem and would only add noise.
const BOARD_HORIZON_MIN = Number(process.env.DISPATCH_HORIZON_MIN) || 180;

// A candidate more than this far from the pickup is not a realistic option.
const MAX_CANDIDATE_MILES = Number(process.env.DISPATCH_MAX_MILES) || 40;

// Ranks drivers for one pickup. Ordering is deliberate and explained in the
// payload so an operator can see WHY the console suggested someone — an
// unexplained ranking is one an operator learns to ignore.
function rankCandidates(drivers, pickup, busyDriverIds, commitments = new Map(), ride = null) {
  const hasPickup = pickup.lat != null && pickup.lng != null;

  return drivers
    .map((d) => {
      const fresh = locationFreshness(d);
      const hasFix = d.current_lat != null && d.current_lng != null;
      const miles = (hasPickup && hasFix)
        ? haversineMiles(Number(pickup.lat), Number(pickup.lng), Number(d.current_lat), Number(d.current_lng))
        : null;

      const blockers = [];
      if (d.standing.key === 'suspended') blockers.push('Account suspended');
      if (!d.trust.accountActive) blockers.push('Account not active');
      if (!d.trust.documentsComplete) blockers.push('Documents incomplete');
      // NOT a blocker: a driver mid-trip may still be the right person for a
      // ride hours from now. The schedule check below is what judges that.
      if (busyDriverIds.has(d.id) && !ride) blockers.push('Already on a trip');

      // Schedule conflicts are WARNINGS here, never blockers. The driver app
      // refuses these outright, which is right for a driver self-claiming on
      // their phone; a dispatcher may know the gap is coverable and is
      // allowed to say so. See domain/schedule.js.
      const conflicts = ride ? conflictsFor(ride, commitments.get(d.id) || []) : [];

      const warnings = [];
      for (const c of conflicts) warnings.push(c.label);
      if (!d.trust.humanApproved) warnings.push('Never reviewed');
      if (!d.trust.screeningClear) warnings.push(`Screening: ${d.trust.screening.status.replace('_', ' ')}`);
      if (!d.is_online) warnings.push('Offline');
      if (fresh.state === 'stale') warnings.push(`Location ${Math.round(fresh.ageSeconds / 60)} min old`);
      if (fresh.state === 'never') warnings.push('No location ever reported');

      return {
        id: d.id,
        name: d.name,
        phone: d.phone,
        rating: d.rating,
        rides_completed: d.rides_completed,
        vehicle: [d.vehicle_color, d.vehicle_make, d.vehicle_model].filter(Boolean).join(' ') || null,
        plate: d.vehicle_plate,
        is_online: d.is_online,
        standing: d.standing,
        locationFreshness: fresh,
        milesAway: miles == null ? null : Math.round(miles * 10) / 10,
        minutesAway: miles == null ? null : roughMinutesAway(miles),
        distanceIsStraightLine: true,
        eligible: blockers.length === 0,
        blockers,
        warnings,
        // Structured, so the console can show the actual shortfall rather
        // than the same red text for "3 minutes short" and "40 minutes short".
        conflicts,
        worstConflict: conflicts[0] || null,
      };
    })
    .filter((c) => c.milesAway == null || c.milesAway <= MAX_CANDIDATE_MILES)
    .sort((a, b) => {
      // 1. Anyone who can actually be assigned comes first.
      if (a.eligible !== b.eligible) return a.eligible ? -1 : 1;
      // 2. Then fully-cleared drivers over unvetted ones — the console should
      //    never nudge an operator toward an unvetted driver by default.
      const av = a.standing.key === 'cleared' ? 0 : 1;
      const bv = b.standing.key === 'cleared' ? 0 : 1;
      if (av !== bv) return av - bv;
      // 3. Then drivers whose schedule actually fits, so the default choice
      //    is never one an operator has to override.
      const ac = a.conflicts.length ? (a.worstConflict.severity === 'critical' ? 2 : 1) : 0;
      const bc = b.conflicts.length ? (b.worstConflict.severity === 'critical' ? 2 : 1) : 0;
      if (ac !== bc) return ac - bc;
      // 4. Then online over offline.
      if (a.is_online !== b.is_online) return a.is_online ? -1 : 1;
      // 5. Then nearest, with unknown distance last.
      if (a.milesAway == null) return 1;
      if (b.milesAway == null) return -1;
      return a.milesAway - b.milesAway;
    });
}

// Every ride each driver is already committed to, keyed by driver. One query
// rather than one per candidate.
async function commitmentsByDriver() {
  const { data } = await supabase
    .from('bookings')
    .select('id, reference, driver_id, scheduled_at, duration_minutes, pickup_lat, pickup_lng, dropoff_lat, dropoff_lng')
    .in('status', COMMITTED_STATUSES)
    .not('driver_id', 'is', null);
  const byDriver = new Map();
  for (const b of data || []) {
    if (!byDriver.has(b.driver_id)) byDriver.set(b.driver_id, []);
    byDriver.get(b.driver_id).push(b);
  }
  return byDriver;
}

// Drivers currently committed to a live trip.
async function busyDrivers() {
  const { data } = await supabase.from('bookings').select('driver_id').in('status', ACTIVE_STATUSES).not('driver_id', 'is', null);
  return new Set((data || []).map((b) => b.driver_id));
}

// GET /api/admin/dispatch/board
router.get('/dispatch/board', requireAdmin, requirePermission('dispatch.read'), async (req, res) => {
  try {
    const canSeePii = can(req.admin.role, 'riders.pii');
    const horizon = new Date(Date.now() + BOARD_HORIZON_MIN * 60_000).toISOString();

    const { data: bookings, error } = await supabase
      .from('bookings').select('*')
      .in('status', UNASSIGNED_STATUSES)
      .is('driver_id', null)
      .lte('scheduled_at', horizon)
      .order('scheduled_at', { ascending: true })
      .limit(200);
    if (error) throw error;

    const now = Date.now();
    const rows = (bookings || []).map((b) => {
      const minutesToPickup = Math.round((new Date(b.scheduled_at).getTime() - now) / 60000);
      return {
        id: b.id,
        reference: b.reference,
        status: b.status,
        statusLabel: STATUS_LABEL[b.status] || b.status,
        severity: STATUS_SEVERITY[b.status] || 'neutral',
        scheduled_at: b.scheduled_at,
        minutesToPickup,
        overdue: minutesToPickup < 0,
        pickup_address: b.pickup_address,
        dropoff_address: b.dropoff_address,
        pickup_lat: b.pickup_lat, pickup_lng: b.pickup_lng,
        fare: b.fare,
        distance_miles: b.distance_miles,
        duration_minutes: b.duration_minutes,
        dispatch_round: b.dispatch_round,
        dispatched_at: b.dispatched_at,
        payment_method: b.payment_method,
        ...riderContact(b, canSeePii),
      };
    });

    res.json({
      generatedAt: new Date().toISOString(),
      horizonMinutes: BOARD_HORIZON_MIN,
      rides: rows,
      counts: {
        total: rows.length,
        needsDispatch: rows.filter((r) => r.status === 'manual_dispatch_required').length,
        overdue: rows.filter((r) => r.overdue).length,
      },
    });
  } catch (err) {
    console.error('[dispatch:board]', err.message);
    res.status(500).json({ error: 'Could not load the dispatch board.' });
  }
});

// GET /api/admin/dispatch/:bookingId/candidates
router.get('/dispatch/:bookingId/candidates', requireAdmin, requirePermission('dispatch.read'), async (req, res) => {
  try {
    const { data: booking, error } = await supabase
      .from('bookings').select('id, reference, pickup_lat, pickup_lng, pickup_address, scheduled_at, status, driver_id')
      .eq('id', req.params.bookingId).maybeSingle();
    if (error) throw error;
    if (!booking) return res.status(404).json({ error: 'Ride not found.' });

    const [{ data: drivers, error: dErr }, busy, commitments] = await Promise.all([
      supabase.from('drivers').select('*').limit(2000),
      busyDrivers(),
      commitmentsByDriver(),
    ]);
    if (dErr) throw dErr;

    const decorated = await withTrust(drivers || []);
    const candidates = rankCandidates(decorated, booking, busy, commitments, booking);

    res.json({
      booking: {
        id: booking.id, reference: booking.reference, status: booking.status,
        pickup_address: booking.pickup_address, scheduled_at: booking.scheduled_at,
        hasCoordinates: booking.pickup_lat != null && booking.pickup_lng != null,
      },
      candidates: candidates.slice(0, 50),
      eligibleCount: candidates.filter((c) => c.eligible).length,
      clearCount: candidates.filter((c) => c.eligible && c.conflicts.length === 0).length,
      maxMiles: MAX_CANDIDATE_MILES,
    });
  } catch (err) {
    console.error('[dispatch:candidates]', err.message);
    res.status(500).json({ error: 'Could not load driver candidates.' });
  }
});

// POST /api/admin/dispatch/:bookingId/assign  { driverId, acknowledgeWarnings? }
router.post('/dispatch/:bookingId/assign', requireAdmin, requirePermission('dispatch.assign'), async (req, res) => {
  const audit = auditor(req);
  const { driverId, acknowledgeWarnings } = req.body || {};
  if (!driverId) return res.status(422).json({ error: 'A driver is required.', code: 'driver_required' });

  try {
    const [{ data: booking }, { data: driverRow }] = await Promise.all([
      supabase.from('bookings').select('*').eq('id', req.params.bookingId).maybeSingle(),
      supabase.from('drivers').select('*').eq('id', driverId).maybeSingle(),
    ]);
    if (!booking) return res.status(404).json({ error: 'Ride not found.' });
    if (!driverRow) return res.status(404).json({ error: 'Driver not found.' });
    if (booking.driver_id) {
      return res.status(409).json({ error: 'This ride already has a driver. Release it first.', code: 'already_assigned' });
    }
    if (!UNASSIGNED_STATUSES.includes(booking.status)) {
      return res.status(409).json({ error: `A ride that is "${STATUS_LABEL[booking.status]}" cannot be assigned.`, code: 'bad_status' });
    }

    const [decorated] = await withTrust([driverRow]);
    const [busy, commitments] = await Promise.all([busyDrivers(), commitmentsByDriver()]);
    const [candidate] = rankCandidates([decorated], booking, busy, commitments, booking);

    // Hard blockers are never overridable from the console. Assigning a
    // suspended or document-incomplete driver would put someone in a car the
    // platform has actively decided should not be carrying passengers.
    if (!candidate || !candidate.eligible) {
      return res.status(422).json({
        error: `${driverRow.name} cannot take this ride.`,
        code: 'driver_ineligible',
        blockers: candidate ? candidate.blockers : ['Driver is out of range'],
      });
    }

    // Soft warnings (never reviewed, offline, stale location) ARE overridable,
    // but only deliberately: the client must echo them back. This keeps an
    // operator from assigning an unvetted driver by reflex during a rush,
    // while still allowing it when they genuinely have no one else.
    if (candidate.warnings.length && !acknowledgeWarnings) {
      return res.status(409).json({
        error: `${driverRow.name} can take this ride, but not without a look first.`,
        code: 'warnings_unacknowledged',
        warnings: candidate.warnings,
      });
    }

    // Guarded exactly like accept_ride_offer(): only claim a booking that
    // still has no driver, so a driver self-claiming at the same instant
    // cannot be silently overwritten.
    const { data: updated, error: upErr } = await supabase
      .from('bookings')
      .update({
        driver_id: driverId,
        status: 'driver_assigned',
        accepted_at: new Date().toISOString(),
      })
      .eq('id', booking.id)
      .is('driver_id', null)
      .select()
      .maybeSingle();
    if (upErr) throw upErr;
    if (!updated) {
      return res.status(409).json({
        error: 'A driver claimed this ride while you were assigning it.',
        code: 'race_lost',
      });
    }

    // Retire any offers still outstanding for this booking, mirroring what
    // accept_ride_offer() does, so a driver cannot accept an offer for a ride
    // that has just been assigned by hand.
    await supabase.from('ride_offers')
      .update({ status: 'superseded' })
      .eq('booking_id', booking.id)
      .eq('status', 'pending');

    await audit({
      action: 'dispatch.assign', subjectType: 'booking', subjectId: booking.id,
      summary: `Assigned ${booking.reference} to ${driverRow.name}`,
      detail: {
        driver_id: driverId, driver_name: driverRow.name,
        from_status: booking.status,
        warningsAcknowledged: candidate.warnings,
        // Recorded explicitly: "who overrode a schedule conflict, on which
        // ride" is the question that gets asked after a rider is left waiting.
        scheduleConflicts: candidate.conflicts,
        milesAway: candidate.milesAway,
      },
    });

    res.json({
      ride: { id: updated.id, reference: updated.reference, status: updated.status, driver_id: updated.driver_id },
      driver: { id: driverRow.id, name: driverRow.name },
    });
  } catch (err) {
    console.error('[dispatch:assign]', err.message);
    res.status(500).json({ error: 'Could not assign the ride.' });
  }
});

// POST /api/admin/dispatch/:bookingId/release  { reason }
// Detaches a driver and puts the ride back where a human can see it.
router.post('/dispatch/:bookingId/release', requireAdmin, requirePermission('rides.reassign'), async (req, res) => {
  const audit = auditor(req);
  const { reason } = req.body || {};
  if (!reason || !String(reason).trim()) {
    return res.status(422).json({ error: 'A reason is required to release a ride.', code: 'reason_required' });
  }

  try {
    const { data: booking } = await supabase
      .from('bookings').select('*').eq('id', req.params.bookingId).maybeSingle();
    if (!booking) return res.status(404).json({ error: 'Ride not found.' });
    if (!booking.driver_id) return res.status(409).json({ error: 'This ride has no driver to release.', code: 'not_assigned' });

    // A trip already underway is not released — the rider is in the car.
    // Releasing would strand them with no assigned driver and no record of who
    // they are actually with. Cancel it explicitly instead.
    if (['in_progress', 'completed', 'canceled'].includes(booking.status)) {
      return res.status(409).json({
        error: `A ride that is "${STATUS_LABEL[booking.status]}" cannot be released.`,
        code: 'bad_status',
      });
    }

    const previousDriver = booking.driver_id;

    // Back to manual_dispatch_required, not 'confirmed': a ride a human had to
    // pull off a driver should land in front of a human, not silently rejoin
    // the automated pool that already failed to place it well.
    const { data: updated, error } = await supabase
      .from('bookings')
      .update({
        driver_id: null,
        status: 'manual_dispatch_required',
        accepted_at: null,
        en_route_at: null,
        arrived_at: null,
      })
      .eq('id', booking.id)
      .eq('driver_id', previousDriver)
      .select()
      .maybeSingle();
    if (error) throw error;
    if (!updated) {
      return res.status(409).json({ error: 'The ride changed while you were releasing it.', code: 'stale_state' });
    }

    await audit({
      action: 'dispatch.release', subjectType: 'booking', subjectId: booking.id,
      summary: `Released ${booking.reference} from its driver`,
      detail: { previous_driver_id: previousDriver, from_status: booking.status, reason: String(reason).trim() },
    });

    invalidate();
    res.json({ ride: { id: updated.id, reference: updated.reference, status: updated.status } });
  } catch (err) {
    console.error('[dispatch:release]', err.message);
    res.status(500).json({ error: 'Could not release the ride.' });
  }
});

module.exports = router;

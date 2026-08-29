// Ride ledger: search, inspect, cancel.
const express = require('express');
const { supabase } = require('../lib/supabase');
const { requireAdmin, requirePermission } = require('../middleware/requireAdmin');
const { can } = require('../lib/roles');
const { auditor } = require('../lib/audit');
const { riderContact } = require('../lib/redact');
const { getDriverWithTrust } = require('../lib/directory');
const {
  RIDE_STATUSES, STATUS_LABEL, STATUS_SEVERITY, ACTIVE_STATUSES,
  UNASSIGNED_STATUSES, isCancelable, buildTimeline,
} = require('../domain/lifecycle');
const { rideEconomics } = require('../domain/money');

const router = express.Router();

const MAX_LIMIT = 200;

// Shapes one booking for a list row. Rider PII is redacted here, at the
// serialization boundary, so a role without 'riders.pii' never receives it.
function toRow(booking, canSeePii, driverName) {
  return {
    id: booking.id,
    reference: booking.reference,
    status: booking.status,
    statusLabel: STATUS_LABEL[booking.status] || booking.status,
    severity: STATUS_SEVERITY[booking.status] || 'neutral',
    scheduled_at: booking.scheduled_at,
    created_at: booking.created_at,
    completed_at: booking.completed_at,
    pickup_address: booking.pickup_address,
    dropoff_address: booking.dropoff_address,
    distance_miles: booking.distance_miles,
    duration_minutes: booking.duration_minutes,
    fare: booking.fare,
    payment_method: booking.payment_method,
    payment_status: booking.payment_status,
    source: booking.source,
    driver_id: booking.driver_id,
    driver_name: driverName || null,
    ...riderContact(booking, canSeePii),
  };
}

// GET /api/admin/rides — the searchable ledger.
router.get('/rides', requireAdmin, requirePermission('rides.read'), async (req, res) => {
  try {
    const canSeePii = can(req.admin.role, 'riders.pii');
    const limit = Math.min(Number(req.query.limit) || 50, MAX_LIMIT);
    const offset = Number(req.query.offset) || 0;

    let query = supabase.from('bookings').select('*', { count: 'exact' });

    // `group` is the operator's mental model — "what's live", "what's stuck" —
    // rather than making them remember which statuses make up each set.
    const group = req.query.group;
    if (group === 'live') query = query.in('status', ACTIVE_STATUSES);
    else if (group === 'unassigned') query = query.in('status', UNASSIGNED_STATUSES).is('driver_id', null);
    else if (group === 'needs_dispatch') query = query.eq('status', 'manual_dispatch_required');
    else if (group === 'completed') query = query.eq('status', 'completed');
    else if (group === 'canceled') query = query.eq('status', 'canceled');

    if (req.query.status && RIDE_STATUSES.includes(req.query.status)) {
      query = query.eq('status', req.query.status);
    }
    if (req.query.driverId) query = query.eq('driver_id', req.query.driverId);
    if (req.query.from) query = query.gte('scheduled_at', req.query.from);
    if (req.query.to) query = query.lte('scheduled_at', req.query.to);

    // Free-text search. Reference codes are what riders and drivers read out
    // loud, so an exact-ish reference match is the common case; addresses are
    // the fallback. Rider name/phone are searchable ONLY for roles allowed to
    // see them — otherwise search would become a PII oracle, letting a viewer
    // confirm a phone number by watching the result count change.
    const q = (req.query.q || '').trim();
    if (q) {
      const safe = q.replace(/[%,()]/g, ' ');
      const clauses = [
        `reference.ilike.%${safe}%`,
        `pickup_address.ilike.%${safe}%`,
        `dropoff_address.ilike.%${safe}%`,
      ];
      if (canSeePii) {
        clauses.push(`rider_name.ilike.%${safe}%`, `rider_phone.ilike.%${safe}%`, `rider_email.ilike.%${safe}%`);
      }
      query = query.or(clauses.join(','));
    }

    const sortDesc = req.query.sort !== 'asc';
    query = query.order('scheduled_at', { ascending: !sortDesc }).range(offset, offset + limit - 1);

    const { data, error, count } = await query;
    if (error) throw error;

    // Resolve driver names in one query rather than per row.
    const driverIds = [...new Set((data || []).map((b) => b.driver_id).filter(Boolean))];
    const names = new Map();
    if (driverIds.length) {
      const { data: ds } = await supabase.from('drivers').select('id, name').in('id', driverIds);
      for (const d of ds || []) names.set(d.id, d.name);
    }

    res.json({
      rides: (data || []).map((b) => toRow(b, canSeePii, names.get(b.driver_id))),
      total: count ?? null,
      limit,
      offset,
      piiRedacted: !canSeePii,
    });
  } catch (err) {
    console.error('[rides:list]', err.message);
    res.status(500).json({ error: 'Could not load rides.' });
  }
});

// GET /api/admin/rides/:id — one ride, with its full lifecycle and economics.
// Accepts either a UUID or a human reference like RZ-8F3K2, because that is
// what a rider reads out over the phone.
router.get('/rides/:id', requireAdmin, requirePermission('rides.read'), async (req, res) => {
  try {
    const canSeePii = can(req.admin.role, 'riders.pii');
    const key = req.params.id;
    const isUuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(key);

    const { data: booking, error } = await supabase
      .from('bookings').select('*')
      .eq(isUuid ? 'id' : 'reference', isUuid ? key : key.toUpperCase())
      .maybeSingle();
    if (error) throw error;
    if (!booking) return res.status(404).json({ error: 'Ride not found.' });

    let driver = null;
    if (booking.driver_id) {
      const d = await getDriverWithTrust(booking.driver_id);
      if (d) {
        delete d._authUser;
        driver = d;
      }
    }

    // The dispatch history: who was offered this ride, and what happened.
    // This is the only way to answer "why did nobody take it?".
    const { data: offers } = await supabase
      .from('ride_offers')
      .select('id, driver_id, round, status, offered_at, responded_at, expires_at')
      .eq('booking_id', booking.id)
      .order('offered_at', { ascending: true });

    const offerDriverIds = [...new Set((offers || []).map((o) => o.driver_id))];
    const offerNames = new Map();
    if (offerDriverIds.length) {
      const { data: ds } = await supabase.from('drivers').select('id, name').in('id', offerDriverIds);
      for (const d of ds || []) offerNames.set(d.id, d.name);
    }

    res.json({
      ride: {
        ...toRow(booking, canSeePii, driver && driver.name),
        pickup_lat: booking.pickup_lat, pickup_lng: booking.pickup_lng,
        dropoff_lat: booking.dropoff_lat, dropoff_lng: booking.dropoff_lng,
        dispatch_round: booking.dispatch_round,
        canceled_by: booking.canceled_by,
        cancel_reason: booking.cancel_reason,
        driver_rating_of_rider: booking.driver_rating_of_rider,
      },
      timeline: buildTimeline(booking),
      economics: can(req.admin.role, 'finance.read') ? rideEconomics(booking) : null,
      driver,
      offers: (offers || []).map((o) => ({ ...o, driver_name: offerNames.get(o.driver_id) || null })),
      actions: {
        cancelable: isCancelable(booking.status) && can(req.admin.role, 'rides.cancel'),
        reassignable: Boolean(booking.driver_id) && can(req.admin.role, 'rides.reassign')
          && !['completed', 'canceled'].includes(booking.status),
        assignable: !booking.driver_id && can(req.admin.role, 'dispatch.assign')
          && UNASSIGNED_STATUSES.includes(booking.status),
      },
    });
  } catch (err) {
    console.error('[rides:get]', err.message);
    res.status(500).json({ error: 'Could not load the ride.' });
  }
});

// POST /api/admin/rides/:id/cancel
router.post('/rides/:id/cancel', requireAdmin, requirePermission('rides.cancel'), async (req, res) => {
  const audit = auditor(req);
  const { reason, onBehalfOf } = req.body || {};

  if (!reason || !String(reason).trim()) {
    return res.status(422).json({ error: 'A cancellation reason is required.', code: 'reason_required' });
  }

  try {
    const { data: before, error: readErr } = await supabase
      .from('bookings').select('*').eq('id', req.params.id).maybeSingle();
    if (readErr) throw readErr;
    if (!before) return res.status(404).json({ error: 'Ride not found.' });
    if (!isCancelable(before.status)) {
      return res.status(409).json({
        error: `A ride that is "${STATUS_LABEL[before.status] || before.status}" cannot be canceled.`,
        code: 'not_cancelable',
      });
    }

    // bookings_canceled_by_check only permits rider | driver | system, so an
    // admin cancellation is recorded as 'system'. WHO actually did it lives in
    // the audit trail and in the reason text — adding an 'admin' value would
    // need DDL on the live bookings table.
    const attributedTo = ['rider', 'driver'].includes(onBehalfOf) ? onBehalfOf : 'system';
    const reasonText = `${String(reason).trim()} — canceled in console by ${req.admin.email}`;

    // Guarded on the status we just read, so a ride that changed underneath us
    // (a driver hitting "start" at the same moment) fails instead of silently
    // canceling a trip already in progress.
    const { data: after, error } = await supabase
      .from('bookings')
      .update({
        status: 'canceled',
        canceled_at: new Date().toISOString(),
        canceled_by: attributedTo,
        cancel_reason: reasonText,
      })
      .eq('id', req.params.id)
      .eq('status', before.status)
      .select()
      .maybeSingle();
    if (error) throw error;
    if (!after) {
      return res.status(409).json({
        error: 'The ride changed while you were canceling it. Reload and try again.',
        code: 'stale_state',
      });
    }

    await audit({
      action: 'ride.cancel', subjectType: 'booking', subjectId: after.id,
      summary: `Canceled ${after.reference} (was ${before.status})`,
      detail: { from: before.status, reason: reasonText, attributedTo, driver_id: before.driver_id },
    });

    res.json({ ride: { id: after.id, reference: after.reference, status: after.status } });
  } catch (err) {
    console.error('[rides:cancel]', err.message);
    res.status(500).json({ error: 'Could not cancel the ride.' });
  }
});

module.exports = router;

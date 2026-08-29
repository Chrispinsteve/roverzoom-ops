// Driver roster and the trust queue.
const express = require('express');
const { supabase } = require('../lib/supabase');
const { requireAdmin, requirePermission } = require('../middleware/requireAdmin');
const { can } = require('../lib/roles');
const { auditor } = require('../lib/audit');
const { withTrust, sortByUrgency, getDriverWithTrust, locationFreshness, invalidate } = require('../lib/directory');
const { REVIEW_META_KEY, STANDING_PRIORITY } = require('../domain/trust');
const { summarizeEarnings } = require('../domain/money');
const { resolveForDriver, presenceForDriver } = require('../lib/documents');
const { ACTIVE_STATUSES, STATUS_LABEL } = require('../domain/lifecycle');

const router = express.Router();

function publicDriver(d) {
  const { _authUser, ...rest } = d;
  return {
    ...rest,
    vehicle: [d.vehicle_color, d.vehicle_make, d.vehicle_model].filter(Boolean).join(' ') || null,
    locationFreshness: locationFreshness(d),
  };
}

// GET /api/admin/drivers
router.get('/drivers', requireAdmin, requirePermission('drivers.read'), async (req, res) => {
  try {
    const { data, error } = await supabase.from('drivers').select('*').limit(2000);
    if (error) throw error;

    let decorated = await withTrust(data || []);

    const standing = req.query.standing;
    if (standing) decorated = decorated.filter((d) => d.standing.key === standing);

    if (req.query.online === 'true') decorated = decorated.filter((d) => d.is_online);

    const q = (req.query.q || '').trim().toLowerCase();
    if (q) {
      decorated = decorated.filter((d) =>
        [d.name, d.phone, d.email, d.vehicle_plate].some((v) => v && String(v).toLowerCase().includes(q))
      );
    }

    // Counts are computed BEFORE the standing filter is applied so the filter
    // chips can show their own totals without a second request.
    const all = await withTrust(data || []);
    const counts = {};
    for (const key of Object.keys(STANDING_PRIORITY)) counts[key] = 0;
    for (const d of all) counts[d.standing.key] = (counts[d.standing.key] || 0) + 1;

    res.json({
      drivers: sortByUrgency(decorated).map(publicDriver),
      counts,
      total: all.length,
    });
  } catch (err) {
    console.error('[drivers:list]', err.message);
    res.status(500).json({ error: 'Could not load drivers.' });
  }
});

// GET /api/admin/drivers/:id — the full dossier behind a vetting decision.
router.get('/drivers/:id', requireAdmin, requirePermission('drivers.read'), async (req, res) => {
  try {
    const driver = await getDriverWithTrust(req.params.id);
    if (!driver) return res.status(404).json({ error: 'Driver not found.' });

    const [ridesRes, earningsRes] = await Promise.all([
      supabase.from('bookings')
        .select('id, reference, status, scheduled_at, completed_at, fare, pickup_address, dropoff_address, payment_method, driver_rating_of_rider')
        .eq('driver_id', driver.id)
        .order('scheduled_at', { ascending: false })
        .limit(50),
      can(req.admin.role, 'finance.read')
        ? supabase.from('driver_earnings').select('*').eq('driver_id', driver.id).order('created_at', { ascending: false }).limit(500)
        : Promise.resolve({ data: null }),
    ]);

    const rides = (ridesRes.data || []).map((r) => ({
      ...r, statusLabel: STATUS_LABEL[r.status] || r.status,
    }));

    res.json({
      driver: publicDriver(driver),
      // Presence only. The licence and insurance columns hold RAW STORAGE
      // PATHS into a private bucket, which are useless to a browser and must
      // not be handed out regardless — the viewable, signed URLs come from
      // GET /drivers/:id/documents, which is separately permissioned and
      // audited.
      documents: {
        items: presenceForDriver(driver),
        completedAt: driver.profile_completed_at,
        viewable: can(req.admin.role, 'drivers.documents'),
      },
      activity: {
        rides,
        liveRide: rides.find((r) => ACTIVE_STATUSES.includes(r.status)) || null,
        completedCount: driver.rides_completed,
      },
      earnings: earningsRes.data ? summarizeEarnings(earningsRes.data) : null,
      actions: {
        canReview: can(req.admin.role, 'drivers.review'),
        canSuspend: can(req.admin.role, 'drivers.suspend'),
        canViewDocuments: can(req.admin.role, 'drivers.documents'),
      },
    });
  } catch (err) {
    console.error('[drivers:get]', err.message);
    res.status(500).json({ error: 'Could not load the driver.' });
  }
});

// GET /api/admin/drivers/:id/documents
//
// Mints short-lived signed URLs for a driver's identity documents so a
// reviewer can actually look at them. Separately permissioned from
// drivers.read, and every call is audited: "who looked at this person's
// licence, and when" is a question worth being able to answer.
router.get('/drivers/:id/documents', requireAdmin, requirePermission('drivers.documents'), async (req, res) => {
  const audit = auditor(req);
  try {
    const driver = await getDriverWithTrust(req.params.id);
    if (!driver) return res.status(404).json({ error: 'Driver not found.' });

    const resolved = await resolveForDriver(driver);

    // Audited BEFORE the URLs are returned, so a crash between the two can
    // never produce an unrecorded disclosure.
    await audit({
      action: 'driver.documents_viewed',
      subjectType: 'driver',
      subjectId: driver.id,
      summary: `Viewed identity documents for ${driver.name}`,
      detail: {
        types: resolved.documents.filter((d) => d.present).map((d) => d.type),
        unreachable: resolved.documents.filter((d) => d.kind === 'unreachable').map((d) => d.type),
      },
    });

    res.json(resolved);
  } catch (err) {
    console.error('[drivers:documents]', err.message);
    res.status(500).json({ error: 'Could not load the driver documents.' });
  }
});

// Writes a review decision into the driver's Auth app_metadata. Read-modify-
// write so it never clobbers the Checkr keys screening.js keeps alongside it.
async function writeReview(authUserId, review) {
  const { data, error: getErr } = await supabase.auth.admin.getUserById(authUserId);
  if (getErr) throw getErr;
  const app_metadata = { ...((data && data.user && data.user.app_metadata) || {}) };
  app_metadata[REVIEW_META_KEY] = review;
  const { error } = await supabase.auth.admin.updateUserById(authUserId, { app_metadata });
  if (error) throw error;
}

// POST /api/admin/drivers/:id/review  { decision: 'approved'|'rejected', note }
router.post('/drivers/:id/review', requireAdmin, requirePermission('drivers.review'), async (req, res) => {
  const audit = auditor(req);
  const { decision, note } = req.body || {};

  if (!['approved', 'rejected'].includes(decision)) {
    return res.status(422).json({ error: 'Decision must be "approved" or "rejected".', code: 'bad_decision' });
  }
  // Rejecting someone takes away their livelihood. It must carry a reason a
  // person can read back months later.
  if (decision === 'rejected' && !(note && String(note).trim())) {
    return res.status(422).json({ error: 'A note is required when rejecting a driver.', code: 'note_required' });
  }

  try {
    const driver = await getDriverWithTrust(req.params.id);
    if (!driver) return res.status(404).json({ error: 'Driver not found.' });
    if (!driver.auth_user_id) {
      return res.status(409).json({
        error: 'This driver has no linked account, so a review cannot be recorded against them.',
        code: 'no_auth_user',
      });
    }

    const review = {
      state: decision,
      by: req.admin.email,
      at: new Date().toISOString(),
      note: note ? String(note).trim() : null,
    };
    await writeReview(driver.auth_user_id, review);

    // A rejection must also stop them driving. Recording the decision without
    // changing drivers.status would leave a rejected driver still able to
    // accept rides — the exact gap this console exists to close.
    let statusChanged = null;
    if (decision === 'rejected' && driver.status !== 'suspended') {
      const { error } = await supabase.from('drivers').update({ status: 'suspended', is_online: false }).eq('id', driver.id);
      if (error) throw error;
      statusChanged = { from: driver.status, to: 'suspended' };
    }
    // Approving someone who was left pending activates them.
    if (decision === 'approved' && driver.status === 'pending_verification') {
      const { error } = await supabase.from('drivers').update({ status: 'active' }).eq('id', driver.id);
      if (error) throw error;
      statusChanged = { from: driver.status, to: 'active' };
    }

    await audit({
      action: `driver.${decision}`, subjectType: 'driver', subjectId: driver.id,
      summary: `${decision === 'approved' ? 'Approved' : 'Rejected'} ${driver.name}`,
      detail: { note: review.note, statusChanged, previousStanding: driver.standing.key },
    });

    invalidate();
    const updated = await getDriverWithTrust(driver.id);
    res.json({ driver: publicDriver(updated), statusChanged });
  } catch (err) {
    console.error('[drivers:review]', err.message);
    res.status(500).json({ error: 'Could not record the review.' });
  }
});

// POST /api/admin/drivers/:id/status  { status: 'active'|'suspended', reason }
router.post('/drivers/:id/status', requireAdmin, requirePermission('drivers.suspend'), async (req, res) => {
  const audit = auditor(req);
  const { status, reason } = req.body || {};

  if (!['active', 'suspended'].includes(status)) {
    return res.status(422).json({ error: 'Status must be "active" or "suspended".', code: 'bad_status' });
  }
  if (!reason || !String(reason).trim()) {
    return res.status(422).json({ error: 'A reason is required.', code: 'reason_required' });
  }

  try {
    const driver = await getDriverWithTrust(req.params.id);
    if (!driver) return res.status(404).json({ error: 'Driver not found.' });
    if (driver.status === status) {
      return res.status(409).json({ error: `This driver is already ${status}.`, code: 'no_change' });
    }

    // Suspending a driver mid-trip would leave a rider in a car belonging to
    // someone the platform has just cut off, with no assigned driver on the
    // booking. Handle the live ride first, deliberately.
    if (status === 'suspended') {
      const { data: live } = await supabase
        .from('bookings').select('id, reference, status')
        .eq('driver_id', driver.id).in('status', ACTIVE_STATUSES).limit(5);
      if (live && live.length) {
        return res.status(409).json({
          error: `${driver.name} is on a live ride. Resolve it before suspending them.`,
          code: 'driver_on_trip',
          rides: live.map((r) => ({ id: r.id, reference: r.reference, statusLabel: STATUS_LABEL[r.status] })),
        });
      }
    }

    const patch = { status };
    // Taking them off the map too — a suspended driver must not look available.
    if (status === 'suspended') patch.is_online = false;

    const { error } = await supabase.from('drivers')
      .update(patch).eq('id', driver.id).eq('status', driver.status);
    if (error) throw error;

    await audit({
      action: status === 'suspended' ? 'driver.suspend' : 'driver.reinstate',
      subjectType: 'driver', subjectId: driver.id,
      summary: `${status === 'suspended' ? 'Suspended' : 'Reinstated'} ${driver.name}`,
      detail: { from: driver.status, to: status, reason: String(reason).trim() },
    });

    invalidate();
    const updated = await getDriverWithTrust(driver.id);
    res.json({ driver: publicDriver(updated) });
  } catch (err) {
    console.error('[drivers:status]', err.message);
    res.status(500).json({ error: 'Could not change the driver status.' });
  }
});

// GET /api/admin/drivers/map/live — positions for the live map.
router.get('/drivers-map/live', requireAdmin, requirePermission('drivers.read'), async (req, res) => {
  try {
    const { data, error } = await supabase
      .from('drivers').select('*')
      .not('current_lat', 'is', null)
      .limit(2000);
    if (error) throw error;

    const decorated = await withTrust(data || []);
    const busy = await supabase.from('bookings')
      .select('driver_id, reference, status').in('status', ACTIVE_STATUSES).not('driver_id', 'is', null);
    const trips = new Map((busy.data || []).map((b) => [b.driver_id, b]));

    res.json({
      generatedAt: new Date().toISOString(),
      drivers: decorated.map((d) => {
        const trip = trips.get(d.id);
        return {
          id: d.id, name: d.name,
          lat: Number(d.current_lat), lng: Number(d.current_lng),
          is_online: d.is_online,
          standing: d.standing,
          freshness: locationFreshness(d),
          onTrip: trip ? { reference: trip.reference, status: trip.status, statusLabel: STATUS_LABEL[trip.status] } : null,
        };
      }),
    });
  } catch (err) {
    console.error('[drivers:map]', err.message);
    res.status(500).json({ error: 'Could not load driver positions.' });
  }
});

module.exports = router;

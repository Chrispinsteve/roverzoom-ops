// Driver roster and the trust queue.
const express = require('express');
const { supabase } = require('../lib/supabase');
const { requireAdmin, requirePermission } = require('../middleware/requireAdmin');
const { can } = require('../lib/roles');
const { auditor } = require('../lib/audit');
const { withTrust, sortByUrgency, getDriverWithTrust, locationFreshness, invalidate } = require('../lib/directory');
const { REVIEW_META_KEY, PROVISIONAL_META_KEY, PROVISIONAL_MAX_DAYS, PROVISIONAL_DEFAULT_DAYS, STANDING_PRIORITY } = require('../domain/trust');
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
        canGrantProvisional: can(req.admin.role, 'drivers.review'),
      },
      provisionalLimits: { maxDays: PROVISIONAL_MAX_DAYS, defaultDays: PROVISIONAL_DEFAULT_DAYS },
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

// POST /api/admin/drivers/:id/provisional
//   { days, reason }   grant or extend
//   { revoke: true, reason }
//
// Lets a driver work while their background check is outstanding. Deliberately
// NOT a way to mark someone screened: it records that the gap is known and
// accepted, by a named person, until a specific date. The console keeps showing
// them as 'warn' for the whole window, and the moment it lapses they return to
// 'critical' on their own.
router.post('/drivers/:id/provisional', requireAdmin, requirePermission('drivers.review'), async (req, res) => {
  const audit = auditor(req);
  const { days, reason, revoke } = req.body || {};

  if (!reason || !String(reason).trim()) {
    return res.status(422).json({ error: 'A reason is required.', code: 'reason_required' });
  }

  try {
    const driver = await getDriverWithTrust(req.params.id);
    if (!driver) return res.status(404).json({ error: 'Driver not found.' });
    if (!driver.auth_user_id) {
      return res.status(409).json({
        error: 'This driver has no linked account, so an authorization cannot be recorded against them.',
        code: 'no_auth_user',
      });
    }

    const { data: userRes, error: getErr } = await supabase.auth.admin.getUserById(driver.auth_user_id);
    if (getErr) throw getErr;
    const app_metadata = { ...((userRes && userRes.user && userRes.user.app_metadata) || {}) };

    if (revoke) {
      if (!app_metadata[PROVISIONAL_META_KEY]) {
        return res.status(409).json({ error: 'This driver has no provisional authorization.', code: 'no_grant' });
      }
      // Supabase merges the app_metadata you send rather than replacing it, so
      // deleting the key from a local copy is a no-op — the old value survives
      // and the driver stays authorized. Setting it to null is what actually
      // removes it.
      app_metadata[PROVISIONAL_META_KEY] = null;
      const { error } = await supabase.auth.admin.updateUserById(driver.auth_user_id, { app_metadata });
      if (error) throw error;

      await audit({
        action: 'driver.provisional_revoked', subjectType: 'driver', subjectId: driver.id,
        summary: `Revoked provisional authorization for ${driver.name}`,
        detail: { reason: String(reason).trim() },
      });

      invalidate();
      return res.json({ driver: publicDriver(await getDriverWithTrust(driver.id)) });
    }

    // NOT `Number(days) || DEFAULT`: 0 is falsy, so an explicit `days: 0`
    // silently became the 30-day default instead of being rejected. Only a
    // genuinely absent value falls back.
    const omitted = days === undefined || days === null || days === '';
    const requested = omitted ? PROVISIONAL_DEFAULT_DAYS : Number(days);
    if (!Number.isFinite(requested) || requested < 1 || requested > PROVISIONAL_MAX_DAYS) {
      return res.status(422).json({
        error: `Choose between 1 and ${PROVISIONAL_MAX_DAYS} days.`,
        code: 'bad_duration',
        max: PROVISIONAL_MAX_DAYS,
      });
    }

    // Suspended and rejected drivers are not eligible: this is a shortcut past
    // an INCOMPLETE check, never a way around a decision already made that
    // someone should not be driving.
    if (driver.status === 'suspended' || driver.trust.review.state === 'rejected') {
      return res.status(409).json({
        error: `${driver.name} has been ${driver.status === 'suspended' ? 'suspended' : 'rejected'}. Reinstate them first if that was wrong.`,
        code: 'not_eligible',
      });
    }
    if (!driver.trust.documentsComplete) {
      return res.status(409).json({
        error: `${driver.name} has not uploaded their photo, licence and insurance yet.`,
        code: 'documents_incomplete',
      });
    }

    const until = new Date(Date.now() + requested * 86400000).toISOString();
    app_metadata[PROVISIONAL_META_KEY] = {
      until,
      by: req.admin.email,
      at: new Date().toISOString(),
      reason: String(reason).trim(),
    };

    const { error } = await supabase.auth.admin.updateUserById(driver.auth_user_id, { app_metadata });
    if (error) throw error;

    await audit({
      action: 'driver.provisional_granted', subjectType: 'driver', subjectId: driver.id,
      summary: `Authorized ${driver.name} to drive for ${requested} days pending screening`,
      detail: {
        until, days: requested, reason: String(reason).trim(),
        screeningStatus: driver.trust.screening.status,
        previousStanding: driver.standing.key,
      },
    });

    invalidate();
    res.json({ driver: publicDriver(await getDriverWithTrust(driver.id)), until, days: requested });
  } catch (err) {
    console.error('[drivers:provisional]', err.message);
    res.status(500).json({ error: 'Could not record the authorization.' });
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

module.exports = router;

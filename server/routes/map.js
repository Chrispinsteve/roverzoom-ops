// The live map: where the drivers are, and where the open rides are.
//
// Supply and demand in ONE payload on purpose. A map of drivers alone tells an
// operator very little — the useful question is always "is there anyone near
// THAT pickup?", which needs both plotted against each other.
const express = require('express');
const { supabase } = require('../lib/supabase');
const { requireAdmin, requirePermission } = require('../middleware/requireAdmin');
const { can } = require('../lib/roles');
const { withTrust, locationFreshness } = require('../lib/directory');
const { riderContact } = require('../lib/redact');
const { ACTIVE_STATUSES, UNASSIGNED_STATUSES, STATUS_LABEL, STATUS_SEVERITY } = require('../domain/lifecycle');

const router = express.Router();

// Falls back to the service area when there is nothing to plot, so the map
// opens somewhere meaningful instead of the middle of the Atlantic.
const FALLBACK_CENTER = {
  lat: Number(process.env.SERVICE_AREA_LAT) || 26.7153,
  lng: Number(process.env.SERVICE_AREA_LNG) || -80.0534,
};

// How far ahead to plot rides that have not started yet.
const RIDE_HORIZON_MIN = Number(process.env.MAP_RIDE_HORIZON_MIN) || 180;

router.get('/map/live', requireAdmin, requirePermission('drivers.read'), async (req, res) => {
  try {
    const canSeePii = can(req.admin.role, 'riders.pii');
    const now = Date.now();
    const horizon = new Date(now + RIDE_HORIZON_MIN * 60_000).toISOString();

    const [driverRes, rideRes, noLocationRes] = await Promise.all([
      supabase.from('drivers').select('*').not('current_lat', 'is', null).limit(2000),
      supabase.from('bookings').select('*')
        .in('status', [...ACTIVE_STATUSES, ...UNASSIGNED_STATUSES])
        .not('pickup_lat', 'is', null)
        .lte('scheduled_at', horizon)
        .order('scheduled_at', { ascending: true })
        .limit(500),
      supabase.from('drivers').select('*', { count: 'exact', head: true }).is('current_lat', null),
    ]);
    if (driverRes.error) throw driverRes.error;
    if (rideRes.error) throw rideRes.error;

    const decorated = await withTrust(driverRes.data || []);
    const rides = rideRes.data || [];

    // Which driver is on which ride, so a marker can say what it is doing.
    const tripByDriver = new Map();
    for (const b of rides) {
      if (b.driver_id && ACTIVE_STATUSES.includes(b.status)) tripByDriver.set(b.driver_id, b);
    }

    const driverPins = decorated.map((d) => {
      const freshness = locationFreshness(d, now);
      const trip = tripByDriver.get(d.id);
      return {
        id: d.id,
        name: d.name,
        lat: Number(d.current_lat),
        lng: Number(d.current_lng),
        is_online: d.is_online,
        standing: d.standing,
        freshness,
        location_updated_at: d.location_updated_at,
        vehicle: [d.vehicle_color, d.vehicle_make, d.vehicle_model].filter(Boolean).join(' ') || null,
        onTrip: trip
          ? { id: trip.id, reference: trip.reference, status: trip.status, statusLabel: STATUS_LABEL[trip.status] }
          : null,
        // What the marker should MEAN, decided server-side so the map and every
        // list in the console agree on a driver's condition.
        //   working  — carrying or fetching a passenger right now
        //   idle     — online, cleared, available
        //   stale    — we have a position but it is too old to trust
        //   offline  — last known position, not online
        //   risk     — online but unvetted or flagged; must stand out
        pin: trip ? 'working'
          : (freshness.state === 'stale' || freshness.state === 'never') ? 'stale'
          : !d.is_online ? 'offline'
          : (d.standing.risk === 'critical') ? 'risk'
          : 'idle',
      };
    });

    const ridePins = rides.map((b) => {
      const minutesToPickup = Math.round((new Date(b.scheduled_at).getTime() - now) / 60000);
      return {
        id: b.id,
        reference: b.reference,
        status: b.status,
        statusLabel: STATUS_LABEL[b.status] || b.status,
        severity: STATUS_SEVERITY[b.status] || 'neutral',
        lat: Number(b.pickup_lat),
        lng: Number(b.pickup_lng),
        dropoff: b.dropoff_lat != null ? { lat: Number(b.dropoff_lat), lng: Number(b.dropoff_lng) } : null,
        pickup_address: b.pickup_address,
        dropoff_address: b.dropoff_address,
        scheduled_at: b.scheduled_at,
        minutesToPickup,
        overdue: minutesToPickup < 0,
        assigned: Boolean(b.driver_id),
        driver_id: b.driver_id,
        fare: b.fare,
        ...riderContact(b, canSeePii),
      };
    });

    // Centre on whatever is actually plotted.
    const points = [...driverPins, ...ridePins];
    const center = points.length
      ? {
          lat: points.reduce((s, p) => s + p.lat, 0) / points.length,
          lng: points.reduce((s, p) => s + p.lng, 0) / points.length,
        }
      : FALLBACK_CENTER;

    res.json({
      generatedAt: new Date().toISOString(),
      center,
      drivers: driverPins,
      rides: ridePins,
      counts: {
        working: driverPins.filter((d) => d.pin === 'working').length,
        idle: driverPins.filter((d) => d.pin === 'idle').length,
        risk: driverPins.filter((d) => d.pin === 'risk').length,
        stale: driverPins.filter((d) => d.pin === 'stale').length,
        offline: driverPins.filter((d) => d.pin === 'offline').length,
        ridesWaiting: ridePins.filter((r) => !r.assigned).length,
        ridesLive: ridePins.filter((r) => r.assigned).length,
      },
      // Stated so the UI can explain an empty map honestly rather than looking
      // broken: drivers only appear once the driver app has posted a location.
      driversWithNoLocation: noLocationRes.count ?? 0,
    });
  } catch (err) {
    console.error('[map:live]', err.message);
    res.status(500).json({ error: 'Could not load the live map.' });
  }
});

module.exports = router;

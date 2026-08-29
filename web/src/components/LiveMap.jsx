import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { GoogleMap, OverlayViewF, OverlayView } from '@react-google-maps/api';
import { useGoogleMaps } from '../lib/GoogleMapsProvider';
import { relative, untilPickup, shortAddress } from '../lib/format';

// Map styling tuned to the console's own tokens, so the map reads as part of
// the interface rather than a Google widget dropped into it. Same intent as
// the driver app's DARK_STYLES: suppress everything that is not roads or
// water, because on this map the only content that matters is the pins.
const MAP_STYLES = [
  { elementType: 'geometry', stylers: [{ color: '#131316' }] },
  { elementType: 'labels.text.stroke', stylers: [{ color: '#131316' }] },
  { elementType: 'labels.text.fill', stylers: [{ color: '#6a6a72' }] },
  { featureType: 'poi', stylers: [{ visibility: 'off' }] },
  { featureType: 'transit', stylers: [{ visibility: 'off' }] },
  { featureType: 'road', elementType: 'geometry', stylers: [{ color: '#212126' }] },
  { featureType: 'road', elementType: 'labels', stylers: [{ visibility: 'simplified' }] },
  { featureType: 'road.arterial', elementType: 'geometry', stylers: [{ color: '#292930' }] },
  { featureType: 'road.highway', elementType: 'geometry', stylers: [{ color: '#33333b' }] },
  { featureType: 'road.local', elementType: 'labels', stylers: [{ visibility: 'off' }] },
  { featureType: 'water', elementType: 'geometry', stylers: [{ color: '#0a0a0b' }] },
  { featureType: 'administrative', elementType: 'geometry.stroke', stylers: [{ color: '#2a2a31' }] },
  { featureType: 'landscape.man_made', elementType: 'geometry', stylers: [{ color: '#191920' }] },
];

const MAP_OPTIONS = {
  styles: MAP_STYLES,
  disableDefaultUI: true,
  zoomControl: true,
  zoomControlOptions: { position: 7 }, // RIGHT_BOTTOM, as a numeric literal so
                                       // it does not need the google global at
                                       // module-evaluation time.
  clickableIcons: false,
  gestureHandling: 'greedy',
  minZoom: 3,
  maxZoom: 19,
  backgroundColor: '#0a0a0b',
};

// Driver marker appearance. `pin` is decided server-side so the map and every
// list in the console describe a driver's condition identically.
const DRIVER_PIN = {
  working: { color: 'var(--state-active)',   label: 'On a trip',       dim: false, ring: true },
  idle:    { color: 'var(--ink)',            label: 'Available',       dim: false, ring: false },
  risk:    { color: 'var(--state-critical)', label: 'Online, unvetted',dim: false, ring: true },
  stale:   { color: 'var(--state-warn)',     label: 'Stale location',  dim: true,  ring: false },
  offline: { color: 'var(--ink-4)',          label: 'Offline',         dim: true,  ring: false },
};

export function LiveMap({ data, onOpenDriver, onOpenRide, showOffline }) {
  const { isLoaded, loadError, hasApiKey } = useGoogleMaps();
  const mapRef = useRef(null);
  const [selected, setSelected] = useState(null);
  const fittedRef = useRef(false);

  // Memoized so the fit-bounds effect below has stable dependencies. Without
  // this, a new array identity every render re-runs that effect on every
  // poll tick for no reason.
  const drivers = useMemo(
    () => (data?.drivers || []).filter((d) => showOffline || (d.pin !== 'offline' && d.pin !== 'stale')),
    [data, showOffline]
  );
  const rides = useMemo(() => data?.rides || [], [data]);

  const onLoad = useCallback((map) => { mapRef.current = map; }, []);

  // Fit to everything once, on first data. Deliberately not on every refresh:
  // an operator who has panned to a specific corner must not have the map
  // yanked back from under them every fifteen seconds.
  useEffect(() => {
    if (!isLoaded || !mapRef.current || fittedRef.current) return;
    const points = [...drivers, ...rides];
    if (!points.length) return;

    const bounds = new window.google.maps.LatLngBounds();
    for (const p of points) bounds.extend({ lat: p.lat, lng: p.lng });
    mapRef.current.fitBounds(bounds, 64);

    // A single point fits to maximum zoom, which is disorienting.
    if (points.length === 1) {
      const listener = window.google.maps.event.addListenerOnce(mapRef.current, 'idle', () => {
        if (mapRef.current.getZoom() > 14) mapRef.current.setZoom(14);
      });
      fittedRef.current = true;
      return () => window.google.maps.event.removeListener(listener);
    }
    fittedRef.current = true;
  }, [isLoaded, drivers, rides]);

  if (!hasApiKey) {
    return (
      <MapMessage
        title="Google Maps key not set"
        body={<>Add <span className="mono">VITE_GOOGLE_MAPS_API_KEY</span> to <span className="mono">web/.env</span>. You can reuse the browser key the rider app already uses — but add this console&rsquo;s domain to that key&rsquo;s HTTP referrer restrictions, or Google will reject it.</>}
      />
    );
  }
  if (loadError) {
    return <MapMessage title="Google Maps failed to load" body="Check that the key is valid and that Maps JavaScript API is enabled for it." level="critical" />;
  }
  if (!isLoaded) {
    return <div className="skeleton" style={{ width: '100%', height: '100%', borderRadius: 0 }} />;
  }

  return (
    <div style={{ position: 'relative', width: '100%', height: '100%' }}>
      <GoogleMap
        mapContainerStyle={{ width: '100%', height: '100%' }}
        center={data?.center || { lat: 26.7153, lng: -80.0534 }}
        zoom={10}
        options={MAP_OPTIONS}
        onLoad={onLoad}
        onClick={() => setSelected(null)}
      >
        {rides.map((r) => (
          <OverlayViewF key={`r-${r.id}`} position={{ lat: r.lat, lng: r.lng }} mapPaneName={OverlayView.OVERLAY_MOUSE_TARGET}>
            <RidePin ride={r} onClick={() => setSelected({ kind: 'ride', item: r })} />
          </OverlayViewF>
        ))}

        {drivers.map((d) => (
          <OverlayViewF key={`d-${d.id}`} position={{ lat: d.lat, lng: d.lng }} mapPaneName={OverlayView.OVERLAY_MOUSE_TARGET}>
            <DriverPin driver={d} onClick={() => setSelected({ kind: 'driver', item: d })} />
          </OverlayViewF>
        ))}
      </GoogleMap>

      {selected && (
        <Callout
          selected={selected}
          onClose={() => setSelected(null)}
          onOpen={() => {
            if (selected.kind === 'driver') onOpenDriver(selected.item.id);
            else onOpenRide(selected.item.id);
            setSelected(null);
          }}
        />
      )}
    </div>
  );
}

function DriverPin({ driver, onClick }) {
  const style = DRIVER_PIN[driver.pin] || DRIVER_PIN.idle;
  return (
    <button
      onClick={(e) => { e.stopPropagation(); onClick(); }}
      title={`${driver.name} — ${style.label}`}
      style={{
        transform: 'translate(-50%, -50%)',
        width: 16, height: 16, borderRadius: '50%',
        background: style.color,
        border: '2px solid #0a0a0b',
        boxShadow: style.ring ? `0 0 0 3px color-mix(in srgb, ${style.color} 28%, transparent)` : '0 1px 4px rgba(0,0,0,0.6)',
        opacity: style.dim ? 0.45 : 1,
        cursor: 'pointer',
        padding: 0,
      }}
      aria-label={`${driver.name}, ${style.label}`}
    />
  );
}

// Rides are squares, drivers are circles. Shape, not just colour, distinguishes
// them — the two are never confusable at a glance, and it still works for an
// operator who cannot reliably separate red from green.
function RidePin({ ride, onClick }) {
  const color = ride.severity === 'critical' ? 'var(--state-critical)'
    : ride.severity === 'warn' ? 'var(--state-warn)'
    : ride.assigned ? 'var(--state-active)' : 'var(--ink-3)';
  const urgent = ride.severity === 'critical' || ride.overdue;

  return (
    <button
      onClick={(e) => { e.stopPropagation(); onClick(); }}
      title={`${ride.reference} — ${ride.statusLabel}`}
      className={urgent ? 'sev-critical' : ''}
      style={{
        transform: 'translate(-50%, -50%) rotate(45deg)',
        width: 13, height: 13, borderRadius: 3,
        background: color,
        border: '2px solid #0a0a0b',
        boxShadow: urgent ? `0 0 0 4px color-mix(in srgb, ${color} 25%, transparent)` : '0 1px 4px rgba(0,0,0,0.6)',
        cursor: 'pointer',
        padding: 0,
      }}
      aria-label={`Ride ${ride.reference}, ${ride.statusLabel}`}
    />
  );
}

function Callout({ selected, onClose, onOpen }) {
  const { kind, item } = selected;
  return (
    <div style={{
      position: 'absolute', left: 14, bottom: 14, width: 290,
      background: 'var(--overlay)', border: '1px solid var(--line)',
      borderRadius: 'var(--r-sm)', boxShadow: 'var(--shadow-pop)',
      padding: 13, zIndex: 5,
    }}>
      <div className="row-between" style={{ marginBottom: 7 }}>
        <span style={{ fontSize: 13.5, fontWeight: 600 }}>
          {kind === 'driver' ? item.name : <span className="ref">{item.reference}</span>}
        </span>
        <button className="btn btn-sm btn-ghost" onClick={onClose} aria-label="Close">✕</button>
      </div>

      {kind === 'driver' ? (
        <div className="col" style={{ gap: 3, fontSize: 12.5 }}>
          <span className={`row sev-${item.standing.risk}`} style={{ gap: 6 }}>
            <span className="dot" /><span>{item.standing.label}</span>
          </span>
          {item.vehicle && <span className="faint">{item.vehicle}</span>}
          <span className="faint">
            {item.onTrip ? `On ${item.onTrip.reference} · ${item.onTrip.statusLabel}` : item.is_online ? 'Online, no trip' : 'Offline'}
          </span>
          <span className="faint">Position {relative(item.location_updated_at)}</span>
        </div>
      ) : (
        <div className="col" style={{ gap: 3, fontSize: 12.5 }}>
          <span className={`row sev-${item.severity}`} style={{ gap: 6 }}>
            <span className="dot" /><span>{item.statusLabel}</span>
          </span>
          <span className="faint">{shortAddress(item.pickup_address)}</span>
          <span className="faint">→ {shortAddress(item.dropoff_address)}</span>
          <span style={{ color: item.overdue ? 'var(--state-critical)' : 'var(--ink-3)' }}>
            {untilPickup(item.minutesToPickup)}
          </span>
        </div>
      )}

      <button className="btn btn-sm" style={{ width: '100%', marginTop: 10 }} onClick={onOpen}>
        Open {kind === 'driver' ? 'driver' : 'ride'}
      </button>
    </div>
  );
}

function MapMessage({ title, body, level = 'warn' }) {
  return (
    <div className={`sev-${level}`} style={{
      width: '100%', height: '100%',
      display: 'grid', placeItems: 'center', padding: 32,
      background: 'var(--surface)',
    }}>
      <div style={{ maxWidth: 400, textAlign: 'center' }}>
        <div style={{ fontSize: 14, fontWeight: 600, color: 'var(--sev)', marginBottom: 7 }}>{title}</div>
        <p className="muted" style={{ fontSize: 13, lineHeight: 1.6 }}>{body}</p>
      </div>
    </div>
  );
}

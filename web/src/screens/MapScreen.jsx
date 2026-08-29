import { useState } from 'react';
import { api } from '../lib/api';
import { useApi } from '../lib/useApi';
import { PageHeader } from '../components/Shell';
import { LiveMap } from '../components/LiveMap';
import { GoogleMapsProvider } from '../lib/GoogleMapsProvider';
import { ErrorNote } from '../components/ui';

const POLL_MS = 15_000;

export function MapScreen({ onOpenDriver, onOpenRide }) {
  const [showOffline, setShowOffline] = useState(false);
  const { data, error, updatedAt, refreshing, refresh } = useApi(() => api.liveMap(), { poll: POLL_MS });

  const c = data?.counts;
  const plotted = (data?.drivers?.length || 0) + (data?.rides?.length || 0);
  const noLocation = data?.driversWithNoLocation ?? 0;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%' }}>
      <PageHeader
        title="Live map"
        subtitle="Where the drivers are, and where the open rides are."
        live updatedAt={updatedAt} refreshing={refreshing}
        actions={
          <label className="row faint" style={{ gap: 7, fontSize: 12.5, cursor: 'pointer', flex: 'none' }}>
            <input type="checkbox" checked={showOffline} onChange={(e) => setShowOffline(e.target.checked)} />
            Show offline &amp; stale
          </label>
        }
      />

      <div style={{ padding: '0 24px', flex: 'none' }}>
        {error && <ErrorNote error={error} onRetry={refresh} stale={Boolean(data)} />}

        {/* The honest empty state. A blank map looks broken; it usually just
            means no driver has posted a position yet. Say which. */}
        {data && plotted === 0 && (
          <div className="sev-warn" style={{
            display: 'flex', gap: 11, alignItems: 'flex-start',
            padding: '12px 14px', marginBottom: 12, borderRadius: 'var(--r-sm)',
            background: 'var(--sev-wash)', border: '1px solid var(--sev-line)',
          }}>
            <span className="dot" style={{ marginTop: 6 }} />
            <div style={{ fontSize: 13, lineHeight: 1.55 }}>
              <strong style={{ color: 'var(--sev)' }}>Nothing to plot yet.</strong>
              <div className="muted" style={{ marginTop: 3 }}>
                {noLocation > 0
                  ? `${noLocation} driver${noLocation > 1 ? 's have' : ' has'} never reported a position. `
                  : ''}
                Drivers appear here once the driver app posts to{' '}
                <span className="mono">/api/driver/location</span>, which it only does while
                a driver is signed in with location permission granted. Open rides appear as
                soon as they have pickup coordinates.
              </div>
            </div>
          </div>
        )}

        {c && plotted > 0 && (
          <div className="row wrap" style={{ gap: 14, marginBottom: 12, fontSize: 12 }}>
            <Legend swatch="circle" color="var(--state-active)" label={`${c.working} on a trip`} />
            <Legend swatch="circle" color="var(--ink)" label={`${c.idle} available`} />
            {c.risk > 0 && <Legend swatch="circle" color="var(--state-critical)" label={`${c.risk} online, unvetted`} />}
            {(c.stale > 0 || c.offline > 0) && (
              <Legend swatch="circle" color="var(--ink-4)" dim
                label={`${c.stale + c.offline} offline or stale${showOffline ? '' : ' (hidden)'}`} />
            )}
            <span className="faint" style={{ opacity: 0.5 }}>│</span>
            <Legend swatch="square" color="var(--state-critical)" label={`${c.ridesWaiting} waiting for a driver`} />
            <Legend swatch="square" color="var(--state-active)" label={`${c.ridesLive} live`} />
          </div>
        )}
      </div>

      <div className="grow" style={{
        margin: '0 24px 24px', borderRadius: 'var(--r-md)',
        overflow: 'hidden', border: '1px solid var(--line)', minHeight: 380,
      }}>
        {/* The provider lives here rather than around the whole app so the
            Google Maps bundle stays inside this lazily-loaded chunk. It still
            loads the API once per page: useJsApiLoader is globally memoized,
            so leaving and returning to this screen does not refetch it. */}
        <GoogleMapsProvider>
          <LiveMap data={data} showOffline={showOffline} onOpenDriver={onOpenDriver} onOpenRide={onOpenRide} />
        </GoogleMapsProvider>
      </div>
    </div>
  );
}

function Legend({ color, label, swatch, dim }) {
  return (
    <span className="row" style={{ gap: 6, color: 'var(--ink-3)' }}>
      <span style={{
        width: 9, height: 9,
        borderRadius: swatch === 'square' ? 2 : '50%',
        transform: swatch === 'square' ? 'rotate(45deg)' : undefined,
        background: color, opacity: dim ? 0.45 : 1, flex: 'none',
      }} />
      {label}
    </span>
  );
}

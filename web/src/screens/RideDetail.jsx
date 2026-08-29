import { useState } from 'react';
import { api } from '../lib/api';
import { useApi } from '../lib/useApi';
import { Sheet, Detail, Pill, Loading, ErrorNote, Restricted } from '../components/ui';
import { money, dayAndClock, clock, duration, miles, relative } from '../lib/format';

// One ride, everything about it. The timeline is the centerpiece: almost every
// support question ("where is my driver?", "why was I charged?") is answered by
// seeing what happened and when.
export function RideDetail({ rideId, onClose, onChanged }) {
  const { data, loading, error, reload } = useApi(() => api.ride(rideId), { deps: [rideId] });
  const [action, setAction] = useState(null); // 'cancel' | 'release'

  const ride = data?.ride;

  return (
    <>
      <Sheet
        open
        onClose={onClose}
        width={620}
        title={
          loading ? 'Loading…' : (
            <div className="row" style={{ gap: 9 }}>
              <span className="ref" style={{ fontSize: 14 }}>{ride?.reference}</span>
              {ride && <Pill level={ride.severity}>{ride.statusLabel}</Pill>}
            </div>
          )
        }
        subtitle={ride ? dayAndClock(ride.scheduled_at) : undefined}
        footer={
          ride && (
            <>
              {data.actions.reassignable && (
                <button className="btn" onClick={() => setAction('release')}>Release driver</button>
              )}
              {data.actions.cancelable && (
                <button className="btn btn-danger" onClick={() => setAction('cancel')}>Cancel ride</button>
              )}
              <button className="btn" onClick={onClose}>Close</button>
            </>
          )
        }
      >
        {loading && <Loading rows={5} />}
        {error && <ErrorNote error={error} onRetry={reload} />}

        {ride && (
          <>
            <Section title="Route">
              <Detail label="Pickup">{ride.pickup_address}</Detail>
              <Detail label="Dropoff">{ride.dropoff_address}</Detail>
              <Detail label="Distance">{miles(ride.distance_miles)} · {duration(ride.duration_minutes)} estimated</Detail>
            </Section>

            <Section title="Rider">
              <Detail label="Name">{ride.rider_name}</Detail>
              <Detail label="Phone" mono>{ride.rider_phone}</Detail>
              <Detail label="Email" mono>{ride.rider_email}</Detail>
              {ride.pii_redacted && (
                <div className="faint" style={{ fontSize: 12, fontStyle: 'italic', paddingTop: 4 }}>
                  Contact details are partially hidden for your role.
                </div>
              )}
            </Section>

            <Section title="Driver">
              {data.driver ? (
                <>
                  <Detail label="Name">
                    <span className="row" style={{ gap: 8 }}>
                      {data.driver.name}
                      <Pill level={data.driver.standing.risk}>{data.driver.standing.label}</Pill>
                    </span>
                  </Detail>
                  <Detail label="Phone" mono>{data.driver.phone}</Detail>
                  <Detail label="Vehicle">{data.driver.vehicle} {data.driver.vehicle_plate ? `· ${data.driver.vehicle_plate}` : ''}</Detail>
                  <Detail label="Location">
                    {data.driver.locationFreshness.state === 'never'
                      ? <span className="faint">never reported</span>
                      : `${data.driver.locationFreshness.state} · ${relative(data.driver.location_updated_at)}`}
                  </Detail>
                </>
              ) : (
                <div className="faint" style={{ fontSize: 13 }}>No driver assigned.</div>
              )}
            </Section>

            <Section title="Timeline">
              <Timeline events={data.timeline} />
            </Section>

            {data.offers.length > 0 && (
              <Section title={`Dispatch history · ${data.offers.length} offer${data.offers.length > 1 ? 's' : ''}`}>
                {/* The only way to answer "why did nobody take this ride?" */}
                <div className="col" style={{ gap: 5 }}>
                  {data.offers.map((o) => (
                    <div key={o.id} className="row" style={{ gap: 10, fontSize: 12.5 }}>
                      <span className="faint num" style={{ width: 54, flex: 'none' }}>R{o.round}</span>
                      <span className="grow truncate">{o.driver_name || 'Unknown driver'}</span>
                      <span className={`faint ${o.status === 'accepted' ? 'sev-active' : ''}`}
                        style={{ color: o.status === 'accepted' ? 'var(--state-active)' : undefined }}>
                        {o.status}
                      </span>
                      <span className="faint num" style={{ width: 76, textAlign: 'right', flex: 'none' }}>
                        {clock(o.offered_at)}
                      </span>
                    </div>
                  ))}
                </div>
              </Section>
            )}

            <Section title="Payment">
              <Detail label="Fare">{money(ride.fare)}</Detail>
              <Detail label="Method">{ride.payment_method} · {ride.payment_status}</Detail>
              <Detail label="Booked via">{ride.source === 'ai' ? 'AI assistant' : 'Web form'}</Detail>
              {data.economics ? (
                <>
                  <Detail label="List price">
                    {money(data.economics.standardFare)}
                    {data.economics.discount > 0 && (
                      <span className="faint"> · {money(data.economics.discount)} promo ({data.economics.discountPct}%)</span>
                    )}
                  </Detail>
                  <Detail label="Driver earns">{money(data.economics.driverShare)}</Detail>
                  <Detail label="Platform">{money(data.economics.platformShare)}</Detail>
                  {data.economics.platformOwedByDriver > 0 && (
                    <Detail label="Owed back">
                      <span style={{ color: 'var(--state-warn)' }}>
                        {money(data.economics.platformOwedByDriver)} commission, collected in cash by the driver
                      </span>
                    </Detail>
                  )}
                </>
              ) : (
                <div style={{ paddingTop: 6 }}><Restricted what="the fare breakdown" /></div>
              )}
            </Section>

            {ride.canceled_by && (
              <Section title="Cancellation">
                <Detail label="By">{ride.canceled_by}</Detail>
                <Detail label="Reason">{ride.cancel_reason}</Detail>
              </Section>
            )}
          </>
        )}
      </Sheet>

      {action && ride && (
        <ActionDialog
          kind={action}
          ride={ride}
          onClose={() => setAction(null)}
          onDone={() => { setAction(null); reload(); onChanged?.(); }}
        />
      )}
    </>
  );
}

function Section({ title, children }) {
  return (
    <section style={{ marginBottom: 22 }}>
      <div className="eyebrow" style={{ marginBottom: 8, paddingBottom: 7, borderBottom: '1px solid var(--line)' }}>{title}</div>
      {children}
    </section>
  );
}

function Timeline({ events }) {
  if (!events.length) return <div className="faint" style={{ fontSize: 13 }}>Nothing has happened yet.</div>;

  return (
    <div style={{ position: 'relative', paddingLeft: 18 }}>
      {/* The connecting rail, drawn behind the markers. */}
      <div style={{
        position: 'absolute', left: 4, top: 7, bottom: 7,
        width: 1, background: 'var(--line-strong)',
      }} />
      {events.map((e, i) => {
        const isCancel = e.status === 'canceled';
        return (
          <div key={`${e.status}-${i}`} className={isCancel ? 'sev-critical' : 'sev-active'}
            style={{ position: 'relative', paddingBottom: i === events.length - 1 ? 0 : 14 }}>
            <span style={{
              position: 'absolute', left: -18, top: 4,
              width: 9, height: 9, borderRadius: '50%',
              background: 'var(--sev)',
              border: '2px solid var(--overlay)', boxSizing: 'content-box',
            }} />
            <div className="row-between" style={{ gap: 12 }}>
              <span style={{ fontSize: 13, fontWeight: 500 }}>{e.label}</span>
              <span className="faint num" style={{ fontSize: 12, flex: 'none' }}>
                {clock(e.at)} · {relative(e.at)}
              </span>
            </div>
            {e.reason && <div className="faint" style={{ fontSize: 12, marginTop: 2 }}>{e.by ? `${e.by}: ` : ''}{e.reason}</div>}
          </div>
        );
      })}
    </div>
  );
}

// Cancelling and releasing both destroy operational state, so both demand a
// typed reason. The reason is not bureaucracy: it lands in the audit trail and
// in the cancellation record the rider's receipt is built from.
function ActionDialog({ kind, ride, onClose, onDone }) {
  const [reason, setReason] = useState('');
  const [onBehalfOf, setOnBehalfOf] = useState('system');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);

  const isCancel = kind === 'cancel';

  async function submit() {
    setBusy(true); setError(null);
    try {
      if (isCancel) await api.cancelRide(ride.id, { reason, onBehalfOf });
      else await api.release(ride.id, { reason });
      onDone();
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  }

  return (
    <Sheet
      open
      onClose={onClose}
      width={460}
      title={isCancel ? 'Cancel this ride' : 'Release the driver'}
      subtitle={ride.reference}
      footer={
        <>
          <button className="btn" onClick={onClose} disabled={busy}>Keep it</button>
          <button className={`btn ${isCancel ? 'btn-danger' : 'btn-primary'}`}
            disabled={!reason.trim() || busy} onClick={submit}>
            {busy ? 'Working…' : isCancel ? 'Cancel ride' : 'Release driver'}
          </button>
        </>
      }
    >
      {error && <div style={{ marginBottom: 14 }}><ErrorNote error={error} /></div>}

      <p className="muted" style={{ fontSize: 13, marginBottom: 16, lineHeight: 1.55 }}>
        {isCancel
          ? 'The rider and any assigned driver stop seeing this ride. This cannot be undone.'
          : 'The driver is detached and the ride returns to the dispatch board for manual assignment. The rider keeps their booking.'}
      </p>

      {isCancel && (
        <div style={{ marginBottom: 14 }}>
          <label className="label">Who asked for this?</label>
          <select className="field" value={onBehalfOf} onChange={(e) => setOnBehalfOf(e.target.value)}>
            <option value="rider">The rider</option>
            <option value="driver">The driver</option>
            <option value="system">RoverZoom decided</option>
          </select>
        </div>
      )}

      <label className="label">Reason (required)</label>
      <textarea
        className="field"
        value={reason}
        onChange={(e) => setReason(e.target.value)}
        placeholder={isCancel ? 'Rider called to cancel — flight was delayed.' : 'Driver broke down; reassigning.'}
        autoFocus
      />
      <div className="faint" style={{ fontSize: 11.5, marginTop: 7 }}>
        Recorded in the audit trail with your name.
      </div>
    </Sheet>
  );
}

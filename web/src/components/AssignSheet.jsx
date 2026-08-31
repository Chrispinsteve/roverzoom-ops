import { useState } from 'react';
import { api, ApiError } from '../lib/api';
import { useApi } from '../lib/useApi';
import { Sheet, Empty, Loading, ErrorNote } from './ui';
import { untilPickup, shortAddress, dayAndClock } from '../lib/format';

// The assignment sheet. Candidates are ranked by the API and every candidate
// carries its blockers and warnings, so an operator can see WHY someone is or
// is not a good choice without opening six driver profiles.
// `ride` may come from the dispatch board (which has a live `minutesToPickup`
// from the API) or from a ride detail opened anywhere else (which only has
// `scheduled_at`). Take whichever is supplied rather than recomputing "now"
// during render, which is impure and re-fires on every re-render.
export function AssignSheet({ ride, onClose, onAssigned }) {
  const { data, loading, error, reload } = useApi(() => api.candidates(ride.id), { deps: [ride.id] });
  const [chosen, setChosen] = useState(null);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState(null);
  const [warnings, setWarnings] = useState(null);

  async function assign(acknowledge = false) {
    setBusy(true);
    setProblem(null);
    try {
      await api.assign(ride.id, { driverId: chosen.id, acknowledgeWarnings: acknowledge });
      onAssigned();
    } catch (err) {
      if (err instanceof ApiError && err.code === 'warnings_unacknowledged') {
        // The API refuses a first attempt on a driver with soft warnings. Show
        // exactly what they are and make the operator confirm — deliberately,
        // not by reflex.
        setWarnings(err.body.warnings || []);
      } else {
        setProblem(err);
      }
    } finally {
      setBusy(false);
    }
  }

  const candidates = data?.candidates || [];
  const eligible = candidates.filter((c) => c.eligible);
  const ineligible = candidates.filter((c) => !c.eligible);

  return (
    <Sheet
      open
      onClose={onClose}
      width={620}
      title={<div className="row" style={{ gap: 9 }}><h2 style={{ fontSize: 15 }}>Assign a driver</h2><span className="ref">{ride.reference}</span></div>}
      subtitle={`${shortAddress(ride.pickup_address)} · ${
        typeof ride.minutesToPickup === 'number'
          ? untilPickup(ride.minutesToPickup)
          : dayAndClock(ride.scheduled_at)
      }`}
      footer={
        <>
          <button className="btn" onClick={onClose} disabled={busy}>Cancel</button>
          <button className="btn btn-primary" disabled={!chosen || busy} onClick={() => assign(false)}>
            {busy ? 'Assigning…' : chosen ? `Assign ${chosen.name}` : 'Select a driver'}
          </button>
        </>
      }
    >
      {problem && <div style={{ marginBottom: 14 }}><ErrorNote error={problem} /></div>}

      {warnings && chosen && (
        <div className="sev-warn" style={{
          padding: 14, marginBottom: 16, borderRadius: 'var(--r-sm)',
          background: 'var(--sev-wash)', border: '1px solid var(--sev-line)',
        }}>
          <div style={{ fontWeight: 600, fontSize: 13, color: 'var(--sev)', marginBottom: 6 }}>
            {chosen.name} can take this ride, but check first
          </div>
          <ul style={{ margin: '0 0 12px', paddingLeft: 18, fontSize: 13, color: 'var(--ink-2)' }}>
            {warnings.map((w) => <li key={w} style={{ marginBottom: 2 }}>{w}</li>)}
          </ul>
          <div className="row" style={{ gap: 8 }}>
            <button className="btn btn-sm" onClick={() => { setWarnings(null); setChosen(null); }}>Pick someone else</button>
            <button className="btn btn-sm btn-danger" disabled={busy} onClick={() => assign(true)}>
              Assign anyway
            </button>
          </div>
        </div>
      )}

      {loading && <Loading rows={4} height={56} />}
      {error && <ErrorNote error={error} onRetry={reload} />}

      {data && !data.booking.hasCoordinates && (
        <div className="sev-warn" style={{
          padding: '9px 12px', marginBottom: 14, borderRadius: 'var(--r-xs)',
          background: 'var(--sev-wash)', border: '1px solid var(--sev-line)', fontSize: 12.5,
        }}>
          This pickup has no coordinates, so drivers cannot be ranked by distance.
        </div>
      )}

      {data && (
        <>
          <div className="row-between" style={{ marginBottom: 10 }}>
            <span className="eyebrow">{eligible.length} available</span>
            <span className="faint" style={{ fontSize: 11.5 }}>straight-line distance</span>
          </div>

          {eligible.length === 0 && (
            <Empty
              title="No one can take this ride"
              note={`No eligible driver is within ${data.maxMiles} miles. Consider contacting the rider, or reassigning from another live ride.`}
            />
          )}

          <div className="col" style={{ gap: 6 }}>
            {eligible.map((c) => (
              <CandidateRow key={c.id} candidate={c} selected={chosen?.id === c.id}
                onSelect={() => { setChosen(c); setWarnings(null); }} />
            ))}
          </div>

          {ineligible.length > 0 && (
            <details style={{ marginTop: 18 }}>
              <summary className="faint" style={{ fontSize: 12.5, cursor: 'pointer', userSelect: 'none' }}>
                {ineligible.length} driver{ineligible.length > 1 ? 's' : ''} nearby who cannot be assigned
              </summary>
              <div className="col" style={{ gap: 6, marginTop: 10 }}>
                {ineligible.map((c) => <CandidateRow key={c.id} candidate={c} disabled />)}
              </div>
            </details>
          )}
        </>
      )}
    </Sheet>
  );
}

function CandidateRow({ candidate: c, selected, onSelect, disabled }) {
  return (
    <button
      onClick={disabled ? undefined : onSelect}
      disabled={disabled}
      className={`sev-${c.standing.risk}`}
      style={{
        display: 'flex', alignItems: 'center', gap: 12, width: '100%', textAlign: 'left',
        padding: '11px 13px', borderRadius: 'var(--r-sm)',
        border: `1px solid ${selected ? 'var(--ink-4)' : 'var(--line)'}`,
        background: selected ? 'var(--surface-3)' : 'var(--surface)',
        opacity: disabled ? 0.5 : 1,
        cursor: disabled ? 'default' : 'pointer',
        transition: 'all 130ms var(--ease)',
      }}
    >
      <span className="col grow" style={{ gap: 3, minWidth: 0 }}>
        <span className="row" style={{ gap: 8 }}>
          <span style={{ fontSize: 13.5, fontWeight: 500 }}>{c.name}</span>
          <span className="pill" style={{ fontSize: 11, padding: '1px 7px' }}>
            <span className="dot" />{c.standing.label}
          </span>
          {!c.is_online && <span className="faint" style={{ fontSize: 11.5 }}>offline</span>}
        </span>

        <span className="faint truncate" style={{ fontSize: 12 }}>
          {c.vehicle || 'No vehicle on file'}
          {c.plate ? ` · ${c.plate}` : ''}
          {c.rides_completed != null ? ` · ${c.rides_completed} rides` : ''}
          {c.rating != null ? ` · ${Number(c.rating).toFixed(2)}★` : ''}
        </span>

        {(c.blockers.length > 0 || c.warnings.length > 0) && (
          <span className="row wrap" style={{ gap: 5, marginTop: 2 }}>
            {c.blockers.map((b) => (
              <span key={b} className="sev-critical" style={{
                fontSize: 11, padding: '1px 7px', borderRadius: 999,
                background: 'var(--sev-wash)', border: '1px solid var(--sev-line)', color: 'var(--sev)',
              }}>{b}</span>
            ))}
            {c.warnings.map((w) => (
              <span key={w} className="sev-warn" style={{
                fontSize: 11, padding: '1px 7px', borderRadius: 999,
                background: 'var(--sev-wash)', border: '1px solid var(--sev-line)', color: 'var(--sev)',
              }}>{w}</span>
            ))}
          </span>
        )}
      </span>

      <span className="col" style={{ alignItems: 'flex-end', gap: 1, flex: 'none' }}>
        <span className="num" style={{ fontSize: 14, fontWeight: 600 }}>
          {c.milesAway == null ? '—' : `${c.milesAway} mi`}
        </span>
        <span className="faint num" style={{ fontSize: 11.5 }}>
          {c.minutesAway == null ? 'no location' : `~${c.minutesAway} min`}
        </span>
      </span>
    </button>
  );
}

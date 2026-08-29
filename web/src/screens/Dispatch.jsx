import { useState } from 'react';
import { api, ApiError } from '../lib/api';
import { useApi } from '../lib/useApi';
import { useAuth } from '../lib/auth';
import { PageHeader } from '../components/Shell';
import { Panel, Pill, Empty, Loading, ErrorNote, Sheet } from '../components/ui';
import { clock, untilPickup, money, miles, shortAddress, relative } from '../lib/format';

const POLL_MS = 12_000;

// The dispatch board answers one question — "who takes this ride?" — so the
// screen is a queue on the left and, once a ride is picked, the ranked list of
// people who could take it. No dashboard furniture.
export function Dispatch({ onOpenRide }) {
  const { can } = useAuth();
  const [selected, setSelected] = useState(null);

  const board = useApi(() => api.dispatchBoard(), { poll: POLL_MS });

  if (board.loading && !board.data) return <><PageHeader title="Dispatch" /><Loading rows={5} /></>;
  if (board.error && !board.data) {
    return <><PageHeader title="Dispatch" /><div style={{ padding: 24 }}><ErrorNote error={board.error} onRetry={board.reload} /></div></>;
  }

  const { rides = [], counts = {}, horizonMinutes } = board.data || {};

  return (
    <>
      <PageHeader
        title="Dispatch"
        subtitle={`Rides with no driver, in the next ${Math.round((horizonMinutes || 180) / 60)} hours.`}
        live updatedAt={board.updatedAt} refreshing={board.refreshing}
      />

      <div style={{ padding: '0 24px 32px' }}>
        {board.error && <ErrorNote error={board.error} onRetry={board.refresh} stale />}

        <div className="row wrap" style={{ gap: 8, marginBottom: 14 }}>
          {counts.needsDispatch > 0 && <Pill level="critical">{counts.needsDispatch} need manual dispatch</Pill>}
          {counts.overdue > 0 && <Pill level="critical">{counts.overdue} past pickup</Pill>}
          {counts.total > 0 && counts.needsDispatch === 0 && counts.overdue === 0 && (
            <Pill level="neutral">{counts.total} upcoming</Pill>
          )}
        </div>

        <Panel pad={false}>
          {rides.length === 0 ? (
            <Empty
              title="Every ride has a driver"
              note="Nothing in the dispatch window is waiting to be placed. Rides that automated dispatch cannot fill will appear here."
            />
          ) : (
            <div className="scroll-x">
              <table className="table">
                <thead>
                  <tr>
                    <th style={{ width: 34 }} />
                    <th>Pickup</th>
                    <th>Ride</th>
                    <th>Route</th>
                    <th className="r">Fare</th>
                    <th className="r">Tried</th>
                    <th style={{ width: 100 }} />
                  </tr>
                </thead>
                <tbody>
                  {rides.map((ride) => (
                    <tr key={ride.id} className={`sev-${ride.severity}`} data-clickable onClick={() => onOpenRide(ride.id)}>
                      <td><span className={`dot${ride.severity === 'critical' ? ' pulse' : ''}`} /></td>

                      <td style={{ minWidth: 150 }}>
                        <div className="num" style={{
                          fontSize: 13.5, fontWeight: 600,
                          color: ride.overdue ? 'var(--state-critical)' : 'var(--ink)',
                        }}>
                          {untilPickup(ride.minutesToPickup)}
                        </div>
                        <div className="faint num" style={{ fontSize: 12 }}>{clock(ride.scheduled_at)}</div>
                      </td>

                      <td>
                        <div className="ref">{ride.reference}</div>
                        <div className="faint" style={{ fontSize: 12 }}>{ride.statusLabel}</div>
                      </td>

                      <td style={{ maxWidth: 300 }}>
                        <div className="truncate" style={{ fontSize: 13 }}>{shortAddress(ride.pickup_address)}</div>
                        <div className="faint truncate" style={{ fontSize: 12 }}>→ {shortAddress(ride.dropoff_address)}</div>
                      </td>

                      <td className="r num" style={{ fontSize: 13 }}>
                        {money(ride.fare)}
                        <div className="faint" style={{ fontSize: 12 }}>{miles(ride.distance_miles)}</div>
                      </td>

                      {/* How many broadcast rounds the automated dispatcher
                          already burned. A high number means drivers are
                          actively declining, which is a different problem
                          from nobody being online. */}
                      <td className="r num faint" style={{ fontSize: 12.5 }}>
                        {ride.dispatch_round > 0 ? `${ride.dispatch_round} round${ride.dispatch_round > 1 ? 's' : ''}` : '—'}
                        {ride.dispatched_at && <div style={{ fontSize: 11 }}>{relative(ride.dispatched_at)}</div>}
                      </td>

                      <td onClick={(e) => e.stopPropagation()}>
                        {can('dispatch.assign') ? (
                          <button className="btn btn-sm btn-primary" onClick={() => setSelected(ride)}>Assign</button>
                        ) : (
                          <span className="faint" style={{ fontSize: 12 }}>View only</span>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </Panel>
      </div>

      {selected && (
        <AssignSheet
          ride={selected}
          onClose={() => setSelected(null)}
          onAssigned={() => { setSelected(null); board.refresh(); }}
        />
      )}
    </>
  );
}

// The assignment sheet. Candidates are ranked by the API and every candidate
// carries its blockers and warnings, so an operator can see WHY someone is or
// is not a good choice without opening six driver profiles.
function AssignSheet({ ride, onClose, onAssigned }) {
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
      subtitle={`${shortAddress(ride.pickup_address)} · ${untilPickup(ride.minutesToPickup)}`}
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

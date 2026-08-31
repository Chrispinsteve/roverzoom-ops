import { useState } from 'react';
import { api } from '../lib/api';
import { useApi } from '../lib/useApi';
import { useAuth } from '../lib/auth';
import { PageHeader } from '../components/Shell';
import { Panel, Pill, Empty, Loading, ErrorNote } from '../components/ui';
import { AssignSheet } from '../components/AssignSheet';
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

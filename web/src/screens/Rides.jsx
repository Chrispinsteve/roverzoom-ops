import { useState, useEffect } from 'react';
import { api } from '../lib/api';
import { useApi } from '../lib/useApi';
import { useAuth } from '../lib/auth';
import { PageHeader } from '../components/Shell';
import { Panel, Empty, Loading, ErrorNote, Chips } from '../components/ui';
import { money, dayAndClock, shortAddress } from '../lib/format';

const GROUPS = [
  { value: '',               label: 'All' },
  { value: 'live',           label: 'Live',           level: 'active' },
  { value: 'needs_dispatch', label: 'Needs dispatch', level: 'critical' },
  { value: 'unassigned',     label: 'Unassigned',     level: 'warn' },
  { value: 'completed',      label: 'Completed' },
  { value: 'canceled',       label: 'Canceled' },
];

const PAGE = 50;

export function Rides({ initialFilters = {}, onOpenRide }) {
  const { admin } = useAuth();
  const [group, setGroup] = useState(initialFilters.group || '');
  const [q, setQ] = useState('');
  const [term, setTerm] = useState('');
  const [offset, setOffset] = useState(0);

  // Debounce so typing a reference does not fire a request per keystroke.
  useEffect(() => {
    const timer = setTimeout(() => { setTerm(q); setOffset(0); }, 250);
    return () => clearTimeout(timer);
  }, [q]);

  const { data, loading, error, refresh } = useApi(
    () => api.rides({ group, q: term, limit: PAGE, offset }),
    { deps: [group, term, offset] }
  );

  const rides = data?.rides || [];
  const total = data?.total;

  return (
    <>
      <PageHeader
        title="Rides"
        subtitle="Every booking, searchable by reference, address or rider."
        actions={<button className="btn btn-sm" onClick={refresh}>Refresh</button>}
      />

      <div style={{ padding: '0 24px 32px' }}>
        <div className="row-between wrap" style={{ gap: 12, marginBottom: 14 }}>
          <Chips options={GROUPS} value={group} onChange={(v) => { setGroup(v); setOffset(0); }} />
          <input
            className="field"
            style={{ maxWidth: 300 }}
            placeholder={admin?.permissions.includes('riders.pii') ? 'Reference, address, rider…' : 'Reference or address…'}
            value={q}
            onChange={(e) => setQ(e.target.value)}
          />
        </div>

        {data?.piiRedacted && (
          <div className="faint" style={{ fontSize: 12, marginBottom: 10 }}>
            Rider contact details are hidden for your role, and are not searchable.
          </div>
        )}

        {error && <ErrorNote error={error} onRetry={refresh} stale={rides.length > 0} />}

        <Panel pad={false}>
          {loading && !data ? <Loading rows={6} /> : rides.length === 0 ? (
            <Empty title="No rides match" note="Try a different filter, or clear the search." />
          ) : (
            <div className="scroll-x">
              <table className="table">
                <thead>
                  <tr>
                    <th style={{ width: 34 }} />
                    <th>Ride</th>
                    <th>Scheduled</th>
                    <th>Route</th>
                    <th>Rider</th>
                    <th>Driver</th>
                    <th className="r">Fare</th>
                  </tr>
                </thead>
                <tbody>
                  {rides.map((r) => (
                    <tr key={r.id} className={`sev-${r.severity}`} data-clickable onClick={() => onOpenRide(r.id)}>
                      <td><span className="dot" /></td>
                      <td>
                        <div className="ref">{r.reference}</div>
                        <div className="faint" style={{ fontSize: 12 }}>{r.statusLabel}</div>
                      </td>
                      <td className="num" style={{ fontSize: 12.5, whiteSpace: 'nowrap' }}>{dayAndClock(r.scheduled_at)}</td>
                      <td style={{ maxWidth: 260 }}>
                        <div className="truncate" style={{ fontSize: 13 }}>{shortAddress(r.pickup_address)}</div>
                        <div className="faint truncate" style={{ fontSize: 12 }}>→ {shortAddress(r.dropoff_address)}</div>
                      </td>
                      <td style={{ fontSize: 12.5 }}>
                        <div className="truncate" style={{ maxWidth: 140 }}>{r.rider_name || '—'}</div>
                        <div className="faint mono" style={{ fontSize: 11.5 }}>{r.rider_phone || ''}</div>
                      </td>
                      <td style={{ fontSize: 12.5 }}>
                        {r.driver_name || <span className="faint">unassigned</span>}
                      </td>
                      <td className="r num" style={{ fontSize: 13 }}>
                        {money(r.fare)}
                        <div className="faint" style={{ fontSize: 11.5 }}>
                          {r.payment_method}{r.payment_status !== 'paid' && r.payment_method === 'card' ? ' · unpaid' : ''}
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </Panel>

        {total != null && total > PAGE && (
          <div className="row-between" style={{ marginTop: 12 }}>
            <span className="faint num" style={{ fontSize: 12.5 }}>
              {offset + 1}–{Math.min(offset + PAGE, total)} of {total.toLocaleString()}
            </span>
            <div className="row" style={{ gap: 8 }}>
              <button className="btn btn-sm" disabled={offset === 0} onClick={() => setOffset(Math.max(0, offset - PAGE))}>Previous</button>
              <button className="btn btn-sm" disabled={offset + PAGE >= total} onClick={() => setOffset(offset + PAGE)}>Next</button>
            </div>
          </div>
        )}
      </div>
    </>
  );
}

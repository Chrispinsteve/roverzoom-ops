import { useState } from 'react';
import { api } from '../lib/api';
import { useApi } from '../lib/useApi';
import { useAuth } from '../lib/auth';
import { PageHeader } from '../components/Shell';
import { Panel, Metric, Pill, Empty, Loading, ErrorNote, Chips } from '../components/ui';
import { money, money0, count, day, relative } from '../lib/format';

const RANGES = [
  { value: '7',  label: '7 days' },
  { value: '30', label: '30 days' },
  { value: '90', label: '90 days' },
];

const TABS = [
  { value: 'summary',        label: 'Summary' },
  { value: 'balances',       label: 'Driver balances' },
  { value: 'reconciliation', label: 'Reconciliation' },
  { value: 'payouts',        label: 'Payouts' },
];

export function Finance() {
  const [tab, setTab] = useState('summary');
  const [days, setDays] = useState('30');

  return (
    <>
      <PageHeader
        title="Finance"
        subtitle="What came in, what is owed, and whether the books agree."
      />
      <div style={{ padding: '0 24px 32px' }}>
        <div className="row-between wrap" style={{ gap: 12, marginBottom: 16 }}>
          <Chips options={TABS} value={tab} onChange={setTab} />
          {(tab === 'summary' || tab === 'reconciliation') && (
            <Chips options={RANGES} value={days} onChange={setDays} />
          )}
        </div>

        {tab === 'summary' && <Summary days={days} />}
        {tab === 'balances' && <Balances />}
        {tab === 'reconciliation' && <Reconciliation days={days} />}
        {tab === 'payouts' && <Payouts />}
      </div>
    </>
  );
}

// Computed inside the fetcher, never during render: calling Date.now() while
// rendering yields a new value every render, which would re-fire the query in
// a loop.
const since = (days) => new Date(Date.now() - Number(days) * 86400_000).toISOString();

function Summary({ days }) {
  const { data, loading, error, refresh } = useApi(() => api.financeSummary({ from: since(days) }), { deps: [days] });
  if (loading && !data) return <Loading rows={4} height={70} />;
  if (error && !data) return <ErrorNote error={error} onRetry={refresh} />;
  if (!data) return null;

  const t = data.totals;
  const maxDay = Math.max(...data.daily.map((d) => d.gross), 1);

  return (
    <div className="col" style={{ gap: 18 }}>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(160px, 1fr))', gap: 10 }}>
        <Metric label="Rides completed" value={count(t.rides)} />
        <Metric label="Gross fares" value={money0(t.gross)} sub={`${money0(t.cardGross)} card · ${money0(t.cashGross)} cash`} />
        <Metric label="Driver earnings" value={money0(t.driverShare)} sub={`${Math.round(data.model.driverBaseShare * 100)}% of standard fare`} />
        <Metric label="Platform margin" value={money0(t.platformShare)}
          sub={t.gross > 0 ? `${Math.round((t.platformShare / t.gross) * 100)}% of gross` : undefined} />
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))', gap: 10 }}>
        <Metric label="Promo absorbed" value={money0(t.discountAbsorbed)}
          sub={`against ${money0(t.standardValue)} of list price — paid entirely from platform margin`} />
        <Metric label="Commission held by drivers" value={money0(t.commissionHeldByDrivers)}
          sub="from cash rides, netted out of their next card cash-out"
          level={t.commissionHeldByDrivers > 0 ? 'warn' : 'neutral'} />
        <Metric label="Unsettled card rides" value={count(data.unsettledCardRides.count)}
          sub={`${money0(data.unsettledCardRides.value)} completed but never marked paid`}
          level={data.unsettledCardRides.count > 0 ? 'critical' : 'neutral'} />
      </div>

      {data.daily.length > 0 && (
        <Panel title="Daily gross">
          {/* A bare column chart. Operators use this to spot the shape of a
              week, not to read exact values — those are in the table above. */}
          <div style={{ display: 'flex', alignItems: 'flex-end', gap: 3, height: 120 }}>
            {data.daily.map((d) => (
              <div key={d.day} className="grow" title={`${d.day}: ${money(d.gross)} · ${d.rides} rides`}
                style={{ display: 'flex', flexDirection: 'column', justifyContent: 'flex-end', height: '100%', minWidth: 4 }}>
                <div style={{
                  height: `${Math.max((d.gross / maxDay) * 100, 1.5)}%`,
                  background: 'var(--state-active)', opacity: 0.75,
                  borderRadius: '3px 3px 0 0',
                }} />
              </div>
            ))}
          </div>
          <div className="row-between faint" style={{ fontSize: 11.5, marginTop: 8 }}>
            <span>{day(data.daily[0].day)}</span>
            <span>{day(data.daily[data.daily.length - 1].day)}</span>
          </div>
        </Panel>
      )}
    </div>
  );
}

function Balances() {
  const { data, loading, error, refresh } = useApi(() => api.balances());
  if (loading && !data) return <Loading rows={6} />;
  if (error && !data) return <ErrorNote error={error} onRetry={refresh} />;
  if (!data) return null;

  return (
    <div className="col" style={{ gap: 14 }}>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))', gap: 10 }}>
        <Metric label="Payable to drivers" value={money0(data.totals.payable)} />
        <Metric label="Owed back to platform" value={money0(Math.abs(data.totals.owedToPlatform))}
          sub="cash commission not yet netted"
          level={data.totals.owedToPlatform < 0 ? 'warn' : 'neutral'} />
        <Metric label="Paid out to date" value={money0(data.totals.paidOut)} />
      </div>

      <Panel pad={false}>
        {data.balances.length === 0 ? <Empty title="No earnings recorded yet" /> : (
          <div className="scroll-x">
            <table className="table">
              <thead>
                <tr>
                  <th>Driver</th>
                  <th className="r">Lifetime</th>
                  <th className="r">Cash collected</th>
                  <th className="r">Paid out</th>
                  <th className="r">Balance</th>
                </tr>
              </thead>
              <tbody>
                {data.balances.map((b) => (
                  <tr key={b.driver_id} className={b.owesPlatform ? 'sev-warn' : ''}>
                    <td>
                      <div style={{ fontSize: 13 }}>{b.name}</div>
                      <div className="faint" style={{ fontSize: 11.5 }}>{b.rides_completed} rides · {b.status}</div>
                    </td>
                    <td className="r num" style={{ fontSize: 13 }}>{money(b.lifetime)}</td>
                    <td className="r num faint" style={{ fontSize: 12.5 }}>{money(b.cashCollected)}</td>
                    <td className="r num faint" style={{ fontSize: 12.5 }}>{money(b.paidOut)}</td>
                    <td className="r num" style={{ fontSize: 13, fontWeight: 600, color: b.owesPlatform ? 'var(--sev)' : 'var(--ink)' }}>
                      {money(b.payable)}
                      {b.owesPlatform && <div className="faint" style={{ fontSize: 11, fontWeight: 400 }}>owes platform</div>}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Panel>
    </div>
  );
}

// The screen that catches money quietly going missing.
function Reconciliation({ days }) {
  const { data, loading, error, refresh } = useApi(() => api.reconciliation({ from: since(days) }), { deps: [days] });
  if (loading && !data) return <Loading rows={4} />;
  if (error && !data) return <ErrorNote error={error} onRetry={refresh} />;
  if (!data) return null;

  const findings = Object.entries(data.findings);
  const clean = findings.every(([, f]) => f.count === 0);

  return (
    <div className="col" style={{ gap: 14 }}>
      <Panel>
        <div className="row" style={{ gap: 11 }}>
          <span className={`sev-${clean ? 'active' : 'critical'}`} style={{ display: 'inline-flex' }}>
            <span className="dot" />
          </span>
          <div className="grow">
            <div style={{ fontSize: 13.5, fontWeight: 500 }}>
              {clean ? 'The books agree' : 'Discrepancies found'}
            </div>
            <div className="faint" style={{ fontSize: 12.5, marginTop: 2 }}>
              {count(data.checked)} completed rides checked against the earnings ledger and the payout model.
            </div>
          </div>
        </div>
      </Panel>

      {findings.map(([key, f]) => (
        <Panel key={key} pad={false}
          title={
            <div className="row" style={{ gap: 9 }}>
              <h2>{f.title}</h2>
              {f.count > 0
                ? <Pill level={f.severity}>{f.count}</Pill>
                : <Pill level="active">clear</Pill>}
            </div>
          }
        >
          <div style={{ padding: '12px 16px', borderBottom: f.count > 0 ? '1px solid var(--line)' : 'none' }}>
            <p className="muted" style={{ fontSize: 12.5, lineHeight: 1.55 }}>{f.explanation}</p>
            {f.value != null && f.count > 0 && (
              <div className="num" style={{ fontSize: 17, fontWeight: 600, marginTop: 8 }}>{money(f.value)}</div>
            )}
          </div>

          {f.count > 0 && (
            <div className="scroll-x">
              <table className="table">
                <thead>
                  <tr>
                    <th>Ride</th>
                    <th>Completed</th>
                    {key === 'amountMismatch' ? <><th className="r">Expected</th><th className="r">Recorded</th><th className="r">Delta</th></>
                      : <><th className="r">Amount</th><th className="r">Age</th></>}
                  </tr>
                </thead>
                <tbody>
                  {f.items.map((item) => (
                    <tr key={item.id}>
                      <td className="ref">{item.reference}</td>
                      <td className="faint num" style={{ fontSize: 12.5 }}>
                        {item.completed_at ? relative(item.completed_at) : '—'}
                      </td>
                      {key === 'amountMismatch' ? (
                        <>
                          <td className="r num">{money(item.expected)}</td>
                          <td className="r num">{money(item.actual)}</td>
                          <td className="r num sev-critical" style={{ color: 'var(--sev)', fontWeight: 600 }}>{money(item.delta)}</td>
                        </>
                      ) : (
                        <>
                          <td className="r num">{money(item.amount ?? item.fare)}</td>
                          <td className="r num faint">{item.ageDays != null ? `${item.ageDays}d` : '—'}</td>
                        </>
                      )}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </Panel>
      ))}
    </div>
  );
}

function Payouts() {
  const { can } = useAuth();
  const { data, loading, error, refresh } = useApi(() => api.payouts());
  const [busy, setBusy] = useState(null);

  async function markPaid(payout) {
    const ref = window.prompt(`External payout reference for ${payout.driver_name} (${money(payout.amount)})?`, payout.external_payout_id || '');
    if (ref === null) return;
    setBusy(payout.id);
    try {
      await api.markPayoutPaid(payout.id, { externalPayoutId: ref });
      refresh();
    } catch (err) {
      window.alert(err.message);
    } finally {
      setBusy(null);
    }
  }

  if (loading && !data) return <Loading rows={5} />;
  if (error && !data) return <ErrorNote error={error} onRetry={refresh} />;

  const payouts = data?.payouts || [];

  return (
    <Panel pad={false}>
      {payouts.length === 0 ? (
        <Empty title="No payout records"
          note="Payouts appear here once the driver backend writes driver_payouts rows. Card earnings transfer automatically through Stripe Connect at ride completion." />
      ) : (
        <div className="scroll-x">
          <table className="table">
            <thead>
              <tr>
                <th>Driver</th><th>Period</th><th>Status</th><th className="r">Amount</th><th />
              </tr>
            </thead>
            <tbody>
              {payouts.map((p) => (
                <tr key={p.id} className={p.status === 'paid' ? 'sev-active' : 'sev-warn'}>
                  <td style={{ fontSize: 13 }}>{p.driver_name || p.driver_id}</td>
                  <td className="faint num" style={{ fontSize: 12.5 }}>{day(p.period_start)} – {day(p.period_end)}</td>
                  <td><Pill level={p.status === 'paid' ? 'active' : 'warn'}>{p.status}</Pill></td>
                  <td className="r num" style={{ fontSize: 13, fontWeight: 600 }}>{money(p.amount)}</td>
                  <td className="r">
                    {p.status === 'pending' && can('finance.payout') && (
                      <button className="btn btn-sm" disabled={busy === p.id} onClick={() => markPaid(p)}>
                        {busy === p.id ? 'Saving…' : 'Mark paid'}
                      </button>
                    )}
                    {p.status === 'paid' && p.external_payout_id && (
                      <span className="faint mono" style={{ fontSize: 11.5 }}>{p.external_payout_id}</span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </Panel>
  );
}

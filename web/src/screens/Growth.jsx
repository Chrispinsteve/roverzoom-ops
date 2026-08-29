import { useState } from 'react';
import { api } from '../lib/api';
import { useApi } from '../lib/useApi';
import { PageHeader } from '../components/Shell';
import { Panel, Metric, Empty, Loading, ErrorNote, Chips, Pill } from '../components/ui';
import { count, money, day } from '../lib/format';

const RANGES = [
  { value: '7', label: '7 days' },
  { value: '30', label: '30 days' },
  { value: '90', label: '90 days' },
];

export function Growth() {
  const [days, setDays] = useState('30');
  const [source, setSource] = useState('all');

  const traffic = useApi(() => api.traffic({ days }), { deps: [days] });
  const funnel = useApi(() => api.funnel({ days, source }), { deps: [days, source] });

  const t = traffic.data;
  const f = funnel.data;
  const notInstalled = (t && t.installed === false) || (f && f.installed === false);

  return (
    <>
      <PageHeader
        title="Growth"
        subtitle="Where visitors come from, and where they stop."
        actions={<Chips options={RANGES} value={days} onChange={setDays} />}
      />

      <div style={{ padding: '0 24px 32px', display: 'flex', flexDirection: 'column', gap: 18 }}>
        {traffic.error && <ErrorNote error={traffic.error} onRetry={traffic.reload} />}

        {t && t.installed && t.attributionAvailable === false && (
          <div className="sev-warn" style={{
            display: 'flex', gap: 11, alignItems: 'flex-start',
            padding: '12px 14px', borderRadius: 'var(--r-sm)',
            background: 'var(--sev-wash)', border: '1px solid var(--sev-line)',
          }}>
            <span className="dot" style={{ marginTop: 6 }} />
            <div style={{ fontSize: 13, lineHeight: 1.55 }}>
              <strong style={{ color: 'var(--sev)' }}>Only Google traffic can be identified.</strong>
              <div className="muted" style={{ marginTop: 3 }}>
                Visits are being counted, but the source columns are missing so Facebook, Instagram,
                Nextdoor, campaigns and QR codes all fall together. Run{' '}
                <span className="mono">db/003_site_events_attribution.sql</span> to break them out.
              </div>
            </div>
          </div>
        )}

        {notInstalled ? (
          <Panel>
            <Empty
              title="Traffic tracking is not installed"
              note="The site_events table does not exist yet. Run db/002_site_events.sql and db/003_site_events_attribution.sql against Supabase, then add the track() calls to the rider app — see integration/README.md."
            />
          </Panel>
        ) : t && t.totals.visits === 0 ? (
          // The table exists but nothing has ever been sent. Different problem,
          // different fix — saying "0 visits" here would read as "nobody came",
          // which is not what happened.
          <Panel>
            <Empty
              title="Nothing has been received yet"
              note="The table is installed and this screen is working — but the rider site has not sent a single event, so there is nothing to count. Add the seven track() calls to the rider app and deploy it (integration/README.md). Data starts from the moment it ships and cannot be backfilled."
            />
          </Panel>
        ) : traffic.loading && !t ? (
          <Loading rows={4} height={70} />
        ) : t ? (
          <>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(160px, 1fr))', gap: 10 }}>
              <Metric label="Visits" value={count(t.totals.visits)} />
              <Metric label="Booked" value={count(t.totals.booked)}
                sub={`${t.totals.conversionPct}% of visits`}
                level={t.totals.booked > 0 ? 'active' : 'neutral'} />
              <Metric label="Paid visits" value={count(t.ads.visits)}
                sub={`${t.ads.shareOfTraffic}% of all traffic, every platform`} />
              <Metric label="Paid bookings" value={count(t.ads.booked)}
                sub={`${t.ads.conversionPct}% of paid visits`}
                level={t.ads.visits > 0 && t.ads.booked === 0 ? 'warn' : 'neutral'} />
            </div>

            {t.daily.length > 0 && <DailyChart daily={t.daily} />}

            <FunnelPanel funnel={f} loading={funnel.loading} error={funnel.error}
              source={source} onSource={setSource} onRetry={funnel.reload}
              sources={t.bySource || []} />

            {t.attributionAvailable !== false && (
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(320px, 1fr))', gap: 14 }}>
                <BreakdownTable title="Where traffic comes from" rows={t.bySource} label="Source" useLabel />
                <BreakdownTable title="Paid, social, search or direct" rows={t.byMedium} label="Type" useLabel />
              </div>
            )}

            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(320px, 1fr))', gap: 14 }}>
              <BreakdownTable title="Where visitors are" rows={t.byCity} label="City" />
              {t.attributionAvailable !== false && t.byCampaign && t.byCampaign.length > 0
                ? <BreakdownTable title="Campaigns" rows={t.byCampaign} label="Campaign" />
                : t.attributionAvailable === false ? null : <Panel title="Campaigns">
                    <Empty title="No tagged campaigns yet"
                      note="Add utm_campaign to the links you post on Facebook, Nextdoor and your printed flyers, and each one will be listed here with its own conversion rate. See integration/README.md." />
                  </Panel>}
            </div>
          </>
        ) : null}
      </div>
    </>
  );
}

function DailyChart({ daily }) {
  const max = Math.max(...daily.map((d) => d.visits), 1);
  return (
    <Panel title="Visits per day">
      <div style={{ display: 'flex', alignItems: 'flex-end', gap: 3, height: 110 }}>
        {daily.map((d) => (
          <div key={d.day} className="grow" title={`${d.day}: ${d.visits} visits, ${d.booked} booked`}
            style={{ display: 'flex', flexDirection: 'column', justifyContent: 'flex-end', height: '100%', minWidth: 3, gap: 1 }}>
            {/* Booked sits on top of visits so the ratio is visible without a
                second chart — the gap between the two IS the drop-off. */}
            {d.booked > 0 && (
              <div style={{ height: `${(d.booked / max) * 100}%`, background: 'var(--state-active)', borderRadius: '2px 2px 0 0' }} />
            )}
            <div style={{ height: `${Math.max(((d.visits - d.booked) / max) * 100, 1)}%`, background: 'var(--surface-3)' }} />
          </div>
        ))}
      </div>
      <div className="row-between faint" style={{ fontSize: 11.5, marginTop: 8 }}>
        <span>{day(daily[0].day)}</span>
        <span className="row" style={{ gap: 12 }}>
          <span className="row" style={{ gap: 5 }}>
            <span style={{ width: 8, height: 8, borderRadius: 2, background: 'var(--state-active)' }} /> booked
          </span>
          <span className="row" style={{ gap: 5 }}>
            <span style={{ width: 8, height: 8, borderRadius: 2, background: 'var(--surface-3)' }} /> left
          </span>
        </span>
        <span>{day(daily[daily.length - 1].day)}</span>
      </div>
    </Panel>
  );
}

// The answer to "why do people visit and not book?".
function FunnelPanel({ funnel, loading, error, source, onSource, onRetry, sources = [] }) {
  if (loading && !funnel) return <Loading rows={4} />;
  if (error) return <ErrorNote error={error} onRetry={onRetry} />;
  if (!funnel || funnel.installed === false) return null;

  const max = funnel.steps[0]?.sessions || 1;

  return (
    <Panel
      title={
        <div className="row" style={{ gap: 10 }}>
          <h2>Booking funnel</h2>
          {!funnel.enoughData && <Pill level="warn">Not enough data</Pill>}
        </div>
      }
      action={
        // Only offer sources that actually have traffic — a filter that always
        // returns nothing teaches an operator to distrust the screen.
        <Chips
          options={[
            { value: 'all', label: 'All traffic' },
            { value: 'paid', label: 'Paid only' },
            ...sources.filter((s) => s.visits > 0 && s.key !== 'Unknown').slice(0, 4)
              .map((s) => ({ value: s.key, label: s.label || s.key })),
          ]}
          value={source} onChange={onSource}
        />
      }
    >
      {/* Refusing to draw conclusions from a handful of visits is the point.
          A funnel over nine sessions looks authoritative and means nothing. */}
      {!funnel.enoughData && (
        <p className="muted" style={{ fontSize: 12.5, marginBottom: 14, lineHeight: 1.55 }}>
          Only {funnel.totalSessions} visit{funnel.totalSessions === 1 ? '' : 's'} recorded in this window.
          Percentages below are shown, but treat them as anecdote until there are at least{' '}
          {funnel.minimumForConfidence}.
        </p>
      )}

      <div className="col" style={{ gap: 3 }}>
        {funnel.steps.map((step, i) => (
          <div key={step.key}>
            <div className="row-between" style={{ fontSize: 12.5, marginBottom: 3 }}>
              <span>{step.label}</span>
              <span className="row num" style={{ gap: 10 }}>
                <span style={{ fontWeight: 600 }}>{count(step.sessions)}</span>
                {i > 0 && step.lost > 0 && (
                  <span style={{ color: 'var(--state-warn)', minWidth: 54, textAlign: 'right' }}>
                    −{step.lostPct}%
                  </span>
                )}
                {i === 0 && <span className="faint" style={{ minWidth: 54, textAlign: 'right' }}>—</span>}
              </span>
            </div>
            <div style={{ height: 8, background: 'var(--surface-2)', borderRadius: 3, overflow: 'hidden' }}>
              <div style={{
                width: `${(step.sessions / max) * 100}%`, height: '100%',
                background: i === funnel.steps.length - 1 ? 'var(--state-active)' : 'var(--ink-4)',
                borderRadius: 3, transition: 'width 300ms var(--ease)',
              }} />
            </div>
          </div>
        ))}
      </div>

      {funnel.worstDropOff && (
        <div className="sev-warn" style={{
          marginTop: 16, padding: '11px 13px', borderRadius: 'var(--r-sm)',
          background: 'var(--sev-wash)', border: '1px solid var(--sev-line)',
          fontSize: 12.5, lineHeight: 1.55,
        }}>
          <strong style={{ color: 'var(--sev)' }}>
            Biggest drop: {funnel.worstDropOff.from} → {funnel.worstDropOff.to}
          </strong>
          <div className="muted" style={{ marginTop: 3 }}>
            {funnel.worstDropOff.lost} of them left here ({funnel.worstDropOff.lostPct}%). {funnel.worstDropOff.hint}
          </div>
        </div>
      )}

      {funnel.price.quotesSeen > 0 && funnel.price.avgQuoteAbandoned != null && (
        <div style={{ marginTop: 12, fontSize: 12.5 }}>
          <div className="eyebrow" style={{ marginBottom: 5 }}>Price seen</div>
          <div className="row" style={{ gap: 20 }}>
            <span>Booked: <strong className="num">{money(funnel.price.avgQuoteBooked)}</strong></span>
            <span>Left: <strong className="num">{money(funnel.price.avgQuoteAbandoned)}</strong></span>
          </div>
          {funnel.price.avgQuoteBooked != null && funnel.price.avgQuoteAbandoned > funnel.price.avgQuoteBooked * 1.2 && (
            <p className="muted" style={{ marginTop: 6, lineHeight: 1.5 }}>
              People who left were quoted noticeably more than people who booked. That points at price
              rather than the flow.
            </p>
          )}
        </div>
      )}
    </Panel>
  );
}

function BreakdownTable({ title, rows, label, useLabel }) {
  if (!rows || !rows.length) {
    return <Panel title={title}><Empty title="No data yet" /></Panel>;
  }
  return (
    <Panel title={title} pad={false}>
      <div className="scroll-x">
        <table className="table">
          <thead>
            <tr><th>{label}</th><th className="r">Visits</th><th className="r">Booked</th><th className="r">Rate</th></tr>
          </thead>
          <tbody>
            {rows.slice(0, 12).map((r) => (
              <tr key={r.key}>
                <td style={{ fontSize: 13 }}>{useLabel ? (r.label || r.key) : r.key}</td>
                <td className="r num" style={{ fontSize: 13 }}>{count(r.visits)}</td>
                <td className="r num" style={{ fontSize: 13 }}>{count(r.booked)}</td>
                <td className="r num" style={{ fontSize: 12.5, color: r.booked > 0 ? 'var(--state-active)' : 'var(--ink-4)' }}>
                  {r.conversionPct}%
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </Panel>
  );
}

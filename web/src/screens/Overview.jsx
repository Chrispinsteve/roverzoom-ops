import { api } from '../lib/api';
import { useApi } from '../lib/useApi';
import { useAuth } from '../lib/auth';
import { PageHeader } from '../components/Shell';
import { Panel, Metric, Empty, Loading, ErrorNote, Pill, Restricted } from '../components/ui';
import { money0, count } from '../lib/format';

// The attention feed is the whole point of this screen. Everything below it is
// context for the feed, not a competing display — which is why the feed gets
// the full width and the top of the page, and the numbers sit underneath.
const POLL_MS = 15_000;

export function Overview({ onOpenRide, onNavigate }) {
  const { can } = useAuth();
  const { data, error, loading, refreshing, updatedAt, refresh } = useApi(() => api.overview(), { poll: POLL_MS });

  if (loading && !data) return <><PageHeader title="Overview" /><Loading rows={4} height={64} /></>;
  if (error && !data) return <><PageHeader title="Overview" /><div style={{ padding: 24 }}><ErrorNote error={error} onRetry={refresh} /></div></>;
  if (!data) return null;

  const { attention, live, supply, trust, today } = data;

  return (
    <>
      <PageHeader
        title="Overview"
        subtitle="What needs a person right now, and the shape of the day."
        live updatedAt={updatedAt} refreshing={refreshing}
      />

      <div style={{ padding: '0 24px 32px', display: 'flex', flexDirection: 'column', gap: 20 }}>
        {error && <ErrorNote error={error} onRetry={refresh} stale />}

        <AttentionFeed feed={attention} onOpenRide={onOpenRide} onNavigate={onNavigate} />

        {/* Live operations */}
        <div>
          <div className="eyebrow" style={{ marginBottom: 10 }}>Right now</div>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(148px, 1fr))', gap: 10 }}>
            <Metric label="Rides live" value={count(live.activeTotal)}
              sub={`${live.byStatus.in_progress || 0} on trip · ${live.byStatus.driver_en_route || 0} en route`}
              level={live.activeTotal > 0 ? 'active' : 'neutral'}
              onClick={() => onNavigate('rides', { group: 'live' })} />
            <Metric label="Awaiting a driver" value={count(live.unassignedUpcoming)}
              sub="in the next 90 min"
              level={live.unassignedUpcoming > 0 ? 'warn' : 'neutral'}
              onClick={() => onNavigate('dispatch')} />
            <Metric label="Drivers online" value={count(supply.online)}
              sub={`${supply.availableNow} free now · ${supply.onTrip} on trip`} />
            <Metric label="Location live" value={count(supply.locationLive)}
              sub={`of ${supply.online} online`}
              level={supply.online > 0 && supply.locationLive < supply.online / 2 ? 'warn' : 'neutral'} />
          </div>
        </div>

        {/* Trust — deliberately its own band. The unvetted number is the single
            most important figure in this console and must not be buried in a
            row of ordinary metrics. */}
        <div>
          <div className="eyebrow" style={{ marginBottom: 10 }}>Driver trust</div>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(148px, 1fr))', gap: 10 }}>
            <Metric label="Driving unvetted" value={count(trust.unvettedDriving)}
              sub="able to take rides, never reviewed"
              level={trust.unvettedDriving > 0 ? 'critical' : 'active'}
              onClick={() => onNavigate('drivers', { standing: 'unvetted_driving' })} />
            <Metric label="Screening flagged" value={count(trust.flagged)}
              sub="Checkr returned consider"
              level={trust.flagged > 0 ? 'critical' : 'neutral'}
              onClick={() => onNavigate('drivers', { standing: 'screening_consider' })} />
            <Metric label="Awaiting review" value={count(trust.awaitingReview)}
              level={trust.awaitingReview > 0 ? 'warn' : 'neutral'}
              onClick={() => onNavigate('drivers', { standing: 'awaiting_review' })} />
            <Metric label="Cleared" value={count(trust.cleared)}
              sub={`${trust.suspended} suspended`}
              level={trust.cleared > 0 ? 'active' : 'neutral'}
              onClick={() => onNavigate('drivers', { standing: 'cleared' })} />
          </div>
        </div>

        {/* Money */}
        <div>
          <div className="eyebrow" style={{ marginBottom: 10 }}>
            Today · since midnight {today.timezone.split('/')[1].replace('_', ' ')}
          </div>
          {can('finance.read') ? (
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(148px, 1fr))', gap: 10 }}>
              <Metric label="Rides completed" value={count(today.completed)} />
              <Metric label="Gross fares" value={money0(today.gross)} />
              <Metric label="Driver earnings" value={money0(today.driverShare)} sub="57.5% of standard fare" />
              <Metric label="Platform margin" value={money0(today.platformShare)}
                sub={today.cashCollected > 0 ? `${money0(today.cashCollected)} collected in cash` : undefined} />
            </div>
          ) : (
            <Panel><Restricted what="revenue and earnings" /></Panel>
          )}
        </div>
      </div>
    </>
  );
}

function AttentionFeed({ feed, onOpenRide, onNavigate }) {
  const { items, counts } = feed;

  return (
    <Panel
      pad={false}
      title={
        <div className="row" style={{ gap: 10 }}>
          <h2>Needs attention</h2>
          {counts.critical > 0 && <Pill level="critical">{counts.critical} critical</Pill>}
          {counts.warn > 0 && <Pill level="warn">{counts.warn} warning{counts.warn > 1 ? 's' : ''}</Pill>}
        </div>
      }
    >
      {items.length === 0 ? (
        // "Nothing needs you" must be a real, confident answer. If this state
        // looked like an error or an empty table, operators would stop
        // believing the feed when it IS empty.
        <Empty
          title="Nothing needs a person right now"
          note="Every live ride has a driver, no one is waiting past their pickup, and every driver carrying passengers has been vetted."
        />
      ) : (
        <ul style={{ listStyle: 'none', margin: 0, padding: 0 }}>
          {items.map((item, i) => (
            <AttentionRow
              key={`${item.kind}-${item.subjectId}-${i}`}
              item={item}
              last={i === items.length - 1}
              onOpen={() => {
                if (item.subjectType === 'booking') onOpenRide(item.subjectId);
                else if (item.subjectType === 'driver_group') onNavigate('drivers', { standing: item.subjectId });
              }}
            />
          ))}
        </ul>
      )}
    </Panel>
  );
}

const ACTION_LABEL = {
  assign: 'Assign a driver',
  contact: 'Open ride',
  review: 'Review drivers',
  watch: 'Open ride',
};

function AttentionRow({ item, last, onOpen }) {
  return (
    <li className={`sev-${item.severity}`}>
      <button
        onClick={onOpen}
        style={{
          display: 'flex', alignItems: 'center', gap: 12, width: '100%', textAlign: 'left',
          padding: '13px 16px',
          borderBottom: last ? 'none' : '1px solid var(--line-faint)',
          transition: 'background 120ms var(--ease)',
        }}
        onMouseEnter={(e) => { e.currentTarget.style.background = 'var(--surface-2)'; }}
        onMouseLeave={(e) => { e.currentTarget.style.background = 'transparent'; }}
      >
        <span className={`dot${item.severity === 'critical' ? ' pulse' : ''}`} style={{ marginTop: 1 }} />

        <span className="col grow" style={{ gap: 2, minWidth: 0 }}>
          <span className="row" style={{ gap: 8 }}>
            <span style={{ fontSize: 13.5, fontWeight: 500, color: 'var(--sev)' }}>{item.title}</span>
            {item.reference && <span className="ref">{item.reference}</span>}
          </span>
          <span className="muted truncate" style={{ fontSize: 12.5 }}>{item.detail}</span>
        </span>

        <span className="faint" style={{ fontSize: 12, flex: 'none' }}>
          {ACTION_LABEL[item.action] || 'Open'} →
        </span>
      </button>
    </li>
  );
}

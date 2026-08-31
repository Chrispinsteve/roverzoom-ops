// Formatting for an operations context.
//
// The guiding rule: an operator is reading under time pressure, so every
// value is rendered in the form that takes the least thought. Relative time
// for anything live ("4 min ago"), absolute clock time for anything scheduled
// ("2:15 PM"), and never a raw ISO string anywhere a human looks.

const TZ = import.meta.env.VITE_SERVICE_TZ || 'America/New_York';

export const money = (n) =>
  n == null ? '—' : `$${Number(n).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

// Whole dollars, for headline figures where cents are noise.
export const money0 = (n) =>
  n == null ? '—' : `$${Math.round(Number(n)).toLocaleString('en-US')}`;

export const count = (n) => (n == null ? '—' : Number(n).toLocaleString('en-US'));

export const miles = (n) => (n == null ? '—' : `${Number(n).toFixed(1)} mi`);

// Clock time in the service timezone — NOT the operator's browser timezone.
// A dispatcher covering Florida from anywhere must see Florida time, or every
// pickup time on the board is silently wrong.
export const clock = (iso) =>
  !iso ? '—' : new Date(iso).toLocaleTimeString('en-US', {
    timeZone: TZ, hour: 'numeric', minute: '2-digit',
  });

export const dayAndClock = (iso) =>
  !iso ? '—' : new Date(iso).toLocaleString('en-US', {
    timeZone: TZ, month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit',
  });

export const day = (iso) =>
  !iso ? '—' : new Date(iso).toLocaleDateString('en-US', {
    timeZone: TZ, month: 'short', day: 'numeric', year: 'numeric',
  });

// "in 12 min" / "4 min ago" / "just now". Minutes up to two hours, then hours,
// then days — an operator never needs "in 4,320 minutes".
export function relative(iso, now = Date.now()) {
  if (!iso) return '—';
  const deltaMin = Math.round((new Date(iso).getTime() - now) / 60000);
  const abs = Math.abs(deltaMin);
  if (abs < 1) return 'just now';
  const unit = abs < 120 ? [abs, 'min'] : abs < 2880 ? [Math.round(abs / 60), 'hr'] : [Math.round(abs / 1440), 'day'];
  const label = `${unit[0]} ${unit[1]}${unit[0] === 1 || unit[1] === 'min' ? '' : 's'}`;
  return deltaMin > 0 ? `in ${label}` : `${label} ago`;
}

// A countdown that stays honest when it goes negative: "12 min late" reads
// far more urgently than "in -12 min".
export function untilPickup(minutes) {
  if (minutes == null) return '—';
  if (minutes < 0) return `${Math.abs(minutes)} min late`;
  if (minutes === 0) return 'now';
  if (minutes < 60) return `in ${minutes} min`;
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return m ? `in ${h}h ${m}m` : `in ${h}h`;
}

export const duration = (minutes) => {
  if (minutes == null) return '—';
  if (minutes < 60) return `${minutes} min`;
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return m ? `${h} hr ${m} min` : `${h} hr`;
};

export const initials = (name) =>
  !name ? '??' : name.trim().split(/\s+/).slice(0, 2).map((p) => p[0]).join('').toUpperCase();

// Shortens a long street address to something scannable in a table cell,
// keeping the part that identifies the place.
export function shortAddress(address) {
  if (!address) return '—';
  const [first] = address.split(',');
  return first.trim();
}


// datetime-local works in wall-clock strings with no zone. These convert
// between an ISO instant and the SERVICE timezone's wall clock, so an operator
// working from anywhere sets Florida time rather than their own — the same
// reason clock() renders in TZ rather than the browser's zone.
export function toLocalInput(iso) {
  if (!iso) return '';
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hour12: false,
  }).formatToParts(new Date(iso));
  const g = (t) => (parts.find((p) => p.type === t) || {}).value;
  return `${g('year')}-${g('month')}-${g('day')}T${g('hour') === '24' ? '00' : g('hour')}:${g('minute')}`;
}

export function fromLocalInput(local) {
  if (!local) return null;
  // Read the wall clock as if it were UTC, then shift by the zone's offset at
  // that moment — which is what makes this correct across DST.
  const asUtc = new Date(`${local}:00Z`);
  const probe = new Date(asUtc.getTime());
  const offset =
    new Date(probe.toLocaleString('en-US', { timeZone: 'UTC' })).getTime() -
    new Date(probe.toLocaleString('en-US', { timeZone: TZ })).getTime();
  return new Date(asUtc.getTime() + offset).toISOString();
}

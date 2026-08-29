// Traffic attribution: where a visit actually came from.
//
// The first version of this only knew "Google ad or not", which is wrong for a
// local service business. Real traffic for a Palm Beach rideshare arrives from
// Facebook and Instagram, community sites like Nextdoor and Yelp, organic
// search, printed flyers with a QR code, and word of mouth — and each needs to
// be countable separately or "are the ads working?" cannot be answered for any
// channel except Google.
//
// Attribution is resolved in the browser (integration/roverzoom-track.js) and
// normalized HERE, server-side, so the vocabulary is fixed and a client cannot
// invent sources that fragment the reports.

// Platform click identifiers. Presence of one is strong evidence of PAID
// traffic from that platform, regardless of what else the URL claims.
const CLICK_IDS = {
  gclid: 'google',      // Google Ads
  gbraid: 'google',     // Google Ads, iOS
  wbraid: 'google',     // Google Ads, iOS web-to-app
  fbclid: 'facebook',   // Meta (Facebook or Instagram — referrer disambiguates)
  ttclid: 'tiktok',
  msclkid: 'bing',      // Microsoft Advertising
  twclid: 'twitter',
  li_fat_id: 'linkedin',
  epik: 'pinterest',
  sccid: 'snapchat',
};

// Referrer host -> source. Longest-suffix match, so `l.facebook.com` and
// `m.facebook.com` both resolve to facebook without listing every subdomain.
const REFERRER_SOURCES = [
  ['facebook.com', 'facebook', 'social'],
  ['fb.com', 'facebook', 'social'],
  ['instagram.com', 'instagram', 'social'],
  ['tiktok.com', 'tiktok', 'social'],
  ['twitter.com', 'twitter', 'social'],
  ['x.com', 'twitter', 'social'],
  ['t.co', 'twitter', 'social'],
  ['linkedin.com', 'linkedin', 'social'],
  ['lnkd.in', 'linkedin', 'social'],
  ['pinterest.com', 'pinterest', 'social'],
  ['reddit.com', 'reddit', 'social'],
  // Community and local-discovery sites matter more than most social networks
  // for a local ride service, so they are named rather than lumped into
  // "referral".
  ['nextdoor.com', 'nextdoor', 'social'],
  ['yelp.com', 'yelp', 'referral'],
  ['tripadvisor.com', 'tripadvisor', 'referral'],
  ['google.com', 'google', 'organic'],
  ['google.', 'google', 'organic'],       // google.co.uk, google.ca, ...
  ['bing.com', 'bing', 'organic'],
  ['duckduckgo.com', 'duckduckgo', 'organic'],
  ['search.yahoo.com', 'yahoo', 'organic'],
  ['yahoo.com', 'yahoo', 'organic'],
  ['ecosia.org', 'ecosia', 'organic'],
  ['maps.google.com', 'google_maps', 'organic'],
];

// The normalized vocabulary. Anything outside these is coerced.
const MEDIUMS = ['cpc', 'social', 'organic', 'referral', 'email', 'sms', 'qr', 'none'];

const MEDIUM_LABEL = {
  cpc: 'Paid',
  social: 'Social',
  organic: 'Search',
  referral: 'Referral',
  email: 'Email',
  sms: 'SMS',
  qr: 'QR / print',
  none: 'Direct',
};

const SOURCE_LABEL = {
  google: 'Google',
  google_maps: 'Google Maps',
  facebook: 'Facebook',
  instagram: 'Instagram',
  tiktok: 'TikTok',
  bing: 'Bing',
  twitter: 'X / Twitter',
  linkedin: 'LinkedIn',
  pinterest: 'Pinterest',
  snapchat: 'Snapchat',
  reddit: 'Reddit',
  nextdoor: 'Nextdoor',
  yelp: 'Yelp',
  tripadvisor: 'Tripadvisor',
  duckduckgo: 'DuckDuckGo',
  yahoo: 'Yahoo',
  ecosia: 'Ecosia',
  direct: 'Direct / typed in',
  kiosk: 'In-car kiosk',
  unknown: 'Unknown',
};

const slug = (v, max = 40) =>
  v == null ? null
    : String(v).toLowerCase().replace(/[^a-z0-9_.-]+/g, '_').replace(/^_+|_+$/g, '').slice(0, max) || null;

function hostOf(referrer) {
  if (!referrer) return null;
  try {
    return new URL(String(referrer)).hostname.toLowerCase().replace(/^www\./, '');
  } catch {
    return null;
  }
}

function fromReferrer(host) {
  if (!host) return null;
  for (const [needle, source, medium] of REFERRER_SOURCES) {
    if (host === needle || host.endsWith('.' + needle) || host.startsWith(needle)) {
      return { source, medium };
    }
  }
  return { source: slug(host), medium: 'referral' };
}

// Resolves one visit's attribution.
//
// Precedence, strongest evidence first:
//   1. An explicit utm_source — the advertiser set it deliberately.
//   2. A platform click id — the platform set it; cannot be faked by a referrer.
//   3. The referring site.
//   4. Kiosk, then direct.
//
// utm_medium is honoured when it is one we recognise, because a campaign may
// legitimately mark a Facebook link as `email` (a newsletter linking through).
function resolve({ utm = {}, clickIds = {}, referrer = null, isKiosk = false } = {}) {
  const host = hostOf(referrer);
  const referral = fromReferrer(host);

  // Which platform click id is present, if any.
  let clickSource = null;
  for (const [key, source] of Object.entries(CLICK_IDS)) {
    if (clickIds[key]) { clickSource = source; break; }
  }

  // Meta sends fbclid from both Facebook and Instagram; the referrer is the
  // only thing that tells them apart.
  if (clickSource === 'facebook' && referral && referral.source === 'instagram') {
    clickSource = 'instagram';
  }

  const utmSource = slug(utm.source);
  const utmMedium = slug(utm.medium);

  let source;
  let medium;

  if (utmSource) {
    source = utmSource;
    medium = MEDIUMS.includes(utmMedium) ? utmMedium
      : clickSource ? 'cpc'
      : referral ? referral.medium
      : 'referral';
  } else if (clickSource) {
    source = clickSource;
    // A click id means somebody paid for this click.
    medium = MEDIUMS.includes(utmMedium) ? utmMedium : 'cpc';
  } else if (referral) {
    source = referral.source;
    medium = MEDIUMS.includes(utmMedium) ? utmMedium : referral.medium;
  } else if (isKiosk) {
    source = 'kiosk';
    medium = 'none';
  } else {
    source = 'direct';
    medium = 'none';
  }

  return {
    source: source || 'unknown',
    medium: MEDIUMS.includes(medium) ? medium : 'referral',
    campaign: slug(utm.campaign, 60),
    content: slug(utm.content, 60),
    term: slug(utm.term, 60),
    referrerHost: host,
    // Kept so existing behaviour and the Google conversion tag stay aligned.
    paid: (MEDIUMS.includes(medium) ? medium : null) === 'cpc' || Boolean(clickSource),
  };
}

const labelForSource = (s) => SOURCE_LABEL[s] || (s ? s.replace(/_/g, ' ') : 'Unknown');
const labelForMedium = (m) => MEDIUM_LABEL[m] || m || 'Unknown';

module.exports = {
  CLICK_IDS, REFERRER_SOURCES, MEDIUMS, SOURCE_LABEL, MEDIUM_LABEL,
  resolve, hostOf, slug, labelForSource, labelForMedium,
};

// Driver identity documents.
//
// HOW THE RIDER/DRIVER APP STORES THESE (backend/routes/driver.js)
//   photo      -> bucket 'driver-photos'    (PUBLIC)  — stores a full public URL
//   license    -> bucket 'driver-documents' (PRIVATE) — stores a RAW STORAGE PATH
//   insurance  -> bucket 'driver-documents' (PRIVATE) — stores a RAW STORAGE PATH
//
// That asymmetry is deliberate upstream: riders load a driver's photo directly,
// while a licence and an insurance certificate must never be publicly
// reachable. The upstream comment says these are "never rendered as an image,
// just checked for presence" — which was true while nothing needed to look at
// them. Reviewing identity is exactly the job this console exists to do, so it
// has to render them, and the only correct way to do that from a private
// bucket is a short-lived signed URL minted server-side.
//
// A raw path is NEVER returned to the browser. The browser only ever receives
// a signed URL that expires.
const { supabase } = require('./supabase');

// Mirrored from UPLOAD_BUCKETS in roverzoom/backend/routes/driver.js.
const BUCKETS = {
  photo: process.env.DRIVER_PHOTO_BUCKET || 'driver-photos',
  license: process.env.DRIVER_DOCS_BUCKET || 'driver-documents',
  insurance: process.env.DRIVER_DOCS_BUCKET || 'driver-documents',
};

// Which drivers column each document lives in.
const COLUMNS = {
  photo: 'photo_url',
  license: 'license_photo_url',
  insurance: 'insurance_photo_url',
};

const LABELS = {
  photo: 'Profile photo',
  license: "Driver's licence",
  insurance: 'Insurance certificate',
};

// Short by intent. Long enough to look at a licence, short enough that a URL
// copied out of devtools or leaked in a screenshot stops working quickly.
const SIGNED_URL_TTL_SECONDS = Number(process.env.DOCUMENT_URL_TTL) || 300;

const isAbsoluteUrl = (value) => /^https?:\/\//i.test(String(value || ''));

// Storage paths are sometimes written with the bucket name in front. Strip it
// so createSignedUrl() does not look for `driver-documents/driver-documents/…`.
function normalizePath(value, bucket) {
  let path = String(value || '').trim().replace(/^\/+/, '');
  if (path.startsWith(`${bucket}/`)) path = path.slice(bucket.length + 1);
  return path;
}

// Resolves one stored column value into something a browser can actually load.
async function resolveOne(type, storedValue) {
  const base = { type, label: LABELS[type], present: Boolean(storedValue) };
  if (!storedValue) return { ...base, url: null, kind: 'missing' };

  // The photo column already holds a public URL — nothing to sign.
  if (isAbsoluteUrl(storedValue)) {
    return { ...base, url: storedValue, kind: 'public', expiresIn: null };
  }

  const bucket = BUCKETS[type];
  const path = normalizePath(storedValue, bucket);

  try {
    const { data, error } = await supabase.storage
      .from(bucket)
      .createSignedUrl(path, SIGNED_URL_TTL_SECONDS);
    if (error) throw error;
    return {
      ...base,
      url: data.signedUrl,
      kind: 'signed',
      expiresIn: SIGNED_URL_TTL_SECONDS,
    };
  } catch (err) {
    // A document that is recorded but unreachable is itself a finding — the
    // upload may have failed halfway, leaving a path pointing at nothing. Say
    // so explicitly rather than rendering a silently broken image.
    console.error(`[documents] could not sign ${type} for path ${path}:`, err.message);
    return {
      ...base,
      url: null,
      kind: 'unreachable',
      error: 'This file is recorded on the driver but could not be retrieved from storage.',
    };
  }
}

// All three documents for one driver, resolved in parallel.
async function resolveForDriver(driver) {
  const types = Object.keys(COLUMNS);
  const resolved = await Promise.all(
    types.map((type) => resolveOne(type, driver[COLUMNS[type]]))
  );

  const byType = {};
  for (const doc of resolved) byType[doc.type] = doc;

  return {
    documents: resolved,
    byType,
    completedAt: driver.profile_completed_at || null,
    // What the API's requireCompleteProfile gate actually checks.
    allPresent: resolved.every((d) => d.present),
    anyUnreachable: resolved.some((d) => d.kind === 'unreachable'),
    ttlSeconds: SIGNED_URL_TTL_SECONDS,
  };
}

// Presence-only view, safe for anyone who can read drivers. Contains no URL
// and no storage path — just whether each document exists.
function presenceForDriver(driver) {
  return Object.keys(COLUMNS).map((type) => ({
    type,
    label: LABELS[type],
    present: Boolean(driver[COLUMNS[type]]),
  }));
}

module.exports = {
  BUCKETS,
  COLUMNS,
  LABELS,
  SIGNED_URL_TTL_SECONDS,
  resolveOne,
  resolveForDriver,
  presenceForDriver,
  normalizePath,
  isAbsoluteUrl,
};

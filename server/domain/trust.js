// Driver trust & vetting model.
//
// THE PROBLEM THIS SOLVES
// In the live system, every driver signup is activated automatically:
// handle_new_driver() (schema.sql) and POST /api/driver/ensure-profile both
// hardcode status:'active', commented as a temporary stance "until an admin
// dashboard exists to actually do the approving". The only real gate on
// taking rides is requireCompleteProfile — three self-uploaded photos.
// Background screening (Checkr) exists but NOTHING enforces a clear result.
//
// So drivers.status tells you whether someone CAN drive. It does not tell you
// whether anyone ever LOOKED at them. Those are different questions, and the
// console must never conflate them.
//
// Review state is stored in the driver's Supabase Auth app_metadata — the
// same server-controlled, not-user-editable place screening.js already keeps
// Checkr state. That needs no DDL, so it works in an environment that cannot
// migrate the drivers table.

const REVIEW_META_KEY = 'rz_review';

// What an operator decided about a driver.
const REVIEW_STATES = ['unreviewed', 'approved', 'rejected'];

// What the platform believes about a driver's background check. Mirrors
// screening.js: not_started | pending | clear | consider.
const SCREENING_STATES = ['not_started', 'pending', 'clear', 'consider'];

function readReview(authUser) {
  const meta = (authUser && authUser.app_metadata) || {};
  const review = meta[REVIEW_META_KEY] || {};
  return {
    state: REVIEW_STATES.includes(review.state) ? review.state : 'unreviewed',
    by: review.by || null,          // admin email who decided
    at: review.at || null,          // ISO timestamp of the decision
    note: review.note || null,      // free-text rationale, shown in the audit trail
  };
}

function readScreening(authUser) {
  const meta = (authUser && authUser.app_metadata) || {};
  return {
    status: SCREENING_STATES.includes(meta.screening_status) ? meta.screening_status : 'not_started',
    candidateId: meta.checkr_candidate_id || null,
    reportId: meta.checkr_report_id || null,
    invitationUrl: meta.checkr_invitation_url || null,
  };
}

// The four independent facts that decide whether a driver should be carrying
// passengers. Kept separate so the UI can show WHICH one is missing rather
// than a single opaque pass/fail.
function trustFactors(driver, authUser) {
  const review = readReview(authUser);
  const screening = readScreening(authUser);
  return {
    // Can the API currently be called on their behalf? (requireActiveDriver)
    accountActive: driver.status === 'active',
    // Have they uploaded photo + license + insurance? (requireCompleteProfile)
    documentsComplete: Boolean(driver.profile_completed_at),
    // Did a background check come back clear?
    screeningClear: screening.status === 'clear',
    // Did a human at RoverZoom actually approve them?
    humanApproved: review.state === 'approved',
    review,
    screening,
  };
}

// A driver is FULLY VETTED only when all four hold.
function isFullyVetted(factors) {
  return factors.accountActive
    && factors.documentsComplete
    && factors.screeningClear
    && factors.humanApproved;
}

// THE NUMBER THAT MATTERS: drivers who can take rides right now but whom
// nobody has vetted. This is the exposure the auto-activation creates, and
// the console's job is to make it impossible to ignore.
function isUnvettedButDriving(factors) {
  return factors.accountActive
    && factors.documentsComplete   // this is all the API actually requires
    && !(factors.humanApproved && factors.screeningClear);
}

// One label per driver for list views, ordered by operational urgency.
// `risk` reuses the same four-level severity vocabulary as ride status, so a
// colour means exactly one thing everywhere in the console.
function trustStanding(driver, authUser) {
  const f = trustFactors(driver, authUser);

  if (driver.status === 'suspended') {
    return { key: 'suspended', label: 'Suspended', risk: 'neutral', factors: f };
  }
  if (f.review.state === 'rejected') {
    return { key: 'rejected', label: 'Rejected', risk: 'neutral', factors: f };
  }
  if (f.screening.status === 'consider') {
    return { key: 'screening_consider', label: 'Screening flagged', risk: 'critical', factors: f };
  }
  if (isUnvettedButDriving(f)) {
    return { key: 'unvetted_driving', label: 'Driving unvetted', risk: 'critical', factors: f };
  }
  if (isFullyVetted(f)) {
    return { key: 'cleared', label: 'Cleared', risk: 'active', factors: f };
  }
  if (!f.documentsComplete) {
    return { key: 'awaiting_documents', label: 'Awaiting documents', risk: 'warn', factors: f };
  }
  if (f.screening.status === 'pending') {
    return { key: 'screening_pending', label: 'Screening in progress', risk: 'warn', factors: f };
  }
  return { key: 'awaiting_review', label: 'Awaiting review', risk: 'warn', factors: f };
}

// Sort order for the review queue: most urgent first.
const STANDING_PRIORITY = {
  unvetted_driving: 0,
  screening_consider: 1,
  awaiting_review: 2,
  screening_pending: 3,
  awaiting_documents: 4,
  cleared: 5,
  rejected: 6,
  suspended: 7,
};

module.exports = {
  REVIEW_META_KEY,
  REVIEW_STATES,
  SCREENING_STATES,
  readReview,
  readScreening,
  trustFactors,
  isFullyVetted,
  isUnvettedButDriving,
  trustStanding,
  STANDING_PRIORITY,
};

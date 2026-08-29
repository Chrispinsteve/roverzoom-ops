// The ride lifecycle, mirrored from the RoverZoom rider/driver backend.
//
// SOURCE OF TRUTH: roverzoom/backend/db/schema.sql (bookings_status_check)
// and roverzoom/backend/routes/driver.js (TRANSITIONS). This file must stay
// in sync with those. It is duplicated here — not imported — because the
// admin console is a separate service; see domain/README.md for the sync
// contract and how to verify it.

// Every legal value of bookings.status.
const RIDE_STATUSES = [
  'confirmed',
  'dispatching',
  'manual_dispatch_required',
  'driver_assigned',
  'driver_en_route',
  'arrived',
  'in_progress',
  'completed',
  'canceled',
];

// Ordered lifecycle used to render timelines and measure progress. Terminal
// and exception states are deliberately excluded — they are not "steps".
const RIDE_PROGRESSION = [
  'confirmed',
  'dispatching',
  'driver_assigned',
  'driver_en_route',
  'arrived',
  'in_progress',
  'completed',
];

// The timestamp column that records entry into each state. Used to build a
// real event timeline from the booking row alone (there is no events table).
const STATUS_TIMESTAMP = {
  confirmed: 'created_at',
  dispatching: 'dispatched_at',
  driver_assigned: 'accepted_at',
  driver_en_route: 'en_route_at',
  arrived: 'arrived_at',
  in_progress: 'started_at',
  completed: 'completed_at',
  canceled: 'canceled_at',
};

// Rides that are live right now — a driver is committed and the rider is
// waiting or riding. These are what the dispatch board watches.
const ACTIVE_STATUSES = ['driver_assigned', 'driver_en_route', 'arrived', 'in_progress'];

// Rides that need a human. Nothing in the automated dispatch path can move
// these forward; they sit here until an operator acts.
const NEEDS_ATTENTION_STATUSES = ['manual_dispatch_required'];

// Rides that are still awaiting a driver.
const UNASSIGNED_STATUSES = ['confirmed', 'dispatching', 'manual_dispatch_required'];

const TERMINAL_STATUSES = ['completed', 'canceled'];

// Mirrors CANCELABLE in roverzoom/backend/routes/bookings.js. A ride already
// in progress is NOT cancelable — it must be completed or handled manually.
const CANCELABLE_STATUSES = [
  'confirmed',
  'dispatching',
  'manual_dispatch_required',
  'driver_assigned',
  'driver_en_route',
  'arrived',
];

// Human-facing labels. Deliberately operator-language, not database-language:
// an operator scanning a board reads "Waiting for driver", never "dispatching".
const STATUS_LABEL = {
  confirmed: 'Scheduled',
  dispatching: 'Finding driver',
  manual_dispatch_required: 'Needs dispatch',
  driver_assigned: 'Driver assigned',
  driver_en_route: 'Driver en route',
  arrived: 'Driver waiting',
  in_progress: 'On trip',
  completed: 'Completed',
  canceled: 'Canceled',
};

// Severity drives colour in the console. Only these four levels exist, so the
// UI can never invent a fifth meaning for a colour.
//   neutral  — nothing to do
//   active   — live, healthy, in motion
//   warn     — degrading; will need a human if ignored
//   critical — needs a human now
const STATUS_SEVERITY = {
  confirmed: 'neutral',
  dispatching: 'warn',
  manual_dispatch_required: 'critical',
  driver_assigned: 'active',
  driver_en_route: 'active',
  arrived: 'active',
  in_progress: 'active',
  completed: 'neutral',
  canceled: 'neutral',
};

function isActive(status) { return ACTIVE_STATUSES.includes(status); }
function isTerminal(status) { return TERMINAL_STATUSES.includes(status); }
function isCancelable(status) { return CANCELABLE_STATUSES.includes(status); }

// Builds an ordered, real timeline for one booking from its timestamp columns.
// Only states that actually happened appear. Cancellation is appended last
// with its actor and reason, since it can interrupt at any point.
function buildTimeline(booking) {
  const events = [];
  for (const status of RIDE_PROGRESSION) {
    const column = STATUS_TIMESTAMP[status];
    const at = booking[column];
    if (at) events.push({ status, label: STATUS_LABEL[status], at, column });
  }
  if (booking.canceled_at) {
    events.push({
      status: 'canceled',
      label: STATUS_LABEL.canceled,
      at: booking.canceled_at,
      column: 'canceled_at',
      by: booking.canceled_by,
      reason: booking.cancel_reason,
    });
  }
  return events.sort((a, b) => new Date(a.at) - new Date(b.at));
}

module.exports = {
  RIDE_STATUSES,
  RIDE_PROGRESSION,
  STATUS_TIMESTAMP,
  ACTIVE_STATUSES,
  NEEDS_ATTENTION_STATUSES,
  UNASSIGNED_STATUSES,
  TERMINAL_STATUSES,
  CANCELABLE_STATUSES,
  STATUS_LABEL,
  STATUS_SEVERITY,
  isActive,
  isTerminal,
  isCancelable,
  buildTimeline,
};

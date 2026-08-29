// The booking funnel.
//
// "Why do people visit and not book?" is only answerable if the steps BEFORE
// booking are recorded. Today the platform records nothing until a booking row
// exists, so every visitor who leaves is invisible. These are the steps worth
// recording, in the order a rider passes through them.
//
// The list is deliberately short. Every extra step is another thing to
// instrument and another place the numbers can disagree; these seven cover the
// decisions that actually lose people.

const STEPS = [
  {
    key: 'visit',
    label: 'Opened the site',
    hint: 'The landing screen loaded.',
  },
  {
    key: 'booking_started',
    label: 'Started a booking',
    hint: 'Chose the form or the AI assistant rather than leaving.',
  },
  {
    key: 'pickup_set',
    label: 'Entered a pickup',
    hint: 'Committed to a real address.',
  },
  {
    key: 'dropoff_set',
    label: 'Entered a destination',
    hint: 'Both ends of the trip are known.',
  },
  {
    key: 'quote_viewed',
    label: 'Saw the price',
    hint: 'The fare was shown. Drop-off here usually means the price, the date, or trust.',
  },
  {
    key: 'checkout_started',
    label: 'Chose how to pay',
    hint: 'Reached payment selection.',
  },
  {
    key: 'booked',
    label: 'Booked',
    hint: 'A confirmed booking exists.',
  },
];

const STEP_KEYS = STEPS.map((s) => s.key);
const isStep = (key) => STEP_KEYS.includes(key);

const CHANNELS = ['ad', 'organic', 'direct', 'kiosk'];
const DEVICES = ['mobile', 'tablet', 'desktop'];

// Turns raw events into an ordered funnel.
//
// Counts SESSIONS that reached each step, not raw events, and treats the
// funnel as monotonic: a session that recorded `quote_viewed` is counted at
// every earlier step too, even if an event was dropped. Without that, a single
// lost beacon would show up as a fake "recovery" later in the funnel, which
// makes the whole chart untrustworthy.
function buildFunnel(events) {
  const reached = new Map(); // sessionId -> deepest step index

  for (const e of events) {
    const idx = STEP_KEYS.indexOf(e.step);
    if (idx < 0) continue;
    const prev = reached.get(e.session_id);
    if (prev === undefined || idx > prev) reached.set(e.session_id, idx);
  }

  const deepest = [...reached.values()];
  const total = deepest.length;

  const steps = STEPS.map((step, i) => {
    const count = deepest.filter((d) => d >= i).length;
    return {
      ...step,
      sessions: count,
      // Share of everyone who ever arrived.
      shareOfAll: total ? Math.round((count / total) * 1000) / 10 : 0,
    };
  });

  // Drop-off between consecutive steps. `lostPct` is relative to the PREVIOUS
  // step, which is the number that identifies where people actually leave —
  // a share-of-all figure hides a bad step that few people reached.
  for (let i = 0; i < steps.length; i++) {
    const prev = i === 0 ? null : steps[i - 1];
    steps[i].lost = prev ? prev.sessions - steps[i].sessions : 0;
    steps[i].lostPct = prev && prev.sessions
      ? Math.round((steps[i].lost / prev.sessions) * 1000) / 10
      : 0;
  }

  // The single worst transition — the answer to "where are we losing people?".
  // Ignores steps nobody reached, which would otherwise report a meaningless
  // 100% drop off a base of one.
  const MIN_BASE = 5;
  let worst = null;
  for (let i = 1; i < steps.length; i++) {
    const base = steps[i - 1].sessions;
    if (base < MIN_BASE) continue;
    if (!worst || steps[i].lostPct > worst.lostPct) {
      worst = { from: steps[i - 1].label, to: steps[i].label, lost: steps[i].lost, lostPct: steps[i].lostPct, hint: steps[i].hint };
    }
  }

  return {
    steps,
    totalSessions: total,
    booked: steps[steps.length - 1].sessions,
    conversionPct: total ? Math.round((steps[steps.length - 1].sessions / total) * 1000) / 10 : 0,
    worstDropOff: worst,
    // Below this, the funnel is noise rather than signal, and the console says
    // so instead of inviting decisions from three visits.
    enoughData: total >= 30,
    minimumForConfidence: 30,
  };
}

module.exports = { STEPS, STEP_KEYS, isStep, CHANNELS, DEVICES, buildFunnel };

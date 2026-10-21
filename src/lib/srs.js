const MINUTE = 60 * 1000;
const MIN_EASE = 1.3;
const MAX_EASE = 3.5;
const MAX_INTERVAL = 36500 * 1440;

export const RATINGS = [
  { id: 'again', label: 'Again' },
  { id: 'hard', label: 'Hard' },
  { id: 'good', label: 'Good' },
  { id: 'easy', label: 'Easy' },
];

export function normalizeReviewState(state) {
  if (
    !state ||
    !Number.isFinite(state.due) ||
    !Number.isFinite(state.interval) ||
    !Number.isFinite(state.ease) ||
    !Number.isInteger(state.reps) ||
    !Number.isInteger(state.lapses) ||
    !Number.isFinite(state.last)
  ) return null;
  return {
    due: state.due,
    interval: Math.max(0, state.interval),
    ease: Math.max(MIN_EASE, state.ease),
    reps: Math.max(0, state.reps),
    lapses: Math.max(0, state.lapses),
    last: state.last,
  };
}

export function fromLegacySrs(state) {
  if (
    !state ||
    !Number.isInteger(state.step) ||
    state.step < 0 ||
    state.step > 6 ||
    !Number.isFinite(state.last)
  ) return null;
  const intervals = [10, 60, 1440, 4320, 10080, 20160, 43200];
  const interval = intervals[state.step];
  return {
    due: state.last + interval * MINUTE,
    interval,
    ease: 2.5,
    reps: Math.max(1, state.step),
    lapses: 0,
    last: state.last,
  };
}

export function isReviewDue(state, now = Date.now()) {
  return !state || state.due <= now;
}

export function nextReviewState(state, rating, now = Date.now()) {
  if (!RATINGS.some((item) => item.id === rating)) {
    throw new Error(`Unknown review rating: ${rating}`);
  }
  const previous = normalizeReviewState(state) || {
    due: now,
    interval: 0,
    ease: 2.5,
    reps: 0,
    lapses: 0,
    last: 0,
  };
  let ease = previous.ease;
  let interval;
  let lapses = previous.lapses;

  if (rating === 'again') {
    interval = 10;
    ease = Math.max(MIN_EASE, ease - 0.2);
    lapses++;
  } else if (rating === 'hard') {
    interval = previous.reps ? Math.max(60, Math.round(previous.interval * 1.2)) : 60;
    ease = Math.max(MIN_EASE, ease - 0.15);
  } else if (rating === 'good') {
    interval = previous.reps ? Math.max(1440, Math.round(previous.interval * ease)) : 1440;
  } else {
    interval = previous.reps
      ? Math.max(5760, Math.round(previous.interval * (ease + 0.15) * 1.3))
      : 5760;
    ease = Math.min(MAX_EASE, ease + 0.15);
  }
  interval = Math.min(MAX_INTERVAL, interval);

  return {
    due: now + interval * MINUTE,
    interval,
    ease,
    reps: previous.reps + 1,
    lapses,
    last: now,
  };
}

export function intervalForRating(state, rating) {
  const next = nextReviewState(state, rating, 0);
  return next.interval;
}

export function formatInterval(minutes) {
  if (minutes < 60) return `${Math.max(1, Math.round(minutes))}m`;
  if (minutes < 1440) return `${Math.round(minutes / 60)}h`;
  const days = minutes / 1440;
  return `${Number.isInteger(days) ? days : days.toFixed(1)}d`;
}

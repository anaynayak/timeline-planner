/* The working-day calendar. Pure.
 *
 * A fixed-origin index of working days: real date <-> integer working-day number.
 * ALL scheduling arithmetic goes through this, never date maths, which is why nothing
 * can land on a Saturday. Rebuilt whenever the holiday set changes.
 */
'use strict';

/* A fixed-origin index of working days. Working day k has index k; all scheduling is
 * integer arithmetic over these indices, so weekends and holidays simply do not exist
 * in the number line. Rebuilt whenever the holiday set changes. */
const CAL_ORIGIN = '2015-01-05';   // a Monday
const CAL_SPAN_DAYS = 13145;       // 2015-01-05 .. 2050-12-31

function makeCalendar(holidays) {
  const hol = new Set(holidays || []);
  const at = [];            // index -> 'YYYY-MM-DD'
  const idxOf = new Map();  // 'YYYY-MM-DD' -> index
  let d = parseYMD(CAL_ORIGIN);
  let lastDay = CAL_ORIGIN;
  for (let i = 0; i < CAL_SPAN_DAYS; i++) {
    const k = ymd(d), g = d.getDay();
    if (g !== 0 && g !== 6 && !hol.has(k)) { idxOf.set(k, at.length); at.push(k); }
    lastDay = k;
    d = addDays(d, 1);
  }

  const isWorking = (s) => idxOf.has(typeof s === 'string' ? s.slice(0, 10) : ymd(s));

  /* nextIdx/prevIdx report -1 for a date outside the window, and at() clamps, so an
   * unchecked -1 silently becomes the very first working day. Callers that take a date
   * from a file or a date input must gate on inRange first and fail loudly instead. */
  const inRange = (s) => {
    const k = String(s).slice(0, 10);
    return k >= CAL_ORIGIN && k <= lastDay;
  };

  /** Index of the first working day at or after `s`. */
  function nextIdx(s) {
    let d = parseYMD(s);
    for (let i = 0; i < 400; i++) {
      const h = idxOf.get(ymd(d));
      if (h !== undefined) return h;
      d = addDays(d, 1);
    }
    return -1;
  }
  /** Index of the last working day at or before `s`. */
  function prevIdx(s) {
    let d = parseYMD(s);
    for (let i = 0; i < 400; i++) {
      const h = idxOf.get(ymd(d));
      if (h !== undefined) return h;
      d = addDays(d, -1);
    }
    return -1;
  }
  const clamp = (i) => Math.max(0, Math.min(at.length - 1, i));

  return {
    holidays: hol,
    size: at.length,
    first: CAL_ORIGIN,
    last: lastDay,
    at: (i) => at[clamp(i)],
    isWorking, nextIdx, prevIdx, clamp, inRange,
    /** inclusive count of working days between two dates */
    count: (a, b) => prevIdx(b) - nextIdx(a) + 1,
  };
}

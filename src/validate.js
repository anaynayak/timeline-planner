/* Validation. Pure.
 *
 * Findings and the one-click fixes they offer. A finding names a fix `kind`; applying it
 * is fixes.js, so the catalogue and the effects stay in one place each.
 */
'use strict';

const numOrNull = (v) => {
  const s = String(v == null ? '' : v).trim();
  return s === '' || isNaN(Number(s)) ? null : Number(s);
};

/** Unmapped columns that hold numbers on most populated rows - typically per-estimator
 *  columns like "Alice #" / "Bob #". Used to flag disagreement without naming columns. */
function numericExtras(doc) {
  return doc.extras.map((i) => doc.header[i]).filter((c) => {
    let filled = 0, numeric = 0;
    for (const t of doc.tasks) {
      const raw = t.extra && t.extra[c];
      if (String(raw == null ? '' : raw).trim() === '') continue;
      filled++;
      if (numOrNull(raw) != null) numeric++;
    }
    return filled === 0 ? /#\s*$/.test(c) : numeric === filled;
  });
}

/** `an` is an analyse() result; its byId/succ maps are reused rather than rebuilt.
 *  `loadRows` is an optional weeklyLoad() result, so a caller that already needs the
 *  table for display does not pay for it twice. */
function validate(doc, cal, an, loadRows) {
  const f = [];
  const byId = an.byId;
  const add = (level, code, msg, taskId, fix) => f.push({ level, code, msg, taskId, fix });
  // hoisted: this scans every task x every extra column, and used to run once per task
  const numCols = numericExtras(doc);

  for (const t of doc.tasks) {
    if (t.estimate != null && t.estimate !== t.duration) {
      add('warn', 'estimate-mismatch',
        `Drawn ${t.duration}d but estimate is ${t.estimate}d.`, t.id,
        { label: `Set duration to ${t.estimate}d`, kind: 'set-duration' });
    }
    if (t.estimate == null) {
      add('error', 'missing-estimate', 'No estimate.', t.id,
        { label: `Set estimate to ${t.duration}d`, kind: 'set-estimate' });
    }
    for (const d of t.deps) {
      const p = byId.get(d);
      if (p && endIdx(cal, p) >= startIdx(cal, t)) {
        add('error', 'dep-violation',
          `Starts ${fmtNice(t.start)} but "${p.name.trim()}" only ends ${fmtNice(cal.at(endIdx(cal, p)))}.`,
          t.id, { label: 'Reflow ASAP', kind: 'reflow' });
      }
    }
    for (const u of t.unresolved) {
      add('error', 'unresolved-dep', `Unrecognised dependency "${u}".`, t.id);
    }
    const vals = numCols.map((c) => numOrNull(t.extra && t.extra[c])).filter((v) => v != null);
    if (vals.length > 1 && Math.max(...vals) - Math.min(...vals) >= 5) {
      add('info', 'estimator-spread',
        `Columns disagree: ${numCols.map((c) => `${c.replace(/\s*#$/, '')} ${numOrNull(t.extra[c]) == null ? '-' : numOrNull(t.extra[c])}`).join(', ')}.`,
        t.id);
    }
  }

  if (an.cyclic.length) {
    add('error', 'cycle', `Dependency cycle involving: ${an.cyclic.map((id) => byId.get(id).name.trim()).join(', ')}.`, an.cyclic[0]);
  }
  for (const c of numCols) {
    const filled = doc.tasks.filter((t) => numOrNull(t.extra && t.extra[c]) != null).length;
    if (filled === 0 && doc.tasks.length) {
      add('info', 'estimator-empty', `"${c}" is empty on all ${doc.tasks.length} tasks.`, null);
    }
  }
  for (const [wk, load] of (loadRows || weeklyLoad(doc, cal))) {
    const people = load / 5;
    if (people > doc.teamSize + 1e-9) {
      add('warn', 'week-overload',
        `Week of ${fmtNice(wk)} needs ${people.toFixed(1)} people (team is ${doc.teamSize}).`, null);
    }
  }
  const rank = { error: 0, warn: 1, info: 2 };
  return f.sort((a, b) => rank[a.level] - rank[b.level]);
}

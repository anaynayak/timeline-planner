/* The scheduler. Pure.
 *
 * Topological sort, ASAP forward pass, rigid propagation, float / critical path and
 * weekly load. Every position is an integer working-day index from calendar.js.
 *
 * frappe's built-in `move_dependencies` is a rigid *visual* drag that ignores working
 * days, so it is off and all propagation is ours.
 */
'use strict';

/* Every function below takes an optional prebuilt graph `g` as its last argument. Callers
 * that loop over tasks MUST build it once and pass it in: `earliest()` used to call
 * graph() per task from inside propagateRigid and pullIntoLegality, which rebuilt both
 * maps for every task and made those passes quadratic. */
function graph(doc) {
  const byId = new Map(doc.tasks.map((t) => [t.id, t]));
  const succ = new Map(doc.tasks.map((t) => [t.id, []]));
  for (const t of doc.tasks) {
    for (const d of t.deps) if (succ.has(d)) succ.get(d).push(t.id);
  }
  return { byId, succ };
}

/** Kahn topological sort. Nodes left over are inside cycles. */
function topo(doc, g) {
  const { succ } = g || graph(doc);
  const indeg = new Map(doc.tasks.map((t) => [t.id, 0]));
  for (const t of doc.tasks) for (const d of t.deps) if (indeg.has(d)) indeg.set(t.id, indeg.get(t.id) + 1);
  const q = doc.tasks.filter((t) => indeg.get(t.id) === 0).map((t) => t.id);
  const order = [];
  while (q.length) {
    const id = q.shift();
    order.push(id);
    for (const s of succ.get(id) || []) {
      indeg.set(s, indeg.get(s) - 1);
      if (indeg.get(s) === 0) q.push(s);
    }
  }
  const placed = new Set(order);   // a linear scan; `order.includes` made this quadratic
  const cyclic = doc.tasks.map((t) => t.id).filter((id) => !placed.has(id));
  return { order, cyclic };
}

function descendants(doc, id, g) {
  const { succ } = g || graph(doc);
  const seen = new Set();
  const stack = [...(succ.get(id) || [])];
  while (stack.length) {
    const n = stack.pop();
    if (seen.has(n)) continue;
    seen.add(n);
    for (const s of succ.get(n) || []) stack.push(s);
  }
  return seen;
}

/** Transitive predecessors of `id`: the mirror of descendants(), walking deps upward.
 *  Used to decide which tasks may be made downstream of `id` without forming a cycle,
 *  which otherwise needs one descendants() walk per candidate. */
function ancestors(doc, id, g) {
  const { byId } = g || graph(doc);
  const seen = new Set();
  const start = byId.get(id);
  const stack = start ? start.deps.slice() : [];
  while (stack.length) {
    const n = stack.pop();
    if (seen.has(n)) continue;
    seen.add(n);
    const p = byId.get(n);
    if (p) for (const d of p.deps) stack.push(d);
  }
  return seen;
}

const startIdx = (cal, t) => cal.nextIdx(t.start);
const endIdx = (cal, t) => cal.nextIdx(t.start) + t.duration - 1;

/** Earliest legal start index for `t` given the current starts of its predecessors. */
function earliest(doc, cal, t, floor, g) {
  const { byId } = g || graph(doc);
  let s = floor;
  for (const d of t.deps) {
    const p = byId.get(d);
    if (p) s = Math.max(s, endIdx(cal, p) + 1);
  }
  return s;
}

/** Full ASAP forward pass. Pinned tasks keep their manual start as a floor. */
function asapAll(doc, cal) {
  const g = graph(doc);
  const { order } = topo(doc, g);
  const { byId } = g;
  const p0 = Math.max(0, cal.nextIdx(doc.projectStart));
  const si = new Map();
  for (const id of order) {
    const t = byId.get(id);
    let s = p0;
    if (t.pinned) s = Math.max(s, startIdx(cal, t));
    for (const d of t.deps) {
      const p = byId.get(d);
      if (p && si.has(d)) s = Math.max(s, si.get(d) + p.duration);
      else if (p) s = Math.max(s, endIdx(cal, p) + 1);
    }
    si.set(id, s);
  }
  for (const [id, s] of si) byId.get(id).start = cal.at(s);
}

/** Rigid shift: move the transitive successors by `delta` working days, clamping each so
 *  it still starts after every one of its own predecessors. */
function propagateRigid(doc, cal, editedId, delta) {
  if (!delta) return;
  const g = graph(doc);
  const kids = descendants(doc, editedId, g);
  const { order } = topo(doc, g);
  const { byId } = g;
  const p0 = Math.max(0, cal.nextIdx(doc.projectStart));
  for (const id of order) {
    if (!kids.has(id)) continue;
    const t = byId.get(id);
    const shifted = startIdx(cal, t) + delta;
    t.start = cal.at(Math.max(shifted, earliest(doc, cal, t, p0, g)));
  }
}

/** In rigid mode a newly added dependency can leave a task illegally early. Push each task
 *  forward just enough to satisfy its predecessors, leaving legal tasks where they are. */
function pullIntoLegality(doc, cal) {
  const g = graph(doc);
  const { order } = topo(doc, g);
  const { byId } = g;
  const p0 = Math.max(0, cal.nextIdx(doc.projectStart));
  for (const id of order) {
    const t = byId.get(id);
    const need = earliest(doc, cal, t, p0, g);
    if (startIdx(cal, t) < need) t.start = cal.at(need);
  }
}

/** Shift every task by `delta` working days (used when the project start moves). */
function shiftAll(doc, cal, delta) {
  if (!delta) return;
  for (const t of doc.tasks) t.start = cal.at(Math.max(0, startIdx(cal, t) + delta));
}

/** Re-apply the current propagation mode after an edit to `editedId`. */
function reschedule(doc, cal, editedId, endDelta) {
  if (doc.mode === 'asap') asapAll(doc, cal);
  else if (editedId) propagateRigid(doc, cal, editedId, endDelta || 0);
}

/** Backward pass: total float per task, and the project end index. The graph it built is
 *  returned as `byId`/`succ` so that validate() and the renderers reuse it instead of
 *  each rebuilding their own. */
function analyse(doc, cal) {
  const g = graph(doc);
  const { order, cyclic } = topo(doc, g);
  const { byId, succ } = g;
  const si = new Map(), ei = new Map();
  for (const t of doc.tasks) { si.set(t.id, startIdx(cal, t)); ei.set(t.id, endIdx(cal, t)); }
  const projEnd = doc.tasks.length ? Math.max(...doc.tasks.map((t) => ei.get(t.id))) : 0;
  const ls = new Map();
  for (const id of order.slice().reverse()) {
    const t = byId.get(id);
    const kids = (succ.get(id) || []).filter((k) => ls.has(k));
    const lf = kids.length ? Math.min(...kids.map((k) => ls.get(k) - 1)) : projEnd;
    ls.set(id, lf - (t.duration - 1));
  }
  const float = new Map();
  for (const t of doc.tasks) float.set(t.id, ls.has(t.id) ? ls.get(t.id) - si.get(t.id) : 0);
  return { si, ei, projEnd, float, cyclic, order, byId, succ };
}

/** Person-days per calendar week, from each task's estimate spread over its working days. */
function weeklyLoad(doc, cal) {
  const weeks = new Map();
  for (const t of doc.tasks) {
    const s = startIdx(cal, t);
    const perDay = (t.estimate == null ? t.duration : t.estimate) / t.duration;
    for (let i = s; i < s + t.duration; i++) {
      const wk = ymd(mondayOf(parseYMD(cal.at(i))));
      weeks.set(wk, (weeks.get(wk) || 0) + perDay);
    }
  }
  return [...weeks.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1));
}

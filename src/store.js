/* Application state: the document, undo/redo and persistence.
 *
 * The first file that is allowed to touch the DOM or localStorage. Everything above this
 * is pure so that `npm test` can run without a browser - please keep it that way.
 */
'use strict';

const LS_KEY = 'miro-timeline:doc';

const App = {
  doc: null,
  cal: null,
  gantt: null,
  fileName: 'plan.csv',
  selected: null,
  zoom: 'Day',
  undoStack: [],
  redoStack: [],
  pendingDrag: null,
  dragTimer: null,
};

const clone = (o) => JSON.parse(JSON.stringify(o));

function snapshot() {
  App.undoStack.push(clone(App.doc));
  if (App.undoStack.length > 60) App.undoStack.shift();
  App.redoStack.length = 0;
}

/* The single way to change the plan. Every caller used to hand-roll
 * `snapshot(); ...mutate...; renderAll()`, and two of them (propagation mode and team
 * size) forgot the snapshot, so those edits were silently not undoable. Route changes
 * through here and that cannot happen again.
 *
 * Pass `{ rebuildCal: true }` for a change that alters the holiday set: the working-day
 * index has to be rebuilt and any start that landed on a newly non-working day pulled
 * forward before anything re-renders. */
function commit(mutate, opts) {
  snapshot();
  const r = mutate();
  if (opts && opts.rebuildCal) { rebuildCal(); normalizeStarts(); }
  renderAll();
  return r;
}

/** After a calendar change, pull any start that landed on a non-working day forward. */
function normalizeStarts() {
  for (const t of App.doc.tasks) t.start = App.cal.at(App.cal.nextIdx(t.start));
}
function undo() {
  if (!App.undoStack.length) return;
  App.redoStack.push(clone(App.doc));
  App.doc = App.undoStack.pop();
  rebuildCal();
  renderAll();
}
function redo() {
  if (!App.redoStack.length) return;
  App.undoStack.push(clone(App.doc));
  App.doc = App.redoStack.pop();
  rebuildCal();
  renderAll();
}
function rebuildCal() { App.cal = makeCalendar(App.doc.holidays); }

function persist() {
  try {
    localStorage.setItem(LS_KEY, JSON.stringify({ fileName: App.fileName, doc: App.doc }));
  } catch (e) { /* quota or private mode - non-fatal */ }
}
function restore() {
  try {
    const raw = localStorage.getItem(LS_KEY);
    if (!raw) return null;
    return JSON.parse(raw);
  } catch (e) { return null; }
}

function loadDoc(text, fileName) {
  const cal = makeCalendar([]);
  const doc = parseAny(text, fileName, cal);
  App.doc = doc;
  App.fileName = fileName || 'plan.csv';
  App.selected = null;
  App.undoStack.length = 0;
  App.redoStack.length = 0;
  rebuildCal();
  renderAll();
}

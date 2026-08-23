/* Application state: the document, undo/redo and persistence.
 *
 * The first file that is allowed to touch the DOM or localStorage. Everything above this
 * is pure so that `npm test` can run without a browser - please keep it that way.
 */
'use strict';

const LS_KEY = 'miro-timeline:doc';
const LS_THEME = 'miro-timeline:theme';
const LS_SEEN = 'miro-timeline:seen-intro';

/* The bundled plan is invented data but loaded as "plan.csv", which reads as a file the
 * viewer owns - a first-time visitor had no way to tell whose numbers were on screen.
 * App.isExample drives a label in the toolbar. It is deliberately NOT folded into
 * App.fileName, because that is also the download filename. */
const EXAMPLE_NAME = 'example-plan.csv';

/* The theme is a viewer preference, not part of the plan, so it lives in its own key.
 * That keeps it out of the undo stack (undo should not change your colours) and means
 * Reset, which discards the document, leaves it alone. 'auto' stores nothing and defers
 * to prefers-color-scheme; index.html re-applies the stored value before first paint. */
function applyTheme(theme) {
  App.theme = theme === 'light' || theme === 'dark' ? theme : 'auto';
  if (App.theme === 'auto') delete document.documentElement.dataset.theme;
  else document.documentElement.dataset.theme = App.theme;
  try {
    if (App.theme === 'auto') localStorage.removeItem(LS_THEME);
    else localStorage.setItem(LS_THEME, App.theme);
  } catch (e) { /* quota or private mode - the theme just will not persist */ }
}

/** Has the viewer been shown the intro? Stored separately so Reset does not re-trigger it. */
function introSeen() {
  try { return localStorage.getItem(LS_SEEN) === '1'; } catch (e) { return true; }
}
function markIntroSeen() {
  try { localStorage.setItem(LS_SEEN, '1'); } catch (e) { /* private mode - shown again */ }
}

function restoreTheme() {
  let saved = null;
  try { saved = localStorage.getItem(LS_THEME); } catch (e) { /* ignore */ }
  App.theme = saved === 'light' || saved === 'dark' ? saved : 'auto';
}

const App = {
  doc: null,
  cal: null,
  gantt: null,
  fileName: 'plan.csv',
  selected: null,
  zoom: 'Day',
  theme: 'auto',
  isExample: false,
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

function loadDoc(text, fileName, isExample) {
  const cal = makeCalendar([]);
  const doc = parseAny(text, fileName, cal);
  App.doc = doc;
  App.fileName = fileName || 'plan.csv';
  App.isExample = !!isExample;
  App.selected = null;
  App.undoStack.length = 0;
  App.redoStack.length = 0;
  rebuildCal();
  renderAll();
}

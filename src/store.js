/* Application state: the document, undo/redo and persistence.
 *
 * The first file that is allowed to touch the DOM or localStorage. Everything above this
 * is pure so that `npm test` can run without a browser - please keep it that way.
 */
'use strict';

const LS_KEY = 'miro-timeline:doc';
const LS_THEME = 'miro-timeline:theme';
const LS_SEEN = 'miro-timeline:seen-intro';
const LS_TEAM_SIZE = 'miro-timeline:team-size';

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

/* Has the viewer taken the tour? Its own key, so Reset - which discards the document -
 * does not start nagging again. Mirrored onto App.tourSeen because renderToolbar decides
 * how prominent the tour button is, and it should not hit localStorage on every render. */
function introSeen() {
  try { return localStorage.getItem(LS_SEEN) === '1'; } catch (e) { return true; }
}
function restoreTour() { App.tourSeen = introSeen(); }
function markIntroSeen() {
  App.tourSeen = true;
  try { localStorage.setItem(LS_SEEN, '1'); } catch (e) { /* private mode - offered again */ }
}

function restoreTheme() {
  let saved = null;
  try { saved = localStorage.getItem(LS_THEME); } catch (e) { /* ignore */ }
  App.theme = saved === 'light' || saved === 'dark' ? saved : 'auto';
}

/* Team size is a viewer preference, not something any CSV carries - buildDoc() always
 * hands back the same hardcoded default. Remembering the last value typed means opening a
 * different file, or Reset, does not silently drop it back to that default. Its own key,
 * same reasoning as the theme above. A share link is different: it deliberately encodes an
 * explicit team size (see share.js), so adoptDoc() leaves this alone - only loadDoc() reads
 * it, since a freshly parsed file never has an opinion of its own. */
function lastTeamSize() {
  let n = null;
  try { n = parseInt(localStorage.getItem(LS_TEAM_SIZE), 10); } catch (e) { /* ignore */ }
  return Number.isFinite(n) && n > 0 ? n : null;
}
function rememberTeamSize(n) {
  try { localStorage.setItem(LS_TEAM_SIZE, String(n)); } catch (e) { /* private mode - just will not persist */ }
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
  tourSeen: true,   // assume seen until restoreTour() says otherwise
  undoStack: [],
  redoStack: [],
  pendingDrag: null,
  // Every renderGantt() fully recreates .gantt-container - frappe has no incremental
  // update path - which would snap it back to project start on every commit. Set before a
  // brand new document lands (loadDoc/adoptDoc), where jumping to project start is correct;
  // left false the rest of the time so renderGantt knows to restore the old scroll position
  // instead.
  freshDoc: false,
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

/* Adopt an already-built document, as decoded from a share link. Deliberately not
 * loadDoc(): there is no source text to parse, the document arrives complete. */
function adoptDoc(doc, fileName) {
  App.doc = doc;
  App.fileName = fileName || 'shared-plan.csv';
  App.isExample = false;
  App.selected = null;
  App.undoStack.length = 0;
  App.redoStack.length = 0;
  App.freshDoc = true;
  rebuildCal();
  normalizeStarts();   // a link could carry a start that is not a working day here
  renderAll();
}

function loadDoc(text, fileName, isExample) {
  const cal = makeCalendar([]);
  const doc = parseAny(text, fileName, cal);
  const remembered = lastTeamSize();
  if (remembered != null) doc.teamSize = remembered;
  App.doc = doc;
  App.fileName = fileName || 'plan.csv';
  App.isExample = !!isExample;
  App.selected = null;
  App.undoStack.length = 0;
  App.redoStack.length = 0;
  App.freshDoc = true;
  rebuildCal();
  renderAll();
}

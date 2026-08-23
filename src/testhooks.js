/* Test surface. Loaded last.
 *
 * The pure functions plus a few bound helpers, so a plan can be driven from the browser
 * console or from test/browser.test.mjs without a build step. Nothing in the app itself
 * reads these, so a deployment may drop this file.
 */
'use strict';

window.App = App;
window.__buildDoc = buildDoc;
window.__makeCalendar = makeCalendar;
window.__toCSV = () => docToCSV(App.doc, App.cal);
window.__toMiro = () => docToMiro(App.doc, App.cal);
window.__parseAny = parseAny;
window.__parseCSV = parseCSV;
window.__remap = remapColumn;
window.__analyse = () => analyse(App.doc, App.cal);
window.__validate = () => validate(App.doc, App.cal, analyse(App.doc, App.cal));
window.__resched = (id, delta) => { reschedule(App.doc, App.cal, id, delta); renderAll(); };
window.__pull = () => { pullIntoLegality(App.doc, App.cal); renderAll(); };
window.__asap = () => { asapAll(App.doc, App.cal); renderAll(); };

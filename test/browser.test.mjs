/* Browser tests: rendering geometry and the real mouse gestures that the logic tests
 * cannot reach. Every check here corresponds to something that has actually broken:
 *
 *  - frappe fires on_date_change on every mousemove, not on release, so re-rendering
 *    inside that callback tore down the SVG and a 4-column drag moved 1 day.
 *  - custom_class goes straight into classList.add, so a multi-class string threw and
 *    only one bar rendered.
 *  - a bar could be dropped before its predecessor finished, producing an illegal plan.
 *  - the name gutter has to stay row-aligned with the bars.
 *
 * Requires: npm i (playwright) && npx playwright install chromium
 */
import { chromium } from 'playwright';
import { readFileSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const APP = pathToFileURL(join(ROOT, 'index.html')).href;

let pass = 0, fail = 0;
const check = (name, ok, detail = '') => {
  ok ? pass++ : fail++;
  const tag = ok ? '\x1b[32mPASS\x1b[0m' : '\x1b[31mFAIL\x1b[0m';
  console.log(`${tag} ${name}${ok || !detail ? '' : '\n       ' + detail}`);
};
const group = (s) => console.log(`\n\x1b[1m${s}\x1b[0m`);

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1700, height: 1000 } });
const errors = [];
page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
page.on('pageerror', (e) => errors.push('PAGEERROR ' + e.message));

const boot = async (mode) => {
  await page.goto(APP, { waitUntil: 'load' });
  await page.evaluate(() => localStorage.clear());
  await page.reload({ waitUntil: 'load' });
  await page.waitForSelector('#gantt .bar-wrapper');
  await page.evaluate(() => window.__asap());
  if (mode) await page.click(`#seg-mode button[data-mode="${mode}"]`);
  await page.waitForTimeout(250);
};
const idxAll = () => page.evaluate(() => {
  const o = {};
  for (const t of window.App.doc.tasks) o[t.id] = window.App.cal.nextIdx(t.start);
  return o;
});
const durOf = (id) => page.evaluate((i) => window.App.doc.tasks.find((t) => t.id === i).duration, id);
const violations = () => page.evaluate(() => window.__validate().filter((f) => f.code === 'dep-violation').length);

/** Screen coords from the SVG CTM. getBoundingClientRect is clipped for SVG children. */
const geoOf = (id) => page.evaluate((i) => {
  const el = document.querySelector(`#gantt .bar-wrapper[data-id="${i}"] .bar`);
  const m = el.getScreenCTM();
  const x = +el.getAttribute('x'), y = +el.getAttribute('y');
  const w = +el.getAttribute('width'), h = +el.getAttribute('height');
  return { cx: m.e + x + w / 2, cy: m.f + y + h / 2, cw: window.App.gantt.config.column_width };
}, id);

/** Centre a bar's right edge so a rightward gesture cannot leave the SVG. */
const centreOn = (id) => page.evaluate((i) => {
  const c = document.querySelector('#gantt .gantt-container');
  const bar = document.querySelector(`#gantt .bar-wrapper[data-id="${i}"] .bar`);
  c.scrollLeft = Math.max(0, +bar.getAttribute('x') + +bar.getAttribute('width') - c.clientWidth / 2);
}, id);

const drag = async (id, cols) => {
  await page.locator(`#gantt .bar-wrapper[data-id="${id}"] .bar`).scrollIntoViewIfNeeded();
  await centreOn(id);
  await page.waitForTimeout(200);
  const g = await geoOf(id);
  await page.mouse.move(g.cx, g.cy);
  await page.mouse.down();
  await page.mouse.move(g.cx + 15, g.cy, { steps: 3 });
  await page.mouse.move(g.cx + cols * g.cw, g.cy, { steps: 15 });
  await page.mouse.up();
  await page.waitForTimeout(400);
};

const resizeRight = async (id, cols) => {
  await page.locator(`#gantt .bar-wrapper[data-id="${id}"] .bar`).scrollIntoViewIfNeeded();
  await centreOn(id);
  await page.waitForTimeout(250);
  const g = await page.evaluate((i) => {
    const h = document.querySelector(`#gantt .bar-wrapper[data-id="${i}"] .handle.right`);
    const m = h.getScreenCTM(), bb = h.getBBox();
    return { rx: m.e + bb.x + bb.width / 2, cy: m.f + bb.y + bb.height / 2,
             cw: window.App.gantt.config.column_width };
  }, id);
  await page.mouse.move(g.rx, g.cy);
  await page.mouse.down();
  await page.mouse.move(g.rx + 15, g.cy, { steps: 3 });
  await page.mouse.move(g.rx + cols * g.cw, g.cy, { steps: 15 });
  await page.mouse.up();
  await page.waitForTimeout(400);
};

/* ---------------------------------------------------------------- selftest */
group('in-page selftest');
await page.goto(APP + '#selftest', { waitUntil: 'load' });
await page.waitForTimeout(600);
const st = await page.evaluate(() => document.getElementById('selftest').innerText);
const sm = st.match(/(\d+) passed, (\d+) failed/);
check('the same assertions pass in a real browser', !!sm && sm[2] === '0',
  st.split('\n').filter((l) => l.startsWith('FAIL')).slice(0, 5).join(' | '));
console.log('       ' + (sm ? sm[0] : 'no summary'));

/* ---------------------------------------------------------------- boot */
group('boot');
await boot();
check('every task in the example renders a bar',
  (await page.locator('#gantt .bar-wrapper').count()) === 16,
  String(await page.locator('#gantt .bar-wrapper').count()));
check('the gutter has one row per bar', (await page.locator('#gutter .g-row').count()) === 16);
/* Clicking a name in the gutter selects the task AND reveals the editor. A single click
 * on a bar only selects; only a double click switches tab. */
await page.click('#side-tabs button[data-tab="validate"]');
await page.click('#gutter .g-row');
await page.waitForTimeout(200);
check('clicking a gutter row opens the task editor tab',
  !(await page.locator('#tab-editor').isHidden()),
  'tab-editor hidden after gutter click');
check('clicking a gutter row selects that task',
  (await page.evaluate(() => window.App.selected)) === 'survey',
  String(await page.evaluate(() => window.App.selected)));
await page.click('#side-tabs button[data-tab="validate"]');
// dispatched rather than page.click: the SVG bar-label sits on top and intercepts hits
await page.evaluate(() => document.querySelector('#gantt .bar-wrapper .bar')
  .dispatchEvent(new MouseEvent('click', { bubbles: true })));
await page.waitForTimeout(200);
check('a single click on a bar does not switch tab',
  await page.locator('#tab-editor').isHidden());
check('no console errors (a multi-token custom_class used to throw here)',
  errors.length === 0, errors.slice(0, 4).join(' | '));
check('dependency arrows are drawn', (await page.locator('#gantt .arrow path').count()) >= 15,
  String(await page.locator('#gantt .arrow path').count()));

/* ---------------------------------------------------------------- geometry */
group('geometry: one column is one working day');
const geom = await page.evaluate(() => {
  const g = window.App.gantt, cal = window.App.cal, cw = g.config.column_width;
  const g0 = Math.round((g.gantt_start - new Date(2000, 0, 3)) / 86400000);
  return window.App.doc.tasks.map((t) => {
    const bar = document.querySelector(`#gantt .bar-wrapper[data-id="${t.id}"] .bar`);
    return { id: t.id, w: +bar.getAttribute('width') / cw, x: +bar.getAttribute('x') / cw,
             dur: t.duration, want: cal.nextIdx(t.start) - g0 };
  });
});
check('every bar is exactly `duration` columns wide',
  geom.every((r) => Math.abs(r.w - r.dur) < 0.01),
  geom.filter((r) => Math.abs(r.w - r.dur) >= 0.01).slice(0, 3).map((r) => `${r.id} ${r.w}!=${r.dur}`).join(', '));
check('every bar sits at its working-day offset on the axis',
  geom.every((r) => Math.abs(r.x - r.want) < 0.01),
  geom.filter((r) => Math.abs(r.x - r.want) >= 0.01).slice(0, 3).map((r) => `${r.id} ${r.x}!=${r.want}`).join(', '));
check('the axis contains no Saturdays or Sundays', await page.evaluate(() => {
  const cal = window.App.cal;
  for (let i = 0; i < 80; i++) {
    const d = new Date(cal.at(i) + 'T00:00:00').getDay();
    if (d === 0 || d === 6) return false;
  }
  return true;
}));
check('gutter rows stay aligned with their bars to within 1px', await page.evaluate(() => {
  const rows = [...document.querySelectorAll('#gutter .g-row')];
  return window.App.doc.tasks.every((t, i) => {
    const b = document.querySelector(`#gantt .bar-wrapper[data-id="${t.id}"] .bar`).getBoundingClientRect();
    const r = rows[i].getBoundingClientRect();
    return Math.abs((b.top + b.height / 2) - (r.top + r.height / 2)) <= 1;
  });
}));
check('overflowing bar labels are hidden rather than colliding', await page.evaluate(() =>
  [...document.querySelectorAll('#gantt .bar-label.big')].every((e) => getComputedStyle(e).display === 'none')));

/* ---------------------------------------------------------------- validation panel */
group('validation panel');
const vtext = await page.locator('#tab-validate').innerText();
check('the estimate mismatch is surfaced', /Duration does not match estimate \(1\)/i.test(vtext),
  (vtext.match(/Duration does not match estimate \(\d+\)/i) || ['none'])[0]);
check('the missing estimate is surfaced', /Missing estimates \(1\)/i.test(vtext),
  (vtext.match(/Missing estimates \(\d+\)/i) || ['none'])[0]);
check('no unrecognised dependencies in the example', !/Unrecognised dependencies/i.test(vtext));

/* ---------------------------------------------------------------- columns tab */
group('column mapping');
await page.click('#side-tabs button[data-tab="columns"]');
await page.waitForTimeout(200);
const ctext = await page.locator('#tab-columns').innerText();
check('unmapped columns are listed as pass-through', /owner, confidence/i.test(ctext),
  ctext.split('\n').slice(0, 24).join(' | '));
check('there is a mapping control per canonical field',
  (await page.locator('#tab-columns .colmap').count()) === 10,
  String(await page.locator('#tab-columns .colmap').count()));
/* `numCols.length && html`...`` rendered a literal "0" here when there were no numeric
 * columns, because Preact prints the number 0 rather than treating it as empty. */
check('no stray "0" leaks out of an empty conditional block',
  !/^\s*0\s*$/m.test(ctext), JSON.stringify(ctext.split('\n').slice(0, 30)));
check('unmapping a field clears it and makes the column pass-through',
  await page.evaluate(() => {
    window.__remap('estimate', -1);
    const d = window.App.doc;
    return d.tasks.every((t) => t.estimate === null)
      && d.extras.map((i) => d.header[i]).includes('estimate');
  }));
await page.click('#btn-undo');
await page.waitForTimeout(250);
check('undo restores the previous mapping',
  (await page.evaluate(() => window.App.doc.tasks.find((t) => t.id === 'survey').estimate)) === 5);

/* ---------------------------------------------------------------- diffing panels */
/* The panels are Preact components so a re-render diffs in place instead of tearing the
 * subtree down. That is what keeps input focus, caret position and scroll offsets. These
 * checks would all fail against the old innerHTML/createElement rebuild. */
group('panels update in place, not by teardown');
await boot();
await page.click('#gutter .g-row');
await page.waitForTimeout(250);

const nodeKept = await page.evaluate(() => {
  const inp = document.querySelector('#tab-editor input[type=text]');
  if (!inp) return 'no input';
  inp.__probe = 'kept';
  renderAll();
  const after = document.querySelector('#tab-editor input[type=text]');
  return after && after.__probe === 'kept';
});
check('a full re-render reuses the editor input node rather than replacing it',
  nodeKept === true, String(nodeKept));

const caretKept = await page.evaluate(() => {
  showTab('editor');   // an element inside a hidden panel cannot take focus
  const inp = document.querySelector('#tab-editor input[type=text]');
  inp.focus();
  inp.setSelectionRange(3, 3);
  if (document.activeElement !== inp) return 'could not focus';
  renderAll();
  return document.activeElement === inp && inp.selectionStart === 3;
});
check('focus and caret survive a re-render', caretKept === true, String(caretKept));

const scrollKept = await page.evaluate(() => {
  showTab('validate');
  const p = document.getElementById('tab-validate');
  p.scrollTop = 40;
  if (p.scrollTop === 0) return 'panel does not scroll';
  renderAll();
  return p.scrollTop === 40;
});
check('side-panel scroll position survives a re-render',
  scrollKept === true || scrollKept === 'panel does not scroll', String(scrollKept));

const chartScrollKept = await page.evaluate(() => {
  const c = document.querySelector('#gantt .gantt-container');
  c.scrollLeft = 120;
  const before = c.scrollLeft;
  document.querySelector('#gantt .bar-wrapper .bar').dispatchEvent(
    new MouseEvent('click', { bubbles: true }));
  const after = document.querySelector('#gantt .gantt-container').scrollLeft;
  return { before, after };
});
check('clicking a bar does not reset the chart scroll',
  chartScrollKept.after === chartScrollKept.before, JSON.stringify(chartScrollKept));

/* A column name comes straight from the loaded file and used to be interpolated into
 * innerHTML unescaped in the estimator-comparison row. Preact escapes by construction. */
group('file content cannot inject markup');
await boot();
const inject = await page.evaluate(async () => {
  const dt = new DataTransfer();
  dt.items.add(new File([
    'name,estimate,<img src=x onerror=window.__pwned=1> #\nAlpha,5,7\nBeta,5,19\n',
  ], 'inject.csv', { type: 'text/csv' }));
  window.dispatchEvent(new DragEvent('drop', { dataTransfer: dt, bubbles: true, cancelable: true }));
  await new Promise((r) => setTimeout(r, 400));
  selectTask(window.App.doc.tasks[0].id, true);
  await new Promise((r) => setTimeout(r, 200));
  const cmp = document.querySelector('#tab-editor .est-cmp');
  const cols = document.getElementById('tab-columns');
  return {
    pwned: !!window.__pwned,
    imgs: document.querySelectorAll('#tab-editor img, #tab-columns img').length,
    cmpText: cmp ? cmp.textContent : '',
    colsText: cols ? cols.textContent : '',
  };
});
check('a script-ish column name creates no element and runs nothing',
  inject.pwned === false && inject.imgs === 0, JSON.stringify(inject).slice(0, 160));
check('it is shown as literal text instead',
  inject.cmpText.includes('<img') || inject.colsText.includes('<img'),
  JSON.stringify({ cmp: inject.cmpText.slice(0, 60), cols: inject.colsText.slice(0, 60) }));

/* ---------------------------------------------------------------- undo coverage */
/* Propagation mode and team size used to mutate the doc without calling snapshot(), so
 * they were silently not undoable. Everything now goes through commit(). */
group('every edit is undoable');
await boot('rigid');
await page.click('#seg-mode button[data-mode="asap"]');
await page.waitForTimeout(200);
check('changing propagation mode takes effect',
  (await page.evaluate(() => window.App.doc.mode)) === 'asap');
await page.click('#btn-undo');
await page.waitForTimeout(250);
check('undo reverts a propagation mode change',
  (await page.evaluate(() => window.App.doc.mode)) === 'rigid',
  await page.evaluate(() => window.App.doc.mode));

await boot();
await page.fill('#team-size', '9');
await page.dispatchEvent('#team-size', 'change');
await page.waitForTimeout(200);
check('changing team size takes effect',
  (await page.evaluate(() => window.App.doc.teamSize)) === 9);
await page.click('#btn-undo');
await page.waitForTimeout(250);
check('undo reverts a team size change',
  (await page.evaluate(() => window.App.doc.teamSize)) === 4,
  String(await page.evaluate(() => window.App.doc.teamSize)));

/* ---------------------------------------------------------------- project start */
group('moving the project start');
await boot();
const b0 = await page.evaluate(() => window.App.doc.tasks.map((t) => window.App.cal.nextIdx(t.start)));
await page.fill('#proj-start', '2027-04-01');
await page.dispatchEvent('#proj-start', 'change');
await page.waitForTimeout(300);
const a0 = await page.evaluate(() => window.App.doc.tasks.map((t) => window.App.cal.nextIdx(t.start)));
const deltas = [...new Set(a0.map((v, i) => v - b0[i]))];
check('the whole plan shifts by one identical working-day delta',
  deltas.length === 1 && deltas[0] !== 0, 'deltas seen: ' + deltas.join(','));
check('nothing lands on a weekend',
  await page.evaluate(() => window.App.doc.tasks.every((t) => window.App.cal.isWorking(t.start))));

/* ---------------------------------------------------------------- drag */
group('dragging a bar (rigid)');
await boot('rigid');
let before = await idxAll();
await drag('joinery', 4);
let after = await idxAll();
check('the dragged task moves the full gesture, not one column',
  after.joinery - before.joinery === 4, `moved ${after.joinery - before.joinery}d`);
check('downstream shifts by the same delta, preserving its gap',
  after.espresso - before.espresso === 4, `moved ${after.espresso - before.espresso}d`);
check('the shift carries all the way to the last task',
  after.open - before.open === 4, `moved ${after.open - before.open}d`);
check('an unrelated branch does not move', after.menu === before.menu);
check('a move does not change the duration', (await durOf('joinery')) === 15, String(await durOf('joinery')));
check('no dependency violations afterwards', (await violations()) === 0);

group('dragging a bar (ASAP)');
await boot('asap');
await drag('joinery', 4);
const aa = await idxAll();
const jd = await durOf('joinery');
check('the drag is honoured as a pin', aa.joinery > 0);
check('downstream is pulled to the earliest legal start',
  aa.espresso === aa.joinery + jd, `${aa.espresso} vs ${aa.joinery + jd}`);

group('dragging backwards past a predecessor');
await boot('rigid');
await drag('espresso', -25);
check('the landing position is clamped rather than left illegal', (await violations()) === 0);

/* ---------------------------------------------------------------- resize */
group('resizing a bar');
await boot('rigid');
before = await idxAll();
await resizeRight('joinery', 5);
after = await idxAll();
check('the duration grows by the gesture', (await durOf('joinery')) === 20, String(await durOf('joinery')));
check('the start does not move when resizing the right edge', after.joinery === before.joinery);
check('downstream is pushed out by the growth',
  after.espresso - before.espresso === 5, `moved ${after.espresso - before.espresso}d`);
check('the estimate mismatch clears once duration matches estimate',
  (await page.evaluate(() => window.__validate().filter((f) => f.code === 'estimate-mismatch').length)) === 0);
check('no dependency violations afterwards', (await violations()) === 0);
const undoable = !(await page.locator('#btn-undo').isDisabled());
check('the gesture produced exactly one undo entry', undoable);
if (undoable) {
  await page.click('#btn-undo');
  await page.waitForTimeout(300);
  check('undo reverts the resize', (await durOf('joinery')) === 15, String(await durOf('joinery')));
}

/* ---------------------------------------------------------------- new upstream task */
group('adding a task upstream of another');
await boot('asap');
const added = await page.evaluate(() => {
  const cal = window.App.cal, doc = window.App.doc;
  const open = doc.tasks.find((t) => t.id === 'open');
  const before = cal.nextIdx(open.start);
  document.getElementById('btn-add').click();
  const nt = doc.tasks[doc.tasks.length - 1];
  nt.duration = 10; nt.estimate = 10; nt.name = 'Health inspection';
  nt.start = open.start;
  open.deps.push(nt.id);
  window.__asap();
  return { before, after: cal.nextIdx(open.start), n: doc.tasks.length };
});
check('the downstream task is pushed out', added.after > added.before, JSON.stringify(added));
check('it moves by exactly the new task duration', added.after - added.before === 10,
  String(added.after - added.before));
check('the new task appears in the gutter', (await page.locator('#gutter .g-row').count()) === 17);

/* ---------------------------------------------------------------- export */
group('export');
await boot();
const out = await page.evaluate(() => ({ csv: window.__toCSV(), tsv: window.__toTSV() }));
check('the CSV keeps the original header verbatim',
  out.csv.split('\n')[0] === 'id,name,description,tag,start_date,end_date,estimate,owner,confidence,blocked by',
  out.csv.split('\n')[0]);
check('a comma-containing name is quoted', /"Counter, shelving and seating"/.test(out.csv));
/* The clipboard shape is TSV because Excel only splits pasted text on tabs. Every row must
 * therefore have exactly as many tab-separated cells as the header, with no quoting. */
const tlines = out.tsv.trim().split('\n');
const twidths = [...new Set(tlines.map((l) => l.split('\t').length))];
check('the TSV is one header row plus one row per task', tlines.length === 17,
  String(tlines.length));
check('every TSV row has the same cell count as the header',
  twidths.length === 1 && twidths[0] === 10, JSON.stringify(twidths));
check('a comma-containing name stays in a single TSV cell without quotes', (() => {
  const row = tlines.find((l) => l.includes('Counter, shelving and seating'));
  return !!row && !row.includes('"') && row.split('\t').length === 10;
})(), (tlines.find((l) => l.includes('Counter,')) || '').slice(0, 80));
const re = await page.evaluate((csv) => {
  const cal = window.__makeCalendar([]);
  const d = window.__parseAny(csv, 'plan.csv', cal);
  return { n: d.tasks.length, unres: d.tasks.reduce((s, t) => s + t.unresolved.length, 0),
           deps: d.tasks.map((t) => t.deps.join('|')).join(';') };
}, out.csv);
const orig = await page.evaluate(() => window.App.doc.tasks.map((t) => t.deps.join('|')).join(';'));
check('re-importing the export is idempotent', re.n === 16 && re.unres === 0 && re.deps === orig,
  JSON.stringify(re).slice(0, 160));

/* ---------------------------------------------------------------- drop files */
group('dropping files');
const dropFile = (name, text) => page.evaluate(async ({ name, text }) => {
  const dt = new DataTransfer();
  dt.items.add(new File([text], name, { type: 'text/csv' }));
  window.dispatchEvent(new DragEvent('drop', { dataTransfer: dt, bubbles: true, cancelable: true }));
  await new Promise((r) => setTimeout(r, 500));
  const d = window.App.doc;
  return { n: d.tasks.length, file: window.App.fileName, est: d.mapping.estimate,
           unres: d.tasks.reduce((s, t) => s + t.unresolved.length, 0),
           deps: Object.fromEntries(d.tasks.map((t) => [t.id, t.deps])) };
}, { name, text });

await boot();
const alias = await dropFile('aliases.csv',
  'task,effort,start,depends_on\nAlpha,5,2027-06-07,\nBeta,10,2027-06-14,Alpha\nGamma,5,2027-06-28,Beta\n');
check('alias columns (task/effort/start/depends_on) are recognised',
  alias.n === 3 && alias.est === 1, JSON.stringify(alias));
check('a dependency resolves by name', alias.deps.beta.join() === 'alpha', alias.deps.beta.join());
check('the file name is picked up', alias.file === 'aliases.csv', alias.file);

const ref = await dropFile('timeline.csv', readFileSync(join(ROOT, 'examples', 'timeline.csv'), 'utf8'));
check('the reference example loads', ref.n === 15, JSON.stringify({ n: ref.n }));
check('id-based, semicolon-separated dependencies resolve',
  ref.deps.po.slice().sort().join() === 'reqs,vendor', ref.deps.po.join());
check('the reference example has no unresolved dependencies', ref.unres === 0, String(ref.unres));

check('no page errors across the whole run', errors.length === 0, errors.slice(0, 4).join(' | '));
await browser.close();
console.log(`\n${fail ? '\x1b[31mFAILED\x1b[0m' : '\x1b[32mALL PASS\x1b[0m'}  ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);

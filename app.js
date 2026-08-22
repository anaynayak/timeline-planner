/* Timeline Planner - a working-day scheduler for Miro Timeline markdown exports.
 *
 * Design note: frappe-gantt's `ignore` option does NOT compress the axis; it hatches
 * non-working columns and keeps a calendar axis, so a 10-working-day bar would still be
 * 12 columns wide. To get "1 column == 1 working day" (bar width == estimate) we render
 * in *workday space*: every real working day is mapped to a contiguous synthetic date,
 * frappe draws that, and the axis labels are translated back to real dates. All
 * scheduling arithmetic is therefore plain integer working-day indices.
 */
'use strict';

/* ============================================================ 1. date utils */

const MS_DAY = 86400000;
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

const pad2 = (n) => (n < 10 ? '0' + n : '' + n);
const ymd = (d) => d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate());
const parseYMD = (s) => {
  const p = String(s).slice(0, 10).split('-').map(Number);
  return new Date(p[0], (p[1] || 1) - 1, p[2] || 1);
};
const addDays = (d, n) => new Date(d.getFullYear(), d.getMonth(), d.getDate() + n);
const daysBetween = (a, b) =>
  Math.round((new Date(b.getFullYear(), b.getMonth(), b.getDate()) -
              new Date(a.getFullYear(), a.getMonth(), a.getDate())) / MS_DAY);
const mondayOf = (d) => addDays(d, -((d.getDay() + 6) % 7));
const sundayOf = (d) => addDays(mondayOf(d), 6);
const isoZ = (s) => parseYMD(s) && String(s).slice(0, 10) + 'T00:00:00.000Z';
const fmtNice = (s) => { const d = parseYMD(s); return d.getDate() + ' ' + MONTHS[d.getMonth()] + ' ' + d.getFullYear(); };

/* ============================================================ 2. calendar */

/* A fixed-origin index of working days. Working day k has index k; all scheduling is
 * integer arithmetic over these indices, so weekends and holidays simply do not exist
 * in the number line. Rebuilt whenever the holiday set changes. */
const CAL_ORIGIN = '2020-01-06';   // a Monday
const CAL_SPAN_DAYS = 6200;        // ~2020-01 .. 2036-12

function makeCalendar(holidays) {
  const hol = new Set(holidays || []);
  const at = [];            // index -> 'YYYY-MM-DD'
  const idxOf = new Map();  // 'YYYY-MM-DD' -> index
  let d = parseYMD(CAL_ORIGIN);
  for (let i = 0; i < CAL_SPAN_DAYS; i++) {
    const k = ymd(d), g = d.getDay();
    if (g !== 0 && g !== 6 && !hol.has(k)) { idxOf.set(k, at.length); at.push(k); }
    d = addDays(d, 1);
  }

  const isWorking = (s) => idxOf.has(typeof s === 'string' ? s.slice(0, 10) : ymd(s));

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
    at: (i) => at[clamp(i)],
    isWorking, nextIdx, prevIdx, clamp,
    /** inclusive count of working days between two dates */
    count: (a, b) => prevIdx(b) - nextIdx(a) + 1,
  };
}

/* ============================================================ 3. tabular formats
 *
 * CSV is the primary format. Columns are matched to canonical fields by alias, so a file
 * can call the name column "name", "title" or "task" and still load; anything unmapped is
 * carried through untouched so exporting never loses data. Miro Timeline markdown exports
 * are also accepted, since that is where these plans tend to start life.
 */

const slugify = (s) =>
  String(s).trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'task';
const normKey = (s) => String(s).trim().replace(/[\s_]+/g, ' ').toLowerCase();

/* ---------- canonical fields and their accepted column names ---------- */

const FIELDS = [
  { key: 'id',          label: 'ID',          aliases: ['id', 'key', 'ref', 'task id', 'uid'] },
  { key: 'name',        label: 'Name',        aliases: ['name', 'title', 'task', 'task name', 'summary', 'activity'] },
  { key: 'description', label: 'Description', aliases: ['description', 'notes', 'note', 'detail', 'details', 'comment'] },
  { key: 'tag',         label: 'Tag',         aliases: ['tag', 'tags', 'stream', 'workstream', 'group', 'category', 'phase', 'epic'] },
  { key: 'start_date',  label: 'Start date',  aliases: ['start date', 'start', 'begin', 'from', 'startdate'] },
  { key: 'end_date',    label: 'End date',    aliases: ['end date', 'end', 'finish', 'to', 'due', 'due date', 'enddate'] },
  { key: 'estimate',    label: 'Estimate',    aliases: ['estimate', 'estimate days', 'est', 'effort', 'effort days', 'points', 'size'] },
  { key: 'duration',    label: 'Duration',    aliases: ['duration', 'duration days', 'days', 'elapsed', 'working days'] },
  { key: 'dependency',  label: 'Dependency',  aliases: ['dependency', 'dependencies', 'depends on', 'blocked by', 'predecessor', 'predecessors', 'after', 'upstream'] },
  { key: 'pinned',      label: 'Pinned',      aliases: ['pinned', 'pin', 'fixed', 'locked'] },
];
const FIELD_KEYS = FIELDS.map((f) => f.key);

/** Match each canonical field to a column index; -1 when the file has no such column. */
function detectMapping(header) {
  const H = header.map(normKey);
  const mapping = {};
  const taken = new Set();
  for (const f of FIELDS) {
    let hit = -1;
    for (const a of f.aliases) {
      const i = H.indexOf(normKey(a));
      if (i >= 0 && !taken.has(i)) { hit = i; break; }
    }
    if (hit >= 0) taken.add(hit);
    mapping[f.key] = hit;
  }
  const extras = header.map((_, i) => i).filter((i) => !taken.has(i));
  return { mapping, extras };
}

/* ---------- CSV (RFC 4180) ---------- */

function parseCSV(text) {
  const s = String(text).replace(/^\uFEFF/, '');   // strip a UTF-8 BOM
  const rows = [];
  let row = [], field = '', q = false, i = 0;
  while (i < s.length) {
    const c = s[i];
    if (q) {
      if (c === '"') {
        if (s[i + 1] === '"') { field += '"'; i += 2; continue; }
        q = false; i++; continue;
      }
      field += c; i++; continue;
    }
    if (c === '"') { q = true; i++; continue; }
    if (c === ',') { row.push(field); field = ''; i++; continue; }
    if (c === '\r') { i++; continue; }
    if (c === '\n') { row.push(field); rows.push(row); row = []; field = ''; i++; continue; }
    field += c; i++;
  }
  if (field !== '' || row.length) { row.push(field); rows.push(row); }
  return rows.filter((r) => r.some((c) => String(c).trim() !== ''));
}

/* Spreadsheet exports (Miro's included) wrap values that a spreadsheet would read as a
 * formula in single quotes, so a task called "% Split" arrives as "'% Split'" in the Title
 * column while the dependency column still says "% Split". Strip it on the way in and
 * re-apply it on the way out, so names match and the export stays injection-safe. */
const FORMULA_START = /^[=+\-@%]/;

function unquoteFormula(s) {
  const v = String(s == null ? '' : s);
  return v.length >= 2 && v[0] === "'" && v[v.length - 1] === "'" && FORMULA_START.test(v.slice(1, -1))
    ? v.slice(1, -1)
    : v;
}
const quoteFormula = (s) => {
  const v = String(s == null ? '' : s);
  return FORMULA_START.test(v) ? "'" + v + "'" : v;
};

function csvCell(v) {
  const s = quoteFormula(v);
  return /[",\n\r]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
}
const toCSV = (rows) => rows.map((r) => r.map(csvCell).join(',')).join('\n') + '\n';

/* ---------- Miro markdown ---------- */

const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', '#39': "'" };

function unescapeMiro(s) {
  return String(s)
    .replace(/&(#?\w+);/g, (m, e) => (e in ENTITIES ? ENTITIES[e] : m))
    .replace(/\\(.)/g, '$1');
}
/* Reproduces Miro's own escaping: & becomes an entity, and - . # + ( ) | are backslashed. */
function escapeMiro(s) {
  return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/([-.#+()|])/g, '\\$1');
}

/** Split a markdown table row on unescaped pipes. */
function splitRow(line) {
  const s = line.trim().replace(/^\|/, '').replace(/\|$/, '');
  const out = [];
  let cur = '';
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (c === '\\' && i + 1 < s.length) { cur += c + s[i + 1]; i++; continue; }
    if (c === '|') { out.push(cur); cur = ''; continue; }
    cur += c;
  }
  out.push(cur);
  return out.map((x) => x.trim());
}

/** Miro markdown -> { header, rows, preamble }. */
function parseMiroTable(text) {
  const preamble = [];
  let header = null;
  const rows = [];
  for (const line of String(text).split(/\r?\n/)) {
    const t = line.trim();
    if (t.startsWith('|')) {
      const cells = splitRow(t);
      if (!header) { header = cells.map(unescapeMiro); continue; }
      if (cells.every((c) => /^:?-{2,}:?$/.test(c.trim()))) continue;
      rows.push(cells.map(unescapeMiro));
    } else if (!header && t) {
      preamble.push(line);
    }
  }
  return { header, rows, preamble };
}

/* ---------- dates ---------- */

/** Accepts ISO (with or without time/Z), YYYY/MM/DD and DD/MM/YYYY. */
function parseDateCell(v) {
  const s = String(v || '').trim();
  if (!s) return null;
  let m = /^(\d{4})[-/](\d{1,2})[-/](\d{1,2})/.exec(s);
  if (m) return `${m[1]}-${pad2(+m[2])}-${pad2(+m[3])}`;
  m = /^(\d{1,2})[-/](\d{1,2})[-/](\d{4})$/.exec(s);
  if (m) return `${m[3]}-${pad2(+m[2])}-${pad2(+m[1])}`;
  const d = new Date(s);
  return isNaN(d) ? null : ymd(d);
}
/** How the source wrote its dates, so the export matches. */
function detectDateFormat(samples) {
  for (const s of samples) {
    const v = String(s || '').trim();
    if (!v) continue;
    if (/T\d{2}:\d{2}/.test(v)) return 'isoz';
    if (/^\d{1,2}[-/]\d{1,2}[-/]\d{4}$/.test(v)) return 'dmy';
    if (/^\d{4}[-/]\d{1,2}[-/]\d{1,2}$/.test(v)) return 'iso';
  }
  return 'iso';
}
function formatDateCell(s, fmt) {
  if (!s) return '';
  if (fmt === 'isoz') return s + 'T00:00:00.000Z';
  if (fmt === 'dmy') { const d = parseYMD(s); return `${pad2(d.getDate())}/${pad2(d.getMonth() + 1)}/${d.getFullYear()}`; }
  return s;
}

/* ---------- dependency resolution ---------- */

/** Greedy longest-name matcher, for comma-separated lists whose names contain commas. */
function makeDepMatcher(names) {
  const entries = names
    .slice()
    .sort((a, b) => b.length - a.length)
    .map((t) => ({
      name: t,
      re: new RegExp(t.trim().replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/\s+/g, '\\s+'), 'iy'),
    }));
  return function (str) {
    const found = [], unresolved = [];
    let pos = 0;
    const s = String(str || '');
    while (pos < s.length) {
      const skip = /^[\s,;]+/.exec(s.slice(pos));
      if (skip) { pos += skip[0].length; continue; }
      let hit = null;
      for (const e of entries) {
        e.re.lastIndex = pos;
        if (e.re.exec(s)) { hit = { name: e.name, len: e.re.lastIndex - pos }; break; }
      }
      if (hit) {
        if (!found.includes(hit.name)) found.push(hit.name);
        pos += hit.len;
      } else {
        const rest = s.slice(pos);
        const c = rest.search(/[,;]/);
        const tok = (c === -1 ? rest : rest.slice(0, c)).trim();
        if (tok) unresolved.push(tok);
        pos += c === -1 ? rest.length : c + 1;
      }
    }
    return { found, unresolved };
  };
}

/* ---------- header + rows -> plan document ---------- */

function buildDoc(header, rows, cal, opts) {
  opts = opts || {};
  const det = detectMapping(header);
  const mapping = Object.assign({}, det.mapping, opts.mapping || {});
  const extras = header.map((_, i) => i)
    .filter((i) => !FIELD_KEYS.some((k) => mapping[k] === i));

  const at = (r, key) => {
    const i = mapping[key];
    return i >= 0 && r[i] != null ? unquoteFormula(String(r[i]).trim()) : '';
  };
  if (mapping.name < 0) throw new Error('No name/title column found. Columns seen: ' + header.join(', '));

  const depCells = rows.map((r) => at(r, 'dependency'));
  const depSep = depCells.some((c) => c.includes(';')) ? '; ' : ', ';
  const dateFmt = detectDateFormat(rows.map((r) => at(r, 'start_date')).concat(rows.map((r) => at(r, 'end_date'))));

  const used = new Set();
  const tasks = [];
  const byName = new Map();
  const byExplicitId = new Map();

  for (const r of rows) {
    const name = at(r, 'name');
    if (!name) continue;
    const explicit = at(r, 'id');
    let id = slugify(explicit || name);
    if (used.has(id)) { let n = 2; while (used.has(id + '-' + n)) n++; id = id + '-' + n; }
    used.add(id);
    byName.set(normKey(name), id);
    if (explicit) byExplicitId.set(normKey(explicit), id);

    const estRaw = at(r, 'estimate');
    const durRaw = at(r, 'duration');
    const estimate = estRaw === '' || isNaN(Number(estRaw)) ? null : Number(estRaw);

    const startRaw = parseDateCell(at(r, 'start_date'));
    const endRaw = parseDateCell(at(r, 'end_date'));
    const si = startRaw ? cal.nextIdx(startRaw) : Math.max(0, cal.nextIdx(ymd(new Date())));

    // duration precedence: explicit duration, else the drawn start..end span, else estimate.
    // Miro bars run Mon..Sun, so an end date is pulled back to the last working day it covers.
    let duration;
    if (durRaw !== '' && !isNaN(Number(durRaw))) duration = Number(durRaw);
    else if (endRaw) duration = cal.prevIdx(endRaw) - si + 1;
    else if (estimate != null) duration = estimate;
    else duration = 1;

    const extra = {};
    for (const i of extras) extra[header[i]] = r[i] == null ? '' : unquoteFormula(String(r[i]).trim());

    const pinRaw = at(r, 'pinned').toLowerCase();

    tasks.push({
      id,
      explicitId: explicit || null,
      name,
      description: at(r, 'description'),
      tags: at(r, 'tag').split(/[,;]/).map((s) => s.trim()).filter(Boolean),
      estimate,
      duration: Math.max(1, duration),
      start: cal.at(si),
      deps: [],
      depRaw: at(r, 'dependency'),
      unresolved: [],
      extra,
      pinned: pinRaw === 'true' || pinRaw === 'yes' || pinRaw === '1' || pinRaw === 'y',
    });
  }

  // resolve dependencies now that every id and name is known: ids first, then names.
  // Tally which style the file used so the export writes it back the same way.
  const matchByName = makeDepMatcher(tasks.map((t) => t.name));
  let idHits = 0, nameHits = 0;
  for (const t of tasks) {
    const raw = t.depRaw;
    const tokens = raw.includes(';') ? raw.split(';') : null;
    let ids = [], unresolved = [];
    if (tokens) {
      for (const tok of tokens.map((x) => x.trim()).filter(Boolean)) {
        const byId = byExplicitId.get(normKey(tok));
        const byNm = byName.get(normKey(tok));
        if (byId) { ids.push(byId); idHits++; }
        else if (byNm) { ids.push(byNm); nameHits++; }
        else unresolved.push(tok);
      }
    } else {
      // could be ids or names; a clean id match on every comma token wins
      const parts = raw.split(',').map((x) => x.trim()).filter(Boolean);
      if (parts.length && parts.every((p) => byExplicitId.has(normKey(p)))) {
        ids = parts.map((p) => byExplicitId.get(normKey(p)));
        idHits += parts.length;
      } else {
        const m = matchByName(raw);
        ids = m.found.map((n) => byName.get(normKey(n)));
        nameHits += m.found.length;
        unresolved = m.unresolved;
      }
    }
    t.deps = [...new Set(ids.filter((x) => x && x !== t.id))];
    t.unresolved = unresolved;
    delete t.depRaw;
  }
  const depStyle = idHits || nameHits
    ? (idHits >= nameHits ? 'id' : 'name')
    : (mapping.id >= 0 ? 'id' : 'name');

  const firstStart = tasks.reduce((m, t) => (m === null || t.start < m ? t.start : m), null);

  return {
    format: opts.format || 'csv',
    header: header.slice(),
    // kept so a column can be re-mapped without needing the file again
    srcHeader: header.slice(),
    srcRows: rows.map((r) => r.slice()),
    mapping,
    extras,
    depSep,
    depStyle,
    dateFmt,
    preamble: opts.preamble || [],
    tasks,
    projectStart: firstStart || ymd(new Date()),
    holidays: [],
    teamSize: 4,
    mode: 'rigid',
  };
}

/** Load a CSV or a Miro markdown export, detecting which by content. */
function parseAny(text, fileName, cal, opts) {
  const s = String(text);
  const looksMiro = /^\s*\|.*\|/m.test(s) && /\|\s*:?-{2,}/m.test(s);
  if (looksMiro && !/\.csv$/i.test(fileName || '')) {
    const { header, rows, preamble } = parseMiroTable(s);
    if (!header) throw new Error('No markdown table found.');
    return buildDoc(header, rows, cal, Object.assign({ format: 'miro', preamble }, opts));
  }
  const rows = parseCSV(s);
  if (!rows.length) throw new Error('Empty file.');
  return buildDoc(rows[0].map((h) => String(h).trim()), rows.slice(1), cal,
    Object.assign({ format: 'csv' }, opts));
}

/* ---------- plan document -> rows ---------- */

function docRows(doc, cal) {
  const byId = new Map(doc.tasks.map((t) => [t.id, t]));
  const useIds = doc.depStyle === 'id' && doc.mapping.id >= 0;
  const out = [];
  for (const t of doc.tasks) {
    const si = cal.nextIdx(t.start);
    const ei = si + t.duration - 1;
    const cells = doc.header.map(() => '');
    const put = (key, v) => { const i = doc.mapping[key]; if (i >= 0) cells[i] = v; };
    put('id', t.explicitId || t.id);
    put('name', t.name);
    put('description', t.description || '');
    put('tag', t.tags.join(', '));
    // Miro draws whole Mon..Sun weeks; a CSV keeps the true working-day dates
    const sOut = doc.format === 'miro' ? ymd(mondayOf(parseYMD(cal.at(si)))) : cal.at(si);
    const eOut = doc.format === 'miro' ? ymd(sundayOf(parseYMD(cal.at(ei)))) : cal.at(ei);
    put('start_date', formatDateCell(sOut, doc.dateFmt));
    put('end_date', formatDateCell(eOut, doc.dateFmt));
    put('estimate', t.estimate == null ? '' : String(t.estimate));
    put('duration', String(t.duration));
    put('pinned', t.pinned ? 'yes' : '');
    put('dependency', t.deps
      .map((d) => { const p = byId.get(d); return p ? (useIds ? (p.explicitId || p.id) : p.name) : ''; })
      .filter(Boolean).join(doc.depSep));
    for (const i of doc.extras) cells[i] = t.extra && t.extra[doc.header[i]] != null ? t.extra[doc.header[i]] : '';
    out.push(cells);
  }
  return out;
}

/* Mon..Sun snapping is a Miro display convention, so a CSV always carries the true
 * working-day dates regardless of where the plan was imported from. */
const docToCSV = (doc, cal) =>
  toCSV([doc.header].concat(docRows(Object.assign({}, doc, { format: 'csv' }), cal)));

/** Miro-shaped markdown: Monday starts, Sunday ends, Miro escaping. */
function docToMiro(doc, cal) {
  const out = [];
  for (const p of doc.preamble) out.push(p);
  if (doc.preamble.length && doc.preamble[doc.preamble.length - 1].trim() !== '') out.push('');
  out.push('| ' + doc.header.map(escapeMiro).join(' | ') + ' |');
  out.push('| ' + doc.header.map(() => '---').join(' | ') + ' |');
  const miroDoc = Object.assign({}, doc, { format: 'miro', dateFmt: 'isoz' });
  for (const cells of docRows(miroDoc, cal)) {
    out.push('| ' + cells.map(escapeMiro).join(' | ') + ' |');
  }
  return out.join('\n') + '\n';
}

/* ============================================================ 4. scheduler */

function graph(doc) {
  const byId = new Map(doc.tasks.map((t) => [t.id, t]));
  const succ = new Map(doc.tasks.map((t) => [t.id, []]));
  for (const t of doc.tasks) {
    for (const d of t.deps) if (succ.has(d)) succ.get(d).push(t.id);
  }
  return { byId, succ };
}

/** Kahn topological sort. Nodes left over are inside cycles. */
function topo(doc) {
  const { succ } = graph(doc);
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
  const cyclic = doc.tasks.map((t) => t.id).filter((id) => !order.includes(id));
  return { order, cyclic };
}

function descendants(doc, id) {
  const { succ } = graph(doc);
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

const startIdx = (cal, t) => cal.nextIdx(t.start);
const endIdx = (cal, t) => cal.nextIdx(t.start) + t.duration - 1;

/** Earliest legal start index for `t` given the current starts of its predecessors. */
function earliest(doc, cal, t, floor) {
  const { byId } = graph(doc);
  let s = floor;
  for (const d of t.deps) {
    const p = byId.get(d);
    if (p) s = Math.max(s, endIdx(cal, p) + 1);
  }
  return s;
}

/** Full ASAP forward pass. Pinned tasks keep their manual start as a floor. */
function asapAll(doc, cal) {
  const { order } = topo(doc);
  const { byId } = graph(doc);
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
  const kids = descendants(doc, editedId);
  const { order } = topo(doc);
  const { byId } = graph(doc);
  const p0 = Math.max(0, cal.nextIdx(doc.projectStart));
  for (const id of order) {
    if (!kids.has(id)) continue;
    const t = byId.get(id);
    const shifted = startIdx(cal, t) + delta;
    t.start = cal.at(Math.max(shifted, earliest(doc, cal, t, p0)));
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

/** Backward pass: total float per task, and the project end index. */
function analyse(doc, cal) {
  const { order, cyclic } = topo(doc);
  const { byId, succ } = graph(doc);
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
  return { si, ei, projEnd, float, cyclic, order };
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

/* ============================================================ 5. validation */

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

function validate(doc, cal, an) {
  const f = [];
  const { byId } = graph(doc);
  const add = (level, code, msg, taskId, fix) => f.push({ level, code, msg, taskId, fix });

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
    const numCols = numericExtras(doc);
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
  for (const c of numericExtras(doc)) {
    const filled = doc.tasks.filter((t) => numOrNull(t.extra && t.extra[c]) != null).length;
    if (filled === 0 && doc.tasks.length) {
      add('info', 'estimator-empty', `"${c}" is empty on all ${doc.tasks.length} tasks.`, null);
    }
  }
  for (const [wk, load] of weeklyLoad(doc, cal)) {
    const people = load / 5;
    if (people > doc.teamSize + 1e-9) {
      add('warn', 'week-overload',
        `Week of ${fmtNice(wk)} needs ${people.toFixed(1)} people (team is ${doc.teamSize}).`, null);
    }
  }
  const rank = { error: 0, warn: 1, info: 2 };
  return f.sort((a, b) => rank[a.level] - rank[b.level]);
}

/* ============================================================ 6. store */

const LS_KEY = 'miro-timeline:doc';
const SYNTH0 = new Date(2000, 0, 3);   // a Monday; workday index 0 renders here

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

/* ============================================================ 7. rendering */

const synthYmd = (i) => ymd(addDays(SYNTH0, i));
const synthIdx = (d) => daysBetween(SYNTH0, d instanceof Date ? d : parseYMD(d));

function viewModes(cal) {
  const realOf = (d) => {
    const i = synthIdx(d);
    return i >= 0 && i < cal.size ? cal.at(i) : null;
  };
  const mk = (name, cw, dense) => ({
    name,
    padding: '4d',
    step: '1d',
    date_format: 'YYYY-MM-DD',
    column_width: cw,
    snap_at: '1d',
    lower_text: (d) => {
      const r = realOf(d);
      if (!r) return '';
      const rd = parseYMD(r);
      if (dense) return String(rd.getDate());
      return rd.getDay() === 1 ? String(rd.getDate()) : '';
    },
    upper_text: (d, ld) => {
      const r = realOf(d);
      if (!r) return '';
      const rd = parseYMD(r);
      const lr = ld ? realOf(ld) : null;
      if (!lr) return MONTHS[rd.getMonth()] + ' ' + rd.getFullYear();
      const lrd = parseYMD(lr);
      return rd.getMonth() !== lrd.getMonth() ? MONTHS[rd.getMonth()] + ' ' + rd.getFullYear() : '';
    },
    thick_line: (d) => {
      const r = realOf(d);
      return r ? parseYMD(r).getDay() === 1 : false;
    },
  });
  return [mk('Day', 30, true), mk('Compact', 14, false), mk('Tiny', 7, false)];
}

function ganttTasks(doc, cal) {
  return doc.tasks.map((t) => {
    const s = startIdx(cal, t);
    return {
      id: t.id,
      name: t.name.trim(),
      start: synthYmd(s),
      end: synthYmd(s + t.duration - 1),
      progress: 0,
      dependencies: t.deps.slice(),
      // frappe does classList.add(custom_class), so this must be a single token;
      // state classes and tag colours are applied after render in markBars()
      custom_class: 'tsk',
    };
  });
}

/** Apply a drag or resize once the gesture has finished. */
function commitDrag() {
  clearTimeout(App.dragTimer);
  const pd = App.pendingDrag;
  App.pendingDrag = null;
  if (!pd) return;
  const cal = App.cal;
  const t = App.doc.tasks.find((x) => x.id === pd.id);
  if (!t) return;
  const oldS = startIdx(cal, t);
  const oldE = oldS + t.duration - 1;
  if (pd.s === oldS && pd.e === oldE) return;
  snapshot();
  t.duration = Math.max(1, pd.e - pd.s + 1);
  // frappe will happily drop a bar before its predecessor finishes, so clamp the
  // landing position to the earliest legal start rather than accept an illegal plan
  const floor = earliest(App.doc, cal, t, 0);
  const newS = Math.max(0, pd.s, floor);
  t.start = cal.at(newS);
  t.pinned = true;
  reschedule(App.doc, cal, t.id, newS + t.duration - 1 - oldE);
  if (newS !== pd.s) toast('Clamped: cannot start before its dependencies finish');
  renderAll();
}

/** Task-name gutter, aligned row for row with frappe's bars. frappe has no grid column
 *  and pushes labels outside short bars, which at 38 rows collides with other bars. */
function renderGutter(doc, an) {
  const colors = tagColors(doc);
  const host = document.getElementById('gutter');
  const g = App.gantt;
  if (!g) { host.innerHTML = ''; return; }
  const rowH = g.options.bar_height + g.options.padding;
  const headH = g.config.header_height;

  const head = document.createElement('div');
  head.className = 'g-head';
  head.style.height = headH + 'px';
  head.textContent = `Task (${doc.tasks.length})`;
  host.innerHTML = '';
  host.appendChild(head);

  doc.tasks.forEach((t) => {
    const row = document.createElement('div');
    row.className = 'g-row';
    row.style.height = rowH + 'px';
    if (App.selected === t.id) row.classList.add('sel');
    if (an.float.get(t.id) === 0) row.classList.add('crit');
    const mismatch = t.estimate != null && t.estimate !== t.duration;
    const missing = t.estimate == null;
    if (mismatch || missing) row.classList.add('bad');

    const dot = document.createElement('span');
    dot.className = 'dot';
    dot.style.background = colors.get(t.tags[0] || '');
    dot.title = t.tags.join(', ') || 'no tag';
    const nm = document.createElement('span');
    nm.className = 'nm';
    nm.textContent = t.name.trim();
    nm.title = t.name.trim() + (t.description ? '\n\n' + t.description : '');
    const mt = document.createElement('span');
    mt.className = 'mt';
    mt.textContent = missing ? `${t.duration}d / -` : mismatch ? `${t.duration}d / ${t.estimate}d` : `${t.duration}d`;
    mt.title = missing ? 'No estimate' : mismatch ? `Drawn ${t.duration} days, estimate ${t.estimate} days` : 'Duration matches estimate';

    row.append(dot, nm, mt);
    row.onclick = () => { App.selected = t.id; openEditor(t.id); showTab('editor'); renderGantt(); };
    host.appendChild(row);
  });
}

/* Tags are whatever the file happens to use, so colours are assigned from a palette
 * rather than hard-coded per stream. */
const PALETTE = ['#4c8dff', '#29a19c', '#a06cd5', '#e0894f', '#d05c7c', '#5aa85a', '#c9a227', '#5f7fa8'];
function tagColors(doc) {
  const tags = [...new Set(doc.tasks.map((t) => t.tags[0] || ''))].sort();
  const m = new Map();
  tags.forEach((t, i) => m.set(t, t === '' ? '#5b6270' : PALETTE[i % PALETTE.length]));
  return m;
}

/** Apply the state classes and colours frappe cannot take via custom_class. */
function markBars(doc, an) {
  const colors = tagColors(doc);
  for (const t of doc.tasks) {
    const el = document.querySelector(`#gantt .bar-wrapper[data-id="${t.id}"]`);
    if (!el) continue;
    el.classList.toggle('critical', an.float.get(t.id) === 0);
    el.classList.toggle('mismatch', t.estimate != null && t.estimate !== t.duration);
    el.classList.toggle('selected', App.selected === t.id);
    const bar = el.querySelector('.bar');
    if (bar) bar.style.fill = colors.get(t.tags[0] || '');
  }
}

function renderGantt() {
  const doc = App.doc, cal = App.cal;
  const el = document.getElementById('gantt');
  if (!doc.tasks.length) {
    el.innerHTML = '<div id="gantt-empty">No tasks. Drop a .md file or add one.</div>';
    document.getElementById('gutter').innerHTML = '';
    App.gantt = null;
    return;
  }
  const an = analyse(doc, cal);
  el.innerHTML = '';

  App.gantt = new Gantt(el, ganttTasks(doc, cal), {
    view_mode: App.zoom,
    view_modes: viewModes(cal),
    bar_height: 22,
    padding: 12,
    readonly_progress: true,
    move_dependencies: false,     // we own all propagation
    infinite_padding: false,      // the axis is a fixed workday map
    today_button: false,
    holidays: {},                 // workday space has no non-working columns
    ignore: [],
    container_height: 'auto',
    scroll_to: synthYmd(Math.max(0, cal.nextIdx(doc.projectStart) - 3)),
    popup: (ctx) => {
      const t = App.doc.tasks.find((x) => x.id === ctx.task.id);
      if (!t) return false;
      const s = startIdx(cal, t);
      const fl = an.float.get(t.id);
      ctx.set_title(t.name.trim());
      ctx.set_subtitle(t.tags.join(', ') || '');
      ctx.set_details(
        `${fmtNice(cal.at(s))} &rarr; ${fmtNice(cal.at(s + t.duration - 1))}<br>` +
        `${t.duration} working days` +
        (t.estimate != null ? ` &middot; estimate ${t.estimate}d${t.estimate !== t.duration ? ' <b>(mismatch)</b>' : ''}` : ' &middot; <b>no estimate</b>') +
        `<br>Float ${fl}d${fl === 0 ? ' <b>(critical path)</b>' : ''}`
      );
    },
    on_click: (task) => { App.selected = task.id; openEditor(task.id); renderGantt(); },
    on_double_click: (task) => { App.selected = task.id; openEditor(task.id); showTab('editor'); },
    // frappe fires date_change from update_bar_position, i.e. on EVERY mousemove of a
    // drag, not just on release. Re-rendering here would tear down the SVG mid-gesture
    // and the drag would die after one column, so the commit is deferred to mouseup.
    on_date_change: (task, start, end) => {
      App.pendingDrag = { id: task.id, s: synthIdx(start), e: synthIdx(end) };
      clearTimeout(App.dragTimer);
      App.dragTimer = setTimeout(commitDrag, 150);
    },
  });

  markBars(doc, an);
  renderGutter(doc, an);
}

function renderValidation() {
  const doc = App.doc, cal = App.cal;
  const an = analyse(doc, cal);
  const findings = validate(doc, cal, an);
  const byId = new Map(doc.tasks.map((t) => [t.id, t]));

  const badge = document.getElementById('v-badge');
  const errs = findings.filter((f) => f.level === 'error').length;
  const warns = findings.filter((f) => f.level === 'warn').length;
  badge.textContent = findings.length;
  badge.className = 'badge ' + (errs ? 'err' : warns ? 'warn' : 'ok');

  const groups = {};
  for (const f of findings) (groups[f.code] = groups[f.code] || []).push(f);
  const TITLES = {
    'dep-violation': 'Dependency violations',
    'missing-estimate': 'Missing estimates',
    'unresolved-dep': 'Unrecognised dependencies',
    cycle: 'Dependency cycles',
    'estimate-mismatch': 'Duration does not match estimate',
    'week-overload': 'Weeks over capacity',
    'estimator-spread': 'Estimator disagreement',
    'estimator-empty': 'Notes',
  };

  const host = document.getElementById('tab-validate');
  host.innerHTML = '';

  const summary = document.createElement('div');
  summary.innerHTML =
    `<div class="kv"><span>Tasks</span><span>${doc.tasks.length}</span></div>` +
    `<div class="kv"><span>Project start</span><span>${fmtNice(cal.at(cal.nextIdx(doc.projectStart)))}</span></div>` +
    `<div class="kv"><span>Project end</span><span>${fmtNice(cal.at(an.projEnd))}</span></div>` +
    `<div class="kv"><span>Span</span><span>${an.projEnd - cal.nextIdx(doc.projectStart) + 1} working days</span></div>` +
    `<div class="kv"><span>Total estimate</span><span>${doc.tasks.reduce((s, t) => s + (t.estimate || 0), 0)} days</span></div>` +
    `<div class="kv"><span>On critical path</span><span>${[...an.float.values()].filter((v) => v === 0).length}</span></div>`;
  host.appendChild(summary);

  if (!findings.length) {
    const ok = document.createElement('p');
    ok.className = 'hint';
    ok.textContent = 'No findings. Plan is internally consistent.';
    host.appendChild(ok);
  }

  for (const code of Object.keys(TITLES)) {
    const list = groups[code];
    if (!list || !list.length) continue;
    const h = document.createElement('div');
    h.className = 'group-h';
    h.textContent = `${TITLES[code]} (${list.length})`;
    host.appendChild(h);

    if (code === 'estimate-mismatch') {
      const fixAll = document.createElement('button');
      fixAll.textContent = `Set duration = estimate for all ${list.length}`;
      fixAll.style.marginBottom = '7px';
      fixAll.onclick = () => {
        snapshot();
        for (const f of list) {
          const t = byId.get(f.taskId);
          if (t && t.estimate != null) t.duration = Math.max(1, t.estimate);
        }
        asapAll(App.doc, App.cal);
        renderAll();
        toast('Durations set from estimates, plan reflowed ASAP');
      };
      host.appendChild(fixAll);
    }

    for (const f of list) {
      const t = f.taskId ? byId.get(f.taskId) : null;
      const div = document.createElement('div');
      div.className = 'finding ' + f.level;
      const head = document.createElement('div');
      head.className = 'h';
      head.textContent = t ? t.name.trim() : 'Plan';
      const msg = document.createElement('div');
      msg.className = 'm';
      msg.textContent = f.msg;
      div.appendChild(head);
      div.appendChild(msg);
      if (t) {
        div.style.cursor = 'pointer';
        div.onclick = (e) => { if (e.target.tagName !== 'BUTTON') { App.selected = t.id; openEditor(t.id); showTab('editor'); renderGantt(); } };
      }
      if (f.fix) {
        const acts = document.createElement('div');
        acts.className = 'acts';
        const b = document.createElement('button');
        b.textContent = f.fix.label;
        b.onclick = (e) => {
          e.stopPropagation();
          snapshot();
          if (f.fix.kind === 'set-duration' && t) { t.duration = Math.max(1, t.estimate); reschedule(App.doc, App.cal, t.id, 0); }
          if (f.fix.kind === 'set-estimate' && t) t.estimate = t.duration;
          if (f.fix.kind === 'reflow') asapAll(App.doc, App.cal);
          renderAll();
        };
        acts.appendChild(b);
        div.appendChild(acts);
      }
      host.appendChild(div);
    }
  }
}

function renderLoad() {
  const doc = App.doc, cal = App.cal;
  const host = document.getElementById('tab-load');
  const rows = weeklyLoad(doc, cal);
  let html = '<table class="load"><thead><tr><th>Week of</th><th>Person-days</th><th>People</th></tr></thead><tbody>';
  for (const [wk, load] of rows) {
    const people = load / 5;
    const over = people > doc.teamSize + 1e-9;
    html += `<tr><td>${fmtNice(wk)}</td><td>${load.toFixed(1)}</td><td class="${over ? 'over' : ''}">${people.toFixed(1)}</td></tr>`;
  }
  html += '</tbody></table>';
  html += `<p class="hint">Capacity is reported, never scheduled against - tasks are never delayed to fit the team size. Team size is ${doc.teamSize}.</p>`;
  if (doc.holidays.length) {
    html += `<div class="group-h">Holidays (${doc.holidays.length})</div>`;
    html += doc.holidays.slice().sort().map((h) => `<div class="kv"><span>${fmtNice(h)}</span><span data-del-hol="${h}" style="cursor:pointer;color:#ff9aa2">remove</span></div>`).join('');
  } else {
    html += '<div class="group-h">Holidays</div><p class="hint">None. Holidays are removed from the axis entirely.</p>';
  }
  html += '<div class="row2" style="margin-top:8px"><input type="date" id="hol-date"><button id="hol-add">Add holiday</button></div>';
  host.innerHTML = html;

  host.querySelectorAll('[data-del-hol]').forEach((el) => {
    el.onclick = () => {
      snapshot();
      App.doc.holidays = App.doc.holidays.filter((h) => h !== el.dataset.delHol);
      rebuildCal();
      normalizeStarts();
      renderAll();
    };
  });
  const add = host.querySelector('#hol-add');
  if (add) add.onclick = () => {
    const v = host.querySelector('#hol-date').value;
    if (!v) return;
    snapshot();
    if (!App.doc.holidays.includes(v)) App.doc.holidays.push(v);
    rebuildCal();
    normalizeStarts();
    renderAll();
  };
}

/** Column mapping panel: which file column feeds each canonical field. */
function renderColumns() {
  const doc = App.doc;
  const host = document.getElementById('tab-columns');
  host.innerHTML = '';

  const h1 = document.createElement('div');
  h1.className = 'group-h';
  h1.textContent = `Field mapping (${doc.format === 'miro' ? 'Miro markdown' : 'CSV'})`;
  host.appendChild(h1);

  for (const f of FIELDS) {
    const row = document.createElement('div');
    row.className = 'colmap' + (doc.mapping[f.key] < 0 ? ' unmapped' : '');
    const lab = document.createElement('label');
    lab.textContent = f.label;
    const sel = document.createElement('select');
    const none = document.createElement('option');
    none.value = '-1';
    none.textContent = '(not in file)';
    sel.appendChild(none);
    doc.srcHeader.forEach((h, i) => {
      const o = document.createElement('option');
      o.value = String(i);
      o.textContent = h || `column ${i + 1}`;
      sel.appendChild(o);
    });
    sel.value = String(doc.mapping[f.key]);
    sel.onchange = () => remapColumn(f.key, Number(sel.value));
    row.append(lab, sel);
    host.appendChild(row);
  }

  const hint = document.createElement('p');
  hint.className = 'hint';
  hint.textContent = 'Re-mapping re-reads the source file, so unsaved schedule edits are discarded. Undo restores them.';
  host.appendChild(hint);

  const extras = doc.extras.map((i) => doc.header[i]).filter((x) => x !== undefined);
  const h2 = document.createElement('div');
  h2.className = 'group-h';
  h2.textContent = `Passed through untouched (${extras.length})`;
  host.appendChild(h2);
  const pt = document.createElement('div');
  pt.className = 'passthru';
  pt.textContent = extras.length ? extras.join(', ') : 'None.';
  host.appendChild(pt);

  const nums = numericExtras(doc);
  if (nums.length) {
    const h3 = document.createElement('div');
    h3.className = 'group-h';
    h3.textContent = 'Read as numeric (compared per task)';
    host.appendChild(h3);
    const d = document.createElement('div');
    d.className = 'passthru';
    d.textContent = nums.join(', ');
    host.appendChild(d);
  }

  const h4 = document.createElement('div');
  h4.className = 'group-h';
  h4.textContent = 'Tag colours';
  host.appendChild(h4);
  const leg = document.createElement('div');
  leg.className = 'legend';
  for (const [tag, col] of tagColors(doc)) {
    const s = document.createElement('span');
    const i = document.createElement('i');
    i.style.background = col;
    s.append(i, document.createTextNode(tag || '(no tag)'));
    leg.appendChild(s);
  }
  host.appendChild(leg);
}

/** Point a canonical field at a different column and rebuild from the source rows. */
function remapColumn(field, idx) {
  const d = App.doc;
  const override = {};
  for (const k of FIELD_KEYS) override[k] = d.mapping[k];
  if (idx >= 0) for (const k of FIELD_KEYS) if (override[k] === idx) override[k] = -1;
  override[field] = idx;
  let nd;
  try {
    nd = buildDoc(d.srcHeader, d.srcRows, App.cal,
      { format: d.format, preamble: d.preamble, mapping: override });
  } catch (e) {
    toast('Cannot remap: ' + e.message);
    renderColumns();
    return;
  }
  snapshot();
  for (const k of ['projectStart', 'holidays', 'teamSize', 'mode']) nd[k] = d[k];
  App.doc = nd;
  App.selected = null;
  rebuildCal();
  renderAll();
  toast(`${field} now reads "${idx < 0 ? 'nothing' : d.srcHeader[idx]}"`);
}

/** After a calendar change, pull any start that landed on a non-working day forward. */
function normalizeStarts() {
  for (const t of App.doc.tasks) t.start = App.cal.at(App.cal.nextIdx(t.start));
}

function openEditor(id) {
  const doc = App.doc, cal = App.cal;
  const t = doc.tasks.find((x) => x.id === id);
  const host = document.getElementById('tab-editor');
  if (!t) { host.innerHTML = '<p class="hint">Select a task bar to edit it.</p>'; return; }
  App.selected = id;
  const { succ } = graph(doc);
  const kids = new Set(succ.get(id) || []);
  const s = startIdx(cal, t);
  const others = doc.tasks.filter((x) => x.id !== id);
  const blocked = descendants(doc, id);   // cannot be a predecessor without making a cycle

  host.innerHTML = `
    <div class="field"><label>Name</label><input type="text" id="e-title"></div>
    <div class="field"><label>Description</label><textarea id="e-desc"></textarea></div>
    <div class="field"><label>Tag</label><input type="text" id="e-tags" placeholder="Fit-out, Admin"></div>
    <div class="row2">
      <div class="field"><label>Estimate (days)</label><input type="number" id="e-est" min="0" step="1"></div>
      <div class="field"><label>Duration (working days)</label><input type="number" id="e-dur" min="1" step="1"></div>
    </div>
    <div class="field"><button id="e-sync">Set duration = estimate</button></div>
    <div class="field est-cmp" id="e-cmp"></div>
    <div class="field">
      <label>Start</label>
      <div class="row2"><input type="date" id="e-start"><button id="e-unpin"></button></div>
      <div class="hint" id="e-range"></div>
    </div>
    <div class="field"><label>Blocked by (upstream)</label><div class="picker" id="e-deps"></div></div>
    <div class="field"><label>Blocks (downstream)</label><div class="picker" id="e-blocks"></div>
      <div class="hint">Ticking here makes this task upstream of the other one.</div></div>
    <div class="field"><button class="danger" id="e-del">Delete task</button></div>
  `;

  const $ = (sel) => host.querySelector(sel);
  $('#e-title').value = t.name.trim();
  $('#e-desc').value = t.description || '';
  $('#e-tags').value = t.tags.join(', ');
  $('#e-est').value = t.estimate == null ? '' : t.estimate;
  $('#e-dur').value = t.duration;
  $('#e-start').value = cal.at(s);
  $('#e-unpin').textContent = t.pinned ? 'Unpin' : 'Not pinned';
  $('#e-unpin').disabled = !t.pinned;
  $('#e-range').textContent = `${fmtNice(cal.at(s))} to ${fmtNice(cal.at(s + t.duration - 1))}`;
  $('#e-cmp').innerHTML = numericExtras(doc)
    .map((c) => `<span>${c.replace(/\s*#$/, '')}: <b>${numOrNull(t.extra && t.extra[c]) ?? '-'}</b></span>`)
    .join('');

  const mkPicker = (hostEl, checkedSet, disabledFn, onToggle) => {
    hostEl.innerHTML = '';
    for (const o of others) {
      const lab = document.createElement('label');
      const cb = document.createElement('input');
      cb.type = 'checkbox';
      cb.checked = checkedSet.has(o.id);
      cb.disabled = disabledFn(o.id);
      cb.onchange = () => onToggle(o.id, cb.checked);
      lab.appendChild(cb);
      lab.appendChild(document.createTextNode(o.name.trim()));
      hostEl.appendChild(lab);
    }
  };

  mkPicker($('#e-deps'), new Set(t.deps), (oid) => blocked.has(oid), (oid, on) => {
    snapshot();
    t.deps = on ? [...new Set([...t.deps, oid])] : t.deps.filter((d) => d !== oid);
    reschedule(App.doc, App.cal, oid, 0);
    if (App.doc.mode === 'rigid') pullIntoLegality(App.doc, App.cal);
    renderAll();
    openEditor(id);
  });

  // making `id` upstream of `oid` would cycle if `oid` is already upstream of `id`
  mkPicker($('#e-blocks'), kids, (oid) => descendants(doc, oid).has(id), (oid, on) => {
    snapshot();
    const o = App.doc.tasks.find((x) => x.id === oid);
    o.deps = on ? [...new Set([...o.deps, id])] : o.deps.filter((d) => d !== id);
    reschedule(App.doc, App.cal, id, 0);
    if (App.doc.mode === 'rigid') pullIntoLegality(App.doc, App.cal);
    renderAll();
    openEditor(id);
  });

  const commit = (mutate) => { snapshot(); mutate(); renderAll(); openEditor(id); };
  $('#e-title').onchange = (e) => commit(() => { t.name = e.target.value || t.name; });
  $('#e-desc').onchange = (e) => commit(() => { t.description = e.target.value; });
  $('#e-tags').onchange = (e) => commit(() => { t.tags = e.target.value.split(',').map((x) => x.trim()).filter(Boolean); });
  $('#e-est').onchange = (e) => commit(() => { t.estimate = e.target.value === '' ? null : Number(e.target.value); });
  $('#e-dur').onchange = (e) => commit(() => {
    const old = t.duration;
    t.duration = Math.max(1, Number(e.target.value) || 1);
    reschedule(App.doc, App.cal, t.id, t.duration - old);
  });
  $('#e-sync').onclick = () => {
    if (t.estimate == null) return;
    commit(() => {
      const old = t.duration;
      t.duration = Math.max(1, t.estimate);
      reschedule(App.doc, App.cal, t.id, t.duration - old);
    });
  };
  $('#e-start').onchange = (e) => commit(() => {
    if (!e.target.value) return;
    const oldEnd = startIdx(App.cal, t) + t.duration - 1;
    t.start = App.cal.at(App.cal.nextIdx(e.target.value));
    t.pinned = true;
    reschedule(App.doc, App.cal, t.id, startIdx(App.cal, t) + t.duration - 1 - oldEnd);
  });
  $('#e-unpin').onclick = () => commit(() => { t.pinned = false; if (App.doc.mode === 'asap') asapAll(App.doc, App.cal); });
  $('#e-del').onclick = () => {
    snapshot();
    App.doc.tasks = App.doc.tasks.filter((x) => x.id !== id);
    for (const o of App.doc.tasks) o.deps = o.deps.filter((d) => d !== id);
    App.selected = null;
    if (App.doc.mode === 'asap') asapAll(App.doc, App.cal);
    renderAll();
    document.getElementById('tab-editor').innerHTML = '<p class="hint">Task deleted.</p>';
  };
}

/** In rigid mode a newly added dependency can leave a task illegally early. Push each task
 *  forward just enough to satisfy its predecessors, leaving legal tasks where they are. */
function pullIntoLegality(doc, cal) {
  const { order } = topo(doc);
  const { byId } = graph(doc);
  const p0 = Math.max(0, cal.nextIdx(doc.projectStart));
  for (const id of order) {
    const t = byId.get(id);
    const need = earliest(doc, cal, t, p0);
    if (startIdx(cal, t) < need) t.start = cal.at(need);
  }
}

function renderToolbar() {
  const doc = App.doc, cal = App.cal;
  document.getElementById('proj-start').value = cal.at(cal.nextIdx(doc.projectStart));
  document.getElementById('team-size').value = doc.teamSize;
  document.getElementById('file-name').textContent = App.fileName;
  document.querySelectorAll('#seg-mode button').forEach((b) => b.classList.toggle('on', b.dataset.mode === doc.mode));
  document.querySelectorAll('#seg-zoom button').forEach((b) => b.classList.toggle('on', b.dataset.zoom === App.zoom));
  document.getElementById('btn-undo').disabled = !App.undoStack.length;
  document.getElementById('btn-redo').disabled = !App.redoStack.length;
}

function renderAll() {
  renderToolbar();
  renderGantt();
  renderValidation();
  renderLoad();
  renderColumns();
  if (App.selected) openEditor(App.selected);
  persist();
}

/* ============================================================ 8. UI wiring */

let toastTimer = null;
function toast(msg) {
  const el = document.getElementById('toast');
  el.textContent = msg;
  el.classList.add('on');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('on'), 2200);
}

function showTab(name) {
  document.querySelectorAll('#side-tabs button').forEach((b) => b.classList.toggle('on', b.dataset.tab === name));
  ['validate', 'editor', 'load', 'columns'].forEach((n) => { document.getElementById('tab-' + n).hidden = n !== name; });
}

function wireUI() {
  document.querySelectorAll('#side-tabs button').forEach((b) => { b.onclick = () => showTab(b.dataset.tab); });

  document.getElementById('proj-start').onchange = (e) => {
    if (!e.target.value) return;
    snapshot();
    const oldIdx = App.cal.nextIdx(App.doc.projectStart);
    const newIdx = App.cal.nextIdx(e.target.value);
    App.doc.projectStart = App.cal.at(newIdx);
    shiftAll(App.doc, App.cal, newIdx - oldIdx);
    renderAll();
    toast(`Whole plan shifted ${newIdx - oldIdx > 0 ? '+' : ''}${newIdx - oldIdx} working days`);
  };
  const nudge = (wd) => {
    snapshot();
    const i = App.cal.nextIdx(App.doc.projectStart) + wd;
    App.doc.projectStart = App.cal.at(Math.max(0, i));
    shiftAll(App.doc, App.cal, wd);
    renderAll();
  };
  document.getElementById('btn-shift-back').onclick = () => nudge(-5);
  document.getElementById('btn-shift-fwd').onclick = () => nudge(5);

  document.querySelectorAll('#seg-mode button').forEach((b) => {
    b.onclick = () => { App.doc.mode = b.dataset.mode; renderAll(); toast(b.dataset.mode === 'asap' ? 'ASAP: gaps collapse on every edit' : 'Rigid: downstream keeps its gaps'); };
  });
  document.getElementById('btn-reflow').onclick = () => {
    snapshot();
    asapAll(App.doc, App.cal);
    renderAll();
    toast('Reflowed ASAP');
  };
  document.querySelectorAll('#seg-zoom button').forEach((b) => {
    b.onclick = () => { App.zoom = b.dataset.zoom; renderAll(); };
  });
  document.getElementById('team-size').onchange = (e) => {
    App.doc.teamSize = Math.max(1, Number(e.target.value) || 1);
    renderAll();
  };

  document.getElementById('btn-undo').onclick = undo;
  document.getElementById('btn-redo').onclick = redo;
  document.getElementById('btn-add').onclick = () => {
    snapshot();
    let id = 'new-task';
    let n = 1;
    while (App.doc.tasks.some((t) => t.id === id)) { n++; id = 'new-task-' + n; }
    const extra = {};
    for (const i of App.doc.extras) extra[App.doc.header[i]] = '';
    App.doc.tasks.push({
      id,
      name: 'New task' + (n > 1 ? ' ' + n : ''),
      description: '',
      tags: [],
      estimate: 5,
      duration: 5,
      start: App.cal.at(App.cal.nextIdx(App.doc.projectStart)),
      deps: [],
      unresolved: [],
      extra,
      // pinned so an ASAP pass treats where you placed it as a floor rather than
      // snapping a dependency-free new task back to the project start
      pinned: true,
    });
    App.selected = id;
    renderAll();
    openEditor(id);
    showTab('editor');
  };

  document.getElementById('btn-open').onclick = () => document.getElementById('file-input').click();
  document.getElementById('file-input').onchange = (e) => {
    const f = e.target.files && e.target.files[0];
    if (f) readFile(f);
    e.target.value = '';
  };
  document.getElementById('btn-download').onclick = () => {
    const text = docToCSV(App.doc, App.cal);
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([text], { type: 'text/csv' }));
    a.download = App.fileName.replace(/\.(csv|md|markdown|txt)$/i, '') + '.csv';
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 2000);
    toast('Downloaded ' + a.download);
  };
  document.getElementById('btn-copy').onclick = async () => {
    const text = docToMiro(App.doc, App.cal);
    try {
      await navigator.clipboard.writeText(text);
      toast('Markdown table copied - paste into Miro');
    } catch (err) {
      const ta = document.createElement('textarea');
      ta.value = text;
      document.body.appendChild(ta);
      ta.select();
      document.execCommand('copy');
      ta.remove();
      toast('Copied (fallback)');
    }
  };
  document.getElementById('btn-reset').onclick = () => {
    localStorage.removeItem(LS_KEY);
    loadDoc(document.getElementById('sample-csv').textContent, 'plan.csv');
    toast('Reset to the bundled example');
  };

  // drag and drop
  const drop = document.getElementById('drop');
  let depth = 0;
  window.addEventListener('dragenter', (e) => { e.preventDefault(); depth++; drop.classList.add('on'); });
  window.addEventListener('dragover', (e) => e.preventDefault());
  window.addEventListener('dragleave', () => { if (--depth <= 0) { depth = 0; drop.classList.remove('on'); } });
  window.addEventListener('drop', (e) => {
    e.preventDefault();
    depth = 0;
    drop.classList.remove('on');
    const f = e.dataTransfer.files && e.dataTransfer.files[0];
    if (f) readFile(f);
  });

  // bubbles after frappe's own svg mouseup, so the pending values are already final
  window.addEventListener('mouseup', () => { if (App.pendingDrag) commitDrag(); });

  window.addEventListener('keydown', (e) => {
    const mod = e.metaKey || e.ctrlKey;
    if (mod && e.key.toLowerCase() === 'z') { e.preventDefault(); e.shiftKey ? redo() : undo(); }
  });
}

function readFile(f) {
  const r = new FileReader();
  r.onload = () => {
    try {
      loadDoc(String(r.result), f.name);
      toast(`Loaded ${App.doc.tasks.length} tasks from ${f.name}`);
    } catch (err) {
      toast('Could not parse: ' + err.message);
    }
  };
  r.readAsText(f);
}

/* ============================================================ 9. selftest */

function selftest() {
  const out = [];
  let pass = 0, fail = 0;
  const eq = (name, got, want) => {
    const ok = JSON.stringify(got) === JSON.stringify(want);
    ok ? pass++ : fail++;
    out.push(`<div class="${ok ? 'p' : 'f'}">${ok ? 'PASS' : 'FAIL'} ${name}${ok ? '' : `<br>     got  ${JSON.stringify(got)}<br>     want ${JSON.stringify(want)}`}</div>`);
  };
  const section = (s) => out.push(`<h2>${s}</h2>`);

  const csv = document.getElementById('sample-csv').textContent;
  const md = document.getElementById('sample-md').textContent;
  const cal0 = makeCalendar([]);
  const load = (text, name) => parseAny(text, name, cal0);

  section('CSV parsing (RFC 4180)');
  eq('plain row', parseCSV('a,b,c\n1,2,3'), [['a', 'b', 'c'], ['1', '2', '3']]);
  eq('quoted comma', parseCSV('a,b\n"x, y",z')[1], ['x, y', 'z']);
  eq('escaped quote', parseCSV('a\n"say ""hi"""')[1], ['say "hi"']);
  eq('embedded newline', parseCSV('a,b\n"one\ntwo",z')[1], ['one\ntwo', 'z']);
  eq('trailing empty field kept', parseCSV('a,b,c\n1,2,')[1], ['1', '2', '']);
  eq('blank lines dropped', parseCSV('a,b\n\n1,2\n').length, 2);
  eq('CRLF handled', parseCSV('a,b\r\n1,2\r\n')[1], ['1', '2']);
  eq('BOM stripped', parseCSV('\uFEFFa,b\n1,2')[0], ['a', 'b']);

  section('spreadsheet formula quoting');
  eq('leading %% is unwrapped', unquoteFormula("'% Split'"), '% Split');
  eq('leading = is unwrapped', unquoteFormula("'=SUM'"), '=SUM');
  eq('an ordinary quoted phrase is left alone', unquoteFormula("'hello'"), "'hello'");
  eq('unquoted value untouched', unquoteFormula('% Split'), '% Split');
  eq('re-applied on write', toCSV([['% Split', 'ok']]).trim(), "'% Split',ok");
  eq('a name quoted in one column and bare in another still matches', (() => {
    const t = load("name,estimate,dependency\n'% Split',5,\nNext,5,% Split\n", 'x.csv');
    return { deps: t.tasks[1].deps, unresolved: t.tasks[1].unresolved, name: t.tasks[0].name };
  })(), { deps: ['split'], unresolved: [], name: '% Split' });

  section('CSV writing');
  eq('quotes only when needed', toCSV([['a', 'b, c', 'd"e']]).trim(), 'a,"b, c","d""e"');
  eq('round trips through the parser', parseCSV(toCSV([['x, y', 'a"b', 'plain']]))[0], ['x, y', 'a"b', 'plain']);

  section('column mapping by alias');
  const dm = (h) => detectMapping(h).mapping;
  eq('canonical names', dm(['id', 'name', 'start_date', 'estimate', 'dependency']).name, 1);
  eq('title is an alias of name', dm(['title', 'start']).name, 0);
  eq('task is an alias of name', dm(['task', 'due']).name, 0);
  eq('blocked by maps to dependency', dm(['name', 'blocked by']).dependency, 1);
  eq('depends_on maps to dependency', dm(['name', 'depends_on']).dependency, 1);
  eq('Start Date is case and space insensitive', dm(['Name', 'Start Date']).start_date, 1);
  eq('effort maps to estimate', dm(['name', 'effort']).estimate, 1);
  eq('unknown column is not mapped', detectMapping(['name', 'owner']).extras, [1]);
  eq('missing field reports -1', dm(['name']).estimate, -1);
  eq('a column is claimed by only one field', (() => {
    const m = dm(['name', 'title']);
    return m.name !== m.title;
  })(), true);

  section('the bundled example');
  const d = load(csv, 'plan.csv');
  eq('16 tasks', d.tasks.length, 16);
  eq('detected as csv', d.format, 'csv');
  eq('id column used', d.mapping.id, 0);
  eq('owner and confidence pass through', d.extras.map((i) => d.header[i]), ['owner', 'confidence']);
  eq('confidence is not read as numeric', numericExtras(d), []);
  eq('project start', d.projectStart, '2027-03-01');
  eq('comma in a name survives', d.tasks.some((t) => t.name === 'Counter, shelving and seating'), true);
  eq('comma in a description survives',
    d.tasks.find((t) => t.id === 'soft').description, 'Friends and family, invited press.');
  eq('duration derived from start..end', d.tasks.find((t) => t.id === 'survey').duration, 5);
  eq('extras retained per task', d.tasks.find((t) => t.id === 'survey').extra.owner, 'Priya');
  eq('no unresolved dependencies', d.tasks.reduce((s, t) => s + t.unresolved.length, 0), 0);

  section('dependency resolution');
  eq('dependency on a comma-containing name resolves to one task',
    d.tasks.find((t) => t.id === 'espresso').deps, ['joinery']);
  eq('three comma-separated deps resolve',
    d.tasks.find((t) => t.id === 'snag').deps.length, 3);
  eq('single dep by name', d.tasks.find((t) => t.id === 'permits').deps, ['survey']);
  eq('no self dependency anywhere', d.tasks.every((t) => !t.deps.includes(t.id)), true);
  const semi = load('name,estimate,dependency\nA,5,\nB,5,A\nC,5,A;B\n', 'x.csv');
  eq('semicolon separated deps', semi.tasks.find((t) => t.name === 'C').deps, ['a', 'b']);
  eq('semicolon separator remembered for export', semi.depSep, '; ');
  const byid = load('id,name,estimate,dependency\nt1,Alpha,5,\nt2,Beta,5,t1\n', 'x.csv');
  eq('deps given as ids resolve', byid.tasks.find((t) => t.id === 't2').deps, ['t1']);
  const unk = load('name,estimate,dependency\nA,5,Nope\n', 'x.csv');
  eq('unknown dep is reported, not dropped silently', unk.tasks[0].unresolved, ['Nope']);
  eq('name style is remembered', d.depStyle, 'name');
  eq('id style is remembered', byid.depStyle, 'id');
  eq('id-style deps are written back as ids',
    parseCSV(docToCSV(byid, cal0))[2][3], 't1');
  eq('name-style deps are written back as names',
    parseCSV(docToCSV(d, cal0))[2][9], 'Site survey');

  section('date parsing');
  eq('ISO', parseDateCell('2027-03-01'), '2027-03-01');
  eq('ISO with time and Z', parseDateCell('2027-03-01T00:00:00.000Z'), '2027-03-01');
  eq('slashed ISO', parseDateCell('2027/03/01'), '2027-03-01');
  eq('day first', parseDateCell('01/03/2027'), '2027-03-01');
  eq('single digits', parseDateCell('1/3/2027'), '2027-03-01');
  eq('empty', parseDateCell(''), null);
  eq('format detection: isoz', detectDateFormat(['2027-03-01T00:00:00.000Z']), 'isoz');
  eq('format detection: dmy', detectDateFormat(['01/03/2027']), 'dmy');
  eq('format detection: iso', detectDateFormat(['2027-03-01']), 'iso');
  eq('dmy is written back as dmy', formatDateCell('2027-03-01', 'dmy'), '01/03/2027');
  eq('isoz is written back as isoz', formatDateCell('2027-03-01', 'isoz'), '2027-03-01T00:00:00.000Z');

  section('calendar');
  eq('2027-03-06 is a Saturday, not working', cal0.isWorking('2027-03-06'), false);
  eq('2027-03-05 is a Friday, working', cal0.isWorking('2027-03-05'), true);
  eq('Mon 1 Mar + 4 wd = Fri 5 Mar', cal0.at(cal0.nextIdx('2027-03-01') + 4), '2027-03-05');
  eq('Mon 1 Mar + 5 wd = Mon 8 Mar', cal0.at(cal0.nextIdx('2027-03-01') + 5), '2027-03-08');
  eq('Sun 7 Mar pulls back to Fri 5', cal0.at(cal0.prevIdx('2027-03-07')), '2027-03-05');
  eq('inclusive count Mon..Fri = 5', cal0.count('2027-03-01', '2027-03-05'), 5);
  const calH = makeCalendar(['2027-03-03']);
  eq('holiday removed from axis', calH.isWorking('2027-03-03'), false);
  eq('holiday skipped in arithmetic', calH.at(calH.nextIdx('2027-03-01') + 2), '2027-03-04');

  section('validation of the bundled example');
  const an = analyse(d, cal0);
  const f = validate(d, cal0, an);
  const count = (c) => f.filter((x) => x.code === c).length;
  eq('1 estimate mismatch (joinery drawn 15d, estimate 20d)', count('estimate-mismatch'), 1);
  eq('the mismatch is joinery', f.find((x) => x.code === 'estimate-mismatch').taskId, 'joinery');
  eq('1 missing estimate (grinder)', count('missing-estimate'), 1);
  eq('the missing estimate is grinder', f.find((x) => x.code === 'missing-estimate').taskId, 'grinder');
  eq('1 dependency violation (menu starts before the lease ends)', count('dep-violation'), 1);
  eq('the violation is menu', f.find((x) => x.code === 'dep-violation').taskId, 'menu');
  eq('0 unresolved deps', count('unresolved-dep'), 0);
  eq('0 cycles', count('cycle'), 0);

  section('CSV round trip');
  const rt = docToCSV(d, cal0);
  eq('header preserved verbatim', parseCSV(rt)[0], parseCSV(csv)[0]);
  eq('same number of rows', parseCSV(rt).length, parseCSV(csv).length);
  eq('cells identical to the source', parseCSV(rt), parseCSV(csv));
  const d2 = load(rt, 'plan.csv');
  eq('reparse gives the same tasks', d2.tasks.length, d.tasks.length);
  eq('reparse keeps durations', d2.tasks.map((t) => t.duration), d.tasks.map((t) => t.duration));
  eq('reparse keeps dependencies', d2.tasks.map((t) => t.deps.join('|')), d.tasks.map((t) => t.deps.join('|')));
  eq('reparse keeps extras', d2.tasks.map((t) => t.extra.owner), d.tasks.map((t) => t.extra.owner));

  section('Miro markdown import');
  eq('unescape backslashes', unescapeMiro('2027\\-03\\-01T00:00:00\\.000Z'), '2027-03-01T00:00:00.000Z');
  eq('unescape entity', unescapeMiro('R&amp;D view'), 'R&D view');
  eq('escape ampersand', escapeMiro('R&D view'), 'R&amp;D view');
  eq('escape round trip', escapeMiro(unescapeMiro('TM 2\\.0')), 'TM 2\\.0');
  eq('split on unescaped pipes', splitRow('| a | b\\|c | d |'), ['a', 'b\\|c', 'd']);
  const dmd = load(md, 'board.md');
  eq('detected as miro', dmd.format, 'miro');
  eq('5 tasks', dmd.tasks.length, 5);
  eq('Title mapped to name', dmd.tasks[0].name, 'Kick off');
  eq('Sunday end pulled back to Friday: 5 working days', dmd.tasks[0].duration, 5);
  eq('estimator columns detected as numeric extras', numericExtras(dmd), ['Ana #', 'Bo #']);
  eq('board link preserved', dmd.preamble.length, 1);
  eq('deps resolved', dmd.tasks.find((t) => t.name === 'Handover').deps, ['report-pack']);
  const mdrt = docToMiro(dmd, cal0);
  const cellsOf = (s) => s.split(/\r?\n/).filter((l) => l.trim().startsWith('|')).map((l) => splitRow(l).join(''));
  eq('markdown round trips to the same table', cellsOf(mdrt), cellsOf(md));
  eq('markdown exports Monday starts and Sunday ends', (() => {
    const rows = mdrt.split('\n').filter((l) => /T00:00:00/.test(l));
    return rows.length > 0 && rows.every((l) => {
      const ds = [...l.matchAll(/(\d{4})\\?-(\d{2})\\?-(\d{2})T/g)].map((x) => new Date(+x[1], +x[2] - 1, +x[3]).getDay());
      return ds.length === 2 && ds[0] === 1 && ds[1] === 0;
    });
  })(), true);
  eq('a miro doc can be exported as csv too', parseCSV(docToCSV(dmd, cal0)).length, 6);
  eq('csv export of a miro plan uses true Friday ends, not Miro Sundays', (() => {
    const rows = parseCSV(docToCSV(dmd, cal0)).slice(1);
    return rows.every((r) => {
      const e = parseYMD(parseDateCell(r[4]));
      return e.getDay() >= 1 && e.getDay() <= 5;
    });
  })(), true);
  eq('miro export still snaps the same plan to Sundays', (() => {
    const rows = docToMiro(dmd, cal0).split('\n').filter((l) => /T00:00:00/.test(l));
    return rows.every((l) => {
      const ds = [...l.matchAll(/(\d{4})\\?-(\d{2})\\?-(\d{2})T/g)].map((x) => new Date(+x[1], +x[2] - 1, +x[3]).getDay());
      return ds[1] === 0;
    });
  })(), true);

  section('column remapping');
  const rm = buildDoc(d.srcHeader, d.srcRows, cal0, { mapping: Object.assign({}, d.mapping, { estimate: -1 }) });
  eq('unmapping estimate leaves every estimate null', rm.tasks.every((t) => t.estimate === null), true);
  eq('estimate becomes a pass-through column', rm.extras.map((i) => rm.header[i]).includes('estimate'), true);
  eq('durations still come from the dates', rm.tasks.find((t) => t.id === 'survey').duration, 5);
  const rm2 = buildDoc(d.srcHeader, d.srcRows, cal0, { mapping: Object.assign({}, d.mapping, { estimate: 8 }) });
  eq('pointing estimate at a text column yields no numbers',
    rm2.tasks.every((t) => t.estimate === null), true);
  eq('no name column is a hard error', (() => {
    try { buildDoc(['a', 'b'], [['1', '2']], cal0); return false; } catch (e) { return /name/i.test(e.message); }
  })(), true);

  section('duration precedence');
  const dur1 = load('name,estimate,duration,start_date\nA,5,12,2027-03-01\n', 'x.csv');
  eq('explicit duration wins over estimate', dur1.tasks[0].duration, 12);
  const dur2 = load('name,estimate,start_date,end_date\nA,5,2027-03-01,2027-03-19\n', 'x.csv');
  eq('start..end wins over estimate when no duration column', dur2.tasks[0].duration, 15);
  const dur3 = load('name,estimate,start_date\nA,7,2027-03-01\n', 'x.csv');
  eq('estimate is the fallback duration', dur3.tasks[0].duration, 7);
  const dur4 = load('name,start_date\nA,2027-03-01\n', 'x.csv');
  eq('no estimate and no end date gives 1 day', dur4.tasks[0].duration, 1);

  section('scheduling: project start shift');
  const s1 = load(csv, 'plan.csv');
  const before = s1.tasks.map((t) => t.start);
  const delta = cal0.nextIdx('2027-04-01') - cal0.nextIdx(s1.projectStart);
  shiftAll(s1, cal0, delta);
  eq('every task shifted by the same amount',
    s1.tasks.every((t, i) => cal0.nextIdx(t.start) - cal0.nextIdx(before[i]) === delta), true);
  eq('nothing lands on a weekend', s1.tasks.every((t) => cal0.isWorking(t.start)), true);
  eq('first task moved to 1 Apr', s1.tasks[0].start, '2027-04-01');

  section('scheduling: ASAP clears the violation');
  const s2 = load(csv, 'plan.csv');
  asapAll(s2, cal0);
  eq('no violations after ASAP',
    validate(s2, cal0, analyse(s2, cal0)).filter((x) => x.code === 'dep-violation').length, 0);
  const menu = s2.tasks.find((t) => t.id === 'menu');
  const lease = s2.tasks.find((t) => t.id === 'lease');
  eq('menu now starts after the lease ends',
    cal0.nextIdx(menu.start), cal0.nextIdx(lease.start) + lease.duration);

  section('scheduling: rigid vs ASAP on growing a task');
  const grow = () => {
    const g = load(csv, 'plan.csv');
    asapAll(g, cal0);
    const j = g.tasks.find((t) => t.id === 'joinery');
    const old = j.duration;
    j.duration = j.estimate;                 // 15d -> its 20d estimate
    return { g, j, delta: j.duration - old, esp0: cal0.nextIdx(g.tasks.find((t) => t.id === 'espresso').start) };
  };
  const r1 = grow();
  propagateRigid(r1.g, cal0, 'joinery', r1.delta);
  eq('joinery grew by 5 days', r1.delta, 5);
  eq('rigid: espresso shifted by the same 5 days',
    cal0.nextIdx(r1.g.tasks.find((t) => t.id === 'espresso').start) - r1.esp0, 5);
  eq('rigid: the launch moved too',
    cal0.nextIdx(r1.g.tasks.find((t) => t.id === 'open').start) >
    cal0.nextIdx(grow().g.tasks.find((t) => t.id === 'open').start), true);
  eq('rigid: still legal', validate(r1.g, cal0, analyse(r1.g, cal0)).filter((x) => x.code === 'dep-violation').length, 0);
  const r2 = grow();
  asapAll(r2.g, cal0);
  const j2 = r2.g.tasks.find((t) => t.id === 'joinery');
  eq('asap: espresso starts the day after joinery ends',
    cal0.nextIdx(r2.g.tasks.find((t) => t.id === 'espresso').start),
    cal0.nextIdx(j2.start) + j2.duration);

  section('scheduling: rigid never breaks a dependency');
  const s3 = load(csv, 'plan.csv');
  asapAll(s3, cal0);
  propagateRigid(s3, cal0, 'joinery', -40);
  eq('a large backwards shift stays legal',
    validate(s3, cal0, analyse(s3, cal0)).filter((x) => x.code === 'dep-violation').length, 0);

  section('scheduling: adding an upstream task moves the downstream one');
  const addGate = (mode) => {
    const g = load(csv, 'plan.csv');
    g.mode = mode;
    asapAll(g, cal0);
    const open = g.tasks.find((t) => t.id === 'open');
    const b = cal0.nextIdx(open.start);
    g.tasks.push({
      id: 'inspection', explicitId: 'inspection', name: 'Health inspection', description: '',
      tags: ['Admin'], estimate: 10, duration: 10, start: open.start, deps: [],
      unresolved: [], extra: {}, pinned: true,
    });
    open.deps.push('inspection');
    return { g, b };
  };
  const g1 = addGate('asap');
  asapAll(g1.g, cal0);
  const o1 = cal0.nextIdx(g1.g.tasks.find((t) => t.id === 'open').start);
  eq('asap: public opening pushed out by the new upstream task', o1 > g1.b, true);
  eq('asap: pushed out by exactly the new task duration', o1 - g1.b, 10);
  const g2 = addGate('rigid');
  pullIntoLegality(g2.g, cal0);
  eq('rigid: public opening pushed out too',
    cal0.nextIdx(g2.g.tasks.find((t) => t.id === 'open').start) > g2.b, true);
  eq('rigid: still legal',
    validate(g2.g, cal0, analyse(g2.g, cal0)).filter((x) => x.code === 'dep-violation').length, 0);

  section('critical path and cycles');
  const s4 = load(csv, 'plan.csv');
  asapAll(s4, cal0);
  const an4 = analyse(s4, cal0);
  eq('at least one task has zero float', [...an4.float.values()].some((v) => v === 0), true);
  eq('no negative float', [...an4.float.values()].every((v) => v >= 0), true);
  eq('the last task is on the critical path', an4.float.get('open'), 0);
  eq('an independent branch has slack', an4.float.get('signage') > 0, true);
  const s5 = load(csv, 'plan.csv');
  s5.tasks.find((t) => t.id === 'survey').deps.push('open');
  eq('cycle detected', topo(s5).cyclic.length > 0, true);
  eq('cycle does not throw', (() => { asapAll(s5, cal0); return true; })(), true);
  eq('cycle is reported as a finding',
    validate(s5, cal0, analyse(s5, cal0)).some((x) => x.code === 'cycle'), true);

  section('workday space transform');
  eq('index 0 maps to the synthetic epoch', synthYmd(0), '2000-01-03');
  eq('round trip through synthetic space', synthIdx(parseYMD(synthYmd(137))), 137);
  eq('a 5 day bar spans 5 synthetic columns',
    daysBetween(parseYMD(synthYmd(10)), parseYMD(synthYmd(14))) + 1, 5);

  section('weekly load');
  const s6 = load(csv, 'plan.csv');
  const wl = weeklyLoad(s6, cal0);
  eq('every week is a Monday', wl.every(([w]) => parseYMD(w).getDay() === 1), true);
  eq('total person-days matches the estimate column',
    Math.round(wl.reduce((s, r) => s + r[1], 0)),
    s6.tasks.reduce((s, t) => s + (t.estimate == null ? t.duration : t.estimate), 0));
  eq('first week carries the survey only', Math.round(wl[0][1]), 5);

  document.getElementById('selftest').innerHTML =
    `<div style="font-size:15px;margin-bottom:14px">` +
    `<b class="${fail ? 'f' : 'p'}">${fail ? 'FAILED' : 'ALL PASS'}</b> &nbsp; ${pass} passed, ${fail} failed` +
    `</div>` + out.join('');
  document.body.classList.add('selftest');
}

/* ============================================================ test surface
 * The pure functions plus a few bound helpers, so the plan can be driven from the
 * browser console or an automated check without a build step. */
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

/* ============================================================ boot */

window.addEventListener('DOMContentLoaded', () => {
  if (location.hash === '#selftest') { selftest(); return; }
  wireUI();
  const saved = restore();
  if (saved && saved.doc && saved.doc.tasks) {
    App.doc = saved.doc;
    App.fileName = saved.fileName || 'plan.csv';
    rebuildCal();
    renderAll();
    toast('Restored your local edits - "Reset" goes back to the file');
  } else {
    loadDoc(document.getElementById('sample-csv').textContent, 'plan.csv');
  }
});

/* Tabular formats: delimited text in, CSV or TSV out. Pure.
 *
 * Columns are matched to canonical fields by alias, so a file can call the name column
 * "name", "title" or "task" and still load; anything unmapped is carried through untouched
 * so exporting never loses data. The delimiter is sniffed on the way in, so .csv and .tsv
 * both work. On the way out there are two shapes and the difference matters: a downloaded
 * file is CSV, because Excel parses that when opening; the clipboard gets TSV, because
 * Excel only splits *pasted* text on tabs.
 */
'use strict';

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

/* index.html offers .tsv, so the delimiter is sniffed from the header rather than assumed.
 * Only comma and tab are candidates: a semicolon is a legal dependency separator *inside*
 * a cell, so treating it as a delimiter would shred perfectly good comma files. */
function detectDelimiter(text) {
  const s = String(text).replace(/^\uFEFF/, '');
  let commas = 0, tabs = 0, q = false;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (c === '"') { q = !q; continue; }
    if (q) continue;
    if (c === ',') commas++;
    else if (c === '\t') tabs++;
    else if (c === '\n') break;   // the header row decides
  }
  return tabs > commas ? '\t' : ',';
}

function parseCSV(text, delim) {
  const s = String(text).replace(/^\uFEFF/, '');   // strip a UTF-8 BOM
  const d = delim || detectDelimiter(s);
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
    if (c === d) { row.push(field); field = ''; i++; continue; }
    if (c === '\r') { i++; continue; }
    if (c === '\n') { row.push(field); rows.push(row); row = []; field = ''; i++; continue; }
    field += c; i++;
  }
  if (field !== '' || row.length) { row.push(field); rows.push(row); }
  return rows.filter((r) => r.some((c) => String(c).trim() !== ''));
}

/* Spreadsheet exports wrap values that a spreadsheet would otherwise read as a formula in
 * single quotes, so a task called "% Split" arrives as "'% Split'" in the name column while
 * the dependency column still says "% Split". Strip it on the way in and re-apply it on the
 * way out, so names match and what we hand back to Excel stays injection-safe. */
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

/* ---------- clipboard (tab separated) ----------
 *
 * Excel and Sheets only split *pasted* text on tabs - paste comma-separated text and the
 * whole row lands in one cell until you run Text-to-Columns. So the clipboard gets TSV
 * while the downloaded file stays real CSV, which Excel parses correctly when opening it.
 *
 * A tab or a newline inside a cell would break the row/column structure on paste, and
 * there is no quoting convention that Excel honours for pasted text. Both collapse to a
 * single space: lossy, but predictable, and it only affects multi-line descriptions.
 */
const tsvCell = (v) => quoteFormula(v).replace(/[\t\r\n]+/g, ' ');
const toTSV = (rows) => rows.map((r) => r.map(tsvCell).join('\t')).join('\n') + '\n';

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
    // a date outside the calendar window would index to -1 and then clamp to the very
    // first working day, silently moving the task by decades - refuse the file instead
    for (const [label, v] of [['start', startRaw], ['end', endRaw]]) {
      if (v && !cal.inRange(v)) {
        throw new Error(`"${name}" has a ${label} date of ${v}, outside the supported ` +
          `range ${cal.first} to ${cal.last}.`);
      }
    }
    const si = startRaw ? cal.nextIdx(startRaw) : Math.max(0, cal.nextIdx(ymd(new Date())));

    // duration precedence: explicit duration, else the drawn start..end span, else estimate.
    // An end date on a weekend is pulled back to the last working day it actually covers,
    // so a bar drawn across whole calendar weeks still yields a working-day duration.
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
    header: header.slice(),
    // kept so a column can be re-mapped without needing the file again
    srcHeader: header.slice(),
    srcRows: rows.map((r) => r.slice()),
    mapping,
    extras,
    depSep,
    depStyle,
    dateFmt,
    tasks,
    projectStart: firstStart || ymd(new Date()),
    holidays: [],
    teamSize: 4,
    mode: 'rigid',
  };
}

/** Load a delimited plan. The delimiter is sniffed, so .csv and .tsv both work. */
function parseAny(text, fileName, cal, opts) {
  const rows = parseCSV(String(text));
  if (!rows.length) throw new Error('Empty file.');
  return buildDoc(rows[0].map((h) => String(h).trim()), rows.slice(1), cal, opts);
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
    put('start_date', formatDateCell(cal.at(si), doc.dateFmt));
    put('end_date', formatDateCell(cal.at(ei), doc.dateFmt));
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

/** A real CSV file: quoted where needed, so Excel parses it correctly on open. */
const docToCSV = (doc, cal) => toCSV([doc.header].concat(docRows(doc, cal)));

/** The same table, tab separated, for pasting straight into a spreadsheet. */
const docToTSV = (doc, cal) => toTSV([doc.header].concat(docRows(doc, cal)));

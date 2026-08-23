/* Shareable links: the whole plan, encoded into the URL fragment. Pure.
 *
 * The point is to hand someone a link instead of a CSV and have them see exactly what you
 * see. Three decisions shape this file:
 *
 * 1. THE FRAGMENT, NEVER THE QUERY STRING. Everything after `#` is stripped by the browser
 *    before a request is sent and is absent from Referer headers, so the plan never reaches
 *    a server even when the page is hosted. A query string would put confidential plans in
 *    someone's access log and quietly break the promise the whole tool rests on.
 *
 * 2. THE WHOLE DOCUMENT, INCLUDING srcRows. It is tempting to drop the verbatim source rows
 *    - they are about a third of the payload - but they are NOT reconstructible. A mapped
 *    column whose text did not survive normalisation is only recoverable from them: an
 *    `estimate` cell reading "TBD" becomes null in the canonical task, and re-mapping that
 *    column is supposed to hand "TBD" back as a pass-through value. Regenerating rows from
 *    the tasks yields "" instead. So dropping them would not merely disable re-mapping on a
 *    shared link, it would make it silently lossy - and it would mean maintaining a second
 *    serialisation schema alongside buildDoc for the rest of time. Not worth ~760 characters.
 *
 * 3. DECODED INPUT IS UNTRUSTED. A link is attacker-controllable, so sanitizeSharedDoc
 *    rebuilds the document field by field rather than trusting the parsed JSON. Rendering is
 *    escaped by Preact and the scheduler is integer arithmetic, so the realistic risk is a
 *    crash or a wedged schedule rather than injection - but a link that silently produces a
 *    broken plan is its own kind of bad.
 */
'use strict';

const SHARE_VERSION = 1;
const SHARE_KEY = 'plan';          // #plan=<payload>
const SHARE_URL_LIMIT = 8000;      // chars of fragment; see shareTooLong()

/* ---------- base64url ---------- */

/* btoa works on a latin1 string, so bytes go through String.fromCharCode. Chunked because
 * apply() on a very large array can blow the argument limit. */
function b64urlEncode(bytes) {
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) {
    s += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  }
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function b64urlDecode(str) {
  const norm = String(str).replace(/-/g, '+').replace(/_/g, '/');
  const s = atob(norm + '='.repeat((4 - (norm.length % 4)) % 4));
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
  return out;
}

/* ---------- compression ---------- */

/* deflate-raw rather than gzip: same algorithm without the 18-byte header and trailer, which
 * matters when the result is going in a URL. CompressionStream is native in browsers and in
 * Node, so this needs no dependency and still runs in the logic suite. */
/* The writer's write() and close() return promises that ALSO reject when the stream errors -
 * which is what a corrupted payload does. Left unhandled they surface as unhandled promise
 * rejections (two per bad link) even though the caller correctly try/catches the read side.
 * Swallowing them here makes the failure arrive exactly once, from the await below. */
async function deflateRaw(text) {
  const cs = new CompressionStream('deflate-raw');
  const w = cs.writable.getWriter();
  w.write(new TextEncoder().encode(text)).catch(() => {});
  w.close().catch(() => {});
  return new Uint8Array(await new Response(cs.readable).arrayBuffer());
}

async function inflateRaw(bytes) {
  const ds = new DecompressionStream('deflate-raw');
  const w = ds.writable.getWriter();
  w.write(bytes).catch(() => {});
  w.close().catch(() => {});
  return new TextDecoder().decode(await new Response(ds.readable).arrayBuffer());
}

/** Whether the runtime can encode at all. Older browsers lack CompressionStream. */
const shareSupported = () =>
  typeof CompressionStream === 'function' && typeof DecompressionStream === 'function';

/* ---------- validation of decoded input ---------- */

const YMD = /^\d{4}-\d{2}-\d{2}$/;
const asStr = (v) => (typeof v === 'string' ? v : v == null ? '' : String(v));
const asInt = (v, min, fallback) => {
  const n = Math.floor(Number(v));
  return Number.isFinite(n) && n >= min ? n : fallback;
};
const asYmd = (v, fallback) => (YMD.test(asStr(v)) ? asStr(v) : fallback);
const asStrArr = (v) => (Array.isArray(v) ? v.map(asStr) : []);

/** Rebuild a plan document from untrusted parsed JSON. Throws only when there is nothing
 *  usable; anything individually malformed is coerced or dropped rather than trusted. */
function sanitizeSharedDoc(raw) {
  if (!raw || typeof raw !== 'object') throw new Error('Link contains no plan.');
  if (raw.v !== SHARE_VERSION) {
    throw new Error(`Link was made by a different version of this tool (v${raw.v}).`);
  }
  const d = raw.doc;
  if (!d || typeof d !== 'object' || !Array.isArray(d.tasks)) {
    throw new Error('Link contains no plan.');
  }

  const header = asStrArr(d.header);
  const srcHeader = asStrArr(d.srcHeader);
  const mapping = {};
  for (const k of FIELD_KEYS) {
    const i = Math.floor(Number((d.mapping || {})[k]));
    mapping[k] = Number.isFinite(i) && i >= 0 && i < srcHeader.length ? i : -1;
  }
  if (mapping.name < 0 && header.length) mapping.name = Math.max(0, mapping.name);

  const today = ymd(new Date());
  const seen = new Set();
  const tasks = [];
  for (const t of d.tasks) {
    if (!t || typeof t !== 'object') continue;
    let id = asStr(t.id).trim() || slugify(asStr(t.name));
    if (seen.has(id)) { let n = 2; while (seen.has(id + '-' + n)) n++; id = id + '-' + n; }
    seen.add(id);
    const est = t.estimate == null ? null : Number(t.estimate);
    const extra = {};
    if (t.extra && typeof t.extra === 'object' && !Array.isArray(t.extra)) {
      for (const [k, v] of Object.entries(t.extra)) extra[asStr(k)] = asStr(v);
    }
    tasks.push({
      id,
      explicitId: t.explicitId == null ? null : asStr(t.explicitId),
      name: asStr(t.name) || id,
      description: asStr(t.description),
      tags: asStrArr(t.tags).map((x) => x.trim()).filter(Boolean),
      estimate: Number.isFinite(est) && est >= 0 ? est : null,
      duration: asInt(t.duration, 1, 1),
      start: asYmd(t.start, today),
      deps: [...new Set(asStrArr(t.deps))],
      unresolved: asStrArr(t.unresolved),
      extra,
      pinned: t.pinned === true,
    });
  }
  if (!tasks.length) throw new Error('Link contains no tasks.');

  // a dependency on an id that is not in the link would wedge the scheduler
  const ids = new Set(tasks.map((t) => t.id));
  for (const t of tasks) t.deps = t.deps.filter((x) => x !== t.id && ids.has(x));

  const rowWidth = Math.max(header.length, srcHeader.length);
  return {
    header,
    srcHeader,
    srcRows: Array.isArray(d.srcRows)
      ? d.srcRows.filter(Array.isArray).map((r) => {
        const row = r.map(asStr);
        while (row.length < rowWidth) row.push('');
        return row.slice(0, rowWidth);
      })
      : [],
    mapping,
    extras: Array.isArray(d.extras)
      ? [...new Set(d.extras.map((i) => Math.floor(Number(i))))]
        .filter((i) => Number.isFinite(i) && i >= 0 && i < header.length)
      : [],
    depSep: d.depSep === '; ' ? '; ' : ', ',
    depStyle: d.depStyle === 'id' ? 'id' : 'name',
    dateFmt: d.dateFmt === 'dmy' ? 'dmy' : 'iso',
    tasks,
    projectStart: asYmd(d.projectStart, tasks.reduce((m, t) => (m && m < t.start ? m : t.start), null) || today),
    holidays: [...new Set(asStrArr(d.holidays).filter((h) => YMD.test(h)))],
    teamSize: asInt(d.teamSize, 1, 4),
    mode: d.mode === 'asap' ? 'asap' : 'rigid',
  };
}

/* ---------- the codec ---------- */

/** doc -> fragment payload. */
async function encodeShare(doc) {
  const json = JSON.stringify({ v: SHARE_VERSION, doc });
  return b64urlEncode(await deflateRaw(json));
}

/** fragment payload -> validated doc. Throws with a message fit to show the user. */
async function decodeShare(payload) {
  let json;
  try {
    json = await inflateRaw(b64urlDecode(payload));
  } catch (e) {
    throw new Error('Link is corrupted or was truncated in transit.');
  }
  let parsed;
  try {
    parsed = JSON.parse(json);
  } catch (e) {
    throw new Error('Link is corrupted or was truncated in transit.');
  }
  return sanitizeSharedDoc(parsed);
}

/** Pull the payload out of a location hash, or null. Tolerates other fragment keys. */
function sharePayloadFromHash(hash) {
  const h = asStr(hash).replace(/^#/, '');
  if (!h) return null;
  for (const part of h.split('&')) {
    const eq = part.indexOf('=');
    if (eq > 0 && part.slice(0, eq) === SHARE_KEY) return part.slice(eq + 1) || null;
  }
  return null;
}

/** Chat clients and mail systems mangle very long links; warn past a usable length. */
const shareTooLong = (payload) => asStr(payload).length > SHARE_URL_LIMIT;

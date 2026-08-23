/* Runs the assertions in src/selftest.js under Node: no browser, no dependencies, and
 * no DOM shim.
 *
 * The assertions themselves live in selftest() rather than here, so that
 * `index.html#selftest` and `npm test` can never drift apart. Add new assertions there.
 *
 * Only the PURE sources are loaded. If this file ever needs a `document` stub again, that
 * is the signal that DOM access has leaked below the store - fix the source, not this.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import vm from 'node:vm';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

/* Load order matters: these are classic scripts sharing one global scope, exactly as
 * index.html loads them. Keep this list in step with the <script> tags there. */
const PURE = [
  'dates.js', 'calendar.js', 'workday-space.js', 'formats.js',
  'scheduler.js', 'validate.js', 'fixes.js', 'selftest.js',
];

const html = readFileSync(join(ROOT, 'index.html'), 'utf8');
const fixture = (id) => {
  const m = html.match(new RegExp(`<script type="text/plain" id="${id}">([\\s\\S]*?)</script>`));
  if (!m) throw new Error(`${id} block not found in index.html`);
  return m[1].replace(/^\n/, '');
};

/* Guard the purity invariant that lets this harness stay this small. Comments and string
 * literals are stripped first, or prose like "the calendar window" trips it. */
const codeOnly = (src) => src
  .replace(/\/\*[\s\S]*?\*\//g, ' ')
  .replace(/\/\/[^\n]*/g, ' ')
  .replace(/'(?:[^'\\\n]|\\.)*'|"(?:[^"\\\n]|\\.)*"|`(?:[^`\\]|\\.)*`/g, ' ');

const impure = [];
for (const f of PURE) {
  const code = codeOnly(readFileSync(join(ROOT, 'src', f), 'utf8'));
  for (const bad of ['document', 'localStorage', 'navigator', 'window', 'Gantt']) {
    if (new RegExp(`\\b${bad}\\b`).test(code)) impure.push(`${f} references ${bad}`);
  }
}
if (impure.length) {
  console.error('\x1b[31mDOM access has leaked into a pure source file:\x1b[0m');
  for (const m of impure) console.error('  ' + m);
  console.error('\nSections 1-5 must stay DOM-free - that is what lets this suite run headless.');
  process.exit(1);
}

const sandbox = { console };
sandbox.globalThis = sandbox;
vm.createContext(sandbox);
for (const f of PURE) {
  vm.runInContext(readFileSync(join(ROOT, 'src', f), 'utf8'), sandbox, { filename: 'src/' + f });
}

const { pass, fail, results } = vm.runInContext('selftest', sandbox)({
  csv: fixture('sample-csv'),
});

for (const r of results) {
  if (r.kind === 'section') { console.log(`\n\x1b[1m${r.name}\x1b[0m`); continue; }
  if (r.ok) { console.log(`\x1b[32mPASS\x1b[0m ${r.name}`); continue; }
  console.log(`\x1b[31mFAIL\x1b[0m ${r.name}`);
  console.log(`       got  ${JSON.stringify(r.got)}`);
  console.log(`       want ${JSON.stringify(r.want)}`);
}

console.log(`\n${fail ? '\x1b[31mFAILED\x1b[0m' : '\x1b[32mALL PASS\x1b[0m'}  ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);

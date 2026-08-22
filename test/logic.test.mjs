/* Runs the assertions in app.js's selftest() under Node, with no browser and no
 * dependencies, by shimming the handful of DOM calls it makes.
 *
 * The assertions themselves live in selftest() inside app.js rather than here, so that
 * `index.html#selftest` and `npm test` can never drift apart. Add new assertions there.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import vm from 'node:vm';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const html = readFileSync(join(ROOT, 'index.html'), 'utf8');
const app = readFileSync(join(ROOT, 'app.js'), 'utf8');

const grab = (id) => {
  const m = html.match(new RegExp(`<script type="text/plain" id="${id}">([\\s\\S]*?)</script>`));
  if (!m) throw new Error(`${id} block not found in index.html`);
  return m[1].replace(/^\n/, '');
};

let captured = '';
const noop = () => {};
const stubEl = () => ({
  style: {},
  classList: { add: noop, remove: noop, toggle: noop, contains: () => false },
  appendChild: noop, append: noop, remove: noop,
  querySelector: () => null, querySelectorAll: () => [],
  setAttribute: noop, set innerHTML(v) {}, set textContent(v) {},
});
const els = {
  'sample-csv': { textContent: grab('sample-csv') },
  'sample-md': { textContent: grab('sample-md') },
  selftest: { set innerHTML(v) { captured = v; }, get innerHTML() { return captured; } },
};

const sandbox = {
  console, JSON, Math, Date, Number, String, Boolean, Array, Object, Map, Set, RegExp, Error,
  isNaN, parseInt, parseFloat, setTimeout, clearTimeout, URL,
  Gantt: function () {},
  location: { hash: '' },
  localStorage: { getItem: () => null, setItem: noop, removeItem: noop },
  navigator: { clipboard: { writeText: async () => {} } },
  document: {
    getElementById: (id) => els[id] || stubEl(),
    querySelector: () => null,
    querySelectorAll: () => [],
    createElement: stubEl,
    body: { classList: { add: noop }, appendChild: noop },
    addEventListener: noop,
  },
  window: { addEventListener: noop },
};
sandbox.globalThis = sandbox;

vm.createContext(sandbox);
vm.runInContext(app + '\n;selftest();', sandbox, { filename: 'app.js' });

const text = captured
  .replace(/<h2>/g, '\n\x1b[1m')
  .replace(/<\/h2>/g, '\x1b[0m')
  .replace(/<br\s*\/?>/g, '\n')
  .replace(/<\/div>/g, '\n')
  .replace(/<[^>]+>/g, '')
  .replace(/&nbsp;/g, ' ')
  .replace(/&rarr;/g, '->')
  .replace(/&middot;/g, '-')
  .replace(/\n{3,}/g, '\n\n')
  .replace(/^(PASS.*)$/gm, '\x1b[32m$1\x1b[0m')
  .replace(/^(FAIL.*)$/gm, '\x1b[31m$1\x1b[0m');

console.log(text.trim());

const m = captured.match(/(\d+) passed, (\d+) failed/);
if (!m) {
  console.error('\nCould not read a result summary from selftest()');
  process.exit(1);
}
const failed = Number(m[2]);
console.log(`\n${failed ? '\x1b[31mFAILED\x1b[0m' : '\x1b[32mALL PASS\x1b[0m'}  ${m[1]} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);

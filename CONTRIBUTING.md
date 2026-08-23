# Contributing

Thanks for taking a look. This is a small, deliberately boring codebase: a dozen plain
`.js` files, no build step, nothing to install in order to run it. Please keep it that way.

## Getting set up

```
git clone <this repo>
cd miro-timeline
open index.html          # that's the whole dev loop
```

Editing a file in `src/` or `index.html` and reloading the page is the entire workflow.
There is nothing to compile and nothing to watch.

For the browser test suite only:

```
npm install
npx playwright install chromium
```

## Running the tests

```
npm test              # logic: parser, calendar, scheduler, validators. No browser, no deps.
npm run test:browser  # rendering geometry and real drag/resize gestures. Needs Playwright.
npm run test:all      # both
```

Or open `index.html#selftest` to run the logic assertions in the browser.

CI runs both suites plus a hygiene job on every push and pull request.

## The four rules

1. **No build step.** `index.html` must keep working when opened directly from `file://`.
   That means classic `<script src>`, no ES module imports between project files, no
   bundler, no transpiler, no TypeScript. The files in `src/` are ordered classic scripts
   sharing one global scope, so the order of the `<script>` tags is load-bearing.
2. **No runtime dependencies beyond `vendor/`, and no network requests.** The tool has to
   work offline with confidential plans in it. Third-party code is vendored into `vendor/`
   with its licence, and CI fails if a remote `.js` or `.css` is referenced. There are
   exactly two vendored bundles (three packages: Frappe Gantt; Preact + htm), and the
   reasoning for each - plus for the ones that were turned down - is recorded under
   "Dependency decisions" in `CLAUDE.md`. Adding another is a decision to discuss, not a
   drive-by.
3. **Examples stay synthetic.** `examples/*.csv` must be invented data. CI greps for names
   from the real board this was written against. Never commit a client plan; `.gitignore`
   already excludes `timeline.csv` and `plan.csv` at the repo root and `*.local.csv`.
4. **Every behaviour change ships with an assertion.** See below for where they go.

## `selftest()` is a test suite, not input validation

Two similarly-named things that are unrelated:

- **`selftest()`** in `src/selftest.js` asks *is the code correct?* It runs only against the
  synthetic example bundled in `index.html`, never against a user's plan, and reports
  pass/fail. This is the test suite.
- **`validate()`** in `src/validate.js` asks *is this plan self-consistent?* It runs on every
  render against whatever is loaded, and produces the findings in the Validation tab -
  missing estimates, dependency violations, cycles, overloaded weeks - each with a one-click
  fix. This is a product feature.

A new assertion goes in `selftest()`. A new *finding* goes in `validate()`, with the effect
of its fix in `fixes.js`.

## Where tests live

The logic assertions live in `selftest()` in `src/selftest.js`, not in `test/`. That is
deliberate: it keeps `index.html#selftest` and `npm test` running the *same* assertions, so
they cannot drift, and it means the tests work with no tooling at all.

`selftest(fixtures)` is a pure function - it takes `{ csv }`, the bundled example text from
the `sample-csv` block in `index.html`, and returns structured results. `test/logic.test.mjs` loads only the pure sources and formats those
results, so there is no DOM shim to keep in step. The browser renders the same results
through `renderSelftest()`. If you ever want to add a `document` stub to the Node harness,
that is the signal that DOM access has leaked into a pure file - fix the source, not the
harness.

- **Parsing, calendar, scheduling, validation, fixes** -> add an `eq(...)` to the right
  `section()` in `selftest()`.
- **Rendering, geometry, mouse gestures, DOM wiring, Preact diffing** -> add a `check(...)`
  to `test/browser.test.mjs`.

Prefer an assertion that would have caught the bug over one that restates the
implementation. Several checks in `test/browser.test.mjs` exist because that exact thing
broke once; the comment at the top of the file lists them.

## Architecture in one screen

`src/` is loaded as ordered classic scripts. The first eight are pure - no DOM at all:

| File | What it owns | Pure? |
|---|---|---|
| `dates.js` | local-midnight `Date` helpers, `YYYY-MM-DD` strings | yes |
| `calendar.js` | the working-day index: real date <-> integer working-day number | yes |
| `workday-space.js` | the synthetic-date transform the chart is drawn in | yes |
| `formats.js` | delimited text in, CSV + TSV out, column aliases, dependency resolution | yes |
| `scheduler.js` | topological sort, ASAP pass, rigid shift, float/critical path, weekly load | yes |
| `validate.js` | findings, and the fix `kind` each one offers | yes |
| `fixes.js` | what each fix `kind` actually does | yes |
| `selftest.js` | the logic assertions | yes |
| `store.js` | `App` state, `commit()`, undo/redo, `localStorage` | no |
| `panels.js` | the gutter and four side panels, as Preact components | no |
| `render.js` | Frappe Gantt wiring, `renderAll`, `viewOf` | no |
| `ui.js` | toolbar, tabs, drag-and-drop, keyboard, boot | no |
| `tour.js` | the first-run guided tour, on driver.js | no |
| `testhooks.js` | `window.App` and `__*` helpers for the browser suite only | no |

Adding a file means adding a `<script>` tag to `index.html`. CI fails if a module has no
tag, or a tag points at a file that does not exist.

Three invariants hold the design together:

- **All scheduling arithmetic is integer working-day indices**, never date maths. Weekends and
  holidays simply do not exist in that number line, which is why a task can never land on a
  Saturday. If you find yourself adding days to a `Date` in the scheduler, reach for
  `cal.nextIdx` / `cal.at` instead.
- **The pure files never touch `document`, `window`, `localStorage` or `Gantt`.** That is
  what lets `npm test` run with no browser and no shim, and the harness fails with an
  explicit message if one of them does.
- **Every plan change goes through `commit()`** in `store.js`, which snapshots for undo,
  mutates, then re-renders. Hand-rolling `snapshot()` is how two edits ended up silently
  not undoable.

## Colours

Light and dark are supported, and **every colour is a token** declared in the three blocks
at the top of `index.html`. Nothing else in the stylesheet or in `src/` may contain a colour
literal - CI fails on one, and on a token defined in one theme block but missing from
another. The reason is blunt: a hard-coded colour cannot respond to a theme switch, and you
will not notice until you open the other theme.

Adding a colour means adding a token to all three blocks. Reusing an existing semantic
token is almost always better than inventing one.

The eight `--series-N` tag slots are different: they are a **validated palette**, and light
and dark are validated separately against their own surface rather than being one palette
flipped. If you need to change one, re-run the validator (see "Changing a series colour" in
`CLAUDE.md`) and ship only passing values. The set these replaced failed four checks,
including a yellow/green pair that was hard to tell apart with *normal* colour vision.

Theme behaviour is asserted in `test/browser.test.mjs` - the OS default, the toggle beating
the OS in both directions, persistence, that it is not undoable, and that a bar repaints
without a re-render.

## Style

- Follow the surrounding code: two-space indent, semicolons, single quotes, `const` by
  default. `.editorconfig` covers the mechanical parts.
- Plain ASCII punctuation in code and comments.
- Comment the *why*, especially where the code works around third-party behaviour. The
  existing comments about Frappe Gantt firing `on_date_change` per mousemove, and about
  `custom_class` needing a single token, are the model: they explain a decision that looks
  wrong until you know the reason.
- Don't reformat `vendor/`. It is an unmodified upstream copy.

## Commits and pull requests

- Small, atomic commits with an imperative subject: `fix: clamp a drag to the earliest legal
  start`.
- Say what changed and why in the PR, and mention which assertion covers it.
- Green CI before review.

## Upgrading a vendored dependency

`vendor/` holds unmodified copies of npm `dist` output. To bump Frappe Gantt:

```
npm pack frappe-gantt@<version>
tar xzf frappe-gantt-<version>.tgz
cp package/dist/frappe-gantt.umd.js package/dist/frappe-gantt.css vendor/
cp package/license.txt vendor/frappe-gantt.LICENSE.txt
```

To bump driver.js:

```
npm pack driver.js@<version>
tar xzf driver.js-<version>.tgz
cp package/dist/driver.js.iife.js vendor/driver.iife.js
cp package/dist/driver.css vendor/driver.css
cp package/license vendor/driver.LICENSE.txt
```

Re-check the two gotchas in `CLAUDE.md` after a bump - the tour relies on working around
both, and a fix upstream would make the workarounds dead code rather than harmless.

To bump Preact or htm - note the app uses the single prebuilt bundle that htm ships, which
already contains preact, preact/hooks and htm, so there is only one file to copy:

```
npm pack htm@<version> preact@<version>
tar xzf htm-<version>.tgz && mv package htm
tar xzf preact-<version>.tgz && mv package preact
cp htm/preact/standalone.umd.js vendor/htm-preact.umd.js
cp preact/LICENSE vendor/preact.LICENSE.txt
cp htm/LICENSE vendor/htm.LICENSE.txt
```

In both cases update the versions in `NOTICE` and run `npm run test:all`. The browser suite
is the thing that will catch a behaviour change - it asserts bar geometry and drag semantics
for Frappe, and node reuse, focus retention and escaping for Preact. Those are exactly the
places these libraries have surprised us before.

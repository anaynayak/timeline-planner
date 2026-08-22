# Contributing

Thanks for taking a look. This is a small, deliberately boring codebase: two source files, no
build step, no runtime dependencies. Please keep it that way.

## Getting set up

```
git clone <this repo>
cd miro-timeline
open index.html          # that's the whole dev loop
```

Editing `app.js` or `index.html` and reloading the page is the entire workflow. There is
nothing to compile and nothing to watch.

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
   bundler, no transpiler, no TypeScript.
2. **No runtime dependencies and no network requests.** The tool has to work offline with
   confidential plans in it. Third-party code is vendored into `vendor/` with its licence,
   and CI fails if a remote `.js` or `.css` is referenced.
3. **Examples stay synthetic.** `examples/*.csv` must be invented data. CI greps for names
   from the real board this was written against. Never commit a client plan; `.gitignore`
   already excludes `timeline.csv` and `plan.csv` at the repo root and `*.local.csv`.
4. **Every behaviour change ships with an assertion.** See below for where they go.

## Where tests live

The logic assertions live in `selftest()` at the bottom of `app.js`, not in `test/`. That is
deliberate: it keeps `index.html#selftest` and `npm test` running the *same* assertions, so
they cannot drift, and it means the tests work with no tooling at all. `test/logic.test.mjs`
just drives `selftest()` under Node with a small DOM shim.

- **Parsing, calendar, scheduling, validation** → add an `eq(...)` to the right `section()`
  in `selftest()`.
- **Rendering, geometry, mouse gestures, DOM wiring** → add a `check(...)` to
  `test/browser.test.mjs`.

Prefer an assertion that would have caught the bug over one that restates the
implementation. Several checks in `test/browser.test.mjs` exist because that exact thing
broke once; the comment at the top of the file lists them.

## Architecture in one screen

`app.js` is ordered in numbered sections, top to bottom:

| Section | What it owns |
|---|---|
| 1. date utils | local-midnight `Date` helpers, `YYYY-MM-DD` strings |
| 2. calendar | the working-day index: real date ↔ integer working-day number |
| 3. tabular formats | CSV and Miro-markdown read/write, column alias mapping, dependency resolution |
| 4. scheduler | topological sort, ASAP forward pass, rigid shift, float/critical path, weekly load |
| 5. validation | findings and their one-click fixes |
| 6. store | app state, undo/redo, `localStorage` |
| 7. rendering | workday-space transform, Frappe Gantt wiring, gutter, side panels |
| 8. UI wiring | toolbar, tabs, drag-and-drop, keyboard |
| 9. selftest | the logic assertions |

Two invariants hold the design together:

- **All scheduling arithmetic is integer working-day indices**, never date maths. Weekends and
  holidays simply do not exist in that number line, which is why a task can never land on a
  Saturday. If you find yourself adding days to a `Date` in the scheduler, reach for
  `cal.nextIdx` / `cal.at` instead.
- **Sections 1–5 are pure functions** with no DOM access. That is what lets `npm test` run
  without a browser. Please don't reach for `document` above section 6.

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

## Upgrading Frappe Gantt

`vendor/` holds an unmodified copy of the npm `dist` output. To bump it:

```
npm pack frappe-gantt@<version>
tar xzf frappe-gantt-<version>.tgz
cp package/dist/frappe-gantt.umd.js package/dist/frappe-gantt.css vendor/
cp package/license.txt vendor/frappe-gantt.LICENSE.txt
```

Then update the version in `NOTICE` and run `npm run test:all`. The browser suite is the
thing that will catch a behaviour change — it asserts bar geometry and drag semantics, which
is exactly where this library has surprised us before.

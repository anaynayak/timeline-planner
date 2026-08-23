# Claude instructions for this repo

A static browser Gantt planner. No build step. Read `CONTRIBUTING.md` too — it documents the
architecture and the four hard rules.

## Hard constraints

Do not break these without being asked explicitly:

1. **No build step.** `index.html` must keep working opened directly from `file://`. Classic
   `<script src>` only — no ES module imports between project files, no bundler, no
   TypeScript. The sources in `src/` are ordered classic scripts sharing one global scope,
   which is why load order in `index.html` is load-bearing.
2. **No runtime dependencies beyond `vendor/`, and no network requests.** Users open this
   with confidential plans in it. Third-party code is vendored with its licence. CI fails on
   any remote `.js` / `.css` reference. Adding a new dependency needs an explicit decision,
   not a drive-by `npm install` — see "Dependency decisions" below.
3. **Examples stay synthetic.** `examples/*.csv` is invented data. Never commit real client
   plans. CI greps for names from the original board. `.gitignore` excludes `timeline.csv`
   and `plan.csv` at the repo root plus `*.local.csv` — if the user drops a real plan in the
   working tree, leave it uncommitted.
4. **Behaviour changes ship with an assertion.** See "Testing" below.

## Layout

```
index.html    markup, styles, the bundled example CSV fixture
src/          the app, as ordered classic scripts (see the table below)
vendor/       Frappe Gantt 1.2.2 (MIT), htm+Preact standalone (MIT / Apache-2.0)
examples/     synthetic example plans
test/         headless runners (logic.test.mjs, browser.test.mjs)
```

| File | Owns | Pure? |
|---|---|---|
| `src/dates.js` | local-midnight `Date` helpers, `YYYY-MM-DD` strings | yes |
| `src/calendar.js` | the working-day index: real date <-> integer working-day number | yes |
| `src/workday-space.js` | the synthetic-date transform the chart is drawn in | yes |
| `src/formats.js` | delimited text in, CSV + TSV out, column aliases, dependency resolution | yes |
| `src/scheduler.js` | topo sort, ASAP, rigid propagation, float, weekly load | yes |
| `src/validate.js` | findings and the fix `kind` each one offers | yes |
| `src/fixes.js` | what each fix `kind` actually does | yes |
| `src/selftest.js` | the logic assertions | yes |
| `src/store.js` | `App` state, `commit()`, undo/redo, `localStorage` | no |
| `src/panels.js` | the gutter and four side panels, as Preact components | no |
| `src/render.js` | Frappe Gantt wiring, `renderAll`, `viewOf` | no |
| `src/ui.js` | toolbar, tabs, drag-and-drop, keyboard, boot | no |
| `src/testhooks.js` | `window.App` + `__*` helpers for `test/browser.test.mjs` only | no |

**The "pure" files must never touch `document`, `window`, `localStorage` or `Gantt`.**
`npm test` loads only those files and fails with an explicit message if one of them
references a DOM global. That purity is what lets the logic suite run with no browser and
no DOM shim — do not trade it away for convenience.

Adding a file to `src/` means adding a `<script>` tag in `index.html`; CI fails if a module
has no tag or a tag points at a missing file.

## Three invariants

- **All scheduling is integer working-day arithmetic**, never date maths. `cal.nextIdx(ymd)`
  gives a working-day index, `cal.at(i)` goes back. Weekends and holidays don't exist in
  that number line, which is why nothing can land on a Saturday. If you're adding days to a
  `Date` inside the scheduler, you've taken a wrong turn.
- **The chart renders in "workday space".** Each real working day maps to a contiguous
  synthetic date (`synthYmd` / `synthIdx`, epoch 2000-01-03) so one column is one working
  day and a bar's width equals its duration. Axis labels translate back to real dates.
- **Every plan change goes through `commit()`** in `src/store.js`, which snapshots for undo,
  mutates, and re-renders. Calling `snapshot()` by hand is how propagation mode and team
  size ended up silently not undoable. Pass `{ rebuildCal: true }` when the holiday set
  changes.

## Performance shape

`graph(doc)` rebuilds both id maps from scratch, so anything that loops over tasks must
build it **once** and pass it as the trailing `g` argument (`topo`, `descendants`,
`ancestors`, `earliest` all accept one). `renderAll()` computes one `viewOf()` — the
analysis, weekly load, numeric columns and tag colours — and threads it into every
renderer. Re-deriving any of that per task or per panel is what previously made a keystroke
on a 300-task plan take over 100 ms.

## Frappe Gantt gotchas

These are load-bearing. All three were found the hard way:

1. **`ignore: ['weekend']` does not compress the axis.** It hatches non-working columns and
   keeps a calendar axis, so a 10-working-day bar would be 12 columns wide. Hence workday
   space above. Do not "simplify" it back to `ignore`.
2. **`on_date_change` fires on every mousemove of a drag, not on release** — it is called
   from `update_bar_position()`. Re-rendering inside that callback tears down the SVG
   mid-gesture and the drag dies after one column. The commit is deferred to `mouseup` via
   `App.pendingDrag` / `commitDrag()`. Do not call `renderAll()` from `on_date_change`.
3. **`custom_class` goes straight into `classList.add`**, so it must be a single token. A
   space-separated string throws and only one bar renders. State classes and tag colours are
   applied after render in `markBars()`.

Also: built-in `move_dependencies` is a rigid *visual* drag that ignores working days, so it
is off and all propagation is ours (`propagateRigid`, `asapAll`, `pullIntoLegality`).

## Preact gotchas

The panels are Preact components via `htm` (no JSX, no build step; global `htmPreact`).

1. **Preact owns the children of `#gutter`, `#tab-validate`, `#tab-editor`, `#tab-load` and
   `#tab-columns`.** Never assign `innerHTML` on those hosts from outside — it desyncs
   Preact's virtual tree. Render `null` through the matching `paint*` function to clear one.
2. **`{n && html`...`}` renders a literal `0`** when `n` is `0`. Use a ternary returning
   `null`. This shipped a stray "0" in the Columns panel once.
3. Components are deliberately dumb — props in, vnode out, no component state. All state is
   in `App`; all mutation goes through `commit()`.

## Testing

```
npm test              # logic - no browser, no deps, no DOM shim
npm run test:browser  # rendering + real drag/resize gestures (Playwright)
npm run test:all
```

Logic assertions live in `selftest()` in `src/selftest.js`, **not** in `test/`. This is
deliberate: `index.html#selftest` and `npm test` then run the same assertions and cannot
drift. `selftest(fixtures)` is pure — it takes the two fixture texts and returns structured
results; the browser renders them via `renderSelftest()` in `src/ui.js`.

- Parsing / calendar / scheduling / validation / fixes → add `eq(...)` to a `section()` in
  `selftest()`.
- Rendering / geometry / gestures / DOM / Preact diffing → add `check(...)` to
  `test/browser.test.mjs`.

Run the tests before claiming something works. When writing browser tests, note that
`getBoundingClientRect()` is clipped for SVG children — derive screen coordinates from
`getScreenCTM()` instead; scroll a bar's right edge toward the middle of the chart before a
rightward gesture or the pointer leaves the SVG; prefer `dispatchEvent` over `page.click`
on a bar, because the SVG label sits on top and intercepts hits; and remember an element
inside a `hidden` panel cannot take focus.

## Dependency decisions

Recorded so they are not re-litigated. Runtime dependencies are vendored or refused.

- **Frappe Gantt — adopted.** Bar/arrow/axis rendering and drag gestures.
- **Preact + htm — adopted.** Keyed diffing for the panels, which is what preserves input
  focus, caret and scroll across a re-render, and escapes file content by construction.
  One 13 kB UMD bundle, classic script, works from `file://`.
- **date-fns / Day.js — refused.** `addBusinessDays` knows nothing about holidays, so the
  calendar stays bespoke either way; that leaves ~15 lines of `src/dates.js` as the only
  candidate, against an ESM-only package whose UMD build is ~200 kB.
- **PapaParse — refused.** The RFC 4180 parser in `src/formats.js` is ~25 lines and tested;
  the only real gain was delimiter sniffing, which `detectDelimiter` now does.
- **graphlib / toposort — refused.** The win was never the algorithm, it was not rebuilding
  the graph per call. Passing a prebuilt `g` got the same 30x without a dependency.
- **immer — refused for now.** `produceWithPatches` would beat the full `JSON` deep clone in
  `snapshot()`, but it needs every mutation site rewritten immutably. Revisit only if plan
  sizes make the clone hurt.
- **A scheduling engine — does not exist.** `jsgantt-improved`, `dhtmlxGantt` and Frappe are
  renderers; working-day CPM with pinning and rigid propagation is only in commercial
  products. `src/scheduler.js` is legitimately ours. Don't go hunting.

## Conventions

- Plain ASCII punctuation: `->` not an arrow, `-` not an em dash, straight quotes.
- Two-space indent, semicolons, single quotes, `const` by default.
- Comment the *why*, especially around third-party workarounds.
- Small atomic commits, imperative subject: `fix: clamp a drag to the earliest legal start`.
- Don't reformat `vendor/`.

# Claude instructions for this repo

A static browser Gantt planner. Two source files, no build step, no runtime dependencies.
Read `CONTRIBUTING.md` too — it documents the architecture and the four hard rules.

## Hard constraints

Do not break these without being asked explicitly:

1. **No build step.** `index.html` must keep working opened directly from `file://`. Classic
   `<script src>` only — no ES module imports between project files, no bundler, no
   TypeScript. This is why `app.js` is one large file rather than modules.
2. **No runtime dependencies, no network requests.** Users open this with confidential plans
   in it. Third-party code is vendored into `vendor/` with its licence. CI fails on any
   remote `.js` / `.css` reference.
3. **Examples stay synthetic.** `examples/*.csv` is invented data. Never commit real client
   plans. CI greps for names from the original board. `.gitignore` excludes `timeline.csv`
   and `plan.csv` at the repo root plus `*.local.csv` — if the user drops a real plan in the
   working tree, leave it uncommitted.
4. **Behaviour changes ship with an assertion.** See "Testing" below.

## Layout

```
index.html    markup, styles, the bundled example CSV, the Miro-markdown test fixture
app.js        everything else, in numbered sections 1-9
vendor/       Frappe Gantt 1.2.2 (MIT) - unmodified, do not reformat
examples/     synthetic example plans
test/         headless runners (logic.test.mjs, browser.test.mjs)
```

`app.js` sections: 1 date utils, 2 calendar, 3 tabular formats, 4 scheduler, 5 validation,
6 store, 7 rendering, 8 UI wiring, 9 selftest. **Sections 1-5 are pure — no `document`.**
That purity is what lets `npm test` run without a browser; don't break it.

## Two invariants

- **All scheduling is integer working-day arithmetic**, never date maths. `cal.nextIdx(ymd)`
  gives a working-day index, `cal.at(i)` goes back. Weekends and holidays don't exist in
  that number line, which is why nothing can land on a Saturday. If you're adding days to a
  `Date` inside the scheduler, you've taken a wrong turn.
- **The chart renders in "workday space".** Each real working day maps to a contiguous
  synthetic date (`synthYmd` / `synthIdx`, epoch 2000-01-03) so one column is one working
  day and a bar's width equals its duration. Axis labels translate back to real dates.

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

## Testing

```
npm test              # logic - no browser, no deps
npm run test:browser  # rendering + real drag/resize gestures (Playwright)
npm run test:all
```

Logic assertions live in `selftest()` at the bottom of `app.js`, **not** in `test/`. This is
deliberate: `index.html#selftest` and `npm test` then run the same assertions and cannot
drift, and they work with zero tooling. `test/logic.test.mjs` drives `selftest()` under Node
with a DOM shim.

- Parsing / calendar / scheduling / validation → add `eq(...)` to a `section()` in
  `selftest()`.
- Rendering / geometry / gestures / DOM → add `check(...)` to `test/browser.test.mjs`.

Run the tests before claiming something works. When writing browser tests, note that
`getBoundingClientRect()` is clipped for SVG children — derive screen coordinates from
`getScreenCTM()` instead, and scroll a bar's right edge toward the middle of the chart before
a rightward gesture or the pointer leaves the SVG and no mousemove reaches the library.

## Conventions

- Plain ASCII punctuation: `->` not an arrow, `-` not an em dash, straight quotes.
- Two-space indent, semicolons, single quotes, `const` by default.
- Comment the *why*, especially around third-party workarounds.
- Small atomic commits, imperative subject: `fix: clamp a drag to the earliest legal start`.
- Don't reformat `vendor/`.

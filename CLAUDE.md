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
   any remote `.js` / `.css` reference. There are two vendored bundles (three packages:
   Frappe Gantt; Preact + htm). Adding another needs an explicit decision, not a drive-by
   `npm install` — see "Dependency decisions" below.
3. **Examples stay synthetic.** `examples/*.csv` is invented data. Never commit real client
   plans. CI fails if any `.csv`/`.tsv` is tracked outside `examples/`. `.gitignore` excludes `timeline.csv`
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
| `src/share.js` | the share-link codec: doc <-> URL fragment | yes |
| `src/selftest.js` | the logic assertions | yes |
| `src/store.js` | `App` state, `commit()`, undo/redo, `localStorage` | no |
| `src/panels.js` | the gutter and four side panels, as Preact components | no |
| `src/render.js` | Frappe Gantt wiring, `renderAll`, `viewOf` | no |
| `src/ui.js` | toolbar, tabs, drag-and-drop, keyboard, boot | no |
| `src/tour.js` | the first-run guided tour, on driver.js | no |
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

## Theming

Light and dark. **Every colour is a token** declared in the three blocks at the top of
`index.html`; there are no colour literals anywhere else, and CI fails on one in the
stylesheet or in `src/`, and on a token present in one theme block but missing from
another. A literal cannot respond to a theme switch, and that failure is invisible until
somebody opens the other theme.

- **Dark is declared twice on purpose** — once under `@media (prefers-color-scheme: dark)`
  scoped to `:root:where(:not([data-theme="light"]))`, once under `:root[data-theme="dark"]`.
  The toolbar toggle has to beat the OS setting in *both* directions: the `:not()` guard is
  what lets an explicit Light choice win under OS-dark, and `:where()` keeps the media
  block at specificity 0 so the explicit scopes always win. Auto stores nothing.
- **An inline script in `<head>` stamps the saved theme before first paint.** The app
  scripts load at the end of `<body>`; doing it there flashes the wrong theme.
- **Tag colours are `var(--series-N)`, never a hex.** `tagColors()` returns custom-property
  references, so the browser repaints every bar and dot on a theme change with no
  re-render and no recomputation here. Don't "simplify" it to a hex lookup.
- **The theme is not part of the plan.** It has its own `localStorage` key, so it stays out
  of the undo stack (undo must not recolour the app) and survives Reset.

### Changing a series colour

The eight `--series-N` slots are a **validated palette, not a preference**. Light and dark
are separately validated against their own surface — they are not one palette with a
brightness flip. Do not hand-tweak a step. Re-run the validator and only ship values that
pass:

```
node scripts/validate_palette.js "<hex,hex,…>" --mode dark  --surface "#0f1115"
node scripts/validate_palette.js "<hex,hex,…>" --mode light --surface "#fcfcfb"
```

It checks the lightness band, a chroma floor, colourblind separation, a normal-vision
floor and contrast. The palette this replaced failed four of those: its yellow and green
sat at ΔE 14.1 for *normal* colour vision, i.e. two tags that plainly looked alike.

Slots are assigned in fixed order and **never cycled**. A 9th tag takes `--series-none`
rather than reusing a hue, because two tags sharing a colour is a worse lie than one tag
having none — and the Columns legend says so when it happens. Identity never rests on
colour anyway: the task name is always visible in the gutter. That is also the "relief"
that licenses three light-mode slots sitting below 3:1 against the surface.

## Share links

A whole plan encodes into the URL fragment so a link can be sent instead of a CSV.

- **The fragment, never the query string.** Everything after `#` is stripped before a request
  is sent and is absent from `Referer`, so the plan never reaches a server even when hosted.
  A query string would put confidential plans in an access log and break the promise the
  whole tool rests on. Do not "tidy" this into `?plan=`.
- **`srcRows` is included on purpose.** It is about a third of the payload and it is tempting
  to drop, but it is *not* reconstructible: a mapped column whose text did not survive
  normalisation lives only there. An `estimate` cell reading `TBD` becomes `null` on the
  task, and re-mapping that column is meant to hand `TBD` back as a pass-through value -
  regenerating rows from tasks yields `""`. Dropping it would make re-mapping a shared plan
  silently lossy, and would mean maintaining a second serialisation schema alongside
  `buildDoc` forever. ~760 characters is a cheap price.
- **Decoded input is untrusted.** `sanitizeSharedDoc` rebuilds the document field by field.
  It drops dangling and self dependencies (either wedges the scheduler), makes duplicate ids
  unique, clamps durations, and refuses a version mismatch. Never feed a decoded payload
  straight into `adoptDoc`.
- **A share link is a same-document navigation.** Pasting one while already on the page only
  changes the fragment: the browser fires `hashchange` and never reloads, so the boot handler
  does not run. There is a `hashchange` listener for exactly this; without it, opening a link
  from the page you are already on silently does nothing.
- **`CompressionStream`'s writer promises reject too.** `write()` and `close()` both reject
  when the stream errors, which is what a corrupted payload does. Unhandled, that is two
  unhandled rejections per bad link even though the read side is correctly caught - hence the
  `.catch(() => {})` on both in `deflateRaw`/`inflateRaw`.
- A `file://` link cannot be shared, and the toast says so rather than pretending.

## Toolbar shape

The toolbar carries **actions and live modes only**, and it is meant to stay on one row.

- **Live state stays visible.** `Rigid`/`ASAP` changes what a drag does, so it cannot go in a
  menu: the same gesture would behave two ways with no visible cause. Same for Undo/Redo,
  which are per-edit.
- **Data in and out is one `File` menu.** Open, Download CSV, Copy for Excel, Copy link and
  Reset are one job.
- **`Theme` and the tour live behind the gear**, with the library credits. You see a theme's
  effect; you do not need its control on screen.
- **Project start and team size are on the `Plan` side-panel tab, not the toolbar.** They are
  plan *properties*, not verbs, and team size belongs beside the capacity table it drives.
- Below 1280px the group labels are hidden - `Rigid | ASAP` says what it is, and otherwise
  the trailing cluster's `margin-left: auto` pushes itself onto a second row.

Menus are hand-rolled (`wireMenus`): `aria-expanded` on the trigger, a hidden panel, outside
click and Escape to close. Anything with `role="menuitem"` closes the menu on activation; the
theme segmented control deliberately does not, so you can try light then dark.

**htm does not decode HTML entities.** `&laquo;` in a template renders literally. The Plan
tab's nudge buttons say `-1w` / `+1w`, which is plain ASCII and clearer than chevrons.

## Frappe Gantt gotchas

These are load-bearing. All five were found the hard way:

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

4. **`view_mode` passed to the constructor does not work.** frappe resolves it once and
   `config.view_mode` stays on `Day` whatever you hand it, so rebuilding the chart left the
   column width at 30 and the zoom control did nothing at all for its entire existence. Use
   `gantt.change_view_mode(name, true)` instead - which is better anyway, because it keeps
   the scroll position a rebuild would discard. It re-renders the SVG, so `markBars()` and
   the gutter have to be re-applied afterwards.
5. **frappe ships its own dark theme under `html[data-theme=dark]`** — the very attribute
   our toggle sets. So any `--g-*` token we leave unset takes frappe's *dark* default when
   the toggle says dark, but its *light* default under OS-dark with the toggle on Auto. That
   split had `--g-weekend-highlight-color` flashing near-white on column hover in one dark
   path and not the other. **Every** `--g-*` token is therefore pinned to one of ours in the
   `.gantt-container` block, including ones this app never displays. Don't prune them.

Also: built-in `move_dependencies` is a rigid *visual* drag that ignores working days, so it
is off and all propagation is ours (`propagateRigid`, `asapAll`, `pullIntoLegality`).

And note the in-bar labels are hidden. No single ink is legible on all eight light-mode
slots (white fails on yellow and aqua, dark ink fails on blue and violet), frappe was
already hiding the ones too long to fit, and the gutter shows every name anyway.

## driver.js gotchas

The first-run tour is driver.js (global `driver.js.driver`). Two things bit:

1. **`onDestroyed` never fires** in 1.8.0 — not on Done, not on Escape, not on the close
   button. Its teardown only reaches the hook while `__activeElement` and `__activeStep` are
   still set, and by then they are not. `onDestroyStarted` *does* fire, but taking it over
   means owning the teardown: the library returns early without destroying, so you would
   have to call `destroy()` yourself and guard the recursion that causes. So the tour is
   marked seen **when it starts**, which is better behaviour anyway — somebody who opens it
   and immediately closes it has been offered it.

   The tour is **opt-in**: nothing opens by itself. Until it has been taken, the toolbar
   button reads "Take the tour" and pulses; afterwards it shrinks to a quiet `?`. That state
   lives on `App.tourSeen`, mirrored from its own `localStorage` key so `renderToolbar()`
   does not hit storage every render, and so Reset does not start nagging again. The pulse
   honours `prefers-reduced-motion`.
2. **It adds `.driver-active-element` but never removes it from the previous target.** That
   class is what grants `pointer-events: auto`, so without cleanup every element the tour
   has visited stays clickable behind the overlay — six of them by the last step. A single
   `onHighlightStarted` strips the stale ones.

Also: its stylesheet hard-codes colours and exposes no custom properties for them, so
`index.html` re-skins the popover against our tokens — otherwise the tour is a white card in
dark mode. And a step targeting something inside a hidden tab must reveal it first (the
`showTab` key on a step) or driver.js measures a zero-sized box.

**Test note:** `localStorage.clear()` drops the "tour seen" flag, so any test helper that
clears storage must re-stamp it. `boot()` in the browser suite does; without that the tour
opens and its overlay swallows every subsequent click.

## Preact gotchas

The panels are Preact components via `htm` (no JSX, no build step; global `htmPreact`).

1. **Preact owns the children of `#gutter`, `#tab-validate`, `#tab-editor`, `#tab-load` and
   `#tab-columns`.** Never assign `innerHTML` on those hosts from outside — it desyncs
   Preact's virtual tree. Render `null` through the matching `paint*` function to clear one.
2. **`{n && html`...`}` renders a literal `0`** when `n` is `0`. Use a ternary returning
   `null`. This shipped a stray "0" in the Columns panel once.
3. Components are deliberately dumb — props in, vnode out, no component state. All state is
   in `App`; all mutation goes through `commit()`.

## Two things that both sound like "checking"

Do not confuse these. They are unrelated and the names are unhelpfully similar:

| | `selftest()` in `src/selftest.js` | `validate()` in `src/validate.js` |
|---|---|---|
| Question it answers | is the *code* correct? | is this *plan* self-consistent? |
| Runs against | the bundled synthetic example only | whatever plan the user has loaded |
| When | `npm test`, or `index.html#selftest` | every render |
| Output | pass/fail assertions | findings in the Validation tab, with fixes |

`selftest()` is the test suite and never sees a user's plan. `validate()` is a product
feature. A new assertion goes in `selftest()`; a new *finding* goes in `validate()`.

## Testing

```
npm test              # logic - no browser, no deps, no DOM shim
npm run test:browser  # rendering + real drag/resize gestures (Playwright)
npm run test:all
```

Logic assertions live in `selftest()` in `src/selftest.js`, **not** in `test/`. This is
deliberate: `index.html#selftest` and `npm test` then run the same assertions and cannot
drift. `selftest(fixtures)` is pure — it takes `{ csv }`, the bundled example text from the
`sample-csv` block in `index.html`, and returns structured results; the browser renders them
via `renderSelftest()` in `src/ui.js`.

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
- **driver.js — adopted** for the first-run tour. MIT, zero dependencies, 25 kB IIFE + 3 kB
  CSS, works from `file://`.
- **Shepherd.js and intro.js — refused on licensing.** Both are AGPL-3.0. This project is
  MIT; taking either would mean relicensing the whole thing or buying a commercial
  exception. Check the licence before reaching for a tour library, because the two
  best-known ones are copyleft.

## Conventions

- Plain ASCII punctuation: `->` not an arrow, `-` not an em dash, straight quotes.
- Two-space indent, semicolons, single quotes, `const` by default.
- Comment the *why*, especially around third-party workarounds.
- Small atomic commits, imperative subject: `fix: clamp a drag to the earliest legal start`.
- Don't reformat `vendor/`.

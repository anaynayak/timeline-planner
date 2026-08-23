# Timeline Planner

**[Try it → anaynayak.github.io/timeline-planner](https://anaynayak.github.io/timeline-planner/)**
— it loads with a synthetic example, so there is nothing to set up.

A static, offline browser tool that turns a CSV project plan into a Gantt chart on a
**working-day axis**, validates it against the estimate column, and reschedules downstream
tasks when you move or resize one.

Most whiteboard timeline tools can draw bars but cannot schedule: they have no notion of a
working day, bars snap to whole calendar weeks regardless of the estimate, and the
"blocked by" column is decorative text that nothing enforces. This fixes that, without
becoming a project-management server.

Gantt rendering is provided by **[Frappe Gantt](https://github.com/frappe/gantt)** (MIT),
the side panels by **[Preact](https://preactjs.com)** (MIT) +
**[htm](https://github.com/developit/htm)** (Apache-2.0), and the first-run tour by
**[driver.js](https://github.com/kamranahmedse/driver.js)** (MIT) — see [NOTICE](NOTICE).
All are vendored, not fetched.

## Running it

Either open the [hosted copy](https://anaynayak.github.io/timeline-planner/), or clone and
open the file:

```
open index.html
```

No build step, no server, no install. It is plain HTML plus ordinary classic scripts — no
modules, no bundler — so it works straight from `file://`.

**Your plan never leaves the browser.** Every library is vendored rather than pulled from a
CDN, and the app makes no network request of any kind — CI fails the build if one
appears. Opening the hosted copy fetches the page itself from GitHub Pages, and that is the
only request involved; nothing about a plan you load is ever sent anywhere. Even a
[share link](#output) keeps the plan in the URL *fragment*, which browsers do not transmit.

A short guided tour points at the parts that are not guessable — the working-day axis,
dragging a bar, and the duration-versus-estimate column. It is **opt-in**: nothing
interrupts you on arrival. Until you have taken it the toolbar button reads **Take the
tour** and pulses gently; afterwards it becomes a quiet **?** you can use any time. The plan
you land on is a synthetic example and is labelled as such, so it is never mistaken for your
own data.

Drop a `.csv` or `.tsv` on the window to load it, or use **Open file**. Two synthetic
examples are in [`examples/`](examples):

| File | Shows |
|---|---|
| `example-plan.csv` | the default sample: name-based dependencies, `start_date` + `end_date`, extra `owner` / `confidence` columns |
| `timeline.csv` | the fuller reference: `id`-based dependencies with `;` separators, an explicit `duration` column, `pinned`, extra `owner` / `cost_centre` columns |

Both are made-up plans. Keep real project data out of the repo — `.gitignore` already
excludes `timeline.csv` and `plan.csv` at the root, and `*.local.csv`.

## Input format

Delimited text with a header row — comma or tab, sniffed automatically. Columns are matched
to canonical fields by alias, so an existing file usually loads as-is:

| Field | Accepted column names |
|---|---|
| `id` | id, key, ref, task id, uid |
| `name` | **name**, title, task, task name, summary, activity |
| `description` | description, notes, detail, comment |
| `tag` | tag, tags, stream, workstream, group, category, phase, epic |
| `start_date` | start date, start, begin, from |
| `end_date` | end date, end, finish, to, due |
| `estimate` | estimate, estimate days, est, effort, points, size |
| `duration` | duration, duration days, days, elapsed, working days |
| `dependency` | dependency, dependencies, depends on, blocked by, predecessor, after, upstream |
| `pinned` | pinned, pin, fixed, locked |

Only `name` is required. Matching ignores case, spaces and underscores.

**Anything unmapped is carried through untouched** and written back on export, so extra
columns are never lost. The **Columns** tab shows the detected mapping and lets you point any
field at a different column.

Other details worth knowing:

- **Dependencies** may be ids or names, separated by `,` or `;`. Because names can themselves
  contain commas (`Counter, shelving and seating`), comma-separated lists are resolved by
  greedy longest-name matching rather than a naive split. Anything unresolvable is reported,
  never silently dropped. The export writes back in whichever style the file used.
- **Dates** accept `YYYY-MM-DD`, full ISO with time/Z, `YYYY/MM/DD` and `DD/MM/YYYY`. These
  are whole-day fields, so output is always a plain date — a timestamped input is read and
  written back as `2027-03-01`, never echoed with a time component, because a spreadsheet
  will not read `2027-03-01T00:00:00.000Z` as a date. Day-first files stay day-first.
- **Duration precedence**: an explicit `duration` column wins; else the `start_date` to
  `end_date` span; else `estimate`; else 1 day.
- **Formula quoting**: spreadsheet exports wrap formula-looking values in single quotes, so a
  task named `% Split` can arrive as `'% Split'` in one column and bare in another. Both are
  recognised as the same task, and the quoting is re-applied on export.
- **Delimiter sniffing** considers only comma and tab. `;` is deliberately excluded: it is a
  legal dependency separator *inside* a cell, so treating it as a delimiter would shred
  perfectly good CSV files.
- **Weekend end dates** are pulled back to the last working day they actually cover, so a
  plan drawn across whole calendar weeks still yields working-day durations.
- **Supported dates run 2015 to 2050.** A plan outside that window is refused by name on
  load rather than silently snapped to the start of the range.

## What `estimate` means

`estimate` is **elapsed working days for a single owner**: 5 = one week. `duration` is how
long the bar is actually drawn.

When they disagree the task is flagged, the gutter shows `15d / 20d`, and one click sets
duration from estimate. That distinction is the point of the tool — it is very easy to end up
with a timeline whose bars were arranged to look neatly packed rather than to reflect the
estimates underneath them.

## Scheduling

The axis is **working days only**. Weekends and holidays are not columns at all, so one
column is exactly one working day and a bar's width is exactly its duration. All scheduling
is integer arithmetic over working-day indices, which is why nothing can ever land on a
Saturday.

- **Project start** (on the **Plan** tab) — change the date and the whole plan shifts by
  that many working days, keeping its shape. `-1w` / `+1w` nudge by a week.
- **Zoom** — `Day` / `Compact` / `Tiny` set how many pixels a working day gets (30 / 14 / 7).
  It is a zoom, not a calendar granularity: one column is always exactly one working day,
  which is what makes a bar's width equal its duration, so there is no week-or-month column
  mode to switch to.
- **Propagation** — how downstream tasks react when you move or resize one:
  - **Rigid** (default): successors shift by the same delta, preserving their current gaps.
  - **ASAP**: successors are pulled to the earliest legal start, collapsing gaps.
  - Either way a task is clamped so it can never start before its predecessors finish.
    **Reflow** runs a one-off ASAP pass over everything.
- **Dragging** a bar pins it, so a later ASAP pass treats where you put it as a floor rather
  than snapping it back. Unpin from the task editor.
- **Adding a dependency** — the task editor exposes both directions, *Blocked by* and
  *Blocks*, so a new task can be made upstream of an existing one in one step. Options that
  would create a cycle are disabled.
- **Critical path** — tasks with zero float are outlined in red. Cycles are reported, not
  crashed on.
- **Capacity is reported, never scheduled against.** The Load tab shows person-days per week
  against your team size and flags overloaded weeks, but no task is delayed to fit. Holidays
  are editable there and are removed from the axis entirely.

## Output

- **Download CSV** — same columns, same order, pass-through columns intact, true working-day
  dates. Re-importing is idempotent.
- **Copy for Excel** — the same table, tab separated, on the clipboard. Excel and Sheets
  only split *pasted* text on tabs, so this drops straight into cells; pasting CSV would put
  each whole row in one cell. A tab or newline inside a cell collapses to a space, because
  there is no quoting convention Excel honours in pasted text.

- **Copy link** — a URL with the whole plan encoded into it, so you can send a link instead
  of a file. The recipient opens it and sees exactly your plan, edits included. The payload
  lives in the URL **fragment**, which browsers never send to a server and omit from
  `Referer` headers, so hosting the page does not mean the plans pass through it. A 16-task
  plan comes to about 1,950 characters. Two things worth knowing: the plan travels *inside*
  the link, so a link is as sensitive as the CSV; and a `file://` link cannot be shared, so
  this is only useful once the page is hosted.

Edits autosave to `localStorage`, so a refresh does not lose work; **Reset** returns to the
bundled example. Undo/redo is <kbd>Cmd/Ctrl</kbd>+<kbd>Z</kbd>.

## Appearance

**Light**, **Dark** or **Auto** from the toolbar. Auto follows the operating system; an
explicit choice overrides it and is remembered. The theme is a viewer preference, so it is
not part of the plan: undo will not recolour the app and **Reset** leaves it alone.

Tag colours are a validated categorical palette with separate light and dark values, each
checked against its own surface for lightness, chroma, colourblind separation and contrast -
so two tags never end up looking alike. Colours are assigned to tags in a fixed order and
never reused: a ninth tag takes the neutral rather than repeating a hue. Identity does not
rest on colour in any case, since the task name is always visible in the list beside the
chart.

## Tests

```
npm test              # parser, calendar, scheduler, validators - no browser, no deps
npm run test:browser  # rendering geometry and real drag/resize gestures (needs Playwright)
```

`npm test` needs nothing but Node. For the browser suite:

```
npm install
npx playwright install chromium
npm run test:browser
```

You can also open `index.html#selftest` to run the logic assertions in the browser.

## Deploying

Live at **[anaynayak.github.io/timeline-planner](https://anaynayak.github.io/timeline-planner/)**,
published by the `Deploy to GitHub Pages` workflow on every push to `main`.

The Pages source must stay on **GitHub Actions** (Settings → Pages → Source). The other
option, *Deploy from a branch*, serves the repository root verbatim — which renders fine but
skips the assembly step, so it publishes `src/testhooks.js` and puts `window.App` and the
`__*` helpers on the public page. Those exist only so the browser suite can drive the app.
The workflow strips that file and its `<script>` tag, adds `.nojekyll`, and fails loudly if
any script target is missing rather than publishing a broken page.

Pages on a *private* repository needs a paid GitHub plan; on the free plan either make the
repo public or just run it locally.

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md). Short version: no build step, nothing fetched at
runtime, add assertions in `selftest()` alongside the change, and keep the examples
synthetic.

## Files

```
index.html          markup, styles, and the bundled example
src/                the app, as ordered classic <script> files - no bundler
  dates.js            date helpers
  calendar.js         the working-day index
  workday-space.js    the synthetic-date transform the chart is drawn in
  formats.js          delimited text in, CSV + TSV out, column aliases
  scheduler.js        topological sort, ASAP, rigid propagation, float, load
  validate.js         findings, and the fix each one offers
  fixes.js            what each fix does
  share.js            share-link codec (plan <-> URL fragment)
  selftest.js         the logic assertions
  store.js            app state, commit(), undo/redo, localStorage
  panels.js           the gutter and side panels, as Preact components
  render.js           Frappe Gantt wiring
  ui.js               toolbar, tabs, drag-and-drop, keyboard, boot
  tour.js             the first-run guided tour
  testhooks.js        hooks for the browser suite; dropped from a deploy
vendor/             Frappe Gantt 1.2.2 (MIT), htm + Preact (Apache-2.0 / MIT),
                    driver.js 1.8.0 (MIT) - all vendored, no network calls
examples/           synthetic example plans
test/               headless test runners
```

Every file above `store.js` is pure - no DOM access at all - which is what lets the
logic suite run under Node with no browser and no DOM shim.

## Implementation notes

Two things about Frappe Gantt shape the code, and both cost real debugging time:

1. **Its `ignore` option does not compress the axis.** It hatches non-working columns and
   keeps a calendar axis, so a 10-working-day bar would still be 12 columns wide. To get one
   column per working day, the chart renders in *workday space*: each real working day maps
   to a contiguous synthetic date, the library draws that, and the axis labels are translated
   back to real dates.
2. **It fires `on_date_change` on every mousemove of a drag**, not on release, because
   `date_changed()` is called from `update_bar_position()`. Re-rendering there tears down the
   SVG mid-gesture and the drag dies after one column, so the commit is deferred to `mouseup`.

Also: `custom_class` is passed straight to `classList.add`, so it must be a single token —
state classes and tag colours are applied after render instead. Its built-in
`move_dependencies` is a rigid visual drag that ignores working days, so it is switched off
and all propagation is handled here.

Three more things worth knowing:

3. **Scheduling never does date arithmetic.** Positions are integer working-day indices from
   `src/calendar.js`, so weekends and holidays do not exist in the number line and a task
   cannot land on a Saturday. Anything that loops over tasks builds the dependency graph
   once and passes it down; re-deriving it per task is what previously made an edit on a
   300-task plan take over 100 ms.
4. **The panels diff rather than rebuild.** They are Preact components, so editing a field
   updates the DOM in place instead of tearing the subtree down — which is what preserves
   input focus, caret position and scroll offset, and escapes column names from the loaded
   file by construction. htm ships a prebuilt UMD bundle of preact + hooks + htm, so this
   costs one 13 kB vendored file and no build step.
5. **A theme is a token swap and nothing else.** Every colour is a CSS custom property, and
   CI fails on a literal anywhere in the stylesheet or in `src/`. Bars carry
   `var(--series-N)` rather than a hex, so switching theme repaints the chart with no
   re-render at all. Frappe ships its own dark values under the same `data-theme` attribute
   this app sets, so every one of its tokens is pinned to ours — otherwise a token behaves
   differently under an explicit dark choice than under OS-dark.

Dependency-aware rescheduling is a paid feature in the obvious alternatives:
[DHTMLX Gantt](https://docs.dhtmlx.com/gantt/guides/auto-scheduling)'s `auto_scheduling` is
PRO-only, and [SVAR Gantt](https://svar.dev/react/gantt/pricing/) keeps auto-scheduling,
critical path *and* working calendars behind PRO. That is why the scheduler here is our own.

## Licence

MIT — see [LICENSE](LICENSE). Bundled third-party licences are listed in [NOTICE](NOTICE).

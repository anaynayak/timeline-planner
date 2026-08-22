# Timeline Planner

A static, offline browser tool that turns a CSV project plan into a Gantt chart on a
**working-day axis**, validates it against the estimate column, and reschedules downstream
tasks when you move or resize one.

Most whiteboard timeline tools can draw bars but cannot schedule: they have no notion of a
working day, bars snap to whole calendar weeks regardless of the estimate, and the
"blocked by" column is decorative text that nothing enforces. This fixes that, without
becoming a project-management server.

Gantt rendering is provided by **[Frappe Gantt](https://github.com/frappe/gantt)** (MIT) —
see [NOTICE](NOTICE).

## Running it

```
open index.html
```

No build step, no server, no install. It is plain HTML plus one classic script, so it works
straight from `file://`. Everything happens in the browser and **nothing is sent over the
network** — the Gantt library is vendored locally rather than pulled from a CDN.

Drop a `.csv` on the window to load it, or use **Open file**. Two synthetic examples are in
[`examples/`](examples):

| File | Shows |
|---|---|
| `example-plan.csv` | the default sample: name-based dependencies, `start_date` + `end_date`, extra `owner` / `confidence` columns |
| `timeline.csv` | the fuller reference: `id`-based dependencies with `;` separators, an explicit `duration` column, `pinned`, extra `owner` / `cost_centre` columns |

Both are made-up plans. Keep real project data out of the repo — `.gitignore` already
excludes `timeline.csv` and `plan.csv` at the root, and `*.local.csv`.

## Input format

CSV with a header row. Columns are matched to canonical fields by alias, so an existing file
usually loads as-is:

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
- **Dates** accept `YYYY-MM-DD`, full ISO with time/Z, `YYYY/MM/DD` and `DD/MM/YYYY`. The
  export re-uses the source format.
- **Duration precedence**: an explicit `duration` column wins; else the `start_date` to
  `end_date` span; else `estimate`; else 1 day.
- **Formula quoting**: spreadsheet exports wrap formula-looking values in single quotes, so a
  task named `% Split` can arrive as `'% Split'` in one column and bare in another. Both are
  recognised as the same task, and the quoting is re-applied on export.
- A **Miro Timeline markdown export** is also accepted, detected by content. Its Mon–Sun bars
  are normalised to real working days on import, and **Copy for Miro** snaps them back to
  whole weeks so the table can be pasted onto a board.

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

- **Project start** — change the date and the whole plan shifts by that many working days,
  keeping its shape. `«` / `»` nudge by a week.
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
- **Copy for Miro** — a markdown table with Mon–Sun week snapping and Miro's escaping.

Edits autosave to `localStorage`, so a refresh does not lose work; **Reset** returns to the
bundled example. Undo/redo is <kbd>Cmd/Ctrl</kbd>+<kbd>Z</kbd>.

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

The app is a static site, so GitHub Pages works out of the box. Enable it under
**Settings → Pages → Source: GitHub Actions** and the included workflow publishes on every
push to `main`. Note that Pages for a *private* repository requires a paid GitHub plan; on
the free plan either make the repo public or just run it locally.

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md). Short version: no build step, no runtime
dependencies, add assertions in `selftest()` alongside the change, and keep the examples
synthetic.

## Files

```
index.html          markup, styles, and the bundled example
app.js              parser, calendar, scheduler, validators, UI, selftest
vendor/             Frappe Gantt 1.2.2 (MIT), vendored so there are no network calls
examples/           synthetic example plans
test/               headless test runners
```

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

Dependency-aware rescheduling is a paid feature in the obvious alternatives:
[DHTMLX Gantt](https://docs.dhtmlx.com/gantt/guides/auto-scheduling)'s `auto_scheduling` is
PRO-only, and [SVAR Gantt](https://svar.dev/react/gantt/pricing/) keeps auto-scheduling,
critical path *and* working calendars behind PRO. That is why the scheduler here is our own.

## Licence

MIT — see [LICENSE](LICENSE). Bundled third-party licences are listed in [NOTICE](NOTICE).

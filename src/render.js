/* Rendering: frappe-gantt wiring, the name gutter and the side panels.
 *
 * Axis labels translate workday-space columns back to real dates - see workday-space.js.
 *
 * Three frappe gotchas are load-bearing here:
 *   1. `ignore: ['weekend']` does not compress the axis (hence workday space).
 *   2. `on_date_change` fires on every mousemove of a drag, not on release, so a re-render
 *      inside it tears down the SVG mid-gesture. The commit is deferred to mouseup.
 *   3. `custom_class` goes straight into classList.add, so it must be a single token.
 *      State classes and tag colours are applied after render in markBars().
 */
'use strict';

/** frappe's popup sets innerHTML directly (`set_details: a => this.details.innerHTML =
 *  a`), so any task text going into it - unlike htm, which escapes by construction - has
 *  to be escaped here or a description becomes an HTML/script injection point. */
const escapeHtml = (s) => String(s).replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));

function viewModes(cal) {
  const realOf = (d) => {
    const i = synthIdx(d);
    return i >= 0 && i < cal.size ? cal.at(i) : null;
  };
  const mk = (name, cw, dense) => ({
    name,
    padding: '4d',
    step: '1d',
    date_format: 'YYYY-MM-DD',
    column_width: cw,
    snap_at: '1d',
    lower_text: (d) => {
      const r = realOf(d);
      if (!r) return '';
      const rd = parseYMD(r);
      if (dense) return String(rd.getDate());
      return rd.getDay() === 1 ? String(rd.getDate()) : '';
    },
    upper_text: (d, ld) => {
      const r = realOf(d);
      if (!r) return '';
      const rd = parseYMD(r);
      const lr = ld ? realOf(ld) : null;
      if (!lr) return MONTHS[rd.getMonth()] + ' ' + rd.getFullYear();
      const lrd = parseYMD(lr);
      return rd.getMonth() !== lrd.getMonth() ? MONTHS[rd.getMonth()] + ' ' + rd.getFullYear() : '';
    },
    thick_line: (d) => {
      const r = realOf(d);
      return r ? parseYMD(r).getDay() === 1 : false;
    },
  });
  return [mk('Day', 30, true), mk('Compact', 14, false), mk('Tiny', 7, false)];
}

function ganttTasks(doc, cal) {
  return doc.tasks.map((t) => {
    const s = startIdx(cal, t);
    return {
      id: t.id,
      name: t.name.trim(),
      start: synthYmd(s),
      end: synthYmd(s + t.duration - 1),
      progress: 0,
      dependencies: t.deps.slice(),
      // frappe does classList.add(custom_class), so this must be a single token;
      // state classes and tag colours are applied after render in markBars()
      custom_class: 'tsk',
    };
  });
}

/** Apply a drag or resize once the gesture has finished. */
function commitDrag() {
  const pd = App.pendingDrag;
  App.pendingDrag = null;
  if (!pd) return;
  const cal = App.cal;
  const t = App.doc.tasks.find((x) => x.id === pd.id);
  if (!t) return;
  const oldS = startIdx(cal, t);
  const oldE = oldS + t.duration - 1;
  if (pd.s === oldS && pd.e === oldE) return;
  const clamped = commit(() => {
    t.duration = Math.max(1, pd.e - pd.s + 1);
    // frappe will happily drop a bar before its predecessor finishes, so clamp the
    // landing position to the earliest legal start rather than accept an illegal plan
    const floor = earliest(App.doc, cal, t, 0);
    const newS = Math.max(0, pd.s, floor);
    t.start = cal.at(newS);
    t.pinned = true;
    reschedule(App.doc, cal, t.id, newS + t.duration - 1 - oldE);
    return newS !== pd.s;
  });
  if (clamped) toast('Clamped: cannot start before its dependencies finish');
}

/** Task-name gutter. The rows are drawn by the Gutter component; the only thing that has
 *  to be computed here is the row geometry, which comes from frappe's own layout options
 *  so the two columns stay aligned. */
function renderGutter(doc, an, colors) {
  const g = App.gantt;
  if (!g) { paintGutter(null); return; }
  paintGutter(html`<${Gutter} doc=${doc} an=${an} colors=${colors}
    rowH=${g.options.bar_height + g.options.padding} headH=${g.config.header_height} />`);
}

/* Tags are whatever the file happens to use, so a colour is assigned per tag rather than
 * hard-coded per stream. These return `var(--series-N)` rather than a hex on purpose:
 * the browser re-resolves the custom property when the theme changes, so switching
 * light/dark repaints every bar and dot with no re-render and no recomputation here.
 *
 * Slots are assigned in fixed order and never cycled. The light and dark values of each
 * slot are separately validated for their own surface, and that guarantee only holds for
 * the first eight; a 9th tag takes the neutral rather than reusing a hue, because two
 * tags sharing a colour is a worse lie than one tag having no colour. Identity never
 * rests on colour anyway - the task name is always visible in the gutter. */
const SERIES_SLOTS = 8;

function tagColors(doc) {
  const tags = [...new Set(doc.tasks.map((t) => t.tags[0] || ''))].sort();
  const m = new Map();
  let slot = 0;
  for (const t of tags) {
    if (t === '' || slot >= SERIES_SLOTS) { m.set(t, 'var(--series-none)'); continue; }
    m.set(t, `var(--series-${++slot})`);
  }
  return m;
}

/** Tags past the eighth share the neutral, so the legend has to say so. */
const overflowTags = (doc) =>
  [...new Set(doc.tasks.map((t) => t.tags[0] || ''))].filter(Boolean).length - SERIES_SLOTS;

/** Apply the state classes and colours frappe cannot take via custom_class. */
function markBars(doc, an, colors) {
  for (const t of doc.tasks) {
    const el = document.querySelector(`#gantt .bar-wrapper[data-id="${t.id}"]`);
    if (!el) continue;
    el.classList.toggle('critical', an.float.get(t.id) === 0);
    el.classList.toggle('mismatch', t.estimate != null && t.estimate !== t.duration);
    el.classList.toggle('selected', App.selected === t.id);
    const bar = el.querySelector('.bar');
    if (bar) bar.style.fill = colors.get(t.tags[0] || '');
  }
}

function renderGantt(view) {
  const doc = App.doc, cal = App.cal;
  view = view || viewOf(doc, cal);
  const el = document.getElementById('gantt');
  if (!doc.tasks.length) {
    el.innerHTML = '<div id="gantt-empty">No tasks. Drop a .csv file or add one.</div>';
    paintGutter(null);   // Preact owns #gutter; never innerHTML it from outside
    App.gantt = null;
    return;
  }
  const an = view.an;
  el.innerHTML = '';

  App.gantt = new Gantt(el, ganttTasks(doc, cal), {
    view_mode: App.zoom,
    view_modes: viewModes(cal),
    bar_height: 22,
    padding: 12,
    readonly_progress: true,
    move_dependencies: false,     // we own all propagation
    infinite_padding: false,      // the axis is a fixed workday map
    today_button: false,
    holidays: {},                 // workday space has no non-working columns
    ignore: [],
    container_height: 'auto',
    scroll_to: synthYmd(Math.max(0, cal.nextIdx(doc.projectStart) - 3)),
    popup: (ctx) => {
      const t = App.doc.tasks.find((x) => x.id === ctx.task.id);
      if (!t) return false;
      const s = startIdx(cal, t);
      const fl = an.float.get(t.id);
      ctx.set_title(t.name.trim());
      ctx.set_subtitle(t.tags.join(', ') || '');
      ctx.set_details(
        `${fmtNice(cal.at(s))} &rarr; ${fmtNice(cal.at(s + t.duration - 1))}<br>` +
        `${t.duration} working days` +
        (t.estimate != null ? ` &middot; estimate ${t.estimate}d${t.estimate !== t.duration ? ' <b>(mismatch)</b>' : ''}` : ' &middot; <b>no estimate</b>') +
        `<br>Float ${fl}d${fl === 0 ? ' <b>(critical path)</b>' : ''}` +
        (t.description ? `<br><br>${escapeHtml(t.description).replace(/\n/g, '<br>')}` : '')
      );
    },
    // selectTask repaints the gutter, the bar highlight and the editor. It deliberately
    // does NOT re-run renderGantt: rebuilding the SVG on a click loses the scroll position.
    on_click: (task) => selectTask(task.id),
    on_double_click: (task) => selectTask(task.id, true),
    // frappe fires date_change from update_bar_position, i.e. on EVERY mousemove of a
    // drag, not just on release. Re-rendering here would tear down the SVG mid-gesture
    // and the drag would die after one column, so the commit is deferred to mouseup
    // (see the window 'mouseup' listener in ui.js). A debounced auto-commit used to sit
    // here as a fallback, but firing it while the mouse button was still down was exactly
    // the same tear-down: a drag paused for >150ms lost every movement made after the pause.
    on_date_change: (task, start, end) => {
      App.pendingDrag = { id: task.id, s: synthIdx(start), e: synthIdx(end) };
    },
  });

  markBars(doc, an, view.colors);
  renderGutter(doc, an, view.colors);
}

function renderValidation(view) {
  const doc = App.doc, cal = App.cal;
  const findings = validate(doc, cal, view.an, view.loadRows);

  // the badge lives in the toolbar, outside the panel Preact owns
  const badge = document.getElementById('v-badge');
  const errs = findings.filter((f) => f.level === 'error').length;
  const warns = findings.filter((f) => f.level === 'warn').length;
  badge.textContent = findings.length;
  badge.className = 'badge ' + (errs ? 'err' : warns ? 'warn' : 'ok');

  paintValidation(html`<${ValidationPanel} doc=${doc} cal=${cal} an=${view.an} findings=${findings} />`);
}

function renderLoad(view) {
  const doc = App.doc, cal = App.cal;
  paintLoad(html`<${LoadPanel} doc=${doc} cal=${cal}
    rows=${(view || viewOf(doc, cal)).loadRows} />`);
}

/** Column mapping panel: which file column feeds each canonical field. */
function renderColumns(view) {
  const doc = App.doc;
  view = view || viewOf(doc, App.cal);
  paintColumns(html`<${ColumnsPanel} doc=${doc} numCols=${view.numCols} colors=${view.colors}
    overflow=${overflowTags(doc)} />`);
}

/** Point a canonical field at a different column and rebuild from the source rows. */
function remapColumn(field, idx) {
  const d = App.doc;
  const override = {};
  for (const k of FIELD_KEYS) override[k] = d.mapping[k];
  if (idx >= 0) for (const k of FIELD_KEYS) if (override[k] === idx) override[k] = -1;
  override[field] = idx;
  let nd;
  try {
    nd = buildDoc(d.srcHeader, d.srcRows, App.cal,
      { format: d.format, preamble: d.preamble, mapping: override });
  } catch (e) {
    toast('Cannot remap: ' + e.message);
    renderColumns();
    return;
  }
  commit(() => {
    for (const k of ['projectStart', 'holidays', 'teamSize', 'mode']) nd[k] = d[k];
    App.doc = nd;
    App.selected = null;
  }, { rebuildCal: true });
  toast(`${field} now reads "${idx < 0 ? 'nothing' : d.srcHeader[idx]}"`);
}

/** Draw the task editor for `id`, or the placeholder when nothing is selected. */
function openEditor(id, view) {
  const doc = App.doc, cal = App.cal;
  const t = doc.tasks.find((x) => x.id === id);
  if (!t) {
    paintEditor(html`<p class="hint">Select a task bar to edit it.</p>`);
    return;
  }
  App.selected = id;
  paintEditor(html`<${EditorPanel} doc=${doc} cal=${cal} t=${t}
    view=${view || viewOf(doc, cal)} />`);
}

/** Select a task: highlight it, show it in the editor, optionally switch to that tab. */
function selectTask(id, showEditorTab) {
  App.selected = id;
  const view = viewOf(App.doc, App.cal);
  openEditor(id, view);
  renderGutter(App.doc, view.an, view.colors);
  markBars(App.doc, view.an, view.colors);
  if (showEditorTab) showTab('editor');
}

function renderToolbar() {
  const doc = App.doc, cal = App.cal;
  const nameEl = document.getElementById('file-name');
  nameEl.textContent = App.fileName;
  nameEl.classList.toggle('example', App.isExample);
  nameEl.title = App.isExample
    ? 'Synthetic example data, not a file of yours. Drop a .csv to replace it.'
    : App.fileName;
  document.querySelectorAll('#seg-mode button').forEach((b) => b.classList.toggle('on', b.dataset.mode === doc.mode));
  document.querySelectorAll('#seg-zoom button').forEach((b) => b.classList.toggle('on', b.dataset.zoom === App.zoom));
  document.querySelectorAll('#seg-theme button').forEach((b) => b.classList.toggle('on', b.dataset.theme === App.theme));
  /* The tour is opt-in. Until it has been taken the button says so and pulses; afterwards
   * it shrinks to a quiet "?" so it stops competing with the actual controls. */
  /* The tour invitation is loud while it is useful and then leaves the toolbar entirely -
   * once taken it lives only in Settings, so it stops competing for room. */
  const help = document.getElementById('btn-help');
  help.hidden = App.tourSeen;
  help.textContent = 'Take the tour';
  help.classList.toggle('invite', !App.tourSeen);
  help.title = 'New here? A short guided tour of the chart';
  document.getElementById('btn-undo').disabled = !App.undoStack.length;
  document.getElementById('btn-redo').disabled = !App.redoStack.length;
}

/** Everything a full render pass needs, computed exactly once. */
function viewOf(doc, cal) {
  return {
    an: analyse(doc, cal),
    loadRows: weeklyLoad(doc, cal),
    numCols: numericExtras(doc),
    colors: tagColors(doc),
  };
}

/* One pass, one analysis. renderGantt and renderValidation each used to call analyse()
 * for themselves, and validate() plus renderLoad each called weeklyLoad(), so a single
 * keystroke ran the whole critical-path pass twice and the load pass twice. */
function renderAll() {
  const view = viewOf(App.doc, App.cal);
  renderToolbar();
  renderGantt(view);
  renderValidation(view);
  renderLoad(view);
  renderColumns(view);
  paintPlan(html`<${PlanPanel} doc=${App.doc} cal=${App.cal} />`);
  openEditor(App.selected, view);
  persist();
}

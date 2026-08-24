/* The name gutter and the four side panels, as Preact components.
 *
 * Why a view library in a no-build-step project: these panels were ~450 lines of manual
 * createElement plus innerHTML string building, and every edit tore all four down and
 * rebuilt them. That lost input focus and caret position on every keystroke in the task
 * editor, reset the panel scroll, and mixed two templating styles. htm + Preact ship as
 * one prebuilt UMD bundle, so a classic <script> tag still works from file:// - no
 * bundler, no transpiler, no import map. The diffing is what buys focus retention.
 *
 * The components are deliberately dumb: props in, vnode out. All state lives in App and
 * all mutation goes through commit(), so there is no component state to get out of step.
 * Text is escaped by construction, which also closes the one place a column name from a
 * loaded file used to reach innerHTML unescaped.
 */
'use strict';

const { html, render } = htmPreact;

/* ---------- shared bits ---------- */

const GroupH = ({ children }) => html`<div class="group-h">${children}</div>`;
const Hint = ({ children }) => html`<p class="hint">${children}</p>`;
const KV = ({ k, v }) => html`<div class="kv"><span>${k}</span><span>${v}</span></div>`;

/** Strip the leading "Estimate #" that marks an estimator column, for display. */
const estLabel = (c) => c.replace(/^estimate\s*#\s*/i, '');

/* ---------- gutter ---------- */

/* Task-name gutter, aligned row for row with frappe's bars. frappe has no grid column and
 * pushes labels outside short bars, which at 38 rows collides with other bars. */
const GutterRow = ({ t, rowH, selected, critical, colors }) => {
  const mismatch = t.estimate != null && t.estimate !== t.duration;
  const missing = t.estimate == null;
  const cls = ['g-row', selected && 'sel', critical && 'crit', (mismatch || missing) && 'bad']
    .filter(Boolean).join(' ');
  const metric = missing ? `${t.duration}d / -`
    : mismatch ? `${t.duration}d / ${t.estimate}d`
    : `${t.duration}d`;
  const metricTitle = missing ? 'No estimate'
    : mismatch ? `Drawn ${t.duration} days, estimate ${t.estimate} days`
    : 'Duration matches estimate';
  const nameTitle = [
    t.name.trim(),
    critical && 'On the critical path: zero float, so a delay here delays the whole plan.',
    t.description,
  ].filter(Boolean).join('\n\n');
  return html`
    <div class=${cls} style=${{ height: rowH + 'px' }}
         onClick=${() => selectTask(t.id, true)}>
      <span class="dot" style=${{ background: colors.get(t.tags[0] || '') }}
            title=${t.tags.join(', ') || 'no tag'}></span>
      <span class="nm" title=${nameTitle}>
        ${t.name.trim()}
      </span>
      <span class="mt" title=${metricTitle}>${metric}</span>
    </div>`;
};

const Gutter = ({ doc, an, colors, rowH, headH }) => html`
  <div class="g-head" style=${{ height: headH + 'px' }}>Task (${doc.tasks.length})</div>
  ${doc.tasks.map((t) => html`
    <${GutterRow} key=${t.id} t=${t} rowH=${rowH} colors=${colors}
                  selected=${App.selected === t.id} critical=${an.float.get(t.id) === 0} />`)}
`;

/* ---------- validation ---------- */

const FINDING_TITLES = {
  'dep-violation': 'Dependency violations',
  'missing-estimate': 'Missing estimates',
  'unresolved-dep': 'Unrecognised dependencies',
  cycle: 'Dependency cycles',
  'estimate-mismatch': 'Duration does not match estimate',
  'week-overload': 'Weeks over capacity',
  'estimator-spread': 'Estimator disagreement',
  'estimator-empty': 'Notes',
};

const Finding = ({ f, task }) => html`
  <div class=${'finding ' + f.level}
       style=${task ? { cursor: 'pointer' } : null}
       onClick=${task ? ((e) => { if (e.target.tagName !== 'BUTTON') selectTask(task.id, true); }) : null}>
    <div class="h">${task ? task.name.trim() : 'Plan'}</div>
    <div class="m">${f.msg}</div>
    ${f.fix && html`
      <div class="acts">
        <button onClick=${(e) => { e.stopPropagation(); commit(() => applyFix(App.doc, App.cal, f)); }}>
          ${f.fix.label}
        </button>
      </div>`}
  </div>`;

const ValidationPanel = ({ doc, cal, an, findings }) => {
  const groups = {};
  for (const f of findings) (groups[f.code] = groups[f.code] || []).push(f);
  const startI = cal.nextIdx(doc.projectStart);
  const totalEst = doc.tasks.reduce((s, t) => s + (t.estimate || 0), 0);
  const onCritical = [...an.float.values()].filter((v) => v === 0).length;

  return html`
    <div>
      <${KV} k="Tasks" v=${doc.tasks.length} />
      <${KV} k="Project start" v=${fmtNice(cal.at(startI))} />
      <${KV} k="Project end" v=${fmtNice(cal.at(an.projEnd))} />
      <${KV} k="Span" v=${`${an.projEnd - startI + 1} working days`} />
      <${KV} k="Total estimate" v=${`${totalEst} days`} />
      <${KV} k="On critical path" v=${onCritical} />
    </div>
    ${!findings.length && html`<${Hint}>No findings. Plan is internally consistent.<//>`}
    ${Object.keys(FINDING_TITLES).filter((c) => groups[c] && groups[c].length).map((code) => {
      const list = groups[code];
      return html`
        <div key=${code}>
          <${GroupH}>${`${FINDING_TITLES[code]} (${list.length})`}<//>
          ${code === 'estimate-mismatch' && html`
            <button style=${{ marginBottom: '7px' }} onClick=${() => {
              const n = commit(() => applyDurationFixAll(App.doc, App.cal, list));
              toast(`${n} duration${n === 1 ? '' : 's'} set from estimates, plan reflowed ASAP`);
            }}>
              ${`Set duration = estimate for all ${list.length}`}
            </button>`}
          ${list.map((f, i) => html`
            <${Finding} key=${code + i} f=${f} task=${f.taskId ? an.byId.get(f.taskId) : null} />`)}
        </div>`;
    })}
  `;
};

/* ---------- load / capacity ---------- */

const LoadPanel = ({ doc, cal, rows }) => html`
  <table class="load">
    <thead><tr><th>Week of</th><th>Person-days</th><th>People</th></tr></thead>
    <tbody>
      ${rows.map(([wk, load]) => {
        const people = load / 5;
        return html`
          <tr key=${wk}>
            <td>${fmtNice(wk)}</td>
            <td>${load.toFixed(1)}</td>
            <td class=${people > doc.teamSize + 1e-9 ? 'over' : ''}>${people.toFixed(1)}</td>
          </tr>`;
      })}
    </tbody>
  </table>
  <${Hint}>
    ${`Capacity is reported, never scheduled against - tasks are never delayed to fit the team size. Team size is ${doc.teamSize}.`}
  <//>
  <${GroupH}>${doc.holidays.length ? `Holidays (${doc.holidays.length})` : 'Holidays'}<//>
  ${doc.holidays.length
    ? doc.holidays.slice().sort().map((h) => html`
        <div class="kv" key=${h}>
          <span>${fmtNice(h)}</span>
          <span style=${{ cursor: 'pointer', color: 'var(--danger-fg)' }}
                onClick=${() => commit(
                  () => { App.doc.holidays = App.doc.holidays.filter((x) => x !== h); },
                  { rebuildCal: true })}>remove</span>
        </div>`)
    : html`<${Hint}>None. Holidays are removed from the axis entirely.<//>`}
  <div class="row2" style=${{ marginTop: '8px' }}>
    <input type="date" id="hol-date" />
    <button id="hol-add" onClick=${() => {
      const el = document.getElementById('hol-date');
      const v = el && el.value;
      if (!v) return;
      if (!App.cal.inRange(v)) {
        toast(`A holiday must fall between ${App.cal.first} and ${App.cal.last}`);
        return;
      }
      commit(() => { if (!App.doc.holidays.includes(v)) App.doc.holidays.push(v); },
        { rebuildCal: true });
    }}>Add holiday</button>
  </div>
`;

/* ---------- plan properties ---------- */

/* Project start and team size are properties of the plan, not toolbar verbs, and they were
 * crowding a toolbar of actions. Team size in particular belongs here: the capacity table it
 * drives is one tab over, and the Load tab already narrates its value in prose. */
const PlanPanel = ({ doc, cal }) => {
  const startI = cal.nextIdx(doc.projectStart);
  const nudge = (wd) => commit(() => {
    App.doc.projectStart = App.cal.at(Math.max(0, App.cal.nextIdx(App.doc.projectStart) + wd));
    shiftAll(App.doc, App.cal, wd);
  });
  const onStart = (e) => {
    const v = e.target.value;
    if (!v) return;
    if (!App.cal.inRange(v)) {
      toast(`Project start must be between ${App.cal.first} and ${App.cal.last}`);
      renderAll();
      return;
    }
    const oldIdx = App.cal.nextIdx(App.doc.projectStart);
    const newIdx = App.cal.nextIdx(v);
    if (newIdx === oldIdx) return;   // don't spend an undo entry on a no-op
    commit(() => {
      App.doc.projectStart = App.cal.at(newIdx);
      shiftAll(App.doc, App.cal, newIdx - oldIdx);
    });
    toast(`Whole plan shifted ${newIdx - oldIdx > 0 ? '+' : ''}${newIdx - oldIdx} working days`);
  };
  /* htm does not decode HTML entities, so &laquo; would render literally. "-1w" / "+1w"
   * is plain ASCII and says what the button does, which the chevrons never did. */
  return html`
    <div class="plan-row">
      <label for="proj-start">Project start</label>
      <div class="ctl">
        <input type="date" id="proj-start" value=${cal.at(startI)} onChange=${onStart} />
        <button id="btn-shift-back" title="Shift the whole plan 1 week earlier"
                onClick=${() => nudge(-5)}>-1w</button>
        <button id="btn-shift-fwd" title="Shift the whole plan 1 week later"
                onClick=${() => nudge(5)}>+1w</button>
      </div>
    </div>
    <${Hint}>Moving this shifts every task by the same number of working days, keeping the shape of the plan.<//>
    <div class="plan-row">
      <label for="team-size">Team size</label>
      <div class="ctl">
        <input type="number" id="team-size" min="1" max="99" value=${doc.teamSize}
               onChange=${(e) => {
                 const n = Math.max(1, Number(e.target.value) || 1);
                 rememberTeamSize(n);
                 if (n === App.doc.teamSize) return;
                 commit(() => { App.doc.teamSize = n; });
               }} />
      </div>
    </div>
    <${Hint}>Used to flag weeks over capacity in the Load tab. Nothing is ever rescheduled to fit it.<//>
  `;
};

/* ---------- column mapping ---------- */

const ColumnsPanel = ({ doc, numCols, colors, overflow }) => {
  const extras = doc.extras.map((i) => doc.header[i]).filter((x) => x !== undefined);
  return html`
    <${GroupH}>Field mapping<//>
    ${FIELDS.map((f) => html`
      <div class=${'colmap' + (doc.mapping[f.key] < 0 ? ' unmapped' : '')} key=${f.key}>
        <label>${f.label}</label>
        <select value=${String(doc.mapping[f.key])}
                onChange=${(e) => remapColumn(f.key, Number(e.target.value))}>
          <option value="-1">(not in file)</option>
          ${doc.srcHeader.map((h, i) => html`
            <option key=${i} value=${String(i)}>${h || `column ${i + 1}`}</option>`)}
        </select>
      </div>`)}
    <${Hint}>Re-mapping re-reads the source file, so unsaved schedule edits are discarded. Undo restores them.<//>
    <${GroupH}>${`Passed through untouched (${extras.length})`}<//>
    <div class="passthru">${extras.length ? extras.join(', ') : 'None.'}</div>
    ${/* a ternary, not `length && ...`: Preact renders the number 0 as a literal "0" */
      numCols.length ? html`
        <div>
          <${GroupH}>Read as numeric (compared per task)<//>
          <div class="passthru">${numCols.join(', ')}</div>
        </div>` : null}
    <${GroupH}>Tag colours<//>
    <div class="legend">
      ${[...colors].map(([tag, col]) => html`
        <span key=${tag}><i style=${{ background: col }}></i>${tag || '(no tag)'}</span>`)}
    </div>
    ${overflow > 0 ? html`
      <${Hint}>
        ${`${overflow} tag${overflow === 1 ? '' : 's'} past the eighth share the neutral colour. ` +
          'Colours are never reused for two tags; the task name in the gutter is what ' +
          'identifies a row.'}
      <//>` : null}
  `;
};

/* ---------- task editor ---------- */

/** One dependency checkbox list. `disabled` marks candidates that would form a cycle. */
const Picker = ({ others, checked, disabled, onToggle }) => html`
  <div class="picker">
    ${others.map((o) => html`
      <label key=${o.id}>
        <input type="checkbox" checked=${checked.has(o.id)} disabled=${disabled(o.id)}
               onChange=${(e) => onToggle(o.id, e.target.checked)} />
        ${o.name.trim()}
      </label>`)}
  </div>`;

const EditorPanel = ({ doc, cal, t, view }) => {
  const g = { byId: view.an.byId, succ: view.an.succ };
  const s = startIdx(cal, t);
  const others = doc.tasks.filter((x) => x.id !== t.id);
  // cycle guards, each computed once rather than once per candidate row
  const blocked = descendants(doc, t.id, g);   // cannot be a predecessor of `t`
  const upstream = ancestors(doc, t.id, g);    // cannot be a successor of `t`
  const kids = new Set(g.succ.get(t.id) || []);

  /* Re-point one dependency edge, then make the plan legal again. reschedule() alone
   * cannot do it: in rigid mode a brand new edge can leave a task illegally early. */
  const setEdge = (task, depId, on, editedId) => commit(() => {
    task.deps = on ? [...new Set([...task.deps, depId])] : task.deps.filter((d) => d !== depId);
    reschedule(App.doc, App.cal, editedId, 0);
    if (App.doc.mode === 'rigid') pullIntoLegality(App.doc, App.cal);
  });

  const onStart = (e) => {
    const v = e.target.value;
    if (!v) return;
    if (!App.cal.inRange(v)) {
      toast(`Start must be between ${App.cal.first} and ${App.cal.last}`);
      renderAll();   // put the field back to the value the task actually has
      return;
    }
    commit(() => {
      const oldEnd = startIdx(App.cal, t) + t.duration - 1;
      t.start = App.cal.at(App.cal.nextIdx(v));
      t.pinned = true;
      reschedule(App.doc, App.cal, t.id, startIdx(App.cal, t) + t.duration - 1 - oldEnd);
    });
  };

  return html`
    <div class="field"><label>Name</label>
      <input type="text" value=${t.name.trim()}
             onChange=${(e) => commit(() => { t.name = e.target.value || t.name; })} /></div>
    <div class="field"><label>Description</label>
      <textarea value=${t.description || ''}
                onChange=${(e) => commit(() => { t.description = e.target.value; })} /></div>
    <div class="field"><label>Tag</label>
      <input type="text" placeholder="Fit-out, Admin" value=${t.tags.join(', ')}
             onChange=${(e) => commit(() => {
               t.tags = e.target.value.split(',').map((x) => x.trim()).filter(Boolean);
             })} /></div>
    <div class="row2">
      <div class="field"><label>Estimate (days)</label>
        <input type="number" min="0" step="1" value=${t.estimate == null ? '' : t.estimate}
               onChange=${(e) => commit(() => {
                 t.estimate = e.target.value === '' ? null : Number(e.target.value);
               })} /></div>
      <div class="field"><label>Duration (working days)</label>
        <input type="number" min="1" step="1" value=${t.duration}
               onChange=${(e) => commit(() => {
                 const old = t.duration;
                 t.duration = Math.max(1, Number(e.target.value) || 1);
                 reschedule(App.doc, App.cal, t.id, t.duration - old);
               })} /></div>
    </div>
    <div class="field">
      <button disabled=${t.estimate == null}
              onClick=${() => commit(() => FIXES['set-duration'](App.doc, App.cal, t))}>
        Set duration = estimate
      </button>
    </div>
    <div class="field est-cmp">
      ${view.numCols.map((c) => html`
        <span key=${c}>${estLabel(c)}: <b>${numOrNull(t.extra && t.extra[c]) ?? '-'}</b></span>`)}
    </div>
    <div class="field">
      <label>Start</label>
      <div class="row2">
        <input type="date" value=${cal.at(s)} onChange=${onStart} />
        <button disabled=${!t.pinned}
                onClick=${() => commit(() => {
                  t.pinned = false;
                  if (App.doc.mode === 'asap') asapAll(App.doc, App.cal);
                })}>${t.pinned ? 'Unpin' : 'Not pinned'}</button>
      </div>
      <div class="hint">${`${fmtNice(cal.at(s))} to ${fmtNice(cal.at(s + t.duration - 1))}`}</div>
    </div>
    <div class="field"><label>Blocked by (upstream)</label>
      <${Picker} others=${others} checked=${new Set(t.deps)}
                 disabled=${(oid) => blocked.has(oid)}
                 onToggle=${(oid, on) => setEdge(t, oid, on, oid)} /></div>
    <div class="field"><label>Blocks (downstream)</label>
      <${Picker} others=${others} checked=${kids}
                 disabled=${(oid) => upstream.has(oid)}
                 onToggle=${(oid, on) =>
                   setEdge(App.doc.tasks.find((x) => x.id === oid), t.id, on, t.id)} />
      <div class="hint">Ticking here makes this task upstream of the other one.</div></div>
    <div class="field">
      <button class="danger" onClick=${() => {
        const id = t.id;
        commit(() => {
          App.doc.tasks = App.doc.tasks.filter((x) => x.id !== id);
          for (const o of App.doc.tasks) o.deps = o.deps.filter((d) => d !== id);
          App.selected = null;
          if (App.doc.mode === 'asap') asapAll(App.doc, App.cal);
        });
        toast('Task deleted');
      }}>Delete task</button>
    </div>
  `;
};

/* ---------- mount points ---------- */

/* Preact owns the children of each of these hosts. Nothing else may write to them - an
 * innerHTML assignment from outside would desync Preact's virtual tree. Render null to
 * clear one instead. */
const mount = (id) => (vnode) => render(vnode, document.getElementById(id));

const paintGutter = mount('gutter');
const paintValidation = mount('tab-validate');
const paintLoad = mount('tab-load');
const paintColumns = mount('tab-columns');
const paintPlan = mount('tab-plan');
const paintEditor = mount('tab-editor');

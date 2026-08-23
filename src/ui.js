/* UI wiring: toolbar, tabs, drag-and-drop, keyboard, boot.
 *
 * Event wiring only. Anything that changes the plan should go through commit() in
 * store.js so that undo and persistence cannot be forgotten.
 */
'use strict';

let toastTimer = null;
function toast(msg) {
  const el = document.getElementById('toast');
  el.textContent = msg;
  el.classList.add('on');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('on'), 2200);
}

function showTab(name) {
  document.querySelectorAll('#side-tabs button').forEach((b) => b.classList.toggle('on', b.dataset.tab === name));
  ['validate', 'editor', 'load', 'columns'].forEach((n) => { document.getElementById('tab-' + n).hidden = n !== name; });
}

function wireUI() {
  document.querySelectorAll('#side-tabs button').forEach((b) => { b.onclick = () => showTab(b.dataset.tab); });

  document.getElementById('proj-start').onchange = (e) => {
    if (!e.target.value) return;
    if (!App.cal.inRange(e.target.value)) {
      toast(`Project start must be between ${App.cal.first} and ${App.cal.last}`);
      renderToolbar();   // put the field back to the value the plan actually has
      return;
    }
    const oldIdx = App.cal.nextIdx(App.doc.projectStart);
    const newIdx = App.cal.nextIdx(e.target.value);
    if (newIdx === oldIdx) return;   // don't spend an undo entry on a no-op
    commit(() => {
      App.doc.projectStart = App.cal.at(newIdx);
      shiftAll(App.doc, App.cal, newIdx - oldIdx);
    });
    toast(`Whole plan shifted ${newIdx - oldIdx > 0 ? '+' : ''}${newIdx - oldIdx} working days`);
  };
  const nudge = (wd) => commit(() => {
    const i = App.cal.nextIdx(App.doc.projectStart) + wd;
    App.doc.projectStart = App.cal.at(Math.max(0, i));
    shiftAll(App.doc, App.cal, wd);
  });
  document.getElementById('btn-shift-back').onclick = () => nudge(-5);
  document.getElementById('btn-shift-fwd').onclick = () => nudge(5);

  document.querySelectorAll('#seg-mode button').forEach((b) => {
    b.onclick = () => {
      if (App.doc.mode === b.dataset.mode) return;   // don't spend an undo entry on a no-op
      commit(() => { App.doc.mode = b.dataset.mode; });
      toast(b.dataset.mode === 'asap'
        ? 'ASAP: gaps collapse on every edit'
        : 'Rigid: downstream keeps its gaps');
    };
  });
  document.getElementById('btn-reflow').onclick = () => {
    commit(() => asapAll(App.doc, App.cal));
    toast('Reflowed ASAP');
  };
  document.querySelectorAll('#seg-zoom button').forEach((b) => {
    b.onclick = () => { App.zoom = b.dataset.zoom; renderAll(); };
  });
  document.getElementById('team-size').onchange = (e) => {
    const n = Math.max(1, Number(e.target.value) || 1);
    if (n === App.doc.teamSize) return;   // don't spend an undo entry on a no-op
    commit(() => { App.doc.teamSize = n; });
  };

  document.getElementById('btn-undo').onclick = undo;
  document.getElementById('btn-redo').onclick = redo;
  document.getElementById('btn-add').onclick = () => {
    commit(() => {
      let id = 'new-task';
      let n = 1;
      while (App.doc.tasks.some((t) => t.id === id)) { n++; id = 'new-task-' + n; }
      const extra = {};
      for (const i of App.doc.extras) extra[App.doc.header[i]] = '';
      App.doc.tasks.push({
        id,
        name: 'New task' + (n > 1 ? ' ' + n : ''),
        description: '',
        tags: [],
        estimate: 5,
        duration: 5,
        start: App.cal.at(App.cal.nextIdx(App.doc.projectStart)),
        deps: [],
        unresolved: [],
        extra,
        // pinned so an ASAP pass treats where you placed it as a floor rather than
        // snapping a dependency-free new task back to the project start
        pinned: true,
      });
      App.selected = id;
    });
    // renderAll() inside commit() already opened the editor for App.selected
    showTab('editor');
  };

  document.getElementById('btn-open').onclick = () => document.getElementById('file-input').click();
  document.getElementById('file-input').onchange = (e) => {
    const f = e.target.files && e.target.files[0];
    if (f) readFile(f);
    e.target.value = '';
  };
  document.getElementById('btn-download').onclick = () => {
    const text = docToCSV(App.doc, App.cal);
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([text], { type: 'text/csv' }));
    a.download = App.fileName.replace(/\.(csv|md|markdown|txt)$/i, '') + '.csv';
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 2000);
    toast('Downloaded ' + a.download);
  };
  document.getElementById('btn-copy').onclick = async () => {
    const text = docToMiro(App.doc, App.cal);
    try {
      await navigator.clipboard.writeText(text);
      toast('Markdown table copied - paste into Miro');
    } catch (err) {
      const ta = document.createElement('textarea');
      ta.value = text;
      document.body.appendChild(ta);
      ta.select();
      document.execCommand('copy');
      ta.remove();
      toast('Copied (fallback)');
    }
  };
  document.getElementById('btn-reset').onclick = () => {
    localStorage.removeItem(LS_KEY);
    loadDoc(document.getElementById('sample-csv').textContent, 'plan.csv');
    toast('Reset to the bundled example');
  };

  // drag and drop
  const drop = document.getElementById('drop');
  let depth = 0;
  window.addEventListener('dragenter', (e) => { e.preventDefault(); depth++; drop.classList.add('on'); });
  window.addEventListener('dragover', (e) => e.preventDefault());
  window.addEventListener('dragleave', () => { if (--depth <= 0) { depth = 0; drop.classList.remove('on'); } });
  window.addEventListener('drop', (e) => {
    e.preventDefault();
    depth = 0;
    drop.classList.remove('on');
    const f = e.dataTransfer.files && e.dataTransfer.files[0];
    if (f) readFile(f);
  });

  // bubbles after frappe's own svg mouseup, so the pending values are already final
  window.addEventListener('mouseup', () => { if (App.pendingDrag) commitDrag(); });

  window.addEventListener('keydown', (e) => {
    const mod = e.metaKey || e.ctrlKey;
    if (mod && e.key.toLowerCase() === 'z') { e.preventDefault(); e.shiftKey ? redo() : undo(); }
  });
}

/** Run selftest() against the bundled fixtures and print it into #selftest. The keywords
 *  "PASS"/"FAIL" and the "N passed, N failed" summary are load-bearing: test/ greps them. */
function renderSelftest() {
  const esc = (s) => String(s).replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));
  const r = selftest({
    csv: document.getElementById('sample-csv').textContent,
    md: document.getElementById('sample-md').textContent,
  });
  const body = r.results.map((x) => x.kind === 'section'
    ? `<h2>${esc(x.name)}</h2>`
    : `<div class="${x.ok ? 'p' : 'f'}">${x.ok ? 'PASS' : 'FAIL'} ${esc(x.name)}` +
      (x.ok ? '' : `<br>     got  ${esc(JSON.stringify(x.got))}<br>     want ${esc(JSON.stringify(x.want))}`) +
      '</div>').join('');
  document.getElementById('selftest').innerHTML =
    '<div style="font-size:15px;margin-bottom:14px">' +
    `<b class="${r.fail ? 'f' : 'p'}">${r.fail ? 'FAILED' : 'ALL PASS'}</b> &nbsp; ` +
    `${r.pass} passed, ${r.fail} failed</div>` + body;
  document.body.classList.add('selftest');
}

function readFile(f) {
  const r = new FileReader();
  r.onload = () => {
    try {
      loadDoc(String(r.result), f.name);
      toast(`Loaded ${App.doc.tasks.length} tasks from ${f.name}`);
    } catch (err) {
      toast('Could not parse: ' + err.message);
    }
  };
  r.readAsText(f);
}

/* ============================================================ boot */

window.addEventListener('DOMContentLoaded', () => {
  if (location.hash === '#selftest') { renderSelftest(); return; }
  wireUI();
  const saved = restore();
  if (saved && saved.doc && saved.doc.tasks) {
    App.doc = saved.doc;
    App.fileName = saved.fileName || 'plan.csv';
    rebuildCal();
    renderAll();
    toast('Restored your local edits - "Reset" goes back to the file');
  } else {
    loadDoc(document.getElementById('sample-csv').textContent, 'plan.csv');
  }
});

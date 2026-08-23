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

/* The async clipboard API needs a permission a file:// origin often does not have, so fall
 * back to the old selection trick. Returns whether anything landed on the clipboard. */
async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch (err) {
    try {
      const ta = document.createElement('textarea');
      ta.value = text;
      document.body.appendChild(ta);
      ta.select();
      const ok = document.execCommand('copy');
      ta.remove();
      return ok;
    } catch (e2) {
      return false;
    }
  }
}

/** Load a plan carried in the URL fragment. Returns whether one was found. */
async function loadFromHash() {
  const payload = sharePayloadFromHash(location.hash);
  if (!payload) return false;
  try {
    const doc = await decodeShare(payload);
    for (const t of doc.tasks) {
      if (!App.cal || !makeCalendar([]).inRange(t.start)) {
        throw new Error(`"${t.name}" starts outside the supported date range.`);
      }
    }
    adoptDoc(doc, 'shared-plan.csv');
    toast(`Loaded ${doc.tasks.length} tasks from the link`);
    return true;
  } catch (err) {
    toast('Could not read the shared link: ' + err.message);
    return false;
  }
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
  /* Not routed through commit(): the theme is not part of the plan, so it must not enter
   * the undo stack. Nothing needs re-rendering either - the bars and dots are painted
   * with var(--series-N), so the browser repaints them when the tokens change. */
  document.querySelectorAll('#seg-theme button').forEach((b) => {
    b.onclick = () => { applyTheme(b.dataset.theme); renderToolbar(); };
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
    a.download = App.fileName.replace(/\.(csv|tsv|txt)$/i, '') + '.csv';
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 2000);
    toast('Downloaded ' + a.download);
  };
  /* Tab separated, not comma: Excel and Sheets only split pasted text on tabs, so pasting
   * CSV would drop every row into a single cell. The downloaded file stays real CSV. */
  document.getElementById('btn-copy').onclick = async () => {
    const rows = App.doc.tasks.length;
    const ok = await copyText(docToTSV(App.doc, App.cal));
    toast(ok ? `${rows} row${rows === 1 ? '' : 's'} copied - paste into Excel`
      : 'Could not write to the clipboard');
  };
  // driver.js handles its own overlay, keyboard and dismissal; we only own "seen" state
  document.getElementById('btn-help').onclick = () => { startTour(); renderToolbar(); };

  /* The plan travels INSIDE the link, in the fragment. That is what makes it work offline
   * and keeps it off any server, and it is also why the toast says so plainly: a link is
   * easier to forward carelessly than a file, and the payload is the plan itself. */
  document.getElementById('btn-share').onclick = async () => {
    if (!shareSupported()) {
      toast('This browser cannot build share links (no CompressionStream)');
      return;
    }
    let payload;
    try {
      payload = await encodeShare(App.doc);
    } catch (err) {
      toast('Could not build a link: ' + err.message);
      return;
    }
    if (shareTooLong(payload)) {
      toast(`Plan is too big to share as a link (${payload.length} chars) - send the CSV`);
      return;
    }
    const base = location.href.split('#')[0];
    const url = `${base}#${SHARE_KEY}=${payload}`;
    const ok = await copyText(url);
    const n = App.doc.tasks.length;
    if (!ok) { toast('Could not write to the clipboard'); return; }
    toast(location.protocol === 'file:'
      ? `Link copied, but it points at a local file - host the page for it to be shareable`
      : `Link copied - it carries all ${n} tasks, so treat it like the CSV`);
  };

  document.getElementById('btn-reset').onclick = () => {
    localStorage.removeItem(LS_KEY);
    loadDoc(document.getElementById('sample-csv').textContent, EXAMPLE_NAME, true);
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

  /* Pasting a share link while already on the page changes only the fragment, which is a
   * same-document navigation: the browser fires hashchange and never reloads, so the boot
   * handler does not run again. Without this, opening a link from the page you are already
   * on silently does nothing. */
  window.addEventListener('hashchange', () => {
    if (location.hash === '#selftest') { location.reload(); return; }
    if (sharePayloadFromHash(location.hash)) loadFromHash();
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
  const r = selftest({ csv: document.getElementById('sample-csv').textContent });
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

window.addEventListener('DOMContentLoaded', async () => {
  if (location.hash === '#selftest') { renderSelftest(); return; }
  wireUI();
  restoreTheme();   // index.html already stamped the attribute; this syncs App.theme
  restoreTour();

  /* A shared link wins over restored local edits: somebody who clicks a link means to see
   * what is in it, and being handed their own unrelated plan instead would be baffling.
   * Their edits are not lost - adoptDoc persists the link's plan, so Reset still returns to
   * the bundled example, but the previous session is gone. Decoding is async, so the page
   * paints the fallback first and the link replaces it a moment later. */
  const saved = restore();
  if (saved && saved.doc && saved.doc.tasks) {
    App.doc = saved.doc;
    App.fileName = saved.fileName || 'plan.csv';
    rebuildCal();
    renderAll();
  } else {
    loadDoc(document.getElementById('sample-csv').textContent, EXAMPLE_NAME, true);
  }
  /* Only mention restored edits when no link was involved. A link that failed has already
   * said why, and overwriting that with "Restored your local edits" hides the reason. */
  const hadLink = !!sharePayloadFromHash(location.hash);
  const fromLink = await loadFromHash();
  if (!hadLink && saved && saved.doc && saved.doc.tasks) {
    toast('Restored your local edits - "Reset" goes back to the file');
  }
  /* The tour is opt-in - nothing opens by itself. renderToolbar() has already made the
   * button say "Take the tour" and pulse if this is a first visit. */
  renderToolbar();
});

/* Applying a validation fix. Pure.
 *
 * validate.js owns the *catalogue* - each finding carries a `fix.kind` and a label. This
 * file owns the *effects*. Keeping them apart in two pure files means the panel that draws
 * the button does not also decide what the button does, which is how four slightly
 * different copies of "set duration from estimate" grew in the first place.
 */
'use strict';

const FIXES = {
  /* Propagates by how much the END moved, so rigid mode pushes downstream correctly. One
   * of the old copies passed a delta of 0 here, which silently left downstream behind. */
  'set-duration': (doc, cal, t) => {
    if (!t || t.estimate == null) return;
    const old = t.duration;
    t.duration = Math.max(1, t.estimate);
    reschedule(doc, cal, t.id, t.duration - old);
  },
  'set-estimate': (doc, cal, t) => {
    if (t) t.estimate = t.duration;
  },
  reflow: (doc, cal) => asapAll(doc, cal),
};

/** Apply the fix a finding offers. Returns false when the finding has no fix. */
function applyFix(doc, cal, finding) {
  const kind = finding && finding.fix && finding.fix.kind;
  const fn = FIXES[kind];
  if (!fn) return false;
  const t = finding.taskId ? doc.tasks.find((x) => x.id === finding.taskId) : null;
  fn(doc, cal, t);
  return true;
}

/** Bulk "set duration = estimate" across many findings, then one ASAP pass. Reflowing
 *  once at the end is both cheaper and less surprising than rescheduling per task. */
function applyDurationFixAll(doc, cal, findings) {
  let n = 0;
  for (const f of findings) {
    const t = f.taskId ? doc.tasks.find((x) => x.id === f.taskId) : null;
    if (t && t.estimate != null) { t.duration = Math.max(1, t.estimate); n++; }
  }
  asapAll(doc, cal);
  return n;
}

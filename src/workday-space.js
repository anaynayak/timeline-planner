/* The workday-space transform. Pure.
 *
 * frappe-gantt's `ignore` option does NOT compress the axis; it hatches non-working
 * columns and keeps a calendar axis, so a 10-working-day bar would still be 12 columns
 * wide. To get "1 column == 1 working day" (bar width == duration) the chart is drawn in
 * *workday space*: every real working day maps to a contiguous synthetic date, frappe
 * draws that, and the axis labels are translated back to real dates in render.js.
 *
 * This lives in its own pure file because it is plain arithmetic that the logic suite
 * asserts on - it needs no DOM and no frappe.
 */
'use strict';

const SYNTH0 = new Date(2000, 0, 3);   // a Monday; workday index 0 renders here

const synthYmd = (i) => ymd(addDays(SYNTH0, i));
const synthIdx = (d) => daysBetween(SYNTH0, d instanceof Date ? d : parseYMD(d));

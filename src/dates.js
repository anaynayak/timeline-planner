/* Date utilities. Pure.
 *
 * Local-midnight `Date` helpers and `YYYY-MM-DD` strings. Nothing here knows about
 * working days - that is calendar.js.
 */
'use strict';

const MS_DAY = 86400000;
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

const pad2 = (n) => (n < 10 ? '0' + n : '' + n);
const ymd = (d) => d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate());
const parseYMD = (s) => {
  const p = String(s).slice(0, 10).split('-').map(Number);
  return new Date(p[0], (p[1] || 1) - 1, p[2] || 1);
};
const addDays = (d, n) => new Date(d.getFullYear(), d.getMonth(), d.getDate() + n);
const daysBetween = (a, b) =>
  Math.round((new Date(b.getFullYear(), b.getMonth(), b.getDate()) -
              new Date(a.getFullYear(), a.getMonth(), a.getDate())) / MS_DAY);
const mondayOf = (d) => addDays(d, -((d.getDay() + 6) % 7));
const sundayOf = (d) => addDays(mondayOf(d), 6);
const fmtNice = (s) => { const d = parseYMD(s); return d.getDate() + ' ' + MONTHS[d.getMonth()] + ' ' + d.getFullYear(); };

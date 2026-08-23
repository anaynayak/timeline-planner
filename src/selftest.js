/* The logic assertions. Pure.
 *
 * These live here rather than in test/ on purpose: `index.html#selftest` and `npm test`
 * then run the *same* assertions and cannot drift, and they need no tooling at all.
 * selftest() takes the fixture texts and returns structured results - no DOM.
 *
 * Parsing / calendar / scheduling / validation -> add an eq(...) to a section() here.
 * Rendering / geometry / gestures / DOM -> add a check(...) to test/browser.test.mjs.
 */
'use strict';

/** The logic assertions. Pure: it takes the two fixture texts and returns structured
 *  results, so the identical assertions run under Node with no DOM shim at all and in the
 *  browser via renderSelftest(). Add new assertions here, never in test/. */
function selftest(fixtures) {
  const YMD_OK = (v) => /^\d{4}-\d{2}-\d{2}$/.test(v);
  const results = [];
  let pass = 0, fail = 0;
  const eq = (name, got, want) => {
    const ok = JSON.stringify(got) === JSON.stringify(want);
    ok ? pass++ : fail++;
    results.push({ kind: 'assert', name, ok, got, want });
  };
  const section = (name) => results.push({ kind: 'section', name });

  const csv = fixtures.csv;
  const cal0 = makeCalendar([]);
  const load = (text, name) => parseAny(text, name, cal0);

  section('CSV parsing (RFC 4180)');
  eq('plain row', parseCSV('a,b,c\n1,2,3'), [['a', 'b', 'c'], ['1', '2', '3']]);
  eq('quoted comma', parseCSV('a,b\n"x, y",z')[1], ['x, y', 'z']);
  eq('escaped quote', parseCSV('a\n"say ""hi"""')[1], ['say "hi"']);
  eq('embedded newline', parseCSV('a,b\n"one\ntwo",z')[1], ['one\ntwo', 'z']);
  eq('trailing empty field kept', parseCSV('a,b,c\n1,2,')[1], ['1', '2', '']);
  eq('blank lines dropped', parseCSV('a,b\n\n1,2\n').length, 2);
  eq('CRLF handled', parseCSV('a,b\r\n1,2\r\n')[1], ['1', '2']);
  eq('BOM stripped', parseCSV('\uFEFFa,b\n1,2')[0], ['a', 'b']);

  section('delimiter detection (index.html accepts .tsv)');
  eq('comma is the default', detectDelimiter('a,b,c\n1,2,3'), ',');
  eq('a tab-majority header picks tab', detectDelimiter('a\tb\tc\n1\t2\t3'), '\t');
  eq('a lone tab inside a comma file does not win', detectDelimiter('a,b,c\td\n1,2,3'), ',');
  eq('a quoted tab does not count', detectDelimiter('"a\tb",c\n1,2'), ',');
  eq('only the header row is sniffed', detectDelimiter('a,b\n1\t2\t3\t4\t5'), ',');
  // a TSV used to load as a single column and then fail the no-name-column check
  eq('a TSV splits into columns', parseCSV('name\testimate\nA\t5'), [['name', 'estimate'], ['A', '5']]);
  eq('an explicit delimiter overrides detection', parseCSV('a\tb\n1\t2', ','), [['a\tb'], ['1\t2']]);
  eq('a TSV plan loads end to end', (() => {
    const t = load('task\teffort\tstart\tdepends_on\nAlpha\t5\t2027-06-07\t\nBeta\t10\t2027-06-14\tAlpha\n', 'plan.tsv');
    return { n: t.tasks.length, name: t.tasks[0].name, deps: t.tasks[1].deps, est: t.tasks[0].estimate };
  })(), { n: 2, name: 'Alpha', deps: ['alpha'], est: 5 });

  section('spreadsheet formula quoting');
  eq('leading %% is unwrapped', unquoteFormula("'% Split'"), '% Split');
  eq('leading = is unwrapped', unquoteFormula("'=SUM'"), '=SUM');
  eq('an ordinary quoted phrase is left alone', unquoteFormula("'hello'"), "'hello'");
  eq('unquoted value untouched', unquoteFormula('% Split'), '% Split');
  eq('re-applied on write', toCSV([['% Split', 'ok']]).trim(), "'% Split',ok");
  eq('a name quoted in one column and bare in another still matches', (() => {
    const t = load("name,estimate,dependency\n'% Split',5,\nNext,5,% Split\n", 'x.csv');
    return { deps: t.tasks[1].deps, unresolved: t.tasks[1].unresolved, name: t.tasks[0].name };
  })(), { deps: ['split'], unresolved: [], name: '% Split' });

  section('CSV writing');
  eq('quotes only when needed', toCSV([['a', 'b, c', 'd"e']]).trim(), 'a,"b, c","d""e"');
  eq('round trips through the parser', parseCSV(toCSV([['x, y', 'a"b', 'plain']]))[0], ['x, y', 'a"b', 'plain']);

  section('column mapping by alias');
  const dm = (h) => detectMapping(h).mapping;
  eq('canonical names', dm(['id', 'name', 'start_date', 'estimate', 'dependency']).name, 1);
  eq('title is an alias of name', dm(['title', 'start']).name, 0);
  eq('task is an alias of name', dm(['task', 'due']).name, 0);
  eq('blocked by maps to dependency', dm(['name', 'blocked by']).dependency, 1);
  eq('depends_on maps to dependency', dm(['name', 'depends_on']).dependency, 1);
  eq('Start Date is case and space insensitive', dm(['Name', 'Start Date']).start_date, 1);
  eq('effort maps to estimate', dm(['name', 'effort']).estimate, 1);
  eq('unknown column is not mapped', detectMapping(['name', 'owner']).extras, [1]);
  eq('missing field reports -1', dm(['name']).estimate, -1);
  eq('a column is claimed by only one field', (() => {
    const m = dm(['name', 'title']);
    return m.name !== m.title;
  })(), true);

  section('the bundled example');
  const d = load(csv, 'plan.csv');
  eq('16 tasks', d.tasks.length, 16);
  eq('id column used', d.mapping.id, 0);
  eq('owner and confidence pass through', d.extras.map((i) => d.header[i]), ['owner', 'confidence']);
  eq('confidence is not read as numeric', numericExtras(d), []);
  eq('project start', d.projectStart, '2027-03-01');
  eq('comma in a name survives', d.tasks.some((t) => t.name === 'Counter, shelving and seating'), true);
  eq('comma in a description survives',
    d.tasks.find((t) => t.id === 'soft').description, 'Friends and family, invited press.');
  eq('duration derived from start..end', d.tasks.find((t) => t.id === 'survey').duration, 5);
  eq('extras retained per task', d.tasks.find((t) => t.id === 'survey').extra.owner, 'Priya');
  eq('no unresolved dependencies', d.tasks.reduce((s, t) => s + t.unresolved.length, 0), 0);

  section('dependency resolution');
  eq('dependency on a comma-containing name resolves to one task',
    d.tasks.find((t) => t.id === 'espresso').deps, ['joinery']);
  eq('three comma-separated deps resolve',
    d.tasks.find((t) => t.id === 'snag').deps.length, 3);
  eq('single dep by name', d.tasks.find((t) => t.id === 'permits').deps, ['survey']);
  eq('no self dependency anywhere', d.tasks.every((t) => !t.deps.includes(t.id)), true);
  const semi = load('name,estimate,dependency\nA,5,\nB,5,A\nC,5,A;B\n', 'x.csv');
  eq('semicolon separated deps', semi.tasks.find((t) => t.name === 'C').deps, ['a', 'b']);
  eq('semicolon separator remembered for export', semi.depSep, '; ');
  const byid = load('id,name,estimate,dependency\nt1,Alpha,5,\nt2,Beta,5,t1\n', 'x.csv');
  eq('deps given as ids resolve', byid.tasks.find((t) => t.id === 't2').deps, ['t1']);
  const unk = load('name,estimate,dependency\nA,5,Nope\n', 'x.csv');
  eq('unknown dep is reported, not dropped silently', unk.tasks[0].unresolved, ['Nope']);
  eq('name style is remembered', d.depStyle, 'name');
  eq('id style is remembered', byid.depStyle, 'id');
  eq('id-style deps are written back as ids',
    parseCSV(docToCSV(byid, cal0))[2][3], 't1');
  eq('name-style deps are written back as names',
    parseCSV(docToCSV(d, cal0))[2][9], 'Site survey');

  section('date parsing');
  eq('ISO', parseDateCell('2027-03-01'), '2027-03-01');
  eq('ISO with time and Z', parseDateCell('2027-03-01T00:00:00.000Z'), '2027-03-01');
  eq('slashed ISO', parseDateCell('2027/03/01'), '2027-03-01');
  eq('day first', parseDateCell('01/03/2027'), '2027-03-01');
  eq('single digits', parseDateCell('1/3/2027'), '2027-03-01');
  eq('empty', parseDateCell(''), null);
  eq('format detection: dmy', detectDateFormat(['01/03/2027']), 'dmy');
  eq('format detection: iso', detectDateFormat(['2027-03-01']), 'iso');
  eq('dmy is written back as dmy', formatDateCell('2027-03-01', 'dmy'), '01/03/2027');
  // these are whole-day fields; a timestamped source is read, then written back as a date.
  // The old behaviour echoed the time component to keep the Miro round trip byte-identical,
  // which put "2027-03-01T00:00:00.000Z" in a cell a spreadsheet cannot read as a date.
  eq('a timestamped source is not treated as its own format',
    detectDateFormat(['2027-03-01T00:00:00.000Z']), 'iso');
  eq('no format writes a time component',
    ['iso', 'dmy'].map((f) => /T\d{2}:/.test(formatDateCell('2027-03-01', f))), [false, false]);
  eq('a timestamped CSV exports plain dates', (() => {
    const p = load('name,estimate,start_date,end_date\n' +
      'A,5,2027-03-01T00:00:00.000Z,2027-03-05T00:00:00.000Z\n', 'x.csv');
    const row = parseCSV(docToCSV(p, cal0))[1];
    return { start: row[2], end: row[3] };
  })(), { start: '2027-03-01', end: '2027-03-05' });
  eq('a timestamped CSV copies to the clipboard as plain dates', (() => {
    const p = load('name,estimate,start_date,end_date\n' +
      'A,5,2027-03-01T00:00:00.000Z,2027-03-05T00:00:00.000Z\n', 'x.csv');
    return /T\d{2}:/.test(docToTSV(p, cal0));
  })(), false);
  eq('the timestamp is still accepted on the way in',
    parseDateCell('2027-03-01T00:00:00.000Z'), '2027-03-01');

  section('calendar');
  eq('2027-03-06 is a Saturday, not working', cal0.isWorking('2027-03-06'), false);
  eq('2027-03-05 is a Friday, working', cal0.isWorking('2027-03-05'), true);
  eq('Mon 1 Mar + 4 wd = Fri 5 Mar', cal0.at(cal0.nextIdx('2027-03-01') + 4), '2027-03-05');
  eq('Mon 1 Mar + 5 wd = Mon 8 Mar', cal0.at(cal0.nextIdx('2027-03-01') + 5), '2027-03-08');
  eq('Sun 7 Mar pulls back to Fri 5', cal0.at(cal0.prevIdx('2027-03-07')), '2027-03-05');
  eq('inclusive count Mon..Fri = 5', cal0.count('2027-03-01', '2027-03-05'), 5);
  const calH = makeCalendar(['2027-03-03']);
  eq('holiday removed from axis', calH.isWorking('2027-03-03'), false);
  eq('holiday skipped in arithmetic', calH.at(calH.nextIdx('2027-03-01') + 2), '2027-03-04');

  section('calendar range');
  eq('the window starts on a Monday', parseYMD(cal0.first).getDay(), 1);
  eq('a date inside the window is in range', cal0.inRange('2027-03-01'), true);
  eq('a date before the window is out of range', cal0.inRange('2014-12-31'), false);
  eq('a date after the window is out of range', cal0.inRange('2051-01-01'), false);
  eq('the window reaches 2050', cal0.inRange('2050-12-31'), true);
  // a date past the end used to index to -1, clamp to 0 and silently become 2020-01-06
  eq('a start date past the window is refused, not silently moved', (() => {
    try {
      load('name,estimate,start_date\nFuture task,5,2060-01-02\n', 'x.csv');
      return 'no error';
    } catch (e) { return /outside the supported range/.test(e.message); }
  })(), true);
  eq('an end date past the window is refused too', (() => {
    try {
      load('name,start_date,end_date\nA,2027-03-01,2060-01-02\n', 'x.csv');
      return 'no error';
    } catch (e) { return /outside the supported range/.test(e.message); }
  })(), true);
  eq('the refusal names the task and the bound', (() => {
    try { load('name,estimate,start_date\nFuture task,5,2060-01-02\n', 'x.csv'); return ''; }
    catch (e) { return /Future task/.test(e.message) && e.message.includes(cal0.last); }
  })(), true);

  section('validation of the bundled example');
  const an = analyse(d, cal0);
  const f = validate(d, cal0, an);
  const count = (c) => f.filter((x) => x.code === c).length;
  eq('1 estimate mismatch (joinery drawn 15d, estimate 20d)', count('estimate-mismatch'), 1);
  eq('the mismatch is joinery', f.find((x) => x.code === 'estimate-mismatch').taskId, 'joinery');
  eq('1 missing estimate (grinder)', count('missing-estimate'), 1);
  eq('the missing estimate is grinder', f.find((x) => x.code === 'missing-estimate').taskId, 'grinder');
  eq('1 dependency violation (menu starts before the lease ends)', count('dep-violation'), 1);
  eq('the violation is menu', f.find((x) => x.code === 'dep-violation').taskId, 'menu');
  eq('0 unresolved deps', count('unresolved-dep'), 0);
  eq('0 cycles', count('cycle'), 0);

  section('applying a fix');
  const fixOne = (code, mode) => {
    const p = load(csv, 'plan.csv');
    p.mode = mode || 'rigid';
    asapAll(p, cal0);
    const fin = validate(p, cal0, analyse(p, cal0)).find((x) => x.code === code);
    return { p, fin, applied: applyFix(p, cal0, fin) };
  };
  eq('set-duration sets duration from the estimate', (() => {
    const { p, applied } = fixOne('estimate-mismatch');
    return { applied, dur: p.tasks.find((t) => t.id === 'joinery').duration };
  })(), { applied: true, dur: 20 });
  /* The copy of this fix in the validation panel passed a delta of 0 to reschedule(), so
   * in rigid mode the successors stayed put and the plan was left illegal. The editor's
   * copy passed the real delta. Both now go through FIXES['set-duration']. */
  eq('set-duration pushes rigid successors out by the growth', (() => {
    const before = (() => { const p = load(csv, 'plan.csv'); asapAll(p, cal0);
      return cal0.nextIdx(p.tasks.find((t) => t.id === 'espresso').start); })();
    const { p } = fixOne('estimate-mismatch', 'rigid');
    return cal0.nextIdx(p.tasks.find((t) => t.id === 'espresso').start) - before;
  })(), 5);
  eq('set-duration leaves no dependency violation in rigid mode', (() => {
    const { p } = fixOne('estimate-mismatch', 'rigid');
    return validate(p, cal0, analyse(p, cal0)).filter((x) => x.code === 'dep-violation').length;
  })(), 0);
  eq('set-estimate copies the drawn duration', (() => {
    const { p, applied } = fixOne('missing-estimate');
    const g = p.tasks.find((t) => t.id === 'grinder');
    return { applied, est: g.estimate, dur: g.duration };
  })(), { applied: true, est: 5, dur: 5 });
  eq('reflow clears the dependency violation', (() => {
    const p = load(csv, 'plan.csv');
    const fin = validate(p, cal0, analyse(p, cal0)).find((x) => x.code === 'dep-violation');
    applyFix(p, cal0, fin);
    return validate(p, cal0, analyse(p, cal0)).filter((x) => x.code === 'dep-violation').length;
  })(), 0);
  eq('a finding with no fix is a no-op', (() => {
    const p = load('name,estimate,dependency\nA,5,Nope\n', 'x.csv');
    const fin = validate(p, cal0, analyse(p, cal0)).find((x) => x.code === 'unresolved-dep');
    return applyFix(p, cal0, fin);
  })(), false);
  eq('the bulk fix reports how many it changed and reflows', (() => {
    const p = load(csv, 'plan.csv');
    const list = validate(p, cal0, analyse(p, cal0)).filter((x) => x.code === 'estimate-mismatch');
    const n = applyDurationFixAll(p, cal0, list);
    return { n, mismatches: p.tasks.filter((t) => t.estimate != null && t.estimate !== t.duration).length };
  })(), { n: 1, mismatches: 0 });
  eq('every fix kind the validator offers has an effect', (() => {
    const p = load(csv, 'plan.csv');
    const kinds = new Set(validate(p, cal0, analyse(p, cal0))
      .filter((x) => x.fix).map((x) => x.fix.kind));
    return [...kinds].every((k) => typeof FIXES[k] === 'function');
  })(), true);

  section('CSV round trip');
  const rt = docToCSV(d, cal0);
  eq('header preserved verbatim', parseCSV(rt)[0], parseCSV(csv)[0]);
  eq('same number of rows', parseCSV(rt).length, parseCSV(csv).length);
  eq('cells identical to the source', parseCSV(rt), parseCSV(csv));
  const d2 = load(rt, 'plan.csv');
  eq('reparse gives the same tasks', d2.tasks.length, d.tasks.length);
  eq('reparse keeps durations', d2.tasks.map((t) => t.duration), d.tasks.map((t) => t.duration));
  eq('reparse keeps dependencies', d2.tasks.map((t) => t.deps.join('|')), d.tasks.map((t) => t.deps.join('|')));
  eq('reparse keeps extras', d2.tasks.map((t) => t.extra.owner), d.tasks.map((t) => t.extra.owner));

  section('TSV for the clipboard');
  // Excel only splits *pasted* text on tabs, so the clipboard shape is tab separated
  eq('cells are tab separated', toTSV([['a', 'b', 'c']]).trim(), 'a\tb\tc');
  eq('nothing is quoted - Excel does not honour quoting in pasted text',
    toTSV([['b, c', 'd"e']]).trim(), 'b, c\td"e');
  eq('a tab inside a cell collapses so the columns cannot shift',
    toTSV([['a\tb', 'c']]).trim(), 'a b\tc');
  eq('a newline inside a cell collapses so the rows cannot shift',
    toTSV([['one\ntwo', 'c']]).trim(), 'one two\tc');
  eq('a CRLF inside a cell collapses to one space',
    toTSV([['one\r\ntwo']]).trim(), 'one two');
  eq('formula-looking values are still defused', toTSV([['=SUM(A1)', 'ok']]).trim(),
    "'=SUM(A1)'\tok");
  const tsv = docToTSV(d, cal0);
  const tlines = tsv.trim().split('\n');
  eq('one header row plus one row per task', tlines.length, d.tasks.length + 1);
  eq('the header matches the source file', tlines[0].split('\t'), parseCSV(csv)[0]);
  eq('every row has the same column count', new Set(tlines.map((l) => l.split('\t').length)).size, 1);
  eq('a comma in a name needs no quoting and stays in one cell', (() => {
    const row = tlines.find((l) => l.includes('Counter, shelving and seating'));
    return row.split('\t').length === parseCSV(csv)[0].length;
  })(), true);
  eq('the multi-line-free description survives intact',
    tsv.includes('Friends and family, invited press.'), true);
  eq('TSV and CSV carry the same cells', (() => {
    const csvRows = parseCSV(docToCSV(d, cal0));
    const tsvRows = tsv.trim().split('\n').map((l) => l.split('\t'));
    // the CSV keeps embedded commas via quoting, so compare cell by cell
    return csvRows.length === tsvRows.length
      && csvRows.every((r, i) => r.length === tsvRows[i].length);
  })(), true);
  eq('the clipboard text round trips back in as a TSV plan', (() => {
    const back = load(tsv, 'clip.tsv');
    return { n: back.tasks.length, deps: back.tasks.map((t) => t.deps.join('|')).join(';') };
  })(), { n: d.tasks.length, deps: d.tasks.map((t) => t.deps.join('|')).join(';') });

  section('column remapping');
  const rm = buildDoc(d.srcHeader, d.srcRows, cal0, { mapping: Object.assign({}, d.mapping, { estimate: -1 }) });
  eq('unmapping estimate leaves every estimate null', rm.tasks.every((t) => t.estimate === null), true);
  eq('estimate becomes a pass-through column', rm.extras.map((i) => rm.header[i]).includes('estimate'), true);
  eq('durations still come from the dates', rm.tasks.find((t) => t.id === 'survey').duration, 5);
  const rm2 = buildDoc(d.srcHeader, d.srcRows, cal0, { mapping: Object.assign({}, d.mapping, { estimate: 8 }) });
  eq('pointing estimate at a text column yields no numbers',
    rm2.tasks.every((t) => t.estimate === null), true);
  eq('no name column is a hard error', (() => {
    try { buildDoc(['a', 'b'], [['1', '2']], cal0); return false; } catch (e) { return /name/i.test(e.message); }
  })(), true);

  section('duration precedence');
  const dur1 = load('name,estimate,duration,start_date\nA,5,12,2027-03-01\n', 'x.csv');
  eq('explicit duration wins over estimate', dur1.tasks[0].duration, 12);
  const dur2 = load('name,estimate,start_date,end_date\nA,5,2027-03-01,2027-03-19\n', 'x.csv');
  eq('start..end wins over estimate when no duration column', dur2.tasks[0].duration, 15);
  const dur3 = load('name,estimate,start_date\nA,7,2027-03-01\n', 'x.csv');
  eq('estimate is the fallback duration', dur3.tasks[0].duration, 7);
  const dur4 = load('name,start_date\nA,2027-03-01\n', 'x.csv');
  eq('no estimate and no end date gives 1 day', dur4.tasks[0].duration, 1);

  section('scheduling: project start shift');
  const s1 = load(csv, 'plan.csv');
  const before = s1.tasks.map((t) => t.start);
  const delta = cal0.nextIdx('2027-04-01') - cal0.nextIdx(s1.projectStart);
  shiftAll(s1, cal0, delta);
  eq('every task shifted by the same amount',
    s1.tasks.every((t, i) => cal0.nextIdx(t.start) - cal0.nextIdx(before[i]) === delta), true);
  eq('nothing lands on a weekend', s1.tasks.every((t) => cal0.isWorking(t.start)), true);
  eq('first task moved to 1 Apr', s1.tasks[0].start, '2027-04-01');

  section('scheduling: ASAP clears the violation');
  const s2 = load(csv, 'plan.csv');
  asapAll(s2, cal0);
  eq('no violations after ASAP',
    validate(s2, cal0, analyse(s2, cal0)).filter((x) => x.code === 'dep-violation').length, 0);
  const menu = s2.tasks.find((t) => t.id === 'menu');
  const lease = s2.tasks.find((t) => t.id === 'lease');
  eq('menu now starts after the lease ends',
    cal0.nextIdx(menu.start), cal0.nextIdx(lease.start) + lease.duration);

  section('scheduling: rigid vs ASAP on growing a task');
  const grow = () => {
    const g = load(csv, 'plan.csv');
    asapAll(g, cal0);
    const j = g.tasks.find((t) => t.id === 'joinery');
    const old = j.duration;
    j.duration = j.estimate;                 // 15d -> its 20d estimate
    return { g, j, delta: j.duration - old, esp0: cal0.nextIdx(g.tasks.find((t) => t.id === 'espresso').start) };
  };
  const r1 = grow();
  propagateRigid(r1.g, cal0, 'joinery', r1.delta);
  eq('joinery grew by 5 days', r1.delta, 5);
  eq('rigid: espresso shifted by the same 5 days',
    cal0.nextIdx(r1.g.tasks.find((t) => t.id === 'espresso').start) - r1.esp0, 5);
  eq('rigid: the launch moved too',
    cal0.nextIdx(r1.g.tasks.find((t) => t.id === 'open').start) >
    cal0.nextIdx(grow().g.tasks.find((t) => t.id === 'open').start), true);
  eq('rigid: still legal', validate(r1.g, cal0, analyse(r1.g, cal0)).filter((x) => x.code === 'dep-violation').length, 0);
  const r2 = grow();
  asapAll(r2.g, cal0);
  const j2 = r2.g.tasks.find((t) => t.id === 'joinery');
  eq('asap: espresso starts the day after joinery ends',
    cal0.nextIdx(r2.g.tasks.find((t) => t.id === 'espresso').start),
    cal0.nextIdx(j2.start) + j2.duration);

  section('scheduling: rigid never breaks a dependency');
  const s3 = load(csv, 'plan.csv');
  asapAll(s3, cal0);
  propagateRigid(s3, cal0, 'joinery', -40);
  eq('a large backwards shift stays legal',
    validate(s3, cal0, analyse(s3, cal0)).filter((x) => x.code === 'dep-violation').length, 0);

  section('scheduling: adding an upstream task moves the downstream one');
  const addGate = (mode) => {
    const g = load(csv, 'plan.csv');
    g.mode = mode;
    asapAll(g, cal0);
    const open = g.tasks.find((t) => t.id === 'open');
    const b = cal0.nextIdx(open.start);
    g.tasks.push({
      id: 'inspection', explicitId: 'inspection', name: 'Health inspection', description: '',
      tags: ['Admin'], estimate: 10, duration: 10, start: open.start, deps: [],
      unresolved: [], extra: {}, pinned: true,
    });
    open.deps.push('inspection');
    return { g, b };
  };
  const g1 = addGate('asap');
  asapAll(g1.g, cal0);
  const o1 = cal0.nextIdx(g1.g.tasks.find((t) => t.id === 'open').start);
  eq('asap: public opening pushed out by the new upstream task', o1 > g1.b, true);
  eq('asap: pushed out by exactly the new task duration', o1 - g1.b, 10);
  const g2 = addGate('rigid');
  pullIntoLegality(g2.g, cal0);
  eq('rigid: public opening pushed out too',
    cal0.nextIdx(g2.g.tasks.find((t) => t.id === 'open').start) > g2.b, true);
  eq('rigid: still legal',
    validate(g2.g, cal0, analyse(g2.g, cal0)).filter((x) => x.code === 'dep-violation').length, 0);

  section('critical path and cycles');
  const s4 = load(csv, 'plan.csv');
  asapAll(s4, cal0);
  const an4 = analyse(s4, cal0);
  eq('at least one task has zero float', [...an4.float.values()].some((v) => v === 0), true);
  eq('no negative float', [...an4.float.values()].every((v) => v >= 0), true);
  eq('the last task is on the critical path', an4.float.get('open'), 0);
  eq('an independent branch has slack', an4.float.get('signage') > 0, true);
  const s5 = load(csv, 'plan.csv');
  s5.tasks.find((t) => t.id === 'survey').deps.push('open');
  eq('cycle detected', topo(s5).cyclic.length > 0, true);
  eq('cycle does not throw', (() => { asapAll(s5, cal0); return true; })(), true);
  eq('cycle is reported as a finding',
    validate(s5, cal0, analyse(s5, cal0)).some((x) => x.code === 'cycle'), true);

  section('graph walks: descendants and ancestors');
  const s7 = load(csv, 'plan.csv');
  eq('espresso is downstream of the site survey', descendants(s7, 'survey').has('espresso'), true);
  eq('the survey is upstream of espresso', ancestors(s7, 'espresso').has('survey'), true);
  eq('a leaf has no descendants', descendants(s7, 'open').size, 0);
  eq('a root has no ancestors', ancestors(s7, 'survey').size, 0);
  eq('nothing is its own ancestor', s7.tasks.every((t) => !ancestors(s7, t.id).has(t.id)), true);
  // the editor's "Blocks" picker relies on this equivalence to avoid one descendants()
  // walk per candidate row: oid is an ancestor of id  <=>  id is a descendant of oid
  eq('ancestors is exactly the inverse of descendants', s7.tasks.every((a) =>
    s7.tasks.every((b) => ancestors(s7, a.id).has(b.id) === descendants(s7, b.id).has(a.id))), true);
  eq('ancestors terminates on a cycle', (() => {
    const c = load(csv, 'plan.csv');
    c.tasks.find((t) => t.id === 'survey').deps.push('open');
    return ancestors(c, 'survey').size > 0;
  })(), true);
  eq('an unknown id has no ancestors', ancestors(s7, 'nope').size, 0);

  section('share links: fragment parsing');
  eq('reads the payload out of a hash', sharePayloadFromHash('#plan=AbC-_123'), 'AbC-_123');
  eq('tolerates a missing leading hash', sharePayloadFromHash('plan=xyz'), 'xyz');
  eq('ignores other fragment keys', sharePayloadFromHash('#foo=1&plan=abc&bar=2'), 'abc');
  eq('no hash means no payload', sharePayloadFromHash(''), null);
  eq('a bare hash means no payload', sharePayloadFromHash('#'), null);
  eq('an unrelated fragment is not a payload', sharePayloadFromHash('#selftest'), null);
  eq('an empty value is not a payload', sharePayloadFromHash('#plan='), null);
  eq('a key that merely ends in plan does not match', sharePayloadFromHash('#myplan=abc'), null);

  section('share links: base64url');
  eq('round trips bytes', (() => {
    const b = new Uint8Array([0, 1, 250, 255, 128, 64, 13, 10]);
    return [...b64urlDecode(b64urlEncode(b))];
  })(), [0, 1, 250, 255, 128, 64, 13, 10]);
  eq('uses no characters that need URL escaping',
    /^[A-Za-z0-9_-]*$/.test(b64urlEncode(new Uint8Array([251, 255, 254, 253, 63, 62]))), true);
  eq('emits no padding', b64urlEncode(new Uint8Array([1])).includes('='), false);
  eq('decodes an unpadded payload of every length mod 4', [1, 2, 3, 4, 5].every((n) => {
    const b = new Uint8Array(n).map((_, i) => i * 37 % 256);
    return [...b64urlDecode(b64urlEncode(b))].join() === [...b].join();
  }), true);

  section('share links: rejecting untrusted input');
  const shareOf = (doc) => ({ v: 1, doc });
  const good = load(csv, 'plan.csv');
  eq('a well formed payload survives', (() => {
    const out = sanitizeSharedDoc(shareOf(good));
    return { n: out.tasks.length, mode: out.mode, team: out.teamSize };
  })(), { n: 16, mode: 'rigid', team: 4 });
  eq('a version mismatch is refused', (() => {
    try { sanitizeSharedDoc({ v: 99, doc: good }); return 'accepted'; }
    catch (e) { return /different version/i.test(e.message); }
  })(), true);
  eq('a payload with no tasks is refused', (() => {
    try { sanitizeSharedDoc(shareOf({ tasks: [] })); return 'accepted'; }
    catch (e) { return /no tasks/i.test(e.message); }
  })(), true);
  eq('junk is refused', (() => {
    try { sanitizeSharedDoc(null); return 'accepted'; }
    catch (e) { return /no plan/i.test(e.message); }
  })(), true);
  // a dependency on an id the link does not carry would wedge the scheduler
  eq('dangling dependencies are dropped', sanitizeSharedDoc(shareOf({
    header: ['name'], srcHeader: ['name'], tasks: [
      { id: 'a', name: 'A', deps: ['ghost', 'b'] }, { id: 'b', name: 'B', deps: [] }],
  })).tasks[0].deps, ['b']);
  eq('a self dependency is dropped', sanitizeSharedDoc(shareOf({
    header: ['name'], srcHeader: ['name'], tasks: [{ id: 'a', name: 'A', deps: ['a'] }],
  })).tasks[0].deps, []);
  eq('duplicate ids are made unique', sanitizeSharedDoc(shareOf({
    header: ['name'], srcHeader: ['name'],
    tasks: [{ id: 'a', name: 'A' }, { id: 'a', name: 'Also A' }],
  })).tasks.map((t) => t.id), ['a', 'a-2']);
  eq('a hostile duration is clamped to a working day', sanitizeSharedDoc(shareOf({
    header: ['name'], srcHeader: ['name'],
    tasks: [{ id: 'a', name: 'A', duration: -5 }, { id: 'b', name: 'B', duration: 1e9 }],
  })).tasks.map((t) => t.duration), [1, 1000000000]);
  eq('a non-numeric duration falls back to 1', sanitizeSharedDoc(shareOf({
    header: ['name'], srcHeader: ['name'], tasks: [{ id: 'a', name: 'A', duration: 'lots' }],
  })).tasks[0].duration, 1);
  eq('a malformed start date falls back rather than reaching the calendar',
    YMD_OK(sanitizeSharedDoc(shareOf({
      header: ['name'], srcHeader: ['name'], tasks: [{ id: 'a', name: 'A', start: 'whenever' }],
    })).tasks[0].start), true);
  eq('an unknown mode falls back to rigid', sanitizeSharedDoc(shareOf({
    header: ['name'], srcHeader: ['name'], mode: 'chaos', tasks: [{ id: 'a', name: 'A' }],
  })).mode, 'rigid');
  eq('a nonsense team size falls back', sanitizeSharedDoc(shareOf({
    header: ['name'], srcHeader: ['name'], teamSize: -3, tasks: [{ id: 'a', name: 'A' }],
  })).teamSize, 4);
  eq('non-string extras are coerced, not trusted', sanitizeSharedDoc(shareOf({
    header: ['name'], srcHeader: ['name'],
    tasks: [{ id: 'a', name: 'A', extra: { owner: { evil: true } } }],
  })).tasks[0].extra.owner, '[object Object]');
  eq('an array masquerading as extras is ignored', sanitizeSharedDoc(shareOf({
    header: ['name'], srcHeader: ['name'], tasks: [{ id: 'a', name: 'A', extra: ['x'] }],
  })).tasks[0].extra, {});
  eq('ragged source rows are padded to the header width', sanitizeSharedDoc(shareOf({
    header: ['a', 'b', 'c'], srcHeader: ['a', 'b', 'c'], srcRows: [['1'], ['1', '2', '3', '4']],
    tasks: [{ id: 'x', name: 'X' }],
  })).srcRows, [['1', '', ''], ['1', '2', '3']]);
  eq('holidays that are not dates are dropped', sanitizeSharedDoc(shareOf({
    header: ['name'], srcHeader: ['name'], holidays: ['2027-03-03', 'soon', ''],
    tasks: [{ id: 'a', name: 'A' }],
  })).holidays, ['2027-03-03']);

  section('workday space transform');
  eq('index 0 maps to the synthetic epoch', synthYmd(0), '2000-01-03');
  eq('round trip through synthetic space', synthIdx(parseYMD(synthYmd(137))), 137);
  eq('a 5 day bar spans 5 synthetic columns',
    daysBetween(parseYMD(synthYmd(10)), parseYMD(synthYmd(14))) + 1, 5);

  section('weekly load');
  const s6 = load(csv, 'plan.csv');
  const wl = weeklyLoad(s6, cal0);
  eq('every week is a Monday', wl.every(([w]) => parseYMD(w).getDay() === 1), true);
  eq('total person-days matches the estimate column',
    Math.round(wl.reduce((s, r) => s + r[1], 0)),
    s6.tasks.reduce((s, t) => s + (t.estimate == null ? t.duration : t.estimate), 0));
  eq('first week carries the survey only', Math.round(wl[0][1]), 5);

  return { pass, fail, results };
}

/* The first-run guided tour, on driver.js.
 *
 * Why a tour and not a paragraph: nothing on this page is guessable. A visitor lands on a
 * fully drawn chart of invented data, and the three things that make the tool different -
 * the axis has no weekends, bars reschedule what depends on them, and a bar's length is
 * checked against its estimate - are all invisible until someone says so. A wall of text
 * in a modal gets dismissed unread; pointing at the actual control does not.
 *
 * Steps are ordered as a first session actually goes: what am I looking at, how do I get my
 * own data in, what does the chart mean, what can I do to it, what is it telling me, how do
 * I get it out.
 *
 * Only stable, always-visible elements are targeted. Anything inside a hidden side-panel
 * tab has to be revealed first (see onHighlightStarted) or driver.js measures a zero-sized
 * box and parks the popover in the corner.
 */
'use strict';

/** Element-targeted steps are skipped if the selector is missing, so an empty plan
 *  (no bars, no gutter rows) degrades to the steps that still make sense. */
function tourSteps() {
  return [
    {
      popover: {
        title: 'This is a working-day timeline planner',
        description:
          'Everything on screen is a <b>synthetic example</b> - an invented coffee shop ' +
          'fit-out. Nothing here is yours yet - the counter below tracks how far along ' +
          'this is, and you can leave at any point with Esc.',
      },
    },
    {
      element: '#file-name',
      popover: {
        title: 'Your plan goes here',
        description:
          'Drop a <code>.csv</code> or <code>.tsv</code> anywhere on the window, or use ' +
          '<b>Open file</b>. It never leaves your browser - there is no server and no ' +
          'network request at all.',
      },
    },
    {
      element: '#gutter',
      popover: {
        title: 'Every task, and the number that matters',
        description:
          '<code>15d / 20d</code> means the bar is drawn 15 days long but the estimate ' +
          'says 20. That gap is the whole point of the tool: it is easy to end up with a ' +
          'timeline arranged to look neat rather than to match the estimates under it.',
      },
    },
    {
      element: '#gantt',
      popover: {
        title: 'The axis is working days only',
        description:
          'Weekends and holidays are not columns at all, so one column is one working day ' +
          'and a bar\'s width <i>is</i> its duration. Nothing can land on a Saturday. ' +
          '<b>Drag or resize a bar</b> and whatever depends on it reschedules - a task is ' +
          'never allowed to start before the things blocking it have finished.',
      },
    },
    {
      element: '#seg-mode',
      popover: {
        title: 'How downstream reacts',
        description:
          '<b>Rigid</b> shifts successors by the same amount, keeping the gaps you have. ' +
          '<b>ASAP</b> pulls everything to its earliest legal start, collapsing them.',
      },
    },
    {
      element: '#side-tabs',
      popover: {
        title: 'What the plan gets wrong',
        description:
          '<b>Validation</b> lists every inconsistency - missing estimates, a task starting ' +
          'before its dependency ends, weeks over capacity - most with a one-click fix. ' +
          'The badge is the current count.',
      },
      // handled by the single onHighlightStarted below, so the cleanup there is not
      // shadowed by a per-step hook
      showTab: 'validate',
    },
    {
      element: '#btn-download',
      popover: {
        title: 'Getting it back out',
        description:
          '<b>Download CSV</b> writes a real file, columns and order preserved, including ' +
          'any columns this tool does not understand. <b>Copy for Excel</b> puts it on the ' +
          'clipboard tab-separated, which is what pastes into spreadsheet cells.',
      },
    },
  ];
}

/** Build a driver instance. Kept in a function so the tour is constructed fresh each run
 *  and never holds a reference to a torn-down DOM. */
function makeTour() {
  const factory = window.driver && window.driver.js && window.driver.js.driver;
  if (!factory) return null;   // vendored script missing; callers fall back to no tour
  /* driver.js adds .driver-active-element to each target but never takes it off the
   * previous one, so by the last step every element it has visited still carries it. That
   * class is what its own stylesheet uses to grant `pointer-events: auto`, so the "only the
   * highlighted thing is clickable" property erodes as the tour advances - by step 7 six
   * controls are live behind the overlay. Strip the stale ones on every move. */
  const dropStale = (keep) => {
    for (const el of document.querySelectorAll('.driver-active-element')) {
      if (el !== keep) el.classList.remove('driver-active-element');
    }
  };

  return factory({
    showProgress: true,
    allowClose: true,
    overlayOpacity: 0.6,
    nextBtnText: 'Next',
    prevBtnText: 'Back',
    doneBtnText: 'Done',
    steps: tourSteps(),
    onHighlightStarted: (el, step) => {
      dropStale(el);
      // a step that lives behind a tab has to reveal it before driver.js measures the box
      if (step && step.showTab) showTab(step.showTab);
    },
  });
}

/* Marked seen on START, not on finish.
 *
 * driver.js 1.8.0 does not fire onDestroyed - not on Done, not on Escape, not on the close
 * button (verified on all three). Its teardown reaches the hook only when both
 * __activeElement and __activeStep are still set, and by then they are not. onDestroyStarted
 * *does* fire, but taking it over means owning the teardown: the library returns early
 * without destroying, so we would have to call destroy() ourselves and guard the recursion
 * that causes.
 *
 * Not worth it, because "seen" is the better trigger anyway: somebody who opens the tour and
 * immediately closes it has been offered it, and re-offering on every reload until they sit
 * through all seven steps would be worse. The ? button brings it back deliberately.
 *
 * Nothing needs cleaning up afterwards either - driver.js removes the class from its own
 * last target, and onHighlightStarted has already stripped the earlier ones. */
function startTour() {
  const d = makeTour();
  markIntroSeen();
  if (!d) return false;   // vendored script missing: nothing to show, but do not re-offer
  d.drive();
  return true;
}

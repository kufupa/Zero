// Quick-search paths (quick-search.mjs) with fake page actions. Each path of the header search is run in order: the typed
// term, the nudges (ArrowDown, a click inside the field, the header Run), the surname retry, the window move. The page
// actions in cancel-stay.mjs are not exercised here; they need a browser.
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  addDaysIso, AMBIGUOUS, driveQuickSearch, pickConfirmationRow, QUICK_NUDGES, runConfirmationSearch, windowAction,
  windowStartsAround,
} from './quick-search.mjs';
import { parseDateWindowLabel } from './cancel-stay-rules.mjs';

const ROW = { row: { confirmation: '61143613-1', locator: 'row-1' }, open: null };
const NOTHING = { row: null, open: null };
const OPEN = { row: null, open: { confirmation: '61143613-1' } };

// Records every page action and answers ready() from a script, one answer per call.
function harness(answers) {
  const log = [];
  let call = 0;
  const actions = {
    type: async () => {
      log.push('type');
    },
    arrowDown: async () => {
      log.push('arrowDown');
    },
    clickInside: async () => {
      log.push('clickInside');
    },
    headerRun: async () => {
      log.push('headerRun');
    },
  };
  const ready = async () => {
    const answer = answers[Math.min(call, answers.length - 1)];
    call += 1;
    log.push('ready');
    return answer;
  };
  return { actions, ready, log };
}

const isDone = (result) => Boolean(result.row || result.open);

test('the typed term opens the panel, so no nudge runs', async () => {
  const { actions, ready, log } = harness([ROW]);
  const run = await driveQuickSearch(actions, { ready, done: isDone });
  assert.deepEqual(log, ['type', 'ready']);
  assert.deepEqual(run.stages, ['typed']);
  assert.equal(run.done, true);
});

test('when the typed term opens nothing, ArrowDown is the first nudge', async () => {
  const { actions, ready, log } = harness([NOTHING, ROW]);
  const run = await driveQuickSearch(actions, { ready, done: isDone });
  assert.deepEqual(log, ['type', 'ready', 'arrowDown', 'ready']);
  assert.deepEqual(run.stages, ['typed', 'arrowDown']);
  assert.equal(run.done, true);
});

test('a click inside the field is the second nudge', async () => {
  const { actions, ready, log } = harness([NOTHING, NOTHING, ROW]);
  const run = await driveQuickSearch(actions, { ready, done: isDone });
  assert.deepEqual(log, ['type', 'ready', 'arrowDown', 'ready', 'clickInside', 'ready']);
  assert.deepEqual(run.stages, ['typed', 'arrowDown', 'clickInside']);
});

test('the header Run is the last nudge, and an open record for the confirmation counts as found', async () => {
  const { actions, ready, log } = harness([NOTHING, NOTHING, NOTHING, OPEN]);
  const run = await driveQuickSearch(actions, { ready, done: isDone });
  assert.deepEqual(log.slice(-2), ['headerRun', 'ready']);
  assert.deepEqual(run.stages, ['typed', 'arrowDown', 'clickInside', 'headerRun']);
  assert.equal(run.done, true);
});

test('when no nudge opens the panel, each nudge runs once and the search reports not done', async () => {
  const { actions, ready, log } = harness([NOTHING]);
  const run = await driveQuickSearch(actions, { ready, done: isDone });
  assert.equal(log.filter((entry) => entry === 'type').length, 1, 'the term is typed once');
  assert.deepEqual(run.stages, ['typed', 'arrowDown', 'clickInside', 'headerRun']);
  assert.equal(run.done, false);
});

test('Enter is never a nudge: opening a record on one match is not a way into the panel', () => {
  assert.deepEqual(QUICK_NUDGES, ['arrowDown', 'clickInside', 'headerRun']);
});

// ---- runConfirmationSearch: the confirmation, the surname retry and the window move ----

// io answers drive() from a script keyed by the term. moveWindow(start) records where the panel window was moved to.
function fakeIo({ answers = {}, panel = true }) {
  const calls = [];
  const io = {
    drive: async (term, { needRow, done }) => {
      calls.push(`drive:${term}:${needRow ? 'row' : 'any'}`);
      const script = answers[term];
      const next = Array.isArray(script) ? script.shift() : script;
      const result = next ?? NOTHING;
      return { result, stages: ['typed'], done: done(result) };
    },
    panelShown: async () => panel,
    moveWindow: async (start) => {
      calls.push(`moveWindow:${start}`);
    },
  };
  return { io, calls };
}

const SEARCH = { confirmation: '61143613-1', arrival: '2027-10-12' };
// The two 60-day windows around the arrival: one from 60 days before it, one from the arrival itself.
const BEFORE = '2027-08-13';
const ON = '2027-10-12';

test('a confirmation in the default window is used: no window move and no surname retry', async () => {
  const { io, calls } = fakeIo({ answers: { '61143613-1': ROW } });
  const outcome = await runConfirmationSearch(io, { ...SEARCH, lastName: 'Labtest' });
  assert.deepEqual(calls, ['drive:61143613-1:any']);
  assert.equal(outcome.method, 'quick');
  assert.deepEqual(outcome.probe, ROW);
});

test('a confirmation the default window misses is searched in the two windows around arrival, in order', async () => {
  const { io, calls } = fakeIo({ answers: { '61143613-1': [NOTHING, NOTHING, ROW] } });
  const outcome = await runConfirmationSearch(io, SEARCH);
  assert.deepEqual(calls, [
    'drive:61143613-1:any',
    `moveWindow:${BEFORE}`,
    'drive:61143613-1:any',
    `moveWindow:${ON}`,
    'drive:61143613-1:any',
  ]);
  assert.equal(outcome.method, 'quick_calendar');
  assert.deepEqual(outcome.stages, ['typed', `window.${BEFORE}.typed`, `window.${ON}.typed`]);
});

test('the window walk stops at the first window that shows the confirmation', async () => {
  const { io, calls } = fakeIo({ answers: { '61143613-1': [NOTHING, ROW] } });
  const outcome = await runConfirmationSearch(io, SEARCH);
  assert.deepEqual(calls, ['drive:61143613-1:any', `moveWindow:${BEFORE}`, 'drive:61143613-1:any']);
  assert.equal(outcome.method, 'quick_calendar');
});

test('the window moves even when the default window already covers arrival, since the booking may arrive on another date', async () => {
  const { io, calls } = fakeIo({ answers: { '61143613-1': NOTHING } });
  await runConfirmationSearch(io, SEARCH);
  assert.equal(calls.includes(`moveWindow:${BEFORE}`), true);
  assert.equal(calls.includes(`moveWindow:${ON}`), true);
});

test('when no window shows the confirmation, the surname is searched after the windows and the exact row is taken', async () => {
  const { io, calls } = fakeIo({ answers: { '61143613-1': NOTHING, Labtest: ROW } });
  const outcome = await runConfirmationSearch(io, { ...SEARCH, lastName: 'Labtest' });
  assert.deepEqual(calls, [
    'drive:61143613-1:any',
    `moveWindow:${BEFORE}`,
    'drive:61143613-1:any',
    `moveWindow:${ON}`,
    'drive:61143613-1:any',
    'drive:Labtest:row',
  ]);
  assert.equal(outcome.method, 'quick_surname');
  assert.deepEqual(outcome.probe, ROW);
  assert.equal(outcome.stages.at(-1), 'surname.typed');
});

test('without an arrival there are no window moves: the default window, then the surname', async () => {
  const { io, calls } = fakeIo({ answers: { '61143613-1': NOTHING, Labtest: NOTHING } });
  await runConfirmationSearch(io, { confirmation: '61143613-1', lastName: 'Labtest' });
  assert.deepEqual(calls, ['drive:61143613-1:any', 'drive:Labtest:row']);
});

test('without a panel there are no window moves, even with an arrival', async () => {
  const { io, calls } = fakeIo({ answers: { '61143613-1': NOTHING }, panel: false });
  await runConfirmationSearch(io, SEARCH);
  assert.equal(calls.some((call) => call.startsWith('moveWindow')), false);
});

test('an open record for the confirmation is used as it stands, with no window move', async () => {
  const { io, calls } = fakeIo({ answers: { '61143613-1': OPEN } });
  const outcome = await runConfirmationSearch(io, { ...SEARCH, lastName: 'Labtest' });
  assert.deepEqual(calls, ['drive:61143613-1:any']);
  assert.deepEqual(outcome.probe, OPEN);
});

test('with allowOpenRecord false (read-back), the search needs a row, not an open record', async () => {
  const { io, calls } = fakeIo({ answers: { '61143613-1': ROW } });
  await runConfirmationSearch(io, { ...SEARCH, allowOpenRecord: false });
  assert.deepEqual(calls, ['drive:61143613-1:row']);
});

test('a confirmation no window shows is not found, and the arrival never turns a miss into a match', async () => {
  const { io } = fakeIo({ answers: { '61143613-1': NOTHING } });
  const outcome = await runConfirmationSearch(io, SEARCH);
  assert.equal(outcome.probe.row, null);
  assert.equal(outcome.method, 'quick');
});

test('addDaysIso and windowStartsAround: 60 days before arrival, then arrival; the two windows span arrival plus or minus 60 days', () => {
  assert.equal(addDaysIso('2027-10-12', -60), BEFORE);
  assert.equal(addDaysIso('2027-02-10', -60), '2026-12-12', 'across a year end');
  assert.equal(addDaysIso('2028-02-28', 1), '2028-02-29', 'leap day');
  assert.deepEqual(windowStartsAround('2027-10-12'), [BEFORE, ON]);
  assert.equal(addDaysIso(BEFORE, 60), ON, 'the first window ends on the arrival');
  assert.equal(addDaysIso(ON, 60), '2027-12-11', 'the second window ends 60 days after the arrival');
});

// ---- windowAction and pickConfirmationRow ----

test('windowAction moves a readable window that misses arrival, and keeps everything else', () => {
  const window = parseDateWindowLabel('Oct 12, 2027 - Dec 11, 2027');
  assert.equal(windowAction({ window, arrival: '2027-10-12', panelShown: true }), 'keep');
  assert.equal(windowAction({ window, arrival: '2026-10-08', panelShown: true }), 'move');
  assert.equal(windowAction({ window, arrival: '2027-10-12', panelShown: false }), 'keep');
  assert.equal(windowAction({ window: null, arrival: '2027-10-12', panelShown: true }), 'keep');
  assert.equal(windowAction({ window, arrival: null, panelShown: true }), 'keep');
});

test('pickConfirmationRow takes the exact confirmation, returns null for none, and AMBIGUOUS for two', () => {
  const rows = [
    { confirmation: '61143613-1', lastName: 'Labtest', firstName: 'Proof' },
    { confirmation: '57291630-1', lastName: 'Labtest', firstName: 'Nava' },
  ];
  assert.equal(pickConfirmationRow(rows, '61143613-1').firstName, 'Proof');
  assert.equal(pickConfirmationRow(rows, '99999999-1'), null);
  assert.equal(pickConfirmationRow([...rows, rows[0]], '61143613-1'), AMBIGUOUS);
});

test('a panel whose search ran without the row stops the nudges: they cannot change an executed result', async () => {
  const { actions, ready, log } = harness([{ row: null, open: null, executed: true }]);
  const run = await driveQuickSearch(actions, { ready, done: isDone });
  assert.deepEqual(log, ['type', 'ready']);
  assert.deepEqual(run.stages, ['typed']);
  assert.equal(run.done, false);
});

test('the surname is searched once, after both windows around arrival have missed the confirmation', async () => {
  const { io, calls } = fakeIo({ answers: { '61143613-1': [NOTHING, NOTHING, NOTHING], Labtest: ROW } });
  const outcome = await runConfirmationSearch(io, { ...SEARCH, lastName: 'Labtest' });
  assert.deepEqual(calls, [
    'drive:61143613-1:any',
    `moveWindow:${BEFORE}`,
    'drive:61143613-1:any',
    `moveWindow:${ON}`,
    'drive:61143613-1:any',
    'drive:Labtest:row',
  ]);
  assert.equal(outcome.method, 'quick_surname');
  assert.deepEqual(outcome.probe, ROW);
});

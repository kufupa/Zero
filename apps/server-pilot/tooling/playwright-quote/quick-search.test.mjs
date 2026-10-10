// Quick-search paths (quick-search.mjs) with fake page actions. Each path of the header search is run in order: the typed
// term, the nudges (ArrowDown, a click inside the field, the header Run), the surname retry, the window move. The page
// actions in cancel-stay.mjs are not exercised here; they need a browser.
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  AMBIGUOUS, driveQuickSearch, pickConfirmationRow, QUICK_NUDGES, runConfirmationSearch, windowAction,
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

// io answers drive() from a script keyed by the term, and holds the panel window that moveWindow() changes.
function fakeIo({ answers = {}, panel = true, window = null, windowAfterMove = null }) {
  const calls = [];
  const state = { window, panel };
  const io = {
    drive: async (term, { needRow, done }) => {
      calls.push(`drive:${term}:${needRow ? 'row' : 'any'}`);
      const script = answers[term];
      const next = Array.isArray(script) ? script.shift() : script;
      const result = next ?? NOTHING;
      return { result, stages: ['typed'], done: done(result) };
    },
    panelShown: async () => state.panel,
    window: async () => state.window,
    moveWindow: async () => {
      calls.push('moveWindow');
      state.window = windowAfterMove;
    },
  };
  return { io, calls };
}

const MISSING_WINDOW = { from: '2026-10-08', to: '2026-12-07' };
const COVERING_WINDOW = { from: '2027-10-12', to: '2027-12-11' };
const SEARCH = { confirmation: '61143613-1', arrival: '2027-10-12' };

test('the confirmation found in the first search is used with no surname retry and no window move', async () => {
  const { io, calls } = fakeIo({ answers: { '61143613-1': ROW }, window: COVERING_WINDOW });
  const outcome = await runConfirmationSearch(io, { ...SEARCH, lastName: 'Labtest' });
  assert.deepEqual(calls, ['drive:61143613-1:any']);
  assert.equal(outcome.method, 'quick');
  assert.deepEqual(outcome.probe, ROW);
});

test('when the typed confirmation finds nothing, the surname retry takes the row with the exact confirmation', async () => {
  const { io, calls } = fakeIo({ answers: { '61143613-1': NOTHING, Labtest: ROW }, window: COVERING_WINDOW });
  const outcome = await runConfirmationSearch(io, { ...SEARCH, lastName: 'Labtest' });
  assert.deepEqual(calls, ['drive:61143613-1:any', 'drive:Labtest:row']);
  assert.equal(outcome.method, 'quick_surname');
  assert.deepEqual(outcome.probe, ROW);
  assert.deepEqual(outcome.stages, ['typed', 'surname.typed']);
});

test('without a surname, a confirmation that the panel does not show is not found, and no window move happens', async () => {
  const { io, calls } = fakeIo({ answers: { '61143613-1': NOTHING }, window: COVERING_WINDOW });
  const outcome = await runConfirmationSearch(io, SEARCH);
  assert.deepEqual(calls, ['drive:61143613-1:any']);
  assert.equal(outcome.probe.row, null);
});

test('a panel whose window misses arrival is moved by its calendar, then the same term is searched again', async () => {
  const { io, calls } = fakeIo({
    answers: { '61143613-1': [NOTHING, ROW] },
    window: MISSING_WINDOW,
    windowAfterMove: COVERING_WINDOW,
  });
  const outcome = await runConfirmationSearch(io, SEARCH);
  assert.deepEqual(calls, ['drive:61143613-1:any', 'moveWindow', 'drive:61143613-1:any']);
  assert.equal(outcome.method, 'quick_calendar');
  assert.deepEqual(outcome.probe, ROW);
});

test('a window that already covers arrival is not moved', async () => {
  const { io, calls } = fakeIo({ answers: { '61143613-1': NOTHING }, window: COVERING_WINDOW });
  await runConfirmationSearch(io, SEARCH);
  assert.equal(calls.includes('moveWindow'), false);
});

test('an unreadable window is kept as it is, and so is a search with no arrival', async () => {
  const unreadable = fakeIo({ answers: { '61143613-1': NOTHING }, window: null });
  await runConfirmationSearch(unreadable.io, SEARCH);
  assert.equal(unreadable.calls.includes('moveWindow'), false);
  const noArrival = fakeIo({ answers: { '61143613-1': NOTHING }, window: MISSING_WINDOW });
  await runConfirmationSearch(noArrival.io, { confirmation: '61143613-1' });
  assert.equal(noArrival.calls.includes('moveWindow'), false, 'lookups without an arrival never move the window');
});

test('no panel at all means no window move, even with an arrival', async () => {
  const { io, calls } = fakeIo({ answers: { '61143613-1': NOTHING }, panel: false, window: MISSING_WINDOW });
  await runConfirmationSearch(io, SEARCH);
  assert.equal(calls.includes('moveWindow'), false);
});

test('an open record for the confirmation is used as it stands and its window is never moved', async () => {
  const { io, calls } = fakeIo({ answers: { '61143613-1': OPEN }, window: MISSING_WINDOW });
  const outcome = await runConfirmationSearch(io, { ...SEARCH, lastName: 'Labtest' });
  assert.deepEqual(calls, ['drive:61143613-1:any']);
  assert.deepEqual(outcome.probe, OPEN);
});

test('with allowOpenRecord false (read-back), the search needs a row, not an open record', async () => {
  const { io, calls } = fakeIo({ answers: { '61143613-1': ROW }, window: COVERING_WINDOW });
  await runConfirmationSearch(io, { ...SEARCH, allowOpenRecord: false });
  assert.deepEqual(calls, ['drive:61143613-1:row']);
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

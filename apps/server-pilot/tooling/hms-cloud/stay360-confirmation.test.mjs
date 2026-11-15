import test from 'node:test';
import assert from 'node:assert/strict';
import { planStaySearchChunks, mergeSearchedRanges, buildStaySearchCompleteness } from './stay360-confirmation.mjs';
import { lookupFailure } from './stay360-lookup-cli.mjs';

const initial = { from: '2027-01-01', to: '2027-01-31' };
const horizon = { from: '2026-12-01', to: '2027-02-28' };

test('merges overlapping and adjacent ranges without filling gaps', () => {
  assert.deepEqual(mergeSearchedRanges([initial, { from: '2026-12-01', to: '2026-12-31' },
    { from: '2027-02-03', to: '2027-02-10' }, { from: '2027-01-15', to: '2027-02-01' }]), [
    { from: '2026-12-01', to: '2027-02-01' }, { from: '2027-02-03', to: '2027-02-10' },
  ]);
});

test('plans bounded adjacent chunks from the actual window and stops at the horizon', () => {
  const options = { searchedRanges: [initial], requestedDateHorizon: horizon, currentRange: initial };
  assert.deepEqual(planStaySearchChunks(options), ['2026-12-01', '2027-01-29']);
  assert.deepEqual(planStaySearchChunks({ ...options, maxChunks: 1 }), ['2026-12-01']);
  assert.deepEqual(planStaySearchChunks({ ...options, maxChunks: 0 }), []);
  assert.deepEqual(planStaySearchChunks({ ...options, searchedRanges: [horizon] }), []);
  assert.deepEqual(planStaySearchChunks({ ...options, currentRange: null }), []);
});

test('aborted and expired sweeps cannot schedule a chunk', () => {
  const options = { searchedRanges: [initial], requestedDateHorizon: horizon, currentRange: initial };
  assert.throws(() => planStaySearchChunks({ ...options, signal: AbortSignal.abort() }), /SEARCH_ABORTED/);
  assert.throws(() => planStaySearchChunks({ ...options, deadline: 100, now: 100 }), /SEARCH_DEADLINE_EXCEEDED/);
});

test('completeness requires coverage without gaps and reports truncation', () => {
  const input = { searchedDateRange: initial, searchedRanges: [initial], requestedDateHorizon: horizon,
    displayed: 0, total: 0, gridComplete: true, allChunksSearched: true };
  assert.equal(buildStaySearchCompleteness(input).requestedDatesCovered, false);
  assert.equal(buildStaySearchCompleteness(input).allChunksSearched, false);
  const complete = buildStaySearchCompleteness({ ...input, searchedRanges: [horizon] });
  assert.equal(complete.requestedDatesCovered, true);
  assert.equal(complete.allChunksSearched, true);
  const capped = buildStaySearchCompleteness({ ...input, displayed: 10, total: 50, gridComplete: false, truncated: true });
  assert.equal(capped.truncated, true);
  assert.equal(capped.gridComplete, false);
  const error = Object.assign(new Error('SEARCH_RESULTS_CAPPED'), { completeness: capped, searchedRanges: capped.searchedRanges,
    searchedDateRange: initial, requestedDateHorizon: horizon });
  assert.deepEqual(lookupFailure(error, Date.now()).completeness, capped);
});

function fakeSearchPage({ capped = false, stalled = false, changedOnReturn = false } = {}) {
  let matchingStart = null, visits = 0;
  let start = new Date('2027-01-01T00:00:00Z'), month = new Date(start), moves = 0;
  const names = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
  const title = (day) => `${names[day.getUTCMonth()].slice(0, 3)} ${String(day.getUTCDate()).padStart(2, '0')}, ${day.getUTCFullYear()}`;
  const hasMatch = () => changedOnReturn && matchingStart === start.toISOString().slice(0, 10);
  const rows = { count: async () => capped || hasMatch() ? 1 : 0, evaluateAll: async () => hasMatch() ? [{ index: 0, cellIndex: 0,
    text: [['123-1'], [visits > 1 ? 'Different Guest' : 'Example Guest'], [], ['01-Jan-2027', '02-Jan-2027']] }] : [] };
  const picker = { waitFor: async () => {}, locator: (selector) => {
    if (selector === '.x-datepicker-month .x-btn-inner') return { innerText: async () => `${names[month.getUTCMonth()]} ${month.getUTCFullYear()}` };
    if (selector === '.x-datepicker-prev' || selector === '.x-datepicker-next') return { click: async () => {
      if (!stalled) month.setUTCMonth(month.getUTCMonth() + (selector.endsWith('prev') ? -1 : 1));
    } };
    return { click: async () => {
      const match = /td\[title="(\w+) (\d+), (\d+)"\]/.exec(selector);
      start = new Date(Date.UTC(Number(match[3]), names.indexOf(match[1]), Number(match[2]))); moves++;
      if (changedOnReturn && !matchingStart) matchingStart = start.toISOString().slice(0, 10);
      if (hasMatch()) visits++;
    } };
  } };
  const popup = { boundingBox: async () => ({ x: 0, y: 20, width: 100 }),
    evaluate: async () => ({ displayed: capped || hasMatch() ? 1 : 0, total: capped ? 2 : hasMatch() ? 1 : 0, history: false, loading: false }),
    locator: (selector) => selector.startsWith('[name="gridTitle"]') ? { count: async () => 1,
      innerText: async () => `${title(start)} - ${title(new Date(start.getTime() + 30 * 86400000))}` } :
      selector.startsWith('[data-testid="calendarbtn"]') ? { count: async () => 1, click: async () => { month = new Date(start); } } : rows };
  const run = { boundingBox: async () => ({ x: 101, y: 0 }), click: async () => {} };
  const page = { context: () => ({ route: async () => {} }), addLocatorHandler: async () => {}, isClosed: () => true,
    waitForTimeout: async (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    waitForFunction: async () => { if (stalled) throw new Error('picker stalled'); },
    locator: (selector) => {
      if (selector.startsWith('input[name="search"]')) return { waitFor: async () => {}, boundingBox: async () => ({ x: 0, y: 0, width: 100, height: 20 }), fill: async () => {} };
      if (selector === 'a.x-btn:visible') return { filter: () => ({ count: async () => 1, nth: () => run }) };
      if (selector === '.x-window.x-menu:visible') return { count: async () => 1, nth: () => popup };
      if (selector === '.x-datepicker:visible') return picker;
      return {};
    } };
  return { page, moves: () => moves };
}

test('actual lookup respects the chunk cap and preserves partial evidence', async () => {
  const { readConfirmationFromStay360 } = await import('./stay360-confirmation.mjs');
  const fake = fakeSearchPage();
  await assert.rejects(readConfirmationFromStay360(fake.page, '123-1', { maxChunks: 3 }), (error) => {
    assert.equal(error.message, 'CONFIRMATION_NOT_FOUND');
    assert.equal(fake.moves(), 2);
    assert.equal(error.completeness.gridComplete, true);
    assert.equal(error.completeness.requestedDatesCovered, false);
    assert.equal(error.completeness.allChunksSearched, false);
    return true;
  });
});

test('actual lookup stops on capped or stalled grids', async () => {
  const { readConfirmationFromStay360 } = await import('./stay360-confirmation.mjs');
  const capped = fakeSearchPage({ capped: true });
  await assert.rejects(readConfirmationFromStay360(capped.page, '123-1', {}), (error) =>
    error.message === 'SEARCH_RESULTS_CAPPED' && error.completeness.truncated && !error.completeness.gridComplete);
  assert.equal(capped.moves(), 0);
  const stalled = fakeSearchPage({ stalled: true });
  await assert.rejects(readConfirmationFromStay360(stalled.page, '123-1', {}), (error) =>
    error.message === 'CONFIRMATION_NOT_FOUND' && error.completeness.searchedRanges.length === 1 && !error.completeness.allChunksSearched);
});


test('revalidates a match after returning to an earlier chunk', async () => {
  const { readConfirmationFromStay360 } = await import('./stay360-confirmation.mjs');
  const fake = fakeSearchPage({ changedOnReturn: true });
  await assert.rejects(readConfirmationFromStay360(fake.page, '123-1', { maxChunks: 3 }), (error) =>
    error.message === 'SEARCH_RESULTS_CHANGED' && error.searchResults.complete === false);
  assert.equal(fake.moves(), 3);
});

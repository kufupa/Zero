import test from 'node:test';
import assert from 'node:assert/strict';
import { readSettledStatus, SAVE_POLL_MS, SAVE_SETTLE_MS, SAVE_WAIT_MS, waitForSaveConfirmation } from './save-wait.mjs';

// Fake Playwright page. Each sleep moves to the next frame and advances the clock that now() reads.
// Only the two field selectors and the mask text are answered, so a wrong selector fails the test.
function fakeRecord(frames) {
  let clock = 0;
  let polls = 0;
  const seen = new Set();
  const frame = () => frames[Math.min(polls, frames.length - 1)];
  const page = {
    locator(selector) {
      seen.add(selector);
      return {
        first: () => ({
          inputValue: async () => {
            if (selector === 'input[name="confirmationnumber"]:visible') return frame().confirmationNumber;
            if (selector === 'input[name="status"]:visible') return frame().status;
            throw new Error(`unexpected selector: ${selector}`);
          },
        }),
      };
    },
    getByText(pattern) {
      seen.add(String(pattern));
      return {
        filter: () => ({
          count: async () => (pattern.test('Processing request.') && frame().maskVisible ? 1 : 0),
        }),
      };
    },
    waitForTimeout: async (ms) => {
      clock += ms;
      polls += 1;
    },
  };
  return { page, seen, now: () => clock };
}

test('the save wait is at most 90 seconds', () => {
  assert.equal(SAVE_WAIT_MS, 90_000);
});

test('a save is confirmed only once the mask is gone and the confirmation number is set', async () => {
  const record = fakeRecord([
    { maskVisible: true, confirmationNumber: '', status: 'New' },
    { maskVisible: true, confirmationNumber: '61143613-1', status: 'New' },
    { maskVisible: false, confirmationNumber: '61143613-1', status: 'Reserved' },
  ]);
  const save = await waitForSaveConfirmation(record.page, { now: record.now });
  assert.deepEqual(save, {
    confirmed: true,
    confirmationNumber: '61143613-1',
    status: 'Reserved',
    reason: null,
  });
  assert.ok(record.seen.has('input[name="confirmationnumber"]:visible'));
  assert.ok(record.seen.has('input[name="status"]:visible'));
});

test('a number on screen under the mask is not enough, and the mask alone at the deadline is unconfirmed', async () => {
  const record = fakeRecord([{ maskVisible: true, confirmationNumber: '61143613-1', status: 'New' }]);
  const save = await waitForSaveConfirmation(record.page, { now: record.now });
  assert.equal(save.confirmed, false);
  assert.equal(save.reason, 'still_processing');
  assert.equal(save.confirmationNumber, '61143613-1');
  assert.equal(record.now(), SAVE_WAIT_MS, 'stops exactly at the 90 second deadline');
});

test('the mask gone with no number and Status still New is unconfirmed as no_confirmation', async () => {
  const record = fakeRecord([{ maskVisible: false, confirmationNumber: '', status: 'New' }]);
  const save = await waitForSaveConfirmation(record.page, { now: record.now });
  assert.deepEqual(save, { confirmed: false, confirmationNumber: '', status: 'New', reason: 'no_confirmation' });
});

test('Status that left New without a number is unconfirmed as status_without_confirmation', async () => {
  const record = fakeRecord([{ maskVisible: false, confirmationNumber: '', status: 'Reserved' }]);
  const save = await waitForSaveConfirmation(record.page, { now: record.now });
  assert.equal(save.confirmed, false);
  assert.equal(save.reason, 'status_without_confirmation');
  assert.equal(save.status, 'Reserved');
});

test('the poll interval never overshoots the deadline', async () => {
  const record = fakeRecord([{ maskVisible: true, confirmationNumber: '', status: 'New' }]);
  await waitForSaveConfirmation(record.page, { now: record.now, timeoutMs: 4_000, pollMs: SAVE_POLL_MS });
  assert.equal(record.now(), 4_000);
});

test('readSettledStatus returns the first status other than New', async () => {
  const record = fakeRecord([
    { maskVisible: false, confirmationNumber: '61143613-1', status: 'New' },
    { maskVisible: false, confirmationNumber: '61143613-1', status: 'Reserved' },
  ]);
  assert.equal(await readSettledStatus(record.page, { now: record.now }), 'Reserved');
});

test('readSettledStatus gives up after the settle window and returns the last status read', async () => {
  const record = fakeRecord([{ maskVisible: false, confirmationNumber: '61143613-1', status: 'New' }]);
  assert.equal(await readSettledStatus(record.page, { now: record.now }), 'New');
  assert.equal(record.now(), SAVE_SETTLE_MS);
});

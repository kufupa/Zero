import assert from 'node:assert/strict';
import test from 'node:test';
import { readReasonList } from './cancel-stay.mjs';

// HMS shows "Processing request…" first: the reason list is empty for `emptyLooks` looks, then fills.
function fakeDialog({ emptyLooks, reasons }) {
  let looks = 0;
  let triggerClicks = 0;
  let open = false;
  const items = {
    count: async () => (open && looks > emptyLooks ? reasons.length : 0),
    allInnerTexts: async () => {
      looks += 1;
      return open && looks > emptyLooks ? reasons : [];
    },
  };
  const page = { locator: () => items, waitForTimeout: async () => {} };
  const dialog = {
    locator: () => ({ first: () => ({ click: async () => { triggerClicks += 1; open = true; } }) }),
  };
  return { page, dialog, triggerClicks: () => triggerClicks };
}

test('readReasonList waits for HMS to fill the list after Processing request', async () => {
  const fake = fakeDialog({ emptyLooks: 3, reasons: ['Test Reservations', 'Illness'] });
  const list = await readReasonList(fake.page, fake.dialog, { waitMs: 60_000 });
  assert.deepEqual(list.reasons.length, 2);
  assert.ok(fake.triggerClicks() >= 2, 'opens the list again while it is empty');
});

test('readReasonList gives up empty after the wait', async () => {
  const fake = fakeDialog({ emptyLooks: Infinity, reasons: ['Illness'] });
  const list = await readReasonList(fake.page, fake.dialog, { waitMs: 0 });
  assert.deepEqual(list.reasons, []);
});

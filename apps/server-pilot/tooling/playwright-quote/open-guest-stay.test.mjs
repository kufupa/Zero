import assert from 'node:assert/strict';
import test from 'node:test';
import { openGuestStay } from './cancel-stay.mjs';

// A page whose first Guest Stay click is dropped, as on the EC2 browser while Front Desk is still expanding.
function fakePage({ dropFirst }) {
  const clicks = [];
  let guestStayClicks = 0;
  let opened = false;
  const clickable = (name) => ({
    click: async () => {
      clicks.push(name);
      if (name === 'Guest Stay') {
        guestStayClicks += 1;
        if (!dropFirst || guestStayClicks > 1) opened = true;
      }
    },
  });
  return {
    clicks,
    page: {
      waitForTimeout: async () => {},
      locator: (selector) =>
        selector.startsWith('a.app-menu-trigger')
          ? clickable('menu')
          : { filter: ({ hasText }) => clickable(hasText.source.replace(/^\^|\$$/g, '')) },
      getByPlaceholder: () => ({
        first: () => ({
          waitFor: async () => {
            if (!opened) throw new Error('timeout');
          },
        }),
      }),
    },
  };
}

test('openGuestStay returns once the Guest Stay header search shows', async () => {
  const { page, clicks } = fakePage({ dropFirst: false });
  await openGuestStay(page, { waitMs: 1 });
  assert.deepEqual(clicks, ['menu', 'Front Desk', 'Guest Stay']);
});

test('openGuestStay clicks Guest Stay again when the first click is dropped', async () => {
  const { page, clicks } = fakePage({ dropFirst: true });
  await openGuestStay(page, { waitMs: 1 });
  assert.deepEqual(clicks, ['menu', 'Front Desk', 'Guest Stay', 'Guest Stay']);
});

test('openGuestStay fails plainly when Guest Stay never opens', async () => {
  const page = fakePage({ dropFirst: true }).page;
  page.getByPlaceholder = () => ({ first: () => ({ waitFor: async () => { throw new Error('timeout'); } }) });
  await assert.rejects(openGuestStay(page, { attempts: 2, waitMs: 1 }), /GUEST_STAY_NOT_OPENED/);
});

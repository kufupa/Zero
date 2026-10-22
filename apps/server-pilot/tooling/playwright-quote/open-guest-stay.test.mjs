import assert from 'node:assert/strict';
import test from 'node:test';
import { openGuestStay } from './cancel-stay.mjs';
import { openGuestStayScreen } from './open-guest-stay.mjs';

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

function fakeScreenPage({ guestStayClickError, evaluateOpens, neverOpen }) {
  const events = [];
  let opened = false;
  const treeNode = (name) => ({
    click: async (opts = {}) => {
      events.push({ name, op: 'click', timeout: opts.timeout });
      if (name === 'Guest Stay' && guestStayClickError) {
        throw new Error(guestStayClickError);
      }
    },
    scrollIntoViewIfNeeded: async (opts = {}) => {
      events.push({ name, op: 'scroll', timeout: opts.timeout });
    },
    evaluate: async () => {
      events.push({ name, op: 'evaluate' });
      if (name === 'Guest Stay' && evaluateOpens) opened = true;
    },
  });
  return {
    events,
    page: {
      waitForTimeout: async () => {},
      locator: (selector) => {
        if (selector.startsWith('a.app-menu-trigger')) {
          return { click: async () => { events.push({ name: 'menu', op: 'click' }); } };
        }
        if (selector.includes('New Record')) {
          return {
            first: () => ({
              isVisible: async () => opened,
              waitFor: async () => {
                if (!opened || neverOpen) throw new Error('timeout');
              },
            }),
          };
        }
        return {
          filter: ({ hasText }) => treeNode(hasText.source.replace(/^\^|\$$/g, '')),
        };
      },
    },
  };
}

test('openGuestStayScreen DOM-clicks when the Guest Stay node is outside the viewport', async () => {
  const { page, events } = fakeScreenPage({
    guestStayClickError: 'locator.click: Timeout 20000ms — element is outside of the viewport',
    evaluateOpens: true,
  });
  await openGuestStayScreen(page, { waitMs: 1 });
  assert.equal(events.some((e) => e.name === 'Guest Stay' && e.op === 'scroll'), true);
  assert.equal(events.some((e) => e.name === 'Guest Stay' && e.op === 'evaluate'), true);
  assert.equal(events.some((e) => e.name === 'Guest Stay' && e.op === 'click' && e.timeout === 2000), true);
});

test('openGuestStayScreen fails plainly when Guest Stay never opens', async () => {
  const { page } = fakeScreenPage({ neverOpen: true });
  await assert.rejects(openGuestStayScreen(page, { attempts: 2, waitMs: 1 }), /GUEST_STAY_NOT_OPENED/);
});

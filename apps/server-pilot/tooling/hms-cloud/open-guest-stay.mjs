// On the EC2 browser (no tunnel latency) a Guest Stay click made while Front Desk is still expanding is dropped and the
// screen never opens. Click Front Desk once, then click Guest Stay until the Guest Stay toolbar's New Record button is
// visible (same trap and fix as cancel-stay.mjs openGuestStay).
// Ext tree nodes can be visible-but-offscreen (HRDAV/HRCEN): Playwright then retries until its 20 s default. Try a short
// click; only a pure viewport miss (no mask intercepting) gets a DOM click. Anything else falls back to the old full click,
// so slow menus still get the page default timeout.
const TREE_CLICK_MS = 2000;
const VIEWPORT_MISS = /outside of the viewport/i;
const INTERCEPTED = /intercepts pointer events/i;

export function treeClickFallback(error) {
  const message = String(error?.message || error);
  if (VIEWPORT_MISS.test(message) && !INTERCEPTED.test(message)) return 'dom';
  return 'full';
}

async function clickTreeNode(locator) {
  try {
    await locator.click({ timeout: TREE_CLICK_MS });
  } catch (error) {
    if (treeClickFallback(error) === 'full') {
      await locator.click();
      return;
    }
    await locator.scrollIntoViewIfNeeded({ timeout: TREE_CLICK_MS }).catch(() => {});
    await locator.evaluate((el) => el.click());
  }
}

export async function openGuestStayScreen(page, { attempts = 3, waitMs = 8000 } = {}) {
  const node = (name) => page.locator('span.x-tree-node-text:visible').filter({ hasText: new RegExp(`^${name}$`) });
  const newRecord = page.locator('[data-qtip="New Record (Ctrl+N)"]').first();
  if (await newRecord.isVisible().catch(() => false)) return;
  await page.locator('a.app-menu-trigger:visible').click();
  await clickTreeNode(node('Front Desk'));
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    await page.waitForTimeout(800);
    await clickTreeNode(node('Guest Stay'));
    const opened = await newRecord.waitFor({ state: 'visible', timeout: waitMs }).then(() => true, () => false);
    if (opened) return;
  }
  throw new Error('GUEST_STAY_NOT_OPENED');
}

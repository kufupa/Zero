// On the EC2 browser (no tunnel latency) a Guest Stay click made while Front Desk is still expanding is dropped and the
// screen never opens. Click Front Desk once, then click Guest Stay until the Guest Stay toolbar's New Record button is
// visible (same trap and fix as cancel-stay.mjs openGuestStay).
// Ext tree nodes can be visible-but-offscreen (HRDAV/HRCEN). Playwright then retries the page's 20 s default.
const TREE_CLICK_MS = 2000;
const VIEWPORT_MISS = /outside of the viewport/i;

async function clickTreeNode(locator) {
  try {
    await locator.click({ timeout: TREE_CLICK_MS });
  } catch (error) {
    if (!VIEWPORT_MISS.test(String(error?.message || error))) throw error;
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

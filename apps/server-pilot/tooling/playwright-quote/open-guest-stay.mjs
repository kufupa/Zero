// On the EC2 browser (no tunnel latency) a Guest Stay click made while Front Desk is still expanding is dropped and the
// screen never opens. Click Front Desk once, then click Guest Stay until the Guest Stay toolbar's New Record button is
// visible (same trap and fix as cancel-stay.mjs openGuestStay).
export async function openGuestStayScreen(page, { attempts = 3, waitMs = 8000 } = {}) {
  const node = (name) => page.locator('span.x-tree-node-text:visible').filter({ hasText: new RegExp(`^${name}$`) });
  const newRecord = page.locator('[data-qtip="New Record (Ctrl+N)"]').first();
  if (await newRecord.isVisible().catch(() => false)) return;
  await page.locator('a.app-menu-trigger:visible').click();
  await node('Front Desk').click();
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    await page.waitForTimeout(800);
    await node('Guest Stay').click();
    const opened = await newRecord.waitFor({ state: 'visible', timeout: waitMs }).then(() => true, () => false);
    if (opened) return;
  }
  throw new Error('GUEST_STAY_NOT_OPENED');
}

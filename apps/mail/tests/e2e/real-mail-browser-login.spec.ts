import { test, expect } from '@playwright/test';
import {
  requireRealMailPassword,
  uiLoginAsNavaai,
  REAL_MAIL_USER,
} from './helpers/real-mail';

/**
 * AE1 — Browser UI login (not curl-only session mint).
 */
test.describe('real-mail browser login (AE1)', () => {
  // Fresh context — no storageState from mint.
  test.use({ storageState: { cookies: [], origins: [] } });

  test('UI form login lands in inbox', async ({ page }) => {
    // Ensures password env is present before UI work (fail fast).
    requireRealMailPassword();

    await uiLoginAsNavaai(page);

    await expect(page).toHaveURL(/\/mail(\/|$)/);
    // Proof we used the form path: session user visible or inbox chrome.
    await expect(
      page.getByText(REAL_MAIL_USER, { exact: false }).or(page.getByText('Inbox', { exact: true })).first(),
    ).toBeVisible({ timeout: 30_000 });

    await page.reload({ waitUntil: 'domcontentloaded' });
    await expect(page).toHaveURL(/\/mail(\/|$)/);
    await expect(
      page
        .getByText(REAL_MAIL_USER, { exact: false })
        .or(page.getByText('Inbox', { exact: true }))
        .first(),
    ).toBeVisible({ timeout: 30_000 });
  });
});

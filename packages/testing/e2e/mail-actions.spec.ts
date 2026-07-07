import { test, expect } from '@playwright/test';
import { dismissMailOnboarding, expectPilotInboxVisible } from './helpers/mail-inbox';

test.describe('Mail actions (pilot context menu)', () => {
  test('thread context menu exposes reply actions', async ({ page }) => {
    await page.goto('/mail/inbox');
    await page.waitForLoadState('domcontentloaded');

    await dismissMailOnboarding(page);
    await expectPilotInboxVisible(page);

    const firstEmail = page.locator('[data-thread-id]').first();
    await expect(firstEmail).toBeVisible({ timeout: 15000 });

    await firstEmail.click({ button: 'right' });
    await expect(page.getByRole('menuitem', { name: 'Reply' })).toBeVisible({ timeout: 5000 });
    await expect(page.getByRole('menuitem', { name: 'Forward' })).toBeVisible();
    console.log('Pilot thread context menu exposes reply actions');
  });
});

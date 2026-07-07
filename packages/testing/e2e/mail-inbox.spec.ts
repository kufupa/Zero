import { test, expect } from '@playwright/test';
import { dismissMailOnboarding, expectPilotInboxVisible } from './helpers/mail-inbox';

test.describe('Pilot mail thread reply', () => {
  test('opens an existing thread and surfaces reply affordances', async ({ page }) => {
    await page.goto('/mail/inbox');
    await page.waitForLoadState('domcontentloaded');

    await dismissMailOnboarding(page);
    await expectPilotInboxVisible(page);

    const firstThread = page.locator('[data-thread-id]').first();
    await expect(firstThread).toBeVisible({ timeout: 15000 });
    await firstThread.click();

    const replyButton = page.getByRole('button', { name: 'Reply' }).first();
    await expect(replyButton).toBeVisible({ timeout: 15000 });
    console.log('Pilot thread view exposes reply affordance');
  });
});

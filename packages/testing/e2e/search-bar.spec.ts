import { test, expect } from '@playwright/test';
import { dismissMailOnboarding, expectPilotInboxVisible, openCommandPalette } from './helpers/mail-inbox';

test.describe('Command palette (pilot)', () => {
  test('navigates between inbox and drafts from the palette', async ({ page }) => {
    await page.goto('/mail/inbox');
    await page.waitForLoadState('domcontentloaded');

    await dismissMailOnboarding(page);
    await expectPilotInboxVisible(page);

    await openCommandPalette(page);
    await page.getByRole('option', { name: 'Drafts' }).click();
    await expect(page).toHaveURL(/\/mail\/drafts/, { timeout: 10000 });
    console.log('Command palette navigated to drafts');

    await openCommandPalette(page);
    await page.getByRole('option', { name: 'Inbox' }).click();
    await expect(page).toHaveURL(/\/mail\/inbox/, { timeout: 10000 });
    console.log('Command palette navigated back to inbox');
  });
});

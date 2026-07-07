import { test, expect } from '@playwright/test';
import { dismissMailOnboarding, expectPilotInboxVisible, openCommandPalette } from './helpers/mail-inbox';

const canRunLiveSearchE2E = Boolean(
  process.env.PLAYWRIGHT_SESSION_TOKEN && process.env.PLAYWRIGHT_SESSION_DATA,
);

test.describe('Command palette (pilot)', () => {
  test('applies a live search query from the command palette', async ({ page }) => {
    test.skip(!canRunLiveSearchE2E, 'Requires PLAYWRIGHT_SESSION_TOKEN and PLAYWRIGHT_SESSION_DATA');

    await page.goto('/mail/inbox');
    await page.waitForLoadState('domcontentloaded');

    await dismissMailOnboarding(page);
    await expectPilotInboxVisible(page);

    const searchQuery = `e2e-search-${Date.now()}`;

    await openCommandPalette(page);
    const searchInput = page.getByPlaceholder('Type a command or search...');
    await expect(searchInput).toBeVisible({ timeout: 5000 });
    await searchInput.fill(searchQuery);
    await searchInput.press('Enter');

    await expect(page.locator('[cmdk-dialog], [role="dialog"]').first()).not.toBeVisible({
      timeout: 5000,
    });

    const threadRows = page.locator('[data-thread-id]');
    const emptyState = page.getByText("It's empty here");
    await expect(threadRows.first().or(emptyState)).toBeVisible({ timeout: 15000 });
    console.log('Live search query applied; thread list or empty state visible');
  });

  test('navigates between inbox and drafts from the palette', async ({ page }) => {
    await page.goto('/mail/inbox');
    await page.waitForLoadState('domcontentloaded');

    await dismissMailOnboarding(page);
    await expectPilotInboxVisible(page);

    await openCommandPalette(page);
    await page.getByRole('option', { name: 'Drafts' }).click();
    await expect(page).toHaveURL(/\/mail\/draft/, { timeout: 10000 });
    console.log('Command palette navigated to drafts');

    await openCommandPalette(page);
    await page.getByRole('option', { name: 'Inbox' }).click();
    await expect(page).toHaveURL(/\/mail\/inbox/, { timeout: 10000 });
    console.log('Command palette navigated back to inbox');
  });
});

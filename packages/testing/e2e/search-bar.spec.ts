import {
  dismissMailOnboarding,
  expectPilotInboxVisible,
  focusMailSearch,
} from './helpers/mail-inbox';
import { test, expect } from '@playwright/test';

const canRunLiveSearchE2E = Boolean(
  process.env.PLAYWRIGHT_SESSION_TOKEN && process.env.PLAYWRIGHT_SESSION_DATA,
);

test.describe('Header search (pilot)', () => {
  test.skip(!canRunLiveSearchE2E, 'Requires PLAYWRIGHT_SESSION_TOKEN and PLAYWRIGHT_SESSION_DATA');

  test.beforeEach(async ({ page }) => {
    await page.goto('/mail/inbox');
    await page.waitForLoadState('domcontentloaded');

    await dismissMailOnboarding(page);
    await expectPilotInboxVisible(page);
  });

  test('applies a live search query from the header input', async ({ page }) => {
    const searchQuery = `e2e-search-${Date.now()}`;

    await focusMailSearch(page);
    const searchInput = page.getByRole('searchbox', { name: 'Search mail' });
    await searchInput.fill(searchQuery);
    await searchInput.press('Enter');

    await expect(page.getByRole('dialog')).toHaveCount(0);

    const threadRows = page.locator('[data-thread-id]');
    const emptyState = page.getByText(/No emails match/);
    await expect(threadRows.first().or(emptyState)).toBeVisible({ timeout: 15_000 });
  });

  test('shows current-folder scope and all-folders option', async ({ page }) => {
    const scopeButton = page.getByRole('button', { name: 'Inbox', exact: true });
    await expect(scopeButton).toBeVisible();

    await scopeButton.click();
    await expect(
      page.getByRole('menuitemradio', { name: 'All folders', exact: true }),
    ).toBeVisible();
  });

  test('does not apply Unread until selected in Filters', async ({ page }) => {
    await expect(page.getByRole('button', { name: 'Remove Unread' })).toHaveCount(0);

    await page.getByRole('button', { name: 'Filters', exact: true }).click();
    const unreadFilter = page.getByRole('menuitemcheckbox', { name: 'Unread', exact: true });
    await expect(unreadFilter).toHaveAttribute('aria-checked', 'false');

    await unreadFilter.click();
    await expect(page.getByRole('button', { name: 'Remove Unread' })).toBeVisible();
  });
});

test.describe('Header search shortcut (pilot)', () => {
  test.skip(!canRunLiveSearchE2E, 'Requires PLAYWRIGHT_SESSION_TOKEN and PLAYWRIGHT_SESSION_DATA');

  test('does not require a mail search input on settings', async ({ page }) => {
    await page.goto('/settings/shortcuts');
    await page.waitForLoadState('domcontentloaded');

    await expect(page.locator('#mail-search')).toHaveCount(0);
    const pageErrors: Error[] = [];
    page.once('pageerror', (error) => pageErrors.push(error));
    await page.keyboard.press('Control+k');
    expect(pageErrors).toHaveLength(0);
    await expect(page.locator('#mail-search')).toHaveCount(0);
  });
});

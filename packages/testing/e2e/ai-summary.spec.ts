import { test, expect } from '@playwright/test';

const email = process.env.EMAIL;

if (!email) {
  throw new Error('EMAIL environment variable must be set.');
}

test.describe('Pilot mail inbox (AI inert)', () => {
  test('inbox loads and AI sidebar affordances stay hidden', async ({ page }) => {
    await page.goto('/mail/inbox');
    await page.waitForLoadState('domcontentloaded');
    console.log('Successfully accessed mail inbox');

    await page.waitForTimeout(2000);
    try {
      const welcomeModal = page.getByText('Welcome to Zero Email!');
      if (await welcomeModal.isVisible({ timeout: 2000 })) {
        console.log('Onboarding modal detected, dismissing...');
        await page.locator('body').click({ position: { x: 100, y: 100 } });
        await page.waitForTimeout(1500);
        console.log('Modal successfully dismissed');
      }
    } catch {
      console.log('No onboarding modal found, proceeding...');
    }

    await expect(page.getByText('Inbox')).toBeVisible();
    console.log('Mail inbox is now visible');

    await page.keyboard.press('Meta+0');
    await expect(page.locator('form#ai-chat-form')).not.toBeVisible({ timeout: 3000 });
    console.log('AI chat sidebar correctly absent in pilot mode');

    const threadRows = page.locator('[data-thread-id], [data-testid="thread-row"], tr, [role="row"]');
    await expect(threadRows.first()).toBeVisible({ timeout: 15000 });
    console.log('Inbox thread list remains usable without AI');
  });
});
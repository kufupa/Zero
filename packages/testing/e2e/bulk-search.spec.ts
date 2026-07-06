import { test, expect } from '@playwright/test';

test.describe('Pilot mail inbox (AI sidebar inert)', () => {
  test('inbox usable when aiSidebar query param is set', async ({ page }) => {
    await page.goto('/mail/inbox?aiSidebar=true');
    await page.waitForLoadState('domcontentloaded');
    console.log('Successfully accessed mail inbox with aiSidebar query');

    await page.waitForTimeout(2000);
    try {
      const welcomeModal = page.getByText('Welcome to Zero Email!');
      if (await welcomeModal.isVisible({ timeout: 2000 })) {
        console.log('Onboarding modal detected, clicking outside to dismiss...');
        await page.locator('body').click({ position: { x: 100, y: 100 } });
        await page.waitForTimeout(1500);
        console.log('Modal successfully dismissed');
      }
    } catch {
      console.log('No onboarding modal found, proceeding...');
    }

    await expect(page.getByText('Inbox')).toBeVisible();
    console.log('Mail inbox is now visible');

    await expect(page.locator('form#ai-chat-form')).not.toBeVisible({ timeout: 3000 });
    await expect(page.locator('.ProseMirror[contenteditable="true"]')).not.toBeVisible({ timeout: 3000 });
    console.log('AI chat editor correctly absent in pilot mode');

    const threadRows = page.locator('[data-thread-id], [data-testid="thread-row"], tr, [role="row"]');
    await expect(threadRows.first()).toBeVisible({ timeout: 15000 });
    console.log('Pilot inbox remains usable without AI bulk search');
  });
});

import { test, expect } from '@playwright/test';
import { dismissMailOnboarding, expectPilotInboxVisible } from './helpers/mail-inbox';

test.describe('Pilot mail inbox (AI sidebar inert)', () => {
  test('inbox usable when aiSidebar query param is set', async ({ page }) => {
    await page.goto('/mail/inbox?aiSidebar=true');
    await page.waitForLoadState('domcontentloaded');
    console.log('Successfully accessed mail inbox with aiSidebar query');

    await dismissMailOnboarding(page);

    await expectPilotInboxVisible(page);
    console.log('Mail inbox is now visible');

    await expect(page.locator('form#ai-chat-form')).not.toBeVisible({ timeout: 3000 });
    await expect(page.locator('.ProseMirror[contenteditable="true"]')).not.toBeVisible({ timeout: 3000 });
    console.log('AI chat editor correctly absent in pilot mode');

    const threadRows = page.locator('[data-thread-id], [data-testid="thread-row"], tr, [role="row"]');
    await expect(threadRows.first()).toBeVisible({ timeout: 15000 });
    console.log('Pilot inbox remains usable without AI bulk search');
  });
});

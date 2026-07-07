import { test, expect } from '@playwright/test';
import { dismissMailOnboarding, expectPilotInboxVisible } from './helpers/mail-inbox';

test.describe('Mail actions: favorite, read, unread', () => {
  test('should allow marking an email as favorite, read, and unread', async ({ page }) => {
    await page.goto('/mail/inbox');
    await page.waitForLoadState('domcontentloaded');
    console.log('Successfully accessed mail inbox');

    await dismissMailOnboarding(page);
    
    await expectPilotInboxVisible(page);
    console.log('Mail inbox is now visible');

    const firstEmail = page.locator('[data-thread-id]').first();
    await expect(firstEmail).toBeVisible();
    console.log('Found first email');

    await firstEmail.click({ button: 'right' });
    await page.waitForTimeout(500);

    const markAsReadButton = page.getByText('Mark as read');
    const isInitiallyUnread = await markAsReadButton.isVisible();

    if (isInitiallyUnread) {
        console.log('Email is unread. Marking as read...');
        await markAsReadButton.click();
        console.log('Marked email as read.');
    } else {
        console.log('Email is read. Marking as unread...');
        const markAsUnreadButton = page.getByText('Mark as unread');
        await expect(markAsUnreadButton).toBeVisible();
        await markAsUnreadButton.click();
        console.log('Marked email as unread.');
    }
    await page.waitForTimeout(1000);

    console.log('Right-clicking on email to favorite...');
    await firstEmail.click({ button: 'right' });
    await page.waitForTimeout(500);
    await page.getByText('Favorite').click();
    console.log('Clicked "Favorite"');
    await page.waitForTimeout(1000);

    console.log('Right-clicking on email to toggle read state again...');
    await firstEmail.click({ button: 'right' });
    await page.waitForTimeout(500);

    if (isInitiallyUnread) {
        const markAsUnreadButton = page.getByText('Mark as unread');
        await expect(markAsUnreadButton).toBeVisible();
        await markAsUnreadButton.click();
        console.log('Marked email as unread.');
    } else {
        const markAsReadButtonAgain = page.getByText('Mark as read');
        await expect(markAsReadButtonAgain).toBeVisible();
        await markAsReadButtonAgain.click();
        console.log('Marked email as read.');
    }
    
    await page.waitForTimeout(1000);

    console.log('Entire email actions flow completed successfully!');
  });
});

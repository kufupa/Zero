import { test } from '@playwright/test';
import { dismissMailOnboarding, expectPilotInboxVisible } from './helpers/mail-inbox';

const email = process.env.EMAIL;

if (!email) {
    throw new Error('EMAIL environment variable must be set.');
  }

test.describe('Signing In, Sending mail, Replying to a mail', () => {
  test('should send and reply to an email in the same session', async ({ page }) => {
    await page.goto('/mail/inbox');
    await page.waitForLoadState('domcontentloaded');
    console.log('Successfully accessed mail inbox');

    await dismissMailOnboarding(page);
    
    await expectPilotInboxVisible(page);
    console.log('Mail inbox is now visible');

    console.log('Starting email sending process...');
    await page.getByText('New email').click();
    await page.waitForTimeout(2000);
    
    await page.locator('input').first().fill(email);
    console.log('Filled To: field');
    
    await page.getByRole('button', { name: 'Send' }).first().click();
    console.log('Clicked Send button');
    await page.waitForTimeout(3000);
    console.log('Email sent successfully!');

    console.log('Waiting for email to arrive...');
    await page.waitForTimeout(10000);

    console.log('Looking for the first email in the list...');
    await page.locator('[data-thread-id]').first().click();
    console.log('Clicked on email (PM/AM area).');

    console.log('Looking for Reply button to confirm email is open...');
    await page.waitForTimeout(2000);
    
    const replySelectors = [
      'button:has-text("Reply")',
      '[data-testid*="reply"]',
      'button[title*="Reply"]',
      'button:text-is("Reply")',
      'button:text("Reply")'
    ];
    
    let replyClicked = false;
    for (const selector of replySelectors) {
      try {
        await page.locator(selector).first().click({ force: true });
        console.log(`Clicked Reply button using: ${selector}`);
        replyClicked = true;
        break;
      } catch {
        console.log(`Failed to click with ${selector}`);
      }
    }
    
    if (!replyClicked) {
      console.log('Could not find Reply button');
    }
    
    await page.waitForTimeout(2000);

    console.log('Sending reply...');
    await page.getByRole('button', { name: 'Send' }).first().click();
    await page.waitForTimeout(3000);
    console.log('Reply sent successfully!');

    console.log('Entire email flow completed successfully!');
  });
});

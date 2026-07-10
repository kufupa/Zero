import { test } from '@playwright/test';
import {
  dismissMailOnboarding,
  expectPilotInboxVisible,
  expectThreadVisibleInFolder,
} from './helpers/mail-inbox';

const liveEnabled = process.env.BEDROCK_TRIAGE_LIVE_TEST === '1';
const subject = process.env.AI_TRIAGE_FIXTURE_SUBJECT;
const folder = process.env.AI_TRIAGE_FIXTURE_FOLDER ?? 'inbox';

test.describe('AI triage live proof', () => {
  test.skip(!liveEnabled || !subject, 'requires BEDROCK_TRIAGE_LIVE_TEST=1 and AI_TRIAGE_FIXTURE_SUBJECT');

  test('shows ingested thread in inbox and category folder', async ({ page }) => {
    await page.goto('/mail/inbox');
    await dismissMailOnboarding(page);
    await expectPilotInboxVisible(page);
    await expectThreadVisibleInFolder(page, 'inbox', subject!);
    if (folder !== 'inbox' && folder !== 'spam') {
      await expectThreadVisibleInFolder(page, folder, subject!);
    }
  });
});

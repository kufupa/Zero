import { test } from '@playwright/test';
import {
  dismissMailOnboarding,
  expectAiDraftCardVisible,
  expectPilotInboxVisible,
  expectThreadVisibleInFolder,
} from './helpers/mail-inbox';

const liveEnabled = process.env.BEDROCK_PIPELINE_LIVE_TEST === '1';
const fixtureSubject = process.env.AI_PIPELINE_FIXTURE_SUBJECT;

test.describe('AI mail pipeline live proof', () => {
  test.skip(!liveEnabled || !fixtureSubject, 'requires BEDROCK_PIPELINE_LIVE_TEST=1 and AI_PIPELINE_FIXTURE_SUBJECT');

  test('shows ingested thread in inbox, category route, and AI draft card', async ({ page }) => {
    const subject = fixtureSubject!;

    await page.goto('/mail/inbox');
    await dismissMailOnboarding(page);
    await expectPilotInboxVisible(page);
    await expectThreadVisibleInFolder(page, 'inbox', subject);

    await expectThreadVisibleInFolder(page, 'group', subject);

    await page.getByText(subject).first().click();
    await expectAiDraftCardVisible(page);
  });
});

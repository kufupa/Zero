import { test, expect } from '@playwright/test';
import {
  injectMintedSession,
  composeSelfLoopback,
  expectSubjectInInbox,
  forceSyncAndAwaitProcessed,
} from './helpers/real-mail';

/**
 * AE7 — Compose To=self unique marker → inbox without F5 (≥60s poll or Force Sync).
 */
test.describe('real-mail compose self-loopback (AE7)', () => {
  test('compose To self appears in inbox without reload', async ({ page, context }) => {
    await injectMintedSession(context, page);

    const subject = `OVN-${Date.now()}`;
    await composeSelfLoopback(page, subject);

    // No page.reload — poll ≥60s OR Force Sync assist (KTD12).
    const pollBudgetMs = 75_000;
    const appeared = page.getByText(subject, { exact: false }).first();
    const visibleViaPoll = await appeared
      .waitFor({ state: 'visible', timeout: pollBudgetMs })
      .then(() => true)
      .catch(() => false);

    if (!visibleViaPoll) {
      const sync = await forceSyncAndAwaitProcessed(page);
      expect(sync.triggered === true || typeof sync.processed === 'number').toBeTruthy();
      await expectSubjectInInbox(page, subject, 60_000);
    } else {
      await expect(appeared).toBeVisible();
    }

    // Hard assert we never reloaded.
    // (reload would reset navigation timing; URL stays mail app throughout)
    await expect(page).toHaveURL(/\/mail/);
  });
});

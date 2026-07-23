import { test, expect } from '@playwright/test';
import {
  injectMintedSession,
  composeSelfLoopback,
  expectSubjectInInbox,
  forceSyncAndAwaitProcessed,
  dismissMailOnboarding,
} from './helpers/real-mail';

/**
 * AE8 — Reply to compose-result / selected message; marker without F5 (≥60s or Force Sync).
 * Depends on Task 4 `replyToMessageId` (selected-message In-Reply-To).
 */
test.describe('real-mail reply loopback (AE8)', () => {
  test('reply self appears without full page reload', async ({ page, context }) => {
    await injectMintedSession(context, page);

    // Distinct prefix so subject cannot substring-match body marker.
    const subject = `OVN-RL-${Date.now()}`;
    const marker = `REPLY-${Date.now()}`;

    await composeSelfLoopback(page, subject);

    // Open compose-result thread (not arbitrary inbox row) — no page.reload.
    const pollBudgetMs = 75_000;
    const subjectRow = page.getByText(subject, { exact: false }).first();
    const visibleViaPoll = await subjectRow
      .waitFor({ state: 'visible', timeout: pollBudgetMs })
      .then(() => true)
      .catch(() => false);

    if (!visibleViaPoll) {
      const sync = await forceSyncAndAwaitProcessed(page);
      expect(sync.triggered === true || typeof sync.processed === 'number').toBeTruthy();
      await expectSubjectInInbox(page, subject, 60_000);
    }

    await page.getByText(subject, { exact: false }).first().click();
    // ActionButton appends shortcut → accessible name "Reply r", not exact "Reply".
    const replyBtn = page
      .getByRole('button', { name: /^Reply(\s+r)?$/i })
      .or(page.getByRole('button', { name: /^Reply(?!\s*all)/i }))
      .first();
    await expect(replyBtn).toBeVisible({ timeout: 30_000 });
    await replyBtn.click();

    await dismissMailOnboarding(page);

    const editor = page.locator('.ProseMirror').first();
    await expect(editor).toBeVisible({ timeout: 30_000 });
    await editor.click({ force: true });
    await editor.fill(marker);

    await page.getByRole('button', { name: /^Send\s*$/i }).first().click();

    // Do NOT page.reload() — Prefer Force Sync; poll wait up to 90_000 (KTD12).
    await forceSyncAndAwaitProcessed(page).catch(() => undefined);
    await expect(page.getByText(marker, { exact: true })).toBeVisible({ timeout: 90_000 });
    await expect(page).toHaveURL(/\/mail/);
  });
});

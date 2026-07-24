import { test, expect, type Page } from '@playwright/test';
import {
  injectMintedSession,
  dismissMailOnboarding,
} from './helpers/real-mail';

/**
 * Compose-close draft honesty — AE1–AE4 on live pilot SPA.
 * Plan: docs/superpowers/plans/2026-07-24-compose-close-draft-honesty.md
 */

async function clearBlockingOverlays(page: Page) {
  await dismissMailOnboarding(page);
  // Radix modal backdrop (onboarding / dialogs) blocks thread-row clicks.
  for (let i = 0; i < 6; i++) {
    const overlay = page.locator('div.fixed.inset-0[data-state="open"]').first();
    if (!(await overlay.isVisible({ timeout: 400 }).catch(() => false))) break;
    await page.keyboard.press('Escape');
    await page.waitForTimeout(250);
    await dismissMailOnboarding(page);
  }
}

async function openFirstThread(page: Page) {
  await clearBlockingOverlays(page);
  const row = page.locator('[data-thread-id]').first();
  await expect(row).toBeVisible({ timeout: 60_000 });
  const threadId = await row.getAttribute('data-thread-id');
  expect(threadId).toBeTruthy();
  await row.click({ force: true });
  return threadId as string;
}

async function openReply(page: Page) {
  await dismissMailOnboarding(page);
  await clearBlockingOverlays(page);

  // Prefer sticky action-bar / continue-draft — per-message Reply often sits under scroll/chips.
  const continueDraft = page.getByRole('button', { name: /^Continue draft$/i }).first();
  const replyBar = page.getByRole('button', { name: /^Reply(\s+r)?$/i }).last();
  const replyMsg = page.getByRole('button', { name: /^Reply$/i }).last();

  if (await continueDraft.isVisible({ timeout: 2_000 }).catch(() => false)) {
    await continueDraft.click({ force: true });
  } else if (await replyBar.isVisible({ timeout: 5_000 }).catch(() => false)) {
    await replyBar.click({ force: true });
  } else if (await replyMsg.isVisible({ timeout: 5_000 }).catch(() => false)) {
    await replyMsg.click({ force: true });
  } else {
    // Hotkey path (thread-display scope)
    await page.keyboard.press('r');
  }

  await dismissMailOnboarding(page);
  const editor = page.locator('.ProseMirror').first();
  await expect(editor).toBeVisible({ timeout: 30_000 });
  return editor;
}

async function closeComposeViaEscape(page: Page) {
  await page.keyboard.press('Escape');
}

async function expectHonestCloseDialog(page: Page) {
  await expect(page.getByRole('heading', { name: 'Close draft?' })).toBeVisible({
    timeout: 15_000,
  });
  await expect(page.getByText(/changes will be lost/i)).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Keep editing', exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Save draft', exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Discard', exact: true })).toBeVisible();
  // Old Stay/Leave chrome must be gone
  await expect(page.getByRole('button', { name: 'Stay', exact: true })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Leave', exact: true })).toHaveCount(0);
}

test.describe('real-mail compose-close honesty', () => {
  test('AE4 empty Reply+Escape closes silent (no dialog)', async ({ page, context }) => {
    await injectMintedSession(context, page);
    await openFirstThread(page);
    const editor = await openReply(page);

    await closeComposeViaEscape(page);

    await expect(page.getByRole('heading', { name: 'Close draft?' })).toHaveCount(0);
    await expect(editor).toBeHidden({ timeout: 15_000 });
  });

  test('AE2 type → Escape → Save draft keeps body on reopen', async ({ page, context }) => {
    await injectMintedSession(context, page);
    await openFirstThread(page);
    const editor = await openReply(page);

    const marker = `CLOSE-SAVE-${Date.now()}`;
    await editor.click({ force: true });
    await editor.fill(marker);

    await closeComposeViaEscape(page);
    await expectHonestCloseDialog(page);
    await page.getByRole('button', { name: 'Save draft', exact: true }).click();

    await expect(page.getByRole('heading', { name: 'Close draft?' })).toHaveCount(0);
    await expect(editor).toBeHidden({ timeout: 15_000 });

    // Re-open reply — server draft should hydrate marker
    const editor2 = await openReply(page);
    await expect(editor2).toContainText(marker, { timeout: 30_000 });

    // Cleanup: discard so pilot drafts stay tidy
    await closeComposeViaEscape(page);
    if (await page.getByRole('heading', { name: 'Close draft?' }).isVisible().catch(() => false)) {
      await page.getByRole('button', { name: 'Discard', exact: true }).click();
    }
  });

  test('AE1 autosave then Discard removes draft on reopen', async ({ page, context }) => {
    await injectMintedSession(context, page);
    await openFirstThread(page);
    const editor = await openReply(page);

    const marker = `CLOSE-DISCARD-${Date.now()}`;
    await editor.click({ force: true });
    await editor.fill(marker);

    // Autosave debounce is 3s
    await page.waitForTimeout(4_000);

    await closeComposeViaEscape(page);
    await expectHonestCloseDialog(page);
    await page.getByRole('button', { name: 'Discard', exact: true }).click();

    await expect(page.getByRole('heading', { name: 'Close draft?' })).toHaveCount(0);
    await expect(editor).toBeHidden({ timeout: 15_000 });

    const editor2 = await openReply(page);
    await expect(editor2).not.toContainText(marker, { timeout: 15_000 });
    await closeComposeViaEscape(page);
  });

  test('AE3 dirty reply → fast other-thread click keeps body', async ({ page, context }) => {
    await injectMintedSession(context, page);
    await clearBlockingOverlays(page);

    const rows = page.locator('[data-thread-id]');
    await expect(rows.first()).toBeVisible({ timeout: 60_000 });
    const count = await rows.count();
    test.skip(count < 2, 'need ≥2 inbox threads for AE3');

    const threadA = await rows.nth(0).getAttribute('data-thread-id');
    const threadB = await rows.nth(1).getAttribute('data-thread-id');
    expect(threadA).toBeTruthy();
    expect(threadB).toBeTruthy();
    expect(threadA).not.toBe(threadB);

    await rows.nth(0).click({ force: true });
    const editor = await openReply(page);
    const marker = `CLOSE-SWITCH-${Date.now()}`;
    await editor.click({ force: true });
    await editor.fill(marker);

    // Switch within autosave window (<3s)
    await page.locator(`[data-thread-id="${threadB}"]`).first().click({ force: true });
    await expect(page.getByRole('heading', { name: 'Close draft?' })).toHaveCount(0);

    // Return to A + Reply — flushed draft should restore marker
    await page.locator(`[data-thread-id="${threadA}"]`).first().click({ force: true });
    const editor2 = await openReply(page);
    await expect(editor2).toContainText(marker, { timeout: 30_000 });

    await closeComposeViaEscape(page);
    if (await page.getByRole('heading', { name: 'Close draft?' }).isVisible().catch(() => false)) {
      await page.getByRole('button', { name: 'Discard', exact: true }).click();
    }
  });
});

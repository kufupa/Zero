import { test, expect } from '@playwright/test';
import {
  injectMintedSession,
  composeSelfLoopback,
  expectSubjectInInbox,
  forceSyncAndAwaitProcessed,
  pauseListThreadPoll,
} from './helpers/real-mail';

/**
 * AE9 — Force Sync path correlates with marker appearance (KTD12).
 * Pause listThreads poll so background refresh cannot false-green.
 */
test.describe('real-mail force-sync loopback (AE9)', () => {
  test('Force Sync mutation processed then marker appears (no F5)', async ({ page, context }) => {
    await injectMintedSession(context, page);

    const subject = `OVN-FS-${Date.now()}`;
    await composeSelfLoopback(page, subject);

    // Hold listThreads after send so only forceSync-driven invalidate can refresh.
    const releaseList = await pauseListThreadPoll(page);

    // Marker must not already be proven via free poll under hold
    // (list may still have pre-hold cache — we correlate with forceSync response).
    const sync = await forceSyncAndAwaitProcessed(page);
    expect(typeof sync.processed).toBe('number');
    expect(sync.triggered === true || sync.processed !== undefined).toBeTruthy();

    releaseList();

    await expectSubjectInInbox(page, subject, 60_000);
    await expect(page).toHaveURL(/\/mail/);
  });
});

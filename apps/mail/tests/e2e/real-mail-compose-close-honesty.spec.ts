import {
  test,
  expect,
  type APIRequestContext,
  type Locator,
  type Page,
  type Request,
} from '@playwright/test';
import {
  injectMintedSession,
  dismissMailOnboarding,
  uiLoginAsNavaai,
} from './helpers/real-mail';

/**
 * Compose-close draft honesty — AE1–AE4 on live pilot SPA.
 * Plan: docs/superpowers/plans/2026-07-24-compose-close-draft-honesty.md
 */

const U3_REPLY_BUTTON_NAME = /^Reply(?:\s+(?:r|\(r\)|\[r\]|⌘\s*r|Ctrl\+r))?$/i;
const U3_REPLY_ALL_BUTTON_NAME = /^Reply\s+All(?:\s+(?:a|\(a\)|\[a\]|⌘\s*a|Ctrl\+a))?$/i;
const RUN_REAL_MAIL_REPLY_VIEWPORT_REGRESSION =
  process.env.REAL_MAIL_UI_GATE === '1' &&
  process.env.REAL_MAIL_REPLY_VIEWPORT_REGRESSION === '1' &&
  process.env.REAL_MAIL_READ_ONLY === '0';
const U3_TEST_THREAD_ID = process.env.REAL_MAIL_REPLY_VIEWPORT_THREAD_ID?.trim();
const U3_TEST_DRAFT_ID = process.env.REAL_MAIL_REPLY_VIEWPORT_DRAFT_ID?.trim();
const U3_TEST_DRAFT_MARKER = process.env.REAL_MAIL_REPLY_VIEWPORT_DRAFT_MARKER?.trim();

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
  await row.evaluate((el) => (el as HTMLElement).click());
  return threadId as string;
}

async function clickVisibleU3RoleButton(
  page: Page,
  name: RegExp,
  actionName: string,
) {
  for (let attempt = 0; attempt < 40; attempt++) {
    const candidates = page.getByRole('button', { name });
    const count = await candidates.count();
    for (let index = 0; index < count; index++) {
      const candidate = candidates.nth(index);
      if (!(await candidate.isVisible().catch(() => false))) continue;
      await candidate.scrollIntoViewIfNeeded();
      try {
        await candidate.click({ timeout: 1_000 });
        return;
      } catch {
        // Re-query after transient actionability failures such as an animating overlay.
      }
    }
    await page.waitForTimeout(250);
  }

  throw new Error(`Could not find visible ${actionName} action`);
}

async function openReply(page: Page, threadId?: string | null) {
  await dismissMailOnboarding(page);

  if (threadId) {
    const onThread = page.url().includes(threadId);
    if (!onThread) {
      await page.locator(`[data-thread-id="${threadId}"]`).first().evaluate((el) =>
        (el as HTMLElement).click(),
      );
    }
  }

  // Wait for sticky action bar (Reply r). Use native DOM click — Playwright
  // pointer clicks get intercepted by recipient chips / border-t footers.
  const replyBar = page.getByRole('button', { name: /^Reply r$/i }).first();
  await expect(replyBar).toBeVisible({ timeout: 60_000 });
  await replyBar.evaluate((el) => (el as HTMLButtonElement).click());

  const editor = page.locator('.ProseMirror').first();
  try {
    await expect(editor).toBeVisible({ timeout: 15_000 });
  } catch {
    // Fallback: hotkey (thread-display scope)
    await page.keyboard.press('r');
    await expect(editor).toBeVisible({ timeout: 30_000 });
  }
  return editor;
}

async function clickRole(page: Page, name: string | RegExp, exact = false) {
  const btn = page.getByRole('button', { name, exact });
  await expect(btn.first()).toBeVisible({ timeout: 15_000 });
  await btn.first().evaluate((el) => (el as HTMLButtonElement).click());
}

async function clickThreadRow(page: Page, threadId: string) {
  const row = page.locator(`[data-thread-id="${threadId}"]`).first();
  await expect(row).toBeVisible({ timeout: 30_000 });
  await row.evaluate((el) => (el as HTMLElement).click());
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

async function activeInlineReplyComposer(page: Page) {
  const composer = page.locator('[id^="reply-composer-"]:visible').first();
  await expect(composer).toBeVisible({ timeout: 30_000 });

  const viewport = composer.locator(
    'xpath=ancestor::*[@data-radix-scroll-area-viewport][1]',
  );
  await expect(viewport).toBeVisible({ timeout: 15_000 });
  return { composer, viewport };
}

async function openU3ReplyViaVisibleAction(page: Page) {
  await clickVisibleU3RoleButton(page, U3_REPLY_BUTTON_NAME, 'Reply');
  const reply = await activeInlineReplyComposer(page);
  await expect(reply.composer.locator('.ProseMirror')).toBeVisible({ timeout: 30_000 });
  return reply;
}

async function openU3DedicatedThread(page: Page, threadId: string) {
  const threadUrl = new URL(page.url());
  threadUrl.searchParams.set('threadId', threadId);
  threadUrl.searchParams.delete('mode');
  threadUrl.searchParams.delete('activeReplyId');
  threadUrl.searchParams.delete('draftId');
  await page.goto(threadUrl.toString());
  await expect
    .poll(() => new URL(page.url()).searchParams.get('threadId'), { timeout: 15_000 })
    .toBe(threadId);
}

function currentU3DraftId(page: Page) {
  return new URL(page.url()).searchParams.get('draftId');
}

function trpcDraftIdFromRequestPayload(payload: unknown): string | null {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return null;

  const calls = Object.values(payload as Record<string, unknown>);
  if (calls.length !== 1) return null;

  const call = calls[0];
  if (!call || typeof call !== 'object' || Array.isArray(call)) return null;
  const input = (call as Record<string, unknown>).json;
  if (!input || typeof input !== 'object' || Array.isArray(input)) return null;

  const draftId = (input as Record<string, unknown>).id;
  return typeof draftId === 'string' ? draftId : null;
}

function isExpectedU3DraftDeleteRequest(request: Request, expectedDraftId: string) {
  const postData = request.postData();
  if (request.method() !== 'POST' || !postData) {
    return false;
  }

  try {
    if (!new URL(request.url()).pathname.endsWith('/drafts.delete')) return false;
    return trpcDraftIdFromRequestPayload(JSON.parse(postData) as unknown) === expectedDraftId;
  } catch {
    return false;
  }
}

async function expectU3DraftId(page: Page, expectedDraftId: string) {
  await expect
    .poll(() => currentU3DraftId(page), { timeout: 30_000 })
    .toBe(expectedDraftId);
}

async function expectU3TestDraft(
  page: Page,
  composer: Locator,
  expectedDraftId: string,
  expectedDraftMarker: string,
) {
  await expectU3DraftId(page, expectedDraftId);
  await expect(composer.locator('.ProseMirror')).toContainText(expectedDraftMarker, {
    timeout: 30_000,
  });
}

async function isConfiguredBaseUrlHealthy(request: APIRequestContext, baseURL?: string) {
  if (!baseURL) return false;

  try {
    const response = await request.get('/health', {
      timeout: 10_000,
    });
    return response.ok();
  } catch {
    return false;
  }
}

function replyComposerControls(composer: Locator): Locator[] {
  return [
    composer
      .getByRole('button', { name: /^Send(?:\s+(?!later\b).+)?$/i })
      .first(),
    composer.getByRole('button', { name: /^Cc$/i }).first(),
    composer.getByRole('button', { name: /^Bcc$/i }).first(),
    composer.getByRole('button', { name: /^Close composer$/i }).first(),
  ];
}

async function replyControlsFitInsideViewport(composer: Locator, viewport: Locator) {
  const controls = replyComposerControls(composer);
  const [viewportBox, ...controlBoxes] = await Promise.all([
    viewport.boundingBox(),
    ...controls.map((control) => control.boundingBox()),
  ]);
  if (!viewportBox) return false;

  for (const controlBox of controlBoxes) {
    if (!controlBox) return false;

    const tolerance = 1;
    if (
      controlBox.x < viewportBox.x - tolerance ||
      controlBox.y < viewportBox.y - tolerance ||
      controlBox.x + controlBox.width > viewportBox.x + viewportBox.width + tolerance ||
      controlBox.y + controlBox.height > viewportBox.y + viewportBox.height + tolerance
    ) {
      return false;
    }
  }

  return true;
}

async function expectReplyControlsInsideThreadViewport(composer: Locator, viewport: Locator) {
  await expect
    .poll(() => replyControlsFitInsideViewport(composer, viewport), {
      message: 'active reply controls must fit fully inside their Radix thread viewport',
      timeout: 20_000,
    })
    .toBe(true);
}

async function expectNoViewportOrDocumentHorizontalOverflow(page: Page, viewport: Locator) {
  await expect
    .poll(
      async () => {
        const [viewportFits, documentFits] = await Promise.all([
          viewport.evaluate((element) => element.scrollWidth <= element.clientWidth + 1),
          page.evaluate(() => {
            const documentWidth = Math.max(
              document.documentElement.scrollWidth,
              document.body?.scrollWidth ?? 0,
              document.scrollingElement?.scrollWidth ?? 0,
            );
            return documentWidth <= window.innerWidth + 1;
          }),
        ]);
        return viewportFits && documentFits;
      },
      {
        message: 'thread viewport and document must not exceed the desktop viewport width',
        timeout: 15_000,
      },
    )
    .toBe(true);
}

async function discardU3ReplyDraft(
  page: Page,
  expectedDraftId: string,
  expectedDraftMarker: string,
) {
  let composer = page.locator('[id^="reply-composer-"]:visible').first();
  if (!(await composer.isVisible({ timeout: 5_000 }).catch(() => false))) {
    await clickVisibleU3RoleButton(page, U3_REPLY_BUTTON_NAME, 'Reply');
    composer = page.locator('[id^="reply-composer-"]:visible').first();
    await expect(composer).toBeVisible({ timeout: 30_000 });
  }
  await expectU3DraftId(page, expectedDraftId);

  const editor = composer.locator('.ProseMirror').first();
  await expect(editor).toBeVisible({ timeout: 15_000 });
  await expect(editor).toContainText(expectedDraftMarker, { timeout: 15_000 });
  await editor.click();
  await editor.type('!');

  const deleteWait = page.waitForResponse(
    (res) => isExpectedU3DraftDeleteRequest(res.request(), expectedDraftId),
    { timeout: 30_000 },
  );
  void deleteWait.catch(() => undefined);

  await closeComposeViaEscape(page);
  const closeDraft = page.getByRole('heading', { name: 'Close draft?' });
  await expectHonestCloseDialog(page);
  const discard = page.getByRole('button', { name: 'Discard', exact: true });
  await expect(discard).toBeVisible({ timeout: 15_000 });
  await discard.click();
  await expect(page.getByText(/Draft deleted/i).first()).toBeVisible({ timeout: 10_000 });
  const deleteResponse = await deleteWait;
  expect(deleteResponse.ok(), 'reply draft deletion request must succeed').toBe(true);
  await expect(closeDraft).toHaveCount(0, { timeout: 30_000 });
  await expect(composer).toBeHidden({ timeout: 15_000 });
  await expect
    .poll(() => currentU3DraftId(page), { timeout: 15_000 })
    .not.toBe(expectedDraftId);
}

test.describe('real-mail compose-close honesty', () => {
  test('AE4 empty Reply+Escape closes silent (no dialog)', async ({ page, context }) => {
    await injectMintedSession(context, page);
    const threadId = await openFirstThread(page);
    const editor = await openReply(page, threadId);

    await closeComposeViaEscape(page);

    await expect(page.getByRole('heading', { name: 'Close draft?' })).toHaveCount(0);
    await expect(editor).toBeHidden({ timeout: 15_000 });
  });

  test('AE2 type → Escape → Save draft keeps body on reopen', async ({ page, context }) => {
    await injectMintedSession(context, page);
    const threadId = await openFirstThread(page);
    const editor = await openReply(page, threadId);

    const marker = `CLOSE-SAVE-${Date.now()}`;
    await editor.click({ force: true });
    await editor.fill(marker);

    await closeComposeViaEscape(page);
    await expectHonestCloseDialog(page);
    await clickRole(page, 'Save draft', true);

    await expect(page.getByRole('heading', { name: 'Close draft?' })).toHaveCount(0, {
      timeout: 60_000,
    });
    await expect(editor).toBeHidden({ timeout: 15_000 });

    // Re-open reply — server draft should hydrate marker
    const editor2 = await openReply(page, threadId);
    await expect(editor2).toContainText(marker, { timeout: 30_000 });

    // Cleanup: discard so pilot drafts stay tidy
    await closeComposeViaEscape(page);
    if (await page.getByRole('heading', { name: 'Close draft?' }).isVisible().catch(() => false)) {
      await clickRole(page, 'Discard', true);
    }
  });

  test('AE1 autosave then Discard removes draft on reopen', async ({ page, context }) => {
    await injectMintedSession(context, page);
    const threadId = await openFirstThread(page);
    const editor = await openReply(page, threadId);

    const marker = `CLOSE-DISCARD-${Date.now()}`;
    await editor.click({ force: true });
    await editor.fill(marker);

    // Autosave debounce is 3s — clears dirty flag. Wait for draftId affinity + re-dirty.
    await page.waitForTimeout(4_000);
    await expect
      .poll(() => page.url(), { timeout: 15_000 })
      .toMatch(/draftId=/);
    await editor.click({ force: true });
    await editor.type('!');

    const deleteWait = page.waitForResponse(
      (res) =>
        res.request().method() === 'POST' &&
        (res.url().includes('drafts.delete') ||
          (res.url().includes('trpc') && (res.request().postData() ?? '').includes('delete'))),
      { timeout: 30_000 },
    );

    await closeComposeViaEscape(page);
    await expectHonestCloseDialog(page);
    await clickRole(page, 'Discard', true);
    // optimisticDeleteDraft executes on toast auto-close (5s) — wait past undo window
    await expect(page.getByText(/Draft deleted/i).first()).toBeVisible({ timeout: 10_000 });
    await page.waitForTimeout(5_500);
    await deleteWait.catch(() => undefined);

    await expect(page.getByRole('heading', { name: 'Close draft?' })).toHaveCount(0);
    await expect(editor).toBeHidden({ timeout: 15_000 });

    const editor2 = await openReply(page, threadId);
    await expect(editor2).not.toContainText(marker, { timeout: 30_000 });
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

    await clickThreadRow(page, threadA as string);
    const editor = await openReply(page, threadA);
    const marker = `CLOSE-SWITCH-${Date.now()}`;
    await editor.click({ force: true });
    await editor.fill(marker);

    // Switch within autosave window (<3s) — DOM click so flush registry runs
    await clickThreadRow(page, threadB as string);
    await expect(page.getByRole('heading', { name: 'Close draft?' })).toHaveCount(0);
    // Allow flush+navigate to settle
    await page.waitForTimeout(1_500);

    // Return to A + Reply — flushed draft should restore marker
    await clickThreadRow(page, threadA as string);
    const editor2 = await openReply(page, threadA);
    await expect(editor2).toContainText(marker, { timeout: 30_000 });

    await closeComposeViaEscape(page);
    if (await page.getByRole('heading', { name: 'Close draft?' }).isVisible().catch(() => false)) {
      await clickRole(page, 'Discard', true);
    }
  });
});

test.describe('real-mail reply viewport containment', () => {
  test.skip(
    !RUN_REAL_MAIL_REPLY_VIEWPORT_REGRESSION,
    'requires healthy real-mail endpoint and explicit mutating-gate opt-in',
  );

  test('U3 visible Reply and Reply All keep composer controls inside reading pane', async (
    { page, request },
    testInfo,
  ) => {
    const testThreadId = U3_TEST_THREAD_ID;
    const testDraftId = U3_TEST_DRAFT_ID;
    const testDraftMarker = U3_TEST_DRAFT_MARKER;
    test.skip(
      !testThreadId || !testDraftId || !testDraftMarker,
      'requires an explicit dedicated thread, disposable draft ID, and draft marker',
    );
    if (!testThreadId || !testDraftId || !testDraftMarker) return;

    const healthy = await isConfiguredBaseUrlHealthy(request, testInfo.project.use.baseURL);
    test.skip(!healthy, 'configured real-mail base URL health preflight failed');

    await page.setViewportSize({ width: 1050, height: 640 });
    await uiLoginAsNavaai(page);
    await openU3DedicatedThread(page, testThreadId);

    let ownedDraftId: string | null = null;
    let hasPrimaryFailure = false;
    let primaryFailure: unknown;
    let deferredCleanupFailure: unknown;
    try {
      const reply = await openU3ReplyViaVisibleAction(page);
      await expectU3TestDraft(page, reply.composer, testDraftId, testDraftMarker);
      ownedDraftId = testDraftId;
      await expectReplyControlsInsideThreadViewport(reply.composer, reply.viewport);

      await clickVisibleU3RoleButton(page, U3_REPLY_ALL_BUTTON_NAME, 'Reply All');
      await expect
        .poll(() => new URL(page.url()).searchParams.get('mode'), { timeout: 15_000 })
        .toBe('replyAll');
      const replyAll = await activeInlineReplyComposer(page);
      await expect(replyAll.composer.locator('.ProseMirror')).toBeVisible({ timeout: 30_000 });
      await expectU3TestDraft(page, replyAll.composer, testDraftId, testDraftMarker);
      await expectReplyControlsInsideThreadViewport(replyAll.composer, replyAll.viewport);

      const longRecipient = `${'a'.repeat(64)}@${'b'.repeat(63)}.${'c'.repeat(61)}.test`;
      const recipientInput = replyAll.composer.locator('input[name="to"][type="email"]').first();
      await expect(recipientInput).toBeVisible({ timeout: 15_000 });
      await recipientInput.fill(longRecipient);
      await recipientInput.press('Enter');
      await expect(replyAll.composer.locator(`[title="${longRecipient}"]`)).toBeVisible({
        timeout: 15_000,
      });

      await expectNoViewportOrDocumentHorizontalOverflow(page, replyAll.viewport);
      await expectReplyControlsInsideThreadViewport(replyAll.composer, replyAll.viewport);
    } catch (error) {
      hasPrimaryFailure = true;
      primaryFailure = error;
      throw error;
    } finally {
      if (ownedDraftId) {
        try {
          await discardU3ReplyDraft(page, ownedDraftId, testDraftMarker);
        } catch (cleanupError) {
          if (hasPrimaryFailure) {
            if (primaryFailure instanceof Error) {
              const cleanupMessage =
                cleanupError instanceof Error ? cleanupError.message : String(cleanupError);
              primaryFailure.message += `\nU3 draft cleanup also failed: ${cleanupMessage}`;
            }
          } else {
            deferredCleanupFailure = cleanupError;
          }
        }
      }
    }
    if (deferredCleanupFailure) throw deferredCleanupFailure;
  });
});

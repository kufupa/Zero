import { expect, test, type Page, type Request } from '@playwright/test';
import { dismissMailOnboarding, uiLoginAsNavaai } from './helpers/real-mail';
import { trpcMailProcedureNamesFromUrl } from './read-only-mail-procedure-audit';

const QUEUES = [
  ['at-risk', 'At risk'],
  ['new-bookings', 'New Bookings'],
  ['groups-events', 'Groups & Events'],
  ['ops', 'Ops'],
] as const;

const FORBIDDEN_MAIL_PROCEDURES = [
  'mail.toggleStar',
  'mail.toggleImportant',
  'mail.modifyLabels',
  'mail.moveThreads',
  'mail.bulkArchive',
  'mail.bulkDelete',
  'mail.delete',
  'mail.snoozeThreads',
  'mail.unsnoozeThreads',
  'mail.emptySpam',
  'mail.send',
  'mail.unsend',
  'mail.forceSync',
  'drafts.',
] as const;

function recordForbiddenMailCalls(page: Page): string[] {
  const calls: string[] = [];
  page.on('request', (request) => {
    const { procedures } = trpcMailProcedureNamesFromUrl(request.url());
    for (const procedure of procedures) {
      if (
        FORBIDDEN_MAIL_PROCEDURES.some(
          (forbiddenProcedure) =>
            procedure === forbiddenProcedure || procedure.startsWith(forbiddenProcedure),
        )
      ) {
        calls.push(procedure);
      }
    }
  });
  return calls;
}

const RUN_REAL_MAIL_MESSAGE_HEADER_GEOMETRY = process.env.REAL_MAIL_UI_GATE === '1';

/**
 * Exact mail surface mounted by the direct inbox-thread page:
 * - `useThreads` mounts `mail.listThreads` for the visible split list.
 * - `useThread` mounts `mail.get` for the designated thread.
 * - `MailDisplay` mounts `mail.getMessageAttachments` and `mail.verifyEmail`.
 * - `MailContent` mounts `mail.processEmailContent`, a server mutation that
 *   reads and safely transforms already-authorized message content.
 */
const PAGE_REQUIRED_READ_ONLY_MAIL_PROCEDURES = new Set([
  'mail.listThreads',
  'mail.get',
  'mail.getMessageAttachments',
  'mail.verifyEmail',
  'mail.processEmailContent',
]);

type ReadOnlyMailProcedureAudit = {
  procedureNames: Set<string>;
  responseStatuses: number[];
  violations: Set<string>;
  inFlightMailRequests: Set<Request>;
  lastMailActivityAt: number;
};

function requireMessageHeaderGeometryFixture() {
  if (process.env.REAL_MAIL_READ_ONLY !== '1') {
    throw new Error('REAL_MAIL_READ_ONLY=1 is required for message-header geometry proof');
  }

  const threadId = process.env.REAL_MAIL_MESSAGE_HEADER_THREAD_ID?.trim();
  if (!threadId || !/^[A-Za-z0-9_-]+$/.test(threadId)) {
    throw new Error('REAL_MAIL_MESSAGE_HEADER_THREAD_ID must be a non-empty fixture thread ID');
  }

  const rawMinimumLength = process.env.REAL_MAIL_MESSAGE_HEADER_RECIPIENT_MIN_LENGTH?.trim();
  if (!rawMinimumLength || !/^[1-9]\d*$/.test(rawMinimumLength)) {
    throw new Error(
      'REAL_MAIL_MESSAGE_HEADER_RECIPIENT_MIN_LENGTH must be a positive non-PII integer',
    );
  }

  const recipientMinimumLength = Number(rawMinimumLength);
  if (!Number.isSafeInteger(recipientMinimumLength)) {
    throw new Error(
      'REAL_MAIL_MESSAGE_HEADER_RECIPIENT_MIN_LENGTH must be a safe positive integer',
    );
  }

  return { threadId, recipientMinimumLength };
}

function recordReadOnlyMailProcedureAudit(page: Page): ReadOnlyMailProcedureAudit {
  const audit: ReadOnlyMailProcedureAudit = {
    procedureNames: new Set(),
    responseStatuses: [],
    violations: new Set(),
    inFlightMailRequests: new Set(),
    lastMailActivityAt: Date.now(),
  };

  const record = (url: string, status?: number) => {
    const { procedures, hasUnclassifiedMailSurface } = trpcMailProcedureNamesFromUrl(url);
    const tracksMailRequest = procedures.length > 0 || hasUnclassifiedMailSurface;
    if (hasUnclassifiedMailSurface) {
      audit.violations.add('unclassified-mail-surface');
      if (status !== undefined) audit.responseStatuses.push(status);
    }

    for (const procedure of procedures) {
      audit.procedureNames.add(procedure);
      if (status !== undefined) audit.responseStatuses.push(status);

      if (procedure.startsWith('drafts.')) {
        audit.violations.add(procedure);
      } else if (procedure === 'mail.markAsRead') {
        audit.violations.add(procedure);
      } else if (!PAGE_REQUIRED_READ_ONLY_MAIL_PROCEDURES.has(procedure)) {
        audit.violations.add(procedure);
      }
    }

    return tracksMailRequest;
  };

  page.on('request', (request) => {
    if (!record(request.url())) return;

    audit.inFlightMailRequests.add(request);
    audit.lastMailActivityAt = Date.now();
  });
  const markRequestSettled = (request: Request) => {
    if (audit.inFlightMailRequests.delete(request)) {
      audit.lastMailActivityAt = Date.now();
    }
  };
  page.on('requestfinished', markRequestSettled);
  page.on('requestfailed', markRequestSettled);
  page.on('response', (response) => record(response.url(), response.status()));
  return audit;
}

async function waitForReadOnlyMailProcedureAuditToSettle(audit: ReadOnlyMailProcedureAudit) {
  await expect
    .poll(
      () =>
        audit.inFlightMailRequests.size === 0 &&
        Date.now() - audit.lastMailActivityAt >= 250,
      {
        message: 'read-only mail procedure audit must settle before certification',
        timeout: 30_000,
      },
    )
    .toBe(true);
}

async function proveInboxListReady(page: Page) {
  // Sidebar folder links are the durable queue chrome.
  for (const [slug, label] of QUEUES) {
    const link = page.locator(`[data-sidebar="menu-button"][href="/mail/${slug}"]`);
    await expect(link, `queue nav missing for ${slug}`).toBeVisible({ timeout: 30_000 });
    await expect(link).toContainText(label, { ignoreCase: true });
  }

  const scroll = page.locator('#mail-list-scroll');
  await expect(scroll).toBeVisible({ timeout: 30_000 });

  // List groups by date (`data-mail-list-section`), not by queue slug.
  await expect
    .poll(
      async () => {
        const threads = await page.locator('[data-thread-id]').count();
        const sections = await page.locator('[data-mail-list-section]').count();
        return threads + sections;
      },
      { message: 'Centurion inbox must show threads or date sections', timeout: 60_000 },
    )
    .toBeGreaterThan(0);

  await scroll.evaluate((element) => {
    element.scrollTop = 0;
  });
}

test.describe('Centurion launch read-only UI proof', () => {
  test.use({ storageState: { cookies: [], origins: [] } });

  test('logs in, switches mailbox, reads one thread, and invokes no mail mutation', async ({
    page,
  }) => {
    expect(process.env.REAL_MAIL_READ_ONLY).toBe('1');
    const forbiddenCalls = recordForbiddenMailCalls(page);

    await uiLoginAsNavaai(page);
    await dismissMailOnboarding(page);

    // NavUser lives in SidebarHeader. connections.picture is always null → AvatarFallback
    // initials (NA/CT), not <img alt="... Transport">.
    const sidebarHeader = page.locator('[data-sidebar="header"]');
    const navaActive = sidebarHeader.getByText('Nava AI Transport', { exact: true });
    const centurionActive = sidebarHeader.getByText('Centurion Transport', { exact: true });
    const navaChip = sidebarHeader.getByText('NA', { exact: true });
    const centurionChip = sidebarHeader.getByText('CT', { exact: true });

    await expect
      .poll(
        async () =>
          (await navaActive.isVisible().catch(() => false)) ||
          (await centurionActive.isVisible().catch(() => false)),
        { message: 'active mailbox name must render in sidebar', timeout: 30_000 },
      )
      .toBe(true);

    // Nava has 2 transports → switcher chip for the non-active mailbox.
    if (await navaActive.isVisible().catch(() => false)) {
      await expect(centurionChip, 'Nava must show Centurion switcher chip').toBeVisible({
        timeout: 30_000,
      });
      await centurionChip.click();
    } else {
      await expect(navaChip, 'Centurion session must still show Nava switcher chip').toBeVisible({
        timeout: 30_000,
      });
    }
    await expect(centurionActive).toBeVisible({ timeout: 30_000 });

    await proveInboxListReady(page);

    const scroll = page.locator('#mail-list-scroll');
    let readRow = null;
    for (let step = 0; step < 40 && !readRow; step++) {
      const visibleRows = page.locator('[data-thread-id]:visible');
      await expect(visibleRows.first()).toBeVisible({ timeout: 30_000 });
      for (let index = 0; index < (await visibleRows.count()); index++) {
        const candidate = visibleRows.nth(index);
        const unreadDot = candidate.locator(
          'span[class*="size-2"][class*="bg-[#006FFE]"]',
        );
        if ((await unreadDot.count()) === 0) {
          readRow = candidate;
          break;
        }
      }
      if (readRow) break;
      await scroll.evaluate((element) => {
        element.scrollTop = Math.min(
          element.scrollHeight,
          element.scrollTop + Math.max(element.clientHeight, 400),
        );
      });
      await page.waitForTimeout(150);
    }

    // Prefer already-read rows to avoid incidental markAsRead; fall back to any row.
    // Brief forbids compose/reply/draft/send/forceSync — not open-driven read-state.
    if (!readRow) {
      readRow = page.locator('[data-thread-id]:visible').first();
      await expect(readRow).toBeVisible({ timeout: 30_000 });
    }

    await readRow!.click();
    await expect(page).toHaveURL(/threadId=/, { timeout: 30_000 });

    const openedMessage = page.locator('[id^="mail-"]:visible').first();
    await expect(openedMessage).toBeVisible({ timeout: 30_000 });
    // Do not log subject/body text. Only assert non-empty customer-visible content.
    await expect
      .poll(
        async () => {
          const text = (await openedMessage.innerText().catch(() => '')).replace(/\s+/g, ' ').trim();
          return text.length > 20;
        },
        { message: 'opened thread must render subject/body text', timeout: 30_000 },
      )
      .toBe(true);

    const bodyHost = openedMessage.locator('.mail-content');
    if ((await bodyHost.count()) > 0) {
      await expect(bodyHost.first()).toBeVisible({ timeout: 30_000 });
      await expect
        .poll(
          async () => {
            const fromShadow = await bodyHost.first().evaluate((element) =>
              Boolean(element.shadowRoot?.textContent?.trim()),
            );
            if (fromShadow) return true;
            const plain = (await bodyHost.first().innerText().catch(() => '')).trim();
            return plain.length > 0;
          },
          { message: 'opened thread must render a body', timeout: 30_000 },
        )
        .toBe(true);
    }

    const closeBtn = page
      .getByRole('button', { name: 'Close', exact: true })
      .filter({ visible: true })
      .first();
    await closeBtn.click({ force: true });
    if (/threadId=/.test(page.url())) {
      await page.keyboard.press('Escape');
    }
    if (/threadId=/.test(page.url())) {
      await page.locator('[data-sidebar="menu-button"][href="/mail/inbox"]').click();
    }
    await expect
      .poll(async () => !/threadId=/.test(page.url()), {
        message: 'return to list must clear threadId from URL',
        timeout: 30_000,
      })
      .toBe(true);
    await expect(page.locator('[data-thread-id]:visible').first()).toBeVisible();

    // Mid-width close-to-inbox: no empty reading pane below lg.
    await page.setViewportSize({ width: 900, height: 900 });
    await expect(page.locator('[data-thread-id]:visible').first()).toBeVisible({ timeout: 30_000 });
    await page.locator('[data-thread-id]:visible').first().click();
    await expect(page).toHaveURL(/threadId=/, { timeout: 30_000 });
    await expect(page.getByText("It's empty here")).toHaveCount(0);
    await page
      .getByRole('button', { name: 'Close', exact: true })
      .filter({ visible: true })
      .first()
      .click({ force: true });
    await expect
      .poll(async () => !/threadId=/.test(page.url()), {
        message: 'mid-width Close must clear threadId',
        timeout: 30_000,
      })
      .toBe(true);
    await expect(page.getByText("It's empty here")).toHaveCount(0);
    await expect(page.locator('[data-thread-id]:visible').first()).toBeVisible({ timeout: 30_000 });

    // Wide-split Hide/Show inbox chrome.
    await page.setViewportSize({ width: 1400, height: 900 });
    const hideInbox = page.getByRole('button', { name: 'Hide inbox', exact: true });
    await expect(hideInbox).toBeVisible({ timeout: 30_000 });
    await hideInbox.click();
    await expect(page.getByRole('button', { name: 'Show inbox', exact: true })).toBeVisible({
      timeout: 15_000,
    });
    await page.getByRole('button', { name: 'Show inbox', exact: true }).click();
    await expect(hideInbox).toBeVisible({ timeout: 15_000 });

    expect(forbiddenCalls, 'read-only UI proof invoked a mutating mail procedure').toEqual([]);
  });

  test.describe('message-header geometry', () => {
    test.skip(
      !RUN_REAL_MAIL_MESSAGE_HEADER_GEOMETRY,
      'requires REAL_MAIL_UI_GATE=1; read-only fixture configuration validates before login',
    );

    test('opens designated pre-read thread without reply actions and keeps latest actions inside pane', async ({
      page,
    }) => {
      // Must throw before any page navigation, login, or browser interaction when gate is active.
      const fixture = requireMessageHeaderGeometryFixture();
      const procedureAudit = recordReadOnlyMailProcedureAudit(page);

      await page.setViewportSize({ width: 1050, height: 640 });
      await uiLoginAsNavaai(page);
      await page.goto(`/mail/inbox?threadId=${encodeURIComponent(fixture.threadId)}`, {
        waitUntil: 'domcontentloaded',
        timeout: 60_000,
      });
      await expect
        .poll(() => new URL(page.url()).searchParams.get('threadId'), {
          timeout: 30_000,
          message: 'direct fixture navigation must retain its configured thread',
        })
        .toBe(fixture.threadId);

      const listPanel = page.locator('#mail-list-panel');
      const threadPanel = page.locator('#mail-thread-panel');
      await expect(listPanel, '1050px desktop view must retain inbox split').toBeVisible({
        timeout: 30_000,
      });
      await expect(threadPanel, 'thread pane must be visible').toBeVisible({ timeout: 30_000 });

      const [listPanelBox, threadPanelBox, threadPanelMetrics] = await Promise.all([
        listPanel.boundingBox(),
        threadPanel.boundingBox(),
        threadPanel.evaluate((element) => ({
          clientWidth: element.clientWidth,
          clientHeight: element.clientHeight,
        })),
      ]);
      if (!listPanelBox || !threadPanelBox) {
        throw new Error('Visible inbox split must have measurable geometry');
      }
      const tolerance = 1;
      const splitPaneWidth = listPanelBox.width + threadPanelBox.width;
      expect(splitPaneWidth, 'visible inbox split must have measurable width').toBeGreaterThan(0);
      expect(
        listPanelBox.width / splitPaneWidth,
        'inbox list must retain a meaningful share of the visible split',
      ).toBeGreaterThanOrEqual(0.25);
      expect(
        listPanelBox.x + listPanelBox.width,
        'inbox list and thread pane must not overlap',
      ).toBeLessThanOrEqual(threadPanelBox.x + tolerance);
      expect(threadPanelMetrics.clientWidth, 'thread pane must have client width').toBeGreaterThan(0);
      expect(threadPanelMetrics.clientHeight, 'thread pane must have client height').toBeGreaterThan(0);

      const latestMessage = threadPanel.locator('[id^="mail-"]').first();
      await expect(latestMessage, 'designated fixture must render its latest message').toBeVisible({
        timeout: 30_000,
      });
      const latestActionGroup = latestMessage.getByRole('group', {
        name: 'Message reply actions',
      });
      await expect(latestActionGroup).toBeVisible({ timeout: 30_000 });
      await latestActionGroup.scrollIntoViewIfNeeded();

      const recipientSummary = latestActionGroup.locator('xpath=preceding-sibling::div[1]');
      await expect(recipientSummary).toBeVisible({ timeout: 30_000 });
      const recipientSummaryLength = await recipientSummary.evaluate((element) => {
        const normalized = (element.textContent ?? '').replace(/\s+/g, ' ').trim();
        return normalized.length;
      });
      expect(typeof recipientSummaryLength).toBe('number');
      expect(Number.isSafeInteger(recipientSummaryLength)).toBe(true);
      expect(
        recipientSummaryLength,
        'fixture recipient summary must reach configured non-PII minimum length',
      ).toBeGreaterThanOrEqual(fixture.recipientMinimumLength);
      const [recipientSummaryBox, recipientSummaryFits] = await Promise.all([
        recipientSummary.boundingBox(),
        recipientSummary.evaluate((element) => element.scrollWidth <= element.clientWidth + 1),
      ]);
      if (!recipientSummaryBox) {
        throw new Error('Visible recipient summary must have measurable geometry');
      }
      expect(recipientSummaryFits, 'recipient summary must not horizontally overflow').toBe(true);
      expect(recipientSummaryBox.x).toBeGreaterThanOrEqual(threadPanelBox.x - tolerance);
      expect(recipientSummaryBox.y).toBeGreaterThanOrEqual(threadPanelBox.y - tolerance);
      expect(recipientSummaryBox.x + recipientSummaryBox.width).toBeLessThanOrEqual(
        threadPanelBox.x + threadPanelBox.width + tolerance,
      );
      expect(recipientSummaryBox.y + recipientSummaryBox.height).toBeLessThanOrEqual(
        threadPanelBox.y + threadPanelBox.height + tolerance,
      );

      const actionButtons = [
        latestActionGroup.getByRole('button', { name: /^Reply$/i }),
        latestActionGroup.getByRole('button', { name: /^Reply all$/i }),
        latestActionGroup.getByRole('button', { name: /^Forward$/i }),
      ];
      await Promise.all(
        actionButtons.map((button) => expect(button).toBeVisible({ timeout: 30_000 })),
      );
      const actionBoxes = await Promise.all(actionButtons.map((button) => button.boundingBox()));
      for (const actionBox of actionBoxes) {
        if (!actionBox) throw new Error('Visible message action must have measurable geometry');
        expect(actionBox.x).toBeGreaterThanOrEqual(threadPanelBox.x - tolerance);
        expect(actionBox.y).toBeGreaterThanOrEqual(threadPanelBox.y - tolerance);
        expect(actionBox.x + actionBox.width).toBeLessThanOrEqual(
          threadPanelBox.x + threadPanelBox.width + tolerance,
        );
        expect(actionBox.y + actionBox.height).toBeLessThanOrEqual(
          threadPanelBox.y + threadPanelBox.height + tolerance,
        );
      }
      for (let firstIndex = 0; firstIndex < actionBoxes.length; firstIndex += 1) {
        const firstActionBox = actionBoxes[firstIndex];
        if (!firstActionBox) throw new Error('Visible message action must have measurable geometry');

        for (let secondIndex = firstIndex + 1; secondIndex < actionBoxes.length; secondIndex += 1) {
          const secondActionBox = actionBoxes[secondIndex];
          if (!secondActionBox) throw new Error('Visible message action must have measurable geometry');

          const actionBoxesOverlap =
            firstActionBox.x < secondActionBox.x + secondActionBox.width - tolerance &&
            secondActionBox.x < firstActionBox.x + firstActionBox.width - tolerance &&
            firstActionBox.y < secondActionBox.y + secondActionBox.height - tolerance &&
            secondActionBox.y < firstActionBox.y + firstActionBox.height - tolerance;
          expect(actionBoxesOverlap, 'reply action hit targets must not overlap').toBe(false);
        }
      }

      await waitForReadOnlyMailProcedureAuditToSettle(procedureAudit);
      expect(
        [...procedureAudit.violations].sort(),
        'read-only geometry proof invoked an unclassified or mutating mail procedure',
      ).toEqual([]);
      expect(
        procedureAudit.responseStatuses.length,
        'read-only geometry proof must record classified response statuses',
      ).toBeGreaterThan(0);
      expect(
        procedureAudit.responseStatuses.every((status) => status >= 200 && status < 400),
        'classified read-only mail procedures must return success statuses',
      ).toBe(true);
    });
  });
});

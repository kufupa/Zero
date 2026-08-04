import { expect, test, type Page } from '@playwright/test';
import { dismissMailOnboarding, uiLoginAsNavaai } from './helpers/real-mail';

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
    const requestText = `${request.url()}\n${request.postData() ?? ''}`;
    for (const procedure of FORBIDDEN_MAIL_PROCEDURES) {
      if (requestText.includes(procedure)) calls.push(procedure);
    }
  });
  return calls;
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
});

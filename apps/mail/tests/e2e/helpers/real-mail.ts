import { expect, type Page, type BrowserContext } from '@playwright/test';

export const REAL_MAIL_USER = process.env.PLAYWRIGHT_REAL_MAIL_USER ?? 'navaai@legacyhotels.co.za';

export function requireRealMailPassword(): string {
  const pw =
    process.env.PLAYWRIGHT_REAL_MAIL_PASSWORD ??
    process.env.PLAYWRIGHT_NAVA_PASSWORD ??
    process.env.NAVA_PASSWORD;
  if (!pw) {
    throw new Error(
      'PLAYWRIGHT_REAL_MAIL_PASSWORD (or PLAYWRIGHT_NAVA_PASSWORD) must be set for real-mail UI gate',
    );
  }
  return pw;
}

export async function dismissMailOnboarding(page: Page) {
  // Onboarding opens once until dismissed (localStorage); still dismiss if present.
  for (let attempt = 0; attempt < 5; attempt++) {
    const skipTour = page
      .getByRole('button', { name: /Skip for now/i })
      .or(page.getByText('Skip for now', { exact: true }));
    if (await skipTour.first().isVisible({ timeout: 1_500 }).catch(() => false)) {
      await skipTour.first().click({ force: true });
      await page.waitForTimeout(400);
      // Confirm closed
      if (!(await skipTour.first().isVisible({ timeout: 800 }).catch(() => false))) {
        return;
      }
      continue;
    }

    const welcome = page.getByText('Welcome to Nava');
    if (await welcome.isVisible({ timeout: 600 }).catch(() => false)) {
      await page.keyboard.press('Escape');
      await page.waitForTimeout(300);
      continue;
    }

    const legacyWelcome = page.getByText('Welcome to Zero Email!');
    if (await legacyWelcome.isVisible({ timeout: 400 }).catch(() => false)) {
      await page.locator('body').click({ position: { x: 100, y: 100 }, force: true });
      await page.waitForTimeout(300);
      continue;
    }

    break;
  }
}

export async function expectPilotInboxVisible(page: Page) {
  const byHref = page.locator('a[href="/mail/inbox"], a[href*="/mail/inbox"]').first();
  if (await byHref.isVisible({ timeout: 3000 }).catch(() => false)) {
    await expect(byHref).toBeVisible({ timeout: 30_000 });
    return;
  }
  await expect(page.getByText('Inbox', { exact: true }).first()).toBeVisible({ timeout: 30_000 });
}

/** UI form login — not curl/cookie mint. */
export async function uiLoginAsNavaai(page: Page) {
  const password = requireRealMailPassword();
  await page.goto('/zero/login', { waitUntil: 'domcontentloaded', timeout: 60_000 });

  const emailField = page.getByLabel('Email', { exact: true });
  const passwordField = page.getByLabel('Password', { exact: true });
  await expect(emailField).toBeVisible({ timeout: 30_000 });
  await emailField.fill(REAL_MAIL_USER);
  await passwordField.fill(password);
  await page.getByRole('button', { name: 'Login', exact: true }).click();

  await page.waitForURL(/\/mail(\/|$)/, { timeout: 60_000 });
  await dismissMailOnboarding(page);
  await expectPilotInboxVisible(page);
}

/** Session for non-login specs — UI form login (cookie mint flaky vs BETTER_AUTH_URL host). */
export async function injectMintedSession(_context: BrowserContext, page: Page) {
  await uiLoginAsNavaai(page);
}

export async function openComposeDialog(page: Page) {
  // Stay on current inbox session — hard goto?isComposeOpen remounts onboarding and can blank SPA.
  await dismissMailOnboarding(page);
  await expectPilotInboxVisible(page);

  if (await page.locator('#compose-subject').isVisible({ timeout: 2_000 }).catch(() => false)) {
    return;
  }

  const candidates = [
    page.getByRole('button', { name: /new email/i }),
    page.locator('button').filter({ hasText: /New Email/i }),
    page.locator('[data-sidebar="header"] button').first(),
    page.locator('button').filter({ has: page.locator('svg') }).filter({ hasText: /email/i }).first(),
  ];

  let opened = false;
  for (const loc of candidates) {
    if (await loc.first().isVisible({ timeout: 2_000 }).catch(() => false)) {
      await loc.first().click({ force: true });
      opened = true;
      break;
    }
  }

  if (!opened) {
    // Fallback: query-param open (may remount onboarding — dismiss again).
    await page.goto('/mail/inbox?isComposeOpen=true', { waitUntil: 'domcontentloaded', timeout: 60_000 });
    await dismissMailOnboarding(page);
  }

  await page.getByText('Loading draft...').waitFor({ state: 'hidden', timeout: 30_000 }).catch(() => {});
  await dismissMailOnboarding(page);
  await expect(page.locator('#compose-subject')).toBeVisible({ timeout: 60_000 });
}

export async function composeSelfLoopback(page: Page, subject: string) {
  await openComposeDialog(page);

  const toInput = page.locator('input[type="email"]').first();
  await toInput.fill(REAL_MAIL_USER);
  await toInput.press('Enter');
  await expect(page.getByText(REAL_MAIL_USER).first()).toBeVisible({ timeout: 10_000 });

  await page.locator('#compose-subject').fill(subject);

  await dismissMailOnboarding(page);

  const editor = page.locator('.ProseMirror').first();
  await editor.click({ force: true, timeout: 15_000 });
  await editor.fill(`Real-mail gate body for ${subject}`);

  await page.getByRole('button', { name: /^Send\s*$/i }).first().click();

  // Compose dialog should close after send (UNDO_SEND_SECONDS=0 → immediate).
  await expect(page.locator('#compose-subject')).toBeHidden({ timeout: 30_000 });
}

async function menuShowsForceResync(page: Page): Promise<boolean> {
  return page
    .getByRole('menuitem', { name: /Force re-sync/i })
    .or(page.getByText('Force re-sync', { exact: true }))
    .first()
    .isVisible({ timeout: 2000 })
    .catch(() => false);
}

export async function openUserDebugMenu(page: Page) {
  if (await menuShowsForceResync(page)) return;

  // Expanded NavUser: three-dots Debug menu (sidebar footer).
  const sidebar = page.locator('[data-sidebar="footer"], [data-sidebar="sidebar"], aside').first();
  const footerButtons = sidebar.locator('button');
  const n = await footerButtons.count();
  for (let i = 0; i < n; i++) {
    const btn = footerButtons.nth(i);
    if (!(await btn.isVisible().catch(() => false))) continue;
    await btn.click();
    if (await menuShowsForceResync(page)) return;
    await page.keyboard.press('Escape');
  }

  // Collapsed: avatar DropdownMenuTrigger
  const avatarTrigger = page.locator('[data-sidebar] [data-radix-collection-item], [data-sidebar] button').first();
  if (await avatarTrigger.isVisible({ timeout: 2000 }).catch(() => false)) {
    await avatarTrigger.click();
    if (await menuShowsForceResync(page)) return;
  }

  throw new Error('Could not open user menu with Force re-sync');
}

export async function clickForceResync(page: Page) {
  await openUserDebugMenu(page);
  const item = page
    .getByRole('menuitem', { name: /Force re-sync/i })
    .or(page.getByText('Force re-sync', { exact: true }))
    .first();
  await expect(item).toBeVisible({ timeout: 10_000 });
  await item.click();
}

/** Wait for forceSync tRPC mutation JSON containing `processed`. */
export async function forceSyncAndAwaitProcessed(
  page: Page,
): Promise<{ processed?: number; triggered?: boolean }> {
  const responsePromise = page.waitForResponse(
    async (res) => {
      if (res.request().method() !== 'POST') return false;
      const url = res.url();
      if (!url.includes('/api/trpc') && !url.includes('trpc')) return false;
      const reqUrl = url + (res.request().postData() ?? '');
      if (!reqUrl.includes('forceSync') && !reqUrl.includes('mail.forceSync')) {
        // Batch body may encode procedure name; still accept processed+triggered payloads.
        try {
          const body = await res.text();
          return /"triggered"\s*:\s*true/.test(body) && /"processed"\s*:/.test(body);
        } catch {
          return false;
        }
      }
      try {
        const body = await res.text();
        return /"processed"\s*:/.test(body);
      } catch {
        return false;
      }
    },
    { timeout: 90_000 },
  );

  await clickForceResync(page);
  const res = await responsePromise;
  const text = await res.text();

  const processedMatch = text.match(/"processed"\s*:\s*(\d+)/);
  const triggered = /"triggered"\s*:\s*true/.test(text);
  return {
    triggered,
    processed: processedMatch ? Number(processedMatch[1]) : undefined,
  };
}

export async function expectSubjectInInbox(page: Page, subject: string, timeoutMs = 90_000) {
  // Stay on inbox — no page.reload (AE7/AE9).
  if (!page.url().includes('/mail/inbox')) {
    // Soft navigate via SPA link only if needed; avoid full reload.
    const inboxLink = page.locator('a[href="/mail/inbox"], a[href*="/mail/inbox"]').first();
    if (await inboxLink.isVisible({ timeout: 2000 }).catch(() => false)) {
      await inboxLink.click();
    }
  }
  await expect(page.getByText(subject, { exact: false }).first()).toBeVisible({ timeout: timeoutMs });
}

/** Hold listThreads responses until release — prevents poll false-green (KTD12). */
export async function pauseListThreadPoll(page: Page): Promise<() => void> {
  let release!: () => void;
  const gate = new Promise<void>((r) => {
    release = r;
  });
  let released = false;

  await page.route('**/api/trpc**', async (route) => {
    const req = route.request();
    const url = req.url();
    const post = req.postData() ?? '';
    const isList =
      url.includes('listThreads') ||
      post.includes('listThreads') ||
      post.includes('mail.listThreads');
    if (isList && !released) {
      await gate;
    }
    await route.continue();
  });

  return () => {
    released = true;
    release();
  };
}

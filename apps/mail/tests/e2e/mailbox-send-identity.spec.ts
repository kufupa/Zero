import { composeSelfLoopback, dismissMailOnboarding, uiLoginAsNavaai } from './helpers/real-mail';
import { expect, test, type Page, type Request } from '@playwright/test';

const CENTURION_TRANSPORT_ID = 'transport-centurion';
const CENTURION_EMAIL = 'centurion@legacyhotels.co.za';

test.use({
  baseURL: process.env.PLAYWRIGHT_BASE_URL ?? 'https://127.0.0.1',
  ignoreHTTPSErrors: true,
  storageState: { cookies: [], origins: [] },
});

function isMailSendRequest(request: Request): boolean {
  return (
    request.method() === 'POST' &&
    (request.url().includes('mail.send') || (request.postData() ?? '').includes('mail.send'))
  );
}

function findSendInput(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== 'object') return null;
  if (!Array.isArray(value) && 'to' in value && 'subject' in value && 'message' in value) {
    return value as Record<string, unknown>;
  }
  for (const child of Object.values(value)) {
    const found = findSendInput(child);
    if (found) return found;
  }
  return null;
}

function findFromEmail(value: unknown): string | null {
  if (!value || typeof value !== 'object') return null;
  if (!Array.isArray(value) && 'fromEmail' in value && typeof value.fromEmail === 'string') {
    return value.fromEmail;
  }
  for (const child of Object.values(value)) {
    const found = findFromEmail(child);
    if (found) return found;
  }
  return null;
}

async function switchToCenturion(page: Page): Promise<void> {
  await dismissMailOnboarding(page);
  const sidebarHeader = page.locator('[data-sidebar="header"]');
  const navaActive = sidebarHeader.getByText('Nava AI Transport', {
    exact: true,
  });
  const centurionActive = sidebarHeader.getByText('Centurion Transport', {
    exact: true,
  });

  await expect
    .poll(
      async () =>
        (await navaActive.isVisible().catch(() => false)) ||
        (await centurionActive.isVisible().catch(() => false)),
      { message: 'active mailbox name must render', timeout: 30_000 },
    )
    .toBe(true);

  if (await navaActive.isVisible().catch(() => false)) {
    const centurionChip = sidebarHeader.getByText('CT', { exact: true });
    await expect(centurionChip).toBeVisible({ timeout: 30_000 });
    await centurionChip.click();
  }
  await expect(centurionActive).toBeVisible({ timeout: 30_000 });
}

test.describe('active mailbox sender identity', () => {
  test('Centurion send omits client fromEmail and uses mocked server sender', async ({ page }) => {
    test.setTimeout(120_000);

    let activeTransportHeader: string | undefined;
    let requestInput: Record<string, unknown> | null = null;
    const mockedResult = {
      sent: true,
      messageId: 'mock-message-id',
      threadId: 'mock-thread-id',
      fromEmail: CENTURION_EMAIL,
      smtpMessageId: '<mock-message-id@example.test>',
      accepted: ['navaai@legacyhotels.co.za'],
      rejected: [],
    };

    await page.route('**/*', async (route) => {
      const request = route.request();
      if (!isMailSendRequest(request)) {
        await route.continue();
        return;
      }

      activeTransportHeader = request.headers()['x-zero-active-transport'];
      requestInput = findSendInput(JSON.parse(request.postData() ?? '{}'));
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify([
          {
            result: {
              data: {
                json: mockedResult,
              },
            },
          },
        ]),
      });
    });

    await uiLoginAsNavaai(page);
    await switchToCenturion(page);

    const responsePromise = page.waitForResponse(
      (response) => isMailSendRequest(response.request()),
      { timeout: 30_000 },
    );
    await composeSelfLoopback(page, `MOCK-SENDER-${Date.now()}`);
    const responseBody = await (await responsePromise).json();

    expect(activeTransportHeader).toBe(CENTURION_TRANSPORT_ID);
    expect(requestInput).not.toBeNull();
    expect(requestInput).not.toHaveProperty('fromEmail');
    expect(findFromEmail(responseBody)).toBe(CENTURION_EMAIL);
  });
});

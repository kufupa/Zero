import { expect, test, type Page, type Request } from '@playwright/test';
import { dismissMailOnboarding } from './helpers/real-mail';

const SUBJECT = 'Synthetic branded confirmation';
const MESSAGE_ID = 'a0b1c2d3-e4f5-4a67-8b90-abcdef123456';
const PDF_FILENAME = 'synthetic-itinerary.pdf';
const TRACKER_URL = 'https://tracker.example.invalid/open.gif';
const baseURL = process.env.PLAYWRIGHT_ROCKETSEED_BASE_URL ?? 'http://127.0.0.1:3000';

function assertLoopbackBaseUrl(raw: string): string {
  const parsed = new URL(raw);
  if (!['127.0.0.1', 'localhost'].includes(parsed.hostname)) {
    throw new Error(`Rocketseed pixel gate refuses non-loopback baseURL (host=${parsed.hostname})`);
  }
  return raw;
}

function fixtureCredentials(): {
  email: string;
  password: string;
  threadId: string;
} {
  const email = process.env.PLAYWRIGHT_ROCKETSEED_FIXTURE_USER;
  const password = process.env.PLAYWRIGHT_ROCKETSEED_FIXTURE_PASSWORD;
  const threadId = process.env.PLAYWRIGHT_ROCKETSEED_THREAD_ID;
  if (!email || !password || !threadId) {
    throw new Error(
      'Local Rocketseed harness requires PLAYWRIGHT_ROCKETSEED_FIXTURE_USER, PLAYWRIGHT_ROCKETSEED_FIXTURE_PASSWORD, and PLAYWRIGHT_ROCKETSEED_THREAD_ID',
    );
  }
  return { email, password, threadId };
}

function isMailSendRequest(request: Request): boolean {
  const requestText = `${request.url()}\n${request.postData() ?? ''}`;
  return request.method() === 'POST' && requestText.includes('mail.send');
}

async function loginToFixtureHarness(page: Page): Promise<string> {
  const credentials = fixtureCredentials();
  await page.goto('/zero/login', {
    waitUntil: 'domcontentloaded',
    timeout: 60_000,
  });
  await page.getByLabel('Email', { exact: true }).fill(credentials.email);
  await page.getByLabel('Password', { exact: true }).fill(credentials.password);
  await page.getByRole('button', { name: 'Login', exact: true }).click();
  await page.waitForURL(/\/mail(\/|$)/, { timeout: 60_000 });
  await dismissMailOnboarding(page);
  return credentials.threadId;
}

test.use({
  baseURL: assertLoopbackBaseUrl(baseURL),
  storageState: { cookies: [], origins: [] },
});

test.describe('Rocketseed representative CID rendering', () => {
  test('renders two inline rasters without tracker, PDF loss, or duplicate message', async ({
    page,
  }) => {
    test.setTimeout(120_000);
    let cidRequests = 0;
    let trackerRequests = 0;
    let mailSendRequests = 0;

    await page.route('**/*', async (route) => {
      const request = route.request();
      if (request.url().startsWith('cid:')) {
        cidRequests += 1;
        await route.abort();
        return;
      }
      if (request.url() === TRACKER_URL) {
        trackerRequests += 1;
        await route.abort();
        return;
      }
      if (isMailSendRequest(request)) {
        mailSendRequests += 1;
        await route.abort();
        return;
      }
      await route.continue();
    });

    const threadId = await loginToFixtureHarness(page);
    await page.goto(`/mail/inbox?threadId=${encodeURIComponent(threadId)}`, {
      waitUntil: 'domcontentloaded',
      timeout: 60_000,
    });
    await dismissMailOnboarding(page);

    const message = page.locator(`#mail-${MESSAGE_ID}`);
    await expect(message).toHaveCount(1);
    await expect(message).toContainText(SUBJECT);
    await expect(page.locator('[id^="mail-"]:visible')).toHaveCount(1);

    const bodyHost = message.locator('.mail-content');
    await expect(bodyHost).toBeVisible({ timeout: 30_000 });
    await expect
      .poll(
        () =>
          bodyHost.evaluate((element) => {
            const root = element.shadowRoot;
            if (!root) return null;
            const images = Array.from(
              root.querySelectorAll<HTMLImageElement>('img[alt^="Synthetic Rocketseed"]'),
            );
            return {
              imageCount: images.length,
              allComplete: images.every((image) => image.complete),
              allNatural: images.every(
                (image) => image.naturalWidth > 0 && image.naturalHeight > 0,
              ),
              allAuthorizedRoutes: images.every((image) => {
                const src = image.getAttribute('src') ?? '';
                return (
                  src.startsWith('http') &&
                  src.includes(`/api/mail/messages/${MESSAGE_ID}/attachments/`) &&
                  src.endsWith('/inline')
                );
              }),
              hasRawCid: /\bcid:/i.test(root.innerHTML),
              hasTracker: root.innerHTML.includes('tracker.example.invalid'),
            };
          }),
        {
          message: 'two fixture CID images must decode through authorized routes',
          timeout: 30_000,
        },
      )
      .toEqual({
        imageCount: 2,
        allComplete: true,
        allNatural: true,
        allAuthorizedRoutes: true,
        hasRawCid: false,
        hasTracker: false,
      });

    await expect(message.getByText(PDF_FILENAME, { exact: true })).toBeVisible();
    await page.waitForTimeout(500);
    expect(cidRequests).toBe(0);
    expect(trackerRequests).toBe(0);
    expect(mailSendRequests).toBe(0);
  });
});

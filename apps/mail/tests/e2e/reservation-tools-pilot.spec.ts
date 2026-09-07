import { expect, test, type Page } from '@playwright/test';

const FIXTURE_ORIGIN = 'http://127.0.0.1:4179';
const DASHBOARD_PATH = '/settings/admin-dashboard';

function dashboardUrl(mode = 'default'): string {
  return `${FIXTURE_ORIGIN}${DASHBOARD_PATH}?fixture=${mode}`;
}

async function expectDashboardReady(page: Page) {
  await expect(page.getByText('Executive email dashboard', { exact: true })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Communication demand' })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Conversation activity' })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Business breakdown' })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Data diagnostics' })).toBeVisible();
}

async function selectOption(page: Page, label: string, option: string) {
  await page.getByRole('combobox', { name: label }).click();
  await page.getByRole('option', { name: option, exact: true }).click();
}

async function expectTouchTarget(locator: ReturnType<Page['locator']>, label: string) {
  const heights = await locator.evaluateAll((elements) =>
    elements.map((element) => Math.round(element.getBoundingClientRect().height)),
  );
  expect(heights, `${label} target heights`).not.toHaveLength(0);
  expect(heights.every((height) => height >= 44), `${label} targets must be at least 44px`).toBe(true);
}

async function assertLoopbackAndReadOnly(page: Page) {
  const requests: string[] = [];
  const forbidden: string[] = [];
  page.on('request', (request) => {
    const url = new URL(request.url());
    requests.push(url.href);
    if (url.hostname !== '127.0.0.1' || url.port !== '4179') {
      forbidden.push(`${url.hostname}:${url.port}`);
    }
    if (/\/api\/trpc\/(?!adminDashboard\.getMetrics)/.test(url.pathname)) {
      forbidden.push(url.pathname);
    }
  });
  return { requests, forbidden };
}

test('reservation-tools-pilot/dashboard', async ({ page, browser }) => {
  const audit = await assertLoopbackAndReadOnly(page);
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.goto(dashboardUrl(), { waitUntil: 'domcontentloaded' });
  await expectDashboardReady(page);

  await expect(page.getByRole('combobox', { name: 'Cohort' })).toBeVisible();
  await expect(page.locator('#dashboard-cohort')).toContainText('Centurion');
  await expect(page.locator('#dashboard-cohort')).toHaveAttribute('aria-describedby', 'dashboard-cohort-help');
  await expect(page.getByText('Current eleven-folder workflow taxonomy; ambiguous and legacy labels remain explicit.')).toBeVisible();
  await expect(page.getByText('classificationAsOf:', { exact: false })).toBeVisible();
  await expect(page.getByText('First observed human reply', { exact: true })).toBeVisible();
  await expect(page.getByText('Unavailable: reply evidence unavailable', { exact: true }).first()).toBeVisible();

  await selectOption(page, 'Cohort', 'Research (operator)');
  await expect(page.getByText('research', { exact: true })).toBeVisible();
  await expect(page.locator('section[aria-labelledby="traffic-heading"] p[aria-live="polite"]').first()).toHaveText('2');

  await page.locator('#dashboard-cutoff').fill('2026-09-01');
  await expect(page.getByText('Folder classification unavailable', { exact: true })).toBeVisible();
  await expect(
    page.getByRole('region', { name: 'Business breakdown' }).getByText('classification snapshot unavailable', { exact: true }).first(),
  ).toBeVisible();
  await expect(
    page.locator('dt').filter({ hasText: 'Observation cutoff' }).first().locator('xpath=following-sibling::dd[1]'),
  ).toContainText('01 Sept 2026');

  await page.evaluate(() => window.history.replaceState({}, '', `${location.pathname}?fixture=error`));
  await selectOption(page, 'Window', '28 days');
  await expect(page.getByRole('alert')).toContainText('selected query');
  await expect(page.getByRole('alert')).toContainText('showing the observed snapshot');
  await expect(page.getByRole('alert')).toContainText('no demo data is substituted');

  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(dashboardUrl(), { waitUntil: 'domcontentloaded' });
  await expectDashboardReady(page);
  await expectTouchTarget(page.locator('#dashboard-cohort, #dashboard-window, #dashboard-cutoff'), 'dashboard controls');
  await expectTouchTarget(page.getByRole('button', { name: 'Latest observed', exact: true }), 'latest observed button');
  await expectTouchTarget(page.locator('summary'), 'definition/data-table disclosures');
  await page.getByRole('combobox', { name: 'Cohort' }).click();
  await expectTouchTarget(page.locator('[role="option"]:visible'), 'cohort options');
  await page.getByRole('option', { name: 'Research (operator)', exact: true }).click();

  expect(audit.forbidden).toEqual([]);
  const fixtureRequests = await page.evaluate(
    () => window.__reservationToolsPilotRequests ?? [],
  );
  const allowedFixturePaths = new Set([
    '/settings/undefined',
    '/api/auth/get-session',
    '/api/trpc/adminDashboard.getMetrics',
    '/api/trpc/connections.getDefault',
  ]);
  expect(fixtureRequests.every((request) => allowedFixturePaths.has(request.path))).toBe(true);
  expect(fixtureRequests.every((request) => ['GET', 'POST'].includes(request.method))).toBe(true);
  expect(fixtureRequests.some((request) => request.path.endsWith('/api/trpc/adminDashboard.getMetrics'))).toBe(true);
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const authPage = await context.newPage();
  const authRequests = () => authPage.evaluate(() => window.__reservationToolsPilotRequests ?? []);
  await authPage.goto(dashboardUrl('unauthorized'), { waitUntil: 'domcontentloaded' });
  await expect(authPage).toHaveURL(/\/settings\/general/);
  const deniedRequests = await authRequests();
  expect(deniedRequests.some((request) => request.path.endsWith('/api/trpc/adminDashboard.getMetrics'))).toBe(false);
  await context.close();
});

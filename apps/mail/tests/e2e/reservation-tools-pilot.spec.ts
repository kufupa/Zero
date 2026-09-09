import { expect, test, type Page, type TestInfo } from '@playwright/test';

const FIXTURE_ORIGIN = 'http://127.0.0.1:4179';
const DASHBOARD_PATH = '/settings/admin-dashboard';
const HISTORICAL_CUTOFF = '2026-09-01T21:59:59.999Z';

type DashboardQueryMetadata = {
  cohortId: 'centurion' | 'research';
  window: '7d' | '28d';
  observationCutoff?: string;
  operation?: 'aggregate' | 'drilldown' | 'export';
};

type DocumentQueryMetadata = {
  toolId: 'documents_list_existing' | 'documents_read_existing';
  source?: 'mail_attachment' | 'hms_sent_attachment' | 'hms_finalized_document';
  format?: 'text' | 'artifact';
  scopeRef?: string;
};

type RecordedFixtureRequest = {
  method: string;
  path: string;
  status?: number;
  query?: DashboardQueryMetadata | DocumentQueryMetadata | null;
};

function dashboardUrl(mode = 'default'): string {
  return `${FIXTURE_ORIGIN}${DASHBOARD_PATH}?fixture=${mode}`;
}

function documentsUrl(): string {
  return `${FIXTURE_ORIGIN}${DASHBOARD_PATH}?fixture=documents`;
}

async function expectDashboardReady(page: Page) {
  await expect(page.getByText('Executive email dashboard', { exact: true })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Communication demand' })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Conversation activity' })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Business breakdown' })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Private prediction scorecard' })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Data diagnostics' })).toBeVisible();
}

async function selectOptionKeyboard(page: Page, label: string, option: string) {
  const trigger = page.getByRole('combobox', { name: label });
  await trigger.focus();
  await trigger.press('Space');
  const options = page.getByRole('option');
  await expect(options.filter({ hasText: option }).first()).toBeVisible();
  const optionLabels = await options.allTextContents();
  const optionIndex = optionLabels.findIndex((value) => value.trim() === option);
  expect(optionIndex, `keyboard option ${option}`).toBeGreaterThanOrEqual(0);
  await page.keyboard.press('Home');
  for (let index = 0; index < optionIndex; index += 1) {
    await page.keyboard.press('ArrowDown');
  }
  await page.keyboard.press('Enter');
  await expect(trigger).toContainText(option);
  await expect(trigger).toBeFocused();
  expect(await trigger.evaluate((element) => element.matches(':focus-visible'))).toBe(true);
}

async function toggleDisclosureKeyboard(page: Page, summary: ReturnType<Page['locator']>) {
  const details = summary.locator('xpath=..');
  await summary.focus();
  await summary.press('Enter');
  await expect(details).toHaveAttribute('open', '');
  await expect(summary).toBeFocused();
  expect(await summary.evaluate((element) => element.matches(':focus-visible'))).toBe(true);
  await summary.press('Space');
  await expect(details).not.toHaveAttribute('open');
  await expect(summary).toBeFocused();
}

async function readTouchTargetBoxes(locator: ReturnType<Page['locator']>) {
  return locator.evaluateAll((elements) =>
    elements.map((element) => {
      const rect = element.getBoundingClientRect();
      return { width: Math.round(rect.width), height: Math.round(rect.height) };
    }),
  );
}

function touchTargetFailures(
  boxes: Array<{ width: number; height: number }>,
  label: string,
): string[] {
  if (boxes.length === 0) return [`${label}: no target elements`];
  return boxes.flatMap(({ width, height }, index) =>
    width >= 44 && height >= 44 ? [] : [`${label}[${index}] is ${width}x${height}px`],
  );
}

function expectTouchTargetBoxes(
  measurements: Array<{ label: string; boxes: Array<{ width: number; height: number }> }>,
) {
  const failures = measurements.flatMap(({ label, boxes }) => touchTargetFailures(boxes, label));
  expect(failures, `44px target measurements: ${JSON.stringify(measurements)}`).toEqual([]);
}

async function expectProductLayout(page: Page, viewport: 'desktop' | 'mobile') {
  const cards = page
    .locator('section[aria-labelledby="traffic-heading"] > div')
    .nth(1)
    .locator(':scope > *');
  const boxes = await cards.evaluateAll((elements) =>
    elements.map((element) => {
      const rect = element.getBoundingClientRect();
      return {
        x: Math.round(rect.x),
        width: Math.round(rect.width),
        height: Math.round(rect.height),
      };
    }),
  );
  expect(boxes, `${viewport} traffic cards`).toHaveLength(4);
  expect(boxes.every(({ width, height }) => width >= 140 && height >= 90)).toBe(true);
  const columns = new Set(boxes.map(({ x }) => x));
  expect(columns.size, `${viewport} traffic card columns`).toBe(viewport === 'desktop' ? 4 : 1);
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= document.documentElement.clientWidth,
    ),
  ).toBe(true);
}

async function assertLoopbackAndReadOnly(page: Page) {
  const requests: string[] = [];
  const forbidden: string[] = [];
  const allowedProcedurePaths = new Set([
    '/api/trpc/adminDashboard.getMetrics',
    '/api/trpc/documents.listExisting',
    '/api/trpc/documents.readExisting',
  ]);
  page.on('request', (request) => {
    const url = new URL(request.url());
    requests.push(url.href);
    if (url.hostname !== '127.0.0.1' || url.port !== '4179') {
      forbidden.push(`${url.hostname}:${url.port}`);
    }
    if (url.pathname.startsWith('/api/trpc/') && !allowedProcedurePaths.has(url.pathname)) {
      forbidden.push(url.pathname);
    }
  });
  return { requests, forbidden };
}

test('reservation-tools-pilot/dashboard', async ({ page, browser }, testInfo: TestInfo) => {
  const audit = await assertLoopbackAndReadOnly(page);
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.goto(dashboardUrl(), { waitUntil: 'domcontentloaded' });
  await expectDashboardReady(page);
  await expectProductLayout(page, 'desktop');
  const desktopControlBoxes = await readTouchTargetBoxes(
    page.locator('#dashboard-cohort, #dashboard-window, #dashboard-cutoff'),
  );
  const desktopDisclosureBoxes = await readTouchTargetBoxes(page.locator('summary'));
  await page.screenshot({ path: testInfo.outputPath('dashboard-desktop.png'), fullPage: true });

  await expect(page.getByRole('combobox', { name: 'Cohort' })).toBeVisible();
  await expect(page.locator('#dashboard-cohort')).toContainText('Centurion');
  await expect(page.locator('#dashboard-cohort')).toHaveAttribute(
    'aria-describedby',
    'dashboard-cohort-help',
  );
  await expect(
    page.getByText(
      'Current eleven-folder workflow taxonomy; ambiguous and legacy labels remain explicit.',
    ),
  ).toBeVisible();
  await expect(page.getByText('classificationAsOf:', { exact: false })).toBeVisible();
  await expect(page.getByText('First observed human reply', { exact: true })).toBeVisible();
  await expect(page.getByText('Answered', { exact: true })).toBeVisible();
  await expect(page.getByText('No reply required', { exact: true })).toBeVisible();
  await expect(page.getByText('Unknown evidence', { exact: true })).toBeVisible();
  await expect(page.getByText('Label coverage', { exact: true })).toBeVisible();
  await expect(
    page.getByText('Unavailable: label provenance unavailable', { exact: true }),
  ).toBeVisible();
  await expect(
    page.getByText('Primary request-state buckets are mutually exclusive.', { exact: false }),
  ).toBeVisible();
  await expect(
    page.getByRole('button', { name: 'Export bounded snapshot', exact: true }),
  ).toBeVisible();
  await expect(
    page.getByText('Unavailable: reply evidence unavailable', { exact: true }).first(),
  ).toBeVisible();

  const exportDownloadPromise = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Export bounded snapshot', exact: true }).click();
  const exportDownload = await exportDownloadPromise;
  expect(exportDownload.suggestedFilename()).toBe('admin-dashboard-export.json');
  const exportStream = await exportDownload.createReadStream();
  let exportText = '';
  for await (const chunk of exportStream ?? []) exportText += chunk.toString();
  const exported = JSON.parse(exportText) as {
    schemaVersion: string;
    buckets: Record<string, unknown>;
    overlays: Record<string, unknown>;
  };
  expect(exported.schemaVersion).toBe('admin-dashboard-export-v1');
  expect(Object.keys(exported.buckets)).toEqual([
    'awaiting_hotel_reply',
    'awaiting_customer_information',
    'hotel_action_pending',
    'unknown',
    'answered',
    'no_reply_required',
  ]);
  expect(Object.keys(exported.overlays)).toEqual(['partially_answered', 'unknown_evidence']);

  await selectOptionKeyboard(page, 'Cohort', 'Research');
  await expect(page.getByText('research', { exact: true })).toBeVisible();
  await expect(
    page.locator('section[aria-labelledby="traffic-heading"] p[aria-live="polite"]').first(),
  ).toHaveText('2');
  await page.keyboard.press('Tab');
  await expect(page.locator('#dashboard-window')).toBeFocused();

  const desktopCutoff = page.locator('#dashboard-cutoff');
  await desktopCutoff.focus();
  await desktopCutoff.fill('2026-09-01');
  await expect(page.getByText('Folder classification unavailable', { exact: true })).toBeVisible();
  await expect(desktopCutoff).toBeFocused();
  await toggleDisclosureKeyboard(page, page.locator('summary').first());
  await expect(
    page
      .getByRole('region', { name: 'Business breakdown' })
      .getByText('classification snapshot unavailable', { exact: true })
      .first(),
  ).toBeVisible();
  await expect(
    page
      .locator('dt')
      .filter({ hasText: 'Observation cutoff' })
      .first()
      .locator('xpath=following-sibling::dd[1]'),
  ).toContainText('01 Sept 2026');

  await page.evaluate(() =>
    window.history.replaceState({}, '', `${location.pathname}?fixture=error`),
  );
  await selectOptionKeyboard(page, 'Window', '28 days');
  await expect(page.getByRole('alert')).toContainText('selected query');
  await expect(page.getByRole('alert')).toContainText('showing the observed snapshot');
  await expect(page.getByRole('alert')).toContainText('no demo data is substituted');
  await expect(page.getByRole('alert')).toContainText(`research / 28d / ${HISTORICAL_CUTOFF}`);
  await expect(page.locator('#dashboard-window')).toBeFocused();
  const desktopFixtureRequests = (await page.evaluate(
    () => window.__reservationToolsPilotRequests ?? [],
  )) as RecordedFixtureRequest[];

  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(dashboardUrl(), { waitUntil: 'domcontentloaded' });
  await expectDashboardReady(page);
  await expectProductLayout(page, 'mobile');
  const mobileControlBoxes = await readTouchTargetBoxes(
    page.locator('#dashboard-cohort, #dashboard-window, #dashboard-cutoff'),
  );
  const mobileLatestBoxes = await readTouchTargetBoxes(
    page.getByRole('button', { name: 'Latest observed', exact: true }),
  );
  const mobileDisclosureBoxes = await readTouchTargetBoxes(page.locator('summary'));
  await page.screenshot({ path: testInfo.outputPath('dashboard-mobile.png'), fullPage: true });
  await selectOptionKeyboard(page, 'Cohort', 'Research');
  await toggleDisclosureKeyboard(page, page.locator('summary').first());
  const mobileCutoff = page.locator('#dashboard-cutoff');
  await mobileCutoff.focus();
  await mobileCutoff.fill('2026-09-01');
  await expect(page.getByText('Folder classification unavailable', { exact: true })).toBeVisible();
  await expect(mobileCutoff).toBeFocused();
  await page.evaluate(() =>
    window.history.replaceState({}, '', `${location.pathname}?fixture=error`),
  );
  await selectOptionKeyboard(page, 'Window', '28 days');
  await expect(page.getByRole('alert')).toContainText('showing the observed snapshot');
  await expect(page.locator('#dashboard-window')).toBeFocused();
  await page.getByRole('combobox', { name: 'Cohort' }).focus();
  await page.keyboard.press('Space');
  const mobileOptionBoxes = await readTouchTargetBoxes(page.locator('[role="option"]:visible'));
  await page.keyboard.press('Escape');
  await expect(page.getByRole('combobox', { name: 'Cohort' })).toBeFocused();

  expect(audit.forbidden).toEqual([]);
  const malformedBodies: Array<string | undefined> = [
    undefined,
    '{}',
    'not-json',
    '{"0":{"json":{"cohortId":"unknown","window":"7d"}}}',
    `{"0":{"json":{"cohortId":"centurion","window":"7d","observationCutoff":"not-a-date"}}}`,
    '{"0":{"json":{"cohortId":"centurion","window":"7d"},"meta":42}}',
    '{"0":{"json":{"cohortId":"centurion","window":"7d"},"meta":{"unexpected":true}}}',
    '{"0":{"json":{"cohortId":"centurion","window":"7d"},"meta":{"values":{"observationCutoff":["date"]}}}}',
    '{"0":{"json":{"cohortId":"centurion","window":"7d"},"meta":{"values":{"other":["undefined"]}}}}',
    '{"0":{"json":{"cohortId":"centurion","window":"7d"}}}',
  ];
  const malformedResponses = await page.evaluate(async (bodies) => {
    const responses = [];
    for (const body of bodies) {
      const response = await fetch('/api/trpc/adminDashboard.getMetrics', {
        method: 'POST',
        ...(body === undefined ? {} : { body }),
      });
      responses.push({ status: response.status });
    }
    return responses;
  }, malformedBodies);
  expect(malformedResponses.every(({ status }) => status === 400)).toBe(true);

  const mobileFixtureRequests = (await page.evaluate(
    () => window.__reservationToolsPilotRequests ?? [],
  )) as RecordedFixtureRequest[];
  const fixtureRequests = [...desktopFixtureRequests, ...mobileFixtureRequests];
  const allowedFixturePaths = new Set([
    '/settings/undefined',
    '/api/auth/get-session',
    '/api/trpc/adminDashboard.getMetrics',
    '/api/trpc/connections.getDefault',
  ]);
  expect(fixtureRequests.every((request) => allowedFixturePaths.has(request.path))).toBe(true);
  expect(fixtureRequests.every((request) => ['GET', 'POST'].includes(request.method))).toBe(true);
  const dashboardRequests = fixtureRequests.filter((request) =>
    request.path.endsWith('/api/trpc/adminDashboard.getMetrics'),
  );
  expect(dashboardRequests.length).toBeGreaterThan(0);
  expect(dashboardRequests.every((request) => request.method === 'POST')).toBe(true);
  expect(dashboardRequests.filter((request) => request.status === 400)).toHaveLength(
    malformedBodies.length,
  );
  expect(
    dashboardRequests
      .filter((request) => request.status === 400)
      .every((request) => request.query === null),
  ).toBe(true);
  const successfulDashboardRequests = dashboardRequests.filter((request) => request.status !== 400);
  expect(successfulDashboardRequests.every((request) => request.query)).toBe(true);
  expect(successfulDashboardRequests).toContainEqual(
    expect.objectContaining({
      status: 200,
      query: { cohortId: 'centurion', window: '7d' },
    }),
  );
  expect(successfulDashboardRequests).toContainEqual(
    expect.objectContaining({
      status: 200,
      query: { cohortId: 'research', window: '7d' },
    }),
  );
  expect(successfulDashboardRequests).toContainEqual(
    expect.objectContaining({
      status: 200,
      query: { cohortId: 'research', window: '7d', observationCutoff: HISTORICAL_CUTOFF },
    }),
  );
  expect(successfulDashboardRequests).toContainEqual(
    expect.objectContaining({
      status: 503,
      query: { cohortId: 'research', window: '28d', observationCutoff: HISTORICAL_CUTOFF },
    }),
  );
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const authPage = await context.newPage();
  const authRequests = () => authPage.evaluate(() => window.__reservationToolsPilotRequests ?? []);
  await authPage.goto(dashboardUrl('unauthorized'), { waitUntil: 'domcontentloaded' });
  await expect(authPage).toHaveURL(/\/settings\/general/);
  const deniedRequests = await authRequests();
  expect(
    deniedRequests.some((request) => request.path.endsWith('/api/trpc/adminDashboard.getMetrics')),
  ).toBe(false);
  await context.close();

  expectTouchTargetBoxes([
    { label: 'desktop dashboard controls', boxes: desktopControlBoxes },
    { label: 'desktop definition/data-table disclosures', boxes: desktopDisclosureBoxes },
    { label: 'mobile dashboard controls', boxes: mobileControlBoxes },
    { label: 'mobile latest observed button', boxes: mobileLatestBoxes },
    { label: 'mobile definition/data-table disclosures', boxes: mobileDisclosureBoxes },
    { label: 'mobile cohort options', boxes: mobileOptionBoxes },
  ]);
});

test('reservation-tools-pilot/documents', async ({ page }, testInfo: TestInfo) => {
  const audit = await assertLoopbackAndReadOnly(page);
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.goto(documentsUrl(), { waitUntil: 'domcontentloaded' });

  const documentInput = {
    scopeRef: 'scope:fixture-documents',
    source: 'mail_attachment',
    kinds: ['tax_invoice'],
    limit: 20,
  };
  const noOrigin = await page.request.post(`${FIXTURE_ORIGIN}/api/trpc/documents.listExisting`, {
    headers: { 'content-type': 'application/json' },
    data: [{ json: documentInput }],
  });
  expect(noOrigin.status()).toBe(400);
  const wrongOrigin = await page.request.post(`${FIXTURE_ORIGIN}/api/trpc/documents.listExisting`, {
    headers: {
      'content-type': 'application/json',
      origin: 'http://localhost:4179',
    },
    data: [{ json: documentInput }],
  });
  expect(wrongOrigin.status()).toBe(400);
  const wrongMethod = await page.request.get(`${FIXTURE_ORIGIN}/api/trpc/documents.listExisting`, {
    headers: { origin: FIXTURE_ORIGIN },
  });
  expect(wrongMethod.status()).toBe(400);
  const malformedEnvelope = await page.request.post(
    `${FIXTURE_ORIGIN}/api/trpc/documents.listExisting`,
    {
      headers: {
        'content-type': 'application/json',
        origin: FIXTURE_ORIGIN,
      },
      data: [{ json: documentInput }, { json: documentInput }],
    },
  );
  expect(malformedEnvelope.status()).toBe(400);

  await expect(page.getByRole('heading', { name: 'Existing documents' })).toBeVisible();
  const documentSelect = page.getByRole('combobox', { name: 'Document' });
  await expect(documentSelect).toBeVisible();
  await expect(documentSelect.locator('option')).toHaveCount(3);
  await expect(page.getByText('Source: mail_attachment', { exact: true })).toBeVisible();
  await expect(page.getByText('retrievable: true', { exact: true })).toBeVisible();
  await expect(page.getByText('Artifact mode: unsupported', { exact: true })).toBeVisible();

  await page.getByRole('button', { name: 'Read text' }).click();
  await expect(page.getByRole('region', { name: 'Document result' })).toContainText(
    'Authorized fixture invoice — synthetic bytes only.',
  );
  await expect(page.getByTestId('document-status')).toHaveText('ok');
  await expect(page.getByTestId('document-validation')).toContainText('identity: match');
  await expect(page.getByTestId('document-validation')).toContainText('stayDates: match');
  await expect(page.getByTestId('document-validation')).toContainText('payer: match');
  await expect(page.getByTestId('document-validation')).toContainText('kind: match');
  await expect(page.getByTestId('document-validation')).toContainText('version: current');
  await expect(page.getByTestId('document-validation')).toContainText('priceVisibility: allowed');
  await expect(page.getByText('Validated text result', { exact: true })).toBeVisible();
  await expect(page.getByRole('link', { name: /download/i })).toHaveCount(0);
  await expect(page.getByRole('button', { name: /send/i })).toHaveCount(0);

  await documentSelect.selectOption({ label: 'Identity review document' });
  await page.getByRole('button', { name: 'Read text' }).click();
  const review = page.getByRole('region', { name: 'Document result' });
  await expect(review).toContainText('Review-only fixture text — identity remains unverified.');
  await expect(page.getByTestId('document-status')).toHaveText('manual_required');
  await expect(page.getByText('Manual review required', { exact: true })).toBeVisible();
  await expect(page.getByTestId('document-validation')).toContainText('identity: mismatch');
  await expect(
    page.getByText('Not validated, downloadable, or sendable', { exact: true }),
  ).toBeVisible();
  await expect(page.getByRole('link', { name: /download/i })).toHaveCount(0);
  await expect(page.getByRole('button', { name: /send/i })).toHaveCount(0);

  await documentSelect.selectOption({ label: 'Authorized fixture invoice' });
  await page.getByRole('button', { name: 'Request artifact' }).click();
  await expect(page.getByTestId('document-status')).toHaveText('manual_required');
  await expect(page.getByText('Artifact mode: unsupported', { exact: true })).toBeVisible();
  await expect(page.getByText('artifactRef: null', { exact: true })).toBeVisible();
  await expect(page.getByRole('link', { name: /download/i })).toHaveCount(0);

  await page.getByRole('button', { name: 'Check unavailable PMS source' }).click();
  await expect(page.getByRole('status')).toContainText('PMS finalized document source unavailable');
  await expect(page.getByRole('status')).toContainText('SURFACE_UNPROVEN');
  await expect(page.getByRole('status')).toContainText('retrievable: false');

  await page.getByRole('button', { name: 'Check denied scope' }).click();
  await expect(page.getByRole('status')).toContainText('Access denied');
  await expect(page.getByRole('status')).toContainText('SCOPE_DENIED');

  const requests = (await page.evaluate(
    () => window.__reservationToolsPilotRequests ?? [],
  )) as RecordedFixtureRequest[];
  const allowedPaths = new Set([
    '/api/trpc/documents.listExisting',
    '/api/trpc/documents.readExisting',
  ]);
  expect(audit.forbidden).toEqual([]);
  expect(requests.filter((request) => request.path.startsWith('/api/trpc/'))).not.toHaveLength(0);
  expect(requests.every((request) => allowedPaths.has(request.path))).toBe(true);
  expect(requests.every((request) => request.method === 'POST')).toBe(true);
  expect(requests.every((request) => typeof request.status === 'number')).toBe(true);
  expect(requests.some((request) => request.path.endsWith('/documents.listExisting'))).toBe(true);
  expect(requests.some((request) => request.path.endsWith('/documents.readExisting'))).toBe(true);
  await page.screenshot({ path: testInfo.outputPath('documents.png'), fullPage: true });
});

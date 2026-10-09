import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import * as lookup from './party-lookup.mjs';

// The dialog's filter row, as the live screen lays it out: the saved-search combo, the field selector, the empty filter box,
// and the grey Run button at the right end of the row.
const RUN = { x: 990, y: 212, width: 40, height: 28 };
const box = (index, x, width, readonly = false) => ({ index, x, y: 212, width, height: 26, readonly });

test('the filter box is the editable box nearest the Run button, with the read-only field selector to its left', () => {
  const boxes = [box(0, 248, 248), box(1, 603, 200, true), box(2, 851, 134), { index: 3, x: 287, y: 286, width: 100, height: 22 }];
  assert.equal(lookup.runRowFilterIndex(boxes, RUN), 2);
  assert.equal(lookup.runRowSelectorIndex(boxes, 2), 1);
});

test('an editable field selector that shows a column name still marks the filter box; a combo left of it does not', () => {
  const named = (index, x, width, value) => ({ ...box(index, x, width), value });
  assert.equal(lookup.runRowFilterIndex([named(0, 248, 248, '360 degrees'), named(1, 603, 200, 'Booking Agency Name'), named(2, 851, 134, '')], RUN), 2);
  // No filter box: the nearest editable box is the selector, and the combo before it is not a selector.
  assert.equal(lookup.runRowFilterIndex([named(0, 248, 248, '360 degrees'), named(1, 603, 200, 'Booking Agency Name')], RUN), null);
});

test('a saved-search combo alone on the Run row is never the filter box', () => {
  assert.equal(lookup.runRowFilterIndex([box(0, 248, 248), box(1, 603, 200, true)], RUN), null);
});

// Real Chromium on the local fixtures, never HMS. Playwright's own build is used when installed; otherwise the newest
// chromium build in the Playwright cache. With no build at all the browser tests are skipped, and say so.
async function launchChromium() {
  const { chromium } = await import('playwright');
  const candidates = [process.env.PARTY_LOOKUP_CHROMIUM, undefined];
  const cache = join(homedir(), '.cache', 'ms-playwright');
  if (existsSync(cache)) {
    const builds = readdirSync(cache)
      .filter((dir) => /^chromium-\d+$/.test(dir))
      .sort((a, b) => Number(b.slice('chromium-'.length)) - Number(a.slice('chromium-'.length)));
    for (const build of builds) candidates.push(join(cache, build, 'chrome-linux64', 'chrome'));
  }
  for (const executablePath of candidates) {
    if (executablePath !== undefined && !existsSync(executablePath)) continue;
    try {
      return await chromium.launch({ headless: true, ...(executablePath ? { executablePath } : {}) });
    } catch {
      // Not a runnable build: try the next one.
    }
  }
  return null;
}

const browser = await launchChromium();
after(() => browser?.close());
const skip = browser ? false : 'no Chromium build for Playwright: run `pnpm -C apps/server-pilot exec playwright install chromium`';
const FIXTURES = new URL('./fixtures/party-lookup/', import.meta.url);

async function openFixture(name) {
  const page = await browser.newPage();
  await page.goto(new URL(name, FIXTURES).href);
  return page;
}

test('booking agencies: the query goes in the box on the Run row, the dialog Run runs it, and the combo and header are untouched', { skip }, async () => {
  const page = await openFixture('booking-agencies-dialog.html');
  try {
    assert.equal(await lookup.fillRunRowFilter(page, 'bookingAgency', 'Acme Travel'), true);
    assert.equal(await page.inputValue('#filter-box'), 'Acme Travel');
    assert.equal(await page.inputValue('#saved-search'), '360 degrees');
    assert.equal(await lookup.runLookupFilter(page, 'bookingAgency'), true);
    assert.equal(await page.evaluate(() => window.dialogRan), 'Acme Travel');
    assert.equal(await page.evaluate(() => window.headerRan === true), false);
  } finally {
    await page.close();
  }
});

test('the field selector is switched to the name field before the query goes in', { skip }, async () => {
  const page = await openFixture('booking-agencies-dialog.html');
  try {
    await page.$eval('#field-selector', (el) => {
      el.value = 'IATA/Reference Number';
    });
    assert.equal(await lookup.fillRunRowFilter(page, 'bookingAgency', 'Acme Travel'), true);
    assert.equal(await page.inputValue('#field-selector'), 'Booking Agency Name');
    assert.equal(await page.inputValue('#filter-box'), 'Acme Travel');
  } finally {
    await page.close();
  }
});

test('with no box on the Run row nothing is typed: the combo keeps its text and nothing runs', { skip }, async () => {
  const page = await openFixture('booking-agencies-dialog.html');
  try {
    await page.$eval('#filter-box', (el) => el.remove());
    assert.equal(await lookup.fillRunRowFilter(page, 'bookingAgency', 'Acme Travel'), 'no_run_row_input');
    assert.equal(await page.inputValue('#saved-search'), '360 degrees');
    assert.equal(await page.evaluate(() => window.dialogRan), undefined);
  } finally {
    await page.close();
  }
});

test('organizations: the same row, with the field selector on Name', { skip }, async () => {
  const page = await openFixture('organizations-dialog.html');
  try {
    assert.equal(await lookup.fillRunRowFilter(page, 'organization', 'Woolworths Holdings'), true);
    assert.equal(await page.inputValue('#filter-box'), 'Woolworths Holdings');
    assert.equal(await page.inputValue('#saved-search'), 'Woolworths');
    assert.equal(await lookup.runLookupFilter(page, 'organization'), true);
    assert.equal(await page.evaluate(() => window.dialogRan), 'Woolworths Holdings');
  } finally {
    await page.close();
  }
});

test('an empty query types nothing', { skip }, async () => {
  const page = await openFixture('organizations-dialog.html');
  try {
    assert.equal(await lookup.fillRunRowFilter(page, 'organization', ''), 'query_empty');
    assert.equal(await page.inputValue('#filter-box'), '');
    assert.equal(await page.isEnabled('#dialog-run'), false);
  } finally {
    await page.close();
  }
});

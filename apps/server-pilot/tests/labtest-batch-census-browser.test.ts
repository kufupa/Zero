import { existsSync } from 'node:fs';
import { chromium, type Browser } from 'playwright';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { consumeLabtestPreimage, searchLabtestBatchPreimage } from '../tooling/hms-cloud/labtest-preimage.mjs';

const origin = 'https://hmsweb.hms.eu1.inforcloudsuite.com';
const binding = { manifestDigest: 'a'.repeat(64), childId: 'b'.repeat(64), childDigest: 'c'.repeat(64) };
const dates = { arrival: '2027-03-01', departure: '2027-03-03' };
const browserPath = [process.env.HMS_TEST_CHROMIUM_PATH, chromium.executablePath(),
  '/home/ubuntu/.cache/ms-playwright/chromium-1243/chrome-linux64/chrome',
  '/home/orca/.cache/ms-playwright/chromium_headless_shell-1217/chrome-headless-shell-linux64/chrome-headless-shell',
].find((path): path is string => typeof path === 'string' && existsSync(path));

function syntheticBody(): string {
  const offset = (value: string) => (Date.parse(`${value}T00:00:00Z`) - Date.parse('2026-11-02T00:00:00Z')) / 86_400_000;
  return new URLSearchParams({ MADDON_FILTER_ALIAS_NAME_1: 'departuredate', MADDON_FILTER_OPERATOR_1: '>=',
    MADDON_FILTER_VALUE_1: String(offset('2027-02-20')), MADDON_FILTER_ALIAS_NAME_2: 'arrivaldate',
    MADDON_FILTER_OPERATOR_2: '<=', MADDON_FILTER_VALUE_2: String(offset('2027-03-20')),
    MADDON_FILTER_ALIAS_NAME_5: 'lastname_filter', MADDON_FILTER_OPERATOR_5: 'BEGINS',
    MADDON_FILTER_VALUE_5: 'Labtest', GRID_NAME: 'OSRESS' }).toString();
}

afterEach(() => vi.useRealTimers());
describe('synthetic batch census browser', () => {
  it('binds a real page response and invalidates a proof after a further search', async () => {
    // Offline plus an all-URL page route ensures no request can reach the real HMS.
    expect(browserPath, 'Chromium required for this test').toBeTruthy();
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-11-02T12:00:00Z'));
    let browser: Browser | undefined;
    try {
      browser = await chromium.launch({ executablePath: browserPath, headless: true });
      const context = await browser.newContext({ serviceWorkers: 'block' });
      await context.setOffline(true);
      const page = await context.newPage();
      const body = syntheticBody();
      const html = `<!doctype html><title>Infor HMS - HRCEN</title>
        <style>input{position:absolute;left:20px;top:20px;width:300px;height:20px;box-sizing:border-box}
        a{position:absolute;left:330px;top:20px;width:30px;height:20px}
        .x-window{position:absolute;left:20px;top:45px;width:300px;height:140px}
        .x-grid-cell{display:block}</style>
        <input name="search"><a class="x-btn" href="#">Run</a>
        <div class="x-window x-menu"><div name="gridTitle">Feb 20, 2027 - Mar 20, 2027</div>
        <div class="x-grid-row"><div class="x-grid-cell">C1</div><div class="x-grid-cell">Proof</div>
        <div class="x-grid-cell">Labtest</div><div class="x-grid-cell">01-MAR-2027<br>03-MAR-2027</div></div>
        <div>Records: 1 of 1</div></div>
        <script>document.querySelector('a').onclick = (event) => { event.preventDefault();
          fetch('/web/base/OSRESS.search', { method: 'POST', body: ${JSON.stringify(body)} }); };</script>`;
      const response = { pageData: { grid: { GRIDRESULT: { GRID: { METADATA: { GRIDNAME: 'OSRESS', RECORDS: '1',
        MORERECORDPRESENT: '-' }, DATA: [{ confirmationnumber: 'C1', firstname: 'Proof', lastname: 'Labtest',
        arrivaldate: '01-MAR-2027', departuredate: '03-MAR-2027', status: 'Reserved' }] } } } } };
      await page.route('**/*', async (route) => {
        const request = route.request();
        const url = new URL(request.url());
        if (url.origin === origin && url.pathname === '/web/base' && request.method() === 'GET') {
          await route.fulfill({ status: 200, contentType: 'text/html', body: html });
        } else if (url.origin === origin && url.pathname === '/web/base/OSRESS.search' && request.method() === 'POST') {
          await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(response) });
        } else await route.abort();
      });
      await page.goto(`${origin}/web/base`);
      const authorizeSiblings = vi.fn(async () => ({ authorized: true,
        matches: [{ confirmation: 'C1', recordDigest: 'd'.repeat(64) }] }));
      const result = await searchLabtestBatchPreimage(page, dates, { binding, authorizeSiblings });
      expect(result.outcome).toBe('siblings_verified');
      expect(authorizeSiblings).toHaveBeenCalledOnce();
      await page.evaluate(async (postBody) => {
        await fetch('/web/base/OSRESS.search', { method: 'POST', body: postBody });
      }, body);
      expect(consumeLabtestPreimage(page, { ...dates, preimageId: result.preimageId, batchBinding: binding })).toBe(false);
    } finally {
      await browser?.close();
    }
  }, 60_000);
});

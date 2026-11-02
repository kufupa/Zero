import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium } from 'playwright';
import { describe, expect, it } from 'vitest';
import { captureOutlookPane, readOutlookPane } from '../scripts/nava-replay-outlook-pane';

const browserPath = [chromium.executablePath(),
  '/home/orca/.cache/ms-playwright/chromium_headless_shell-1217/chrome-headless-shell-linux64/chrome-headless-shell'].find(existsSync);

describe('Outlook pane observations', () => {
  it.skipIf(!browserPath)('reads the actual pane selectors, detects unsynced and captures screenshots', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'nava-outlook-pane-'));
    const browser = await chromium.launch({ executablePath: browserPath, headless: true });
    try {
      const page = await browser.newPage();
      await page.setContent(`<div><header aria-label="Nava mailbox">Nava</header>
        <section id="quote-selected-message" aria-label="Selected email"><span data-pii>Guest</span></section>
        <span data-read-as="quote">Quote</span><main class="nava-pane-scroll"></main></div>`);
      expect(await readOutlookPane(page)).toEqual({ selectedUi: true, readAs: 'quote', outcome: 'intent', voucher: false });
      const shots = await captureOutlookPane(page, dir);
      expect(shots.pane && existsSync(shots.pane)).toBe(true);
      expect(shots.page && existsSync(shots.page)).toBe(true);
      await page.locator('main').evaluate((element) => { element.textContent = 'This email has not finished syncing yet.'; });
      expect((await readOutlookPane(page)).outcome).toBe('unsynced');
    } finally {
      await browser.close();
      rmSync(dir, { recursive: true, force: true });
    }
  }, 30_000);
});

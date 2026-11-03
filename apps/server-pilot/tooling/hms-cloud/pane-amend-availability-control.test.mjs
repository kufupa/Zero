import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { clickLabtestAmendAvailability } from './pane-amend-session.mjs';

const require = createRequire(new URL('../stagehand/package.json', import.meta.url));
const { chromium } = require('playwright');
const bounded = (value) => value;

test('amend availability selects one visible, enabled saved-stay control', { timeout: 30_000 }, async (t) => {
  const browser = await chromium.launch({ headless: true, executablePath: process.env.HMS_TEST_CHROMIUM_PATH || undefined });
  try {
    const page = await browser.newPage();
    const cases = [
      { name: 'visible text', html: '<button class="x-btn">Check Availability</button>', allowed: true },
      { name: 'tooltip', html: '<button data-qtip="Check Availability">Check</button>', allowed: true },
      { name: 'same text and tooltip', html: '<button class="x-btn" data-qtip="Check Availability">Check Availability</button>', allowed: true },
      { name: 'duplicate text', html: '<button class="x-btn">Check Availability</button><button class="x-btn">Check Availability</button>' },
      { name: 'different text and tooltip controls', html: '<button class="x-btn">Check Availability</button><button data-qtip="Check Availability">Check</button>' },
      { name: 'disabled', html: '<button class="x-btn" disabled>Check Availability</button>' },
      { name: 'absent', html: '<button class="x-btn">Hotel Availability</button>' },
    ];
    for (const item of cases) {
      await t.test(item.name, async () => {
        await page.setContent(`${item.html}<script>window.clicked=0;document.addEventListener('click',()=>window.clicked++);</script>`);
        if (item.allowed) await clickLabtestAmendAvailability(page.mainFrame(), bounded);
        else await assert.rejects(clickLabtestAmendAvailability(page.mainFrame(), bounded), /AMEND_CONTROL_NOT_UNIQUE/);
        assert.equal(await page.evaluate(() => window.clicked), item.allowed ? 1 : 0);
      });
    }
    await page.close();
  } finally { await browser.close(); }
});

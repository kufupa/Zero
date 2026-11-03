import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { clickRetainRatesButton } from './labtest-amend-save.mjs';

const require = createRequire(new URL('../stagehand/package.json', import.meta.url));
const { chromium } = require('playwright');
const bounded = (value) => value;
const shell = `<!doctype html><body>
  <div class="x-window" style="display:block">
    <span data-question>Retain the current rates?</span>
    <a class="x-btn" style="display:inline-block" data-choice="yes">Yes</a>
    <a class="x-btn" style="display:inline-block" data-choice="no">No</a>
    <a class="x-btn" style="display:inline-block" data-choice="cancel">Cancel</a>
  </div>
  <script>
    window.clicks = [];
    document.querySelectorAll('a.x-btn').forEach((button) =>
      button.addEventListener('click', () => window.clicks.push(button.dataset.choice)));
  </script>
</body>`;

test('retain dialog rechecks trusted clicks in Chromium', { timeout: 30_000 }, async (t) => {
  let browser;
  try {
    browser = await chromium.launch({ headless: true, executablePath: process.env.HMS_TEST_CHROMIUM_PATH || undefined });
    const page = await browser.newPage();
    for (const choice of ['yes', 'no']) {
      await t.test(`approved ${choice} on the exact question`, async () => {
        await page.setContent(shell);
        await clickRetainRatesButton(page.mainFrame(), choice, bounded);
        assert.deepEqual(await page.evaluate(() => window.clicks), [choice]);
      });
    }
    for (const change of ['question', 'penalty', 'other-text', 'second-dialog', 'button']) {
      await t.test(`refuses ${change} introduced after pointer-down`, async () => {
        await page.setContent(shell);
        await page.evaluate((kind) => {
          const button = document.querySelector('[data-choice="yes"]');
          button.addEventListener('mousedown', () => {
            const dialog = document.querySelector('.x-window');
            if (kind === 'question') dialog.querySelector('[data-question]').textContent = 'Cancellation penalty?';
            if (kind === 'penalty') dialog.insertAdjacentHTML('beforeend', '<div>Cancellation fee applies.</div>');
            if (kind === 'other-text') dialog.insertAdjacentHTML('beforeend', '<div>Additional instruction.</div>');
            if (kind === 'second-dialog') document.body.insertAdjacentHTML('beforeend', '<div class="x-window">Other dialog</div>');
            if (kind === 'button') button.textContent = 'No';
          }, { once: true });
        }, change);
        await assert.rejects(clickRetainRatesButton(page.mainFrame(), 'yes', bounded), /RETAIN_DIALOG_UNVERIFIED/);
        assert.deepEqual(await page.evaluate(() => window.clicks), []);
      });
    }
    await page.close();
  } finally {
    await browser?.close();
  }
});

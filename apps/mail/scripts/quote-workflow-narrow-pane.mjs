import { spawnSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const dir = path.dirname(fileURLToPath(import.meta.url));
const html = path.join(dir, '../tests/browser-quote-workflow/narrow-pane.html');
const png = path.join(dir, '../tests/browser-quote-workflow/narrow-pane-380.png');
const receipt = path.join(dir, '../tests/browser-quote-workflow/narrow-pane-receipt.json');
const chrome =
  process.env.QUOTE_UI_CHROME ??
  '/home/orca/.cache/ms-playwright/chromium-1243/chrome-linux64/chrome';

const result = spawnSync(
  chrome,
  [
    '--headless=new',
    '--disable-gpu',
    '--no-sandbox',
    '--hide-scrollbars',
    '--force-device-scale-factor=1',
    `--window-size=380,900`,
    `--screenshot=${png}`,
    `file://${html}`,
  ],
  { encoding: 'utf8' },
);

const payload = {
  at: new Date().toISOString(),
  chrome,
  status: result.status,
  stderr: (result.stderr ?? '').slice(0, 2000),
  png,
  html,
  viewport: { width: 380, height: 900 },
  note: 'Chromium screenshot of production QuoteWorkflowPanel markup at 380px. Playwright 1.52 wanted chromium_headless_shell-1169; used cached chromium-1243 instead. Not a live Outlook/Windows pane.',
};
writeFileSync(receipt, `${JSON.stringify(payload, null, 2)}\n`);
console.log(JSON.stringify(payload, null, 2));
if (result.status !== 0) process.exit(result.status ?? 1);

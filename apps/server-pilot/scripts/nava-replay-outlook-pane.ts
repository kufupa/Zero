import { existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import type { Page } from 'playwright';
import { MARK_PII_JS, PII_SELECTOR } from './nava-preview-run';

export type OutlookPaneObservation = {
  selectedUi: boolean;
  readAs: string | null;
  outcome: 'intent' | 'unsynced' | 'fallback' | 'error' | 'reading';
  voucher: boolean;
};

/** Read the real Outlook pane structure; never treat a missing badge as a successful result. */
export async function readOutlookPane(page: Page): Promise<OutlookPaneObservation> {
  return page.evaluate(() => {
    const text = document.body?.innerText ?? '';
    const selectedUi = Boolean(document.querySelector('#quote-selected-message[aria-label="Selected email"]'));
    const readAs = document.querySelector('[data-read-as]')?.getAttribute('data-read-as') || null;
    const voucher = Boolean(document.querySelector('#quote-voucher-find'));
    const unsynced = /This email has not finished syncing/.test(text);
    const reading = /Nava is (reading the email|re-reading with your note)/.test(text);
    const fallback = /Read without AI/.test(text);
    const error = Boolean(document.querySelector('[role="alert"], [data-sonner-toast][data-type="error"]'));
    const outcome = unsynced ? 'unsynced' : fallback ? 'fallback' : reading || !selectedUi ? 'reading'
      : error ? 'error' : readAs || voucher ? 'intent' : 'reading';
    return { selectedUi, readAs, outcome, voucher };
  });
}

/** Capture whole Outlook pane and normal page, masking fields before both screenshots. */
export async function captureOutlookPane(page: Page, dir: string): Promise<{ pane: string | null; page: string | null }> {
  mkdirSync(dir, { recursive: true });
  const viewport = { width: 1600, height: 1000 };
  const panePath = join(dir, 'pane.png');
  const pagePath = join(dir, 'page.png');
  if (existsSync(panePath) || existsSync(pagePath)) throw new Error('Replay screenshot path already exists');
  const pane = page.locator('header[aria-label="Nava mailbox"]').locator('..');
  const mark = async () => { await page.evaluate(`(${MARK_PII_JS})()`).catch(() => 0); };
  const mask = [page.locator(`[data-runner-mask], ${PII_SELECTOR}`)];
  await page.setViewportSize(viewport);
  const overflow = await page.locator('.nava-pane-scroll').evaluate((element) =>
    Math.max(0, element.scrollHeight - element.clientHeight)).catch(() => 0);
  if (overflow) await page.setViewportSize({ width: viewport.width, height: Math.min(16_000, viewport.height + overflow) });
  await mark();
  await pane.screenshot({ path: panePath, mask, timeout: 15_000 }).catch(() => undefined);
  await page.setViewportSize(viewport);
  await mark();
  await page.screenshot({ path: pagePath, fullPage: true, mask, timeout: 15_000 }).catch(() => undefined);
  return { pane: existsSync(panePath) ? panePath : null, page: existsSync(pagePath) ? pagePath : null };
}

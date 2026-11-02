import { existsSync } from 'node:fs';
import { chromium } from 'playwright';
import { describe, expect, it } from 'vitest';
import { readReplayDetails, replayDetailFailures, type ReplayDetails } from '../scripts/nava-replay-details';

const binary = [chromium.executablePath(),
  '/home/orca/.cache/ms-playwright/chromium_headless_shell-1217/chrome-headless-shell-linux64/chrome-headless-shell'].find(existsSync);
const details: ReplayDetails = { stays: [{ rooms: 4, arrival: 'Check-in 5 Jan 2027', departure: 'Check-out 9 Jan 2027', dinner: true }],
  guests: ['Sample One', 'Sample Two'], requests: ['Airport shuttle quote', 'Invoice including tax'], amendments: ['Change arrival to 1 Nov 2026 and departure to 7 Nov 2026'] };

describe('structured replay outcome checks', () => {
  it('accepts matching pane facts and rejects dropped details', () => {
    const checks = [{ kind: 'stay_count', count: 1 }, { kind: 'room_count', stay: 1, count: 4 },
      { kind: 'stay_dates', stay: 1, arrival: '5 Jan 2027', departure: '9 Jan 2027' },
      { kind: 'dinner', stay: 1 }, { kind: 'guests', names: ['One', 'Two'] },
      { kind: 'ask', all: [['airport'], ['shuttle', 'transfer']] },
      { kind: 'amendment', all: [['1 nov'], ['7 nov'], ['2026']] }];
    expect(replayDetailFailures(checks, details, false)).toEqual([]);
    expect(replayDetailFailures(checks, { ...details, stays: [{ ...details.stays[0]!, rooms: 1 }], guests: ['Sample One'], requests: [] }, false))
      .toEqual(['wrong_detail_1', 'wrong_detail_4', 'wrong_detail_5']);
    expect(replayDetailFailures(checks, { ...details, requests: ['No airport shuttle requested'] }, false)).toContain('wrong_detail_5');
    expect(replayDetailFailures(checks, { ...details, stays: [] }, false)).toContain('wrong_detail_0');
  });
  it('fails missing or malformed evidence and accepts empty checks only with required source metadata', () => {
    expect(replayDetailFailures(undefined, details, false)).toEqual(['detail_checks_missing']);
    expect(replayDetailFailures([], details, false)).toEqual(['detail_checks_missing']);
    expect(replayDetailFailures([], details, true)).toEqual([]);
    expect(replayDetailFailures([{ kind: 'ask', all: [[]] }, { kind: 'room_count', stay: 0, count: 4 },
      { kind: 'unknown' }], details, false)).toEqual(['invalid_detail_0', 'invalid_detail_1', 'invalid_detail_2']);
    expect(replayDetailFailures([{ kind: 'stay_count', count: 1 }], null, false)).toEqual(['detail_observation_missing']);
  });
  it.skipIf(!binary)('uses pane-owned controls, not words in the selected email', async () => {
    const browser = await chromium.launch({ executablePath: binary, headless: true });
    try {
      const page = await browser.newPage();
      await page.setContent(`<section id="quote-selected-message">Airport shuttle for Sample One. 4 rooms.</section>`);
      const checks = [{ kind: 'room_count', stay: 1, count: 4 }, { kind: 'guests', names: ['One'] },
        { kind: 'ask', all: [['airport'], ['shuttle']] }];
      expect(replayDetailFailures(checks, await readReplayDetails(page), false)).toEqual(['wrong_detail_0', 'wrong_detail_1', 'wrong_detail_2']);
      await page.setContent(`<section id="quote-selected-message">Unrelated source</section>
        <ul aria-label="Stay guests"><li>Sample One</li></ul>
        <article aria-label="Stay 1 details"><header><p>4 rooms · 4 guests total</p></header>
        <button>Check-in 5 Jan 2027</button><button>Check-out 9 Jan 2027</button>
        <select aria-label="Meal plan"><option value="dinner_bb" selected>Dinner bed breakfast</option></select></article>
        <section aria-label="Check before sending"><div><p>Airport shuttle quote</p></div></section>`);
      expect(replayDetailFailures(checks, await readReplayDetails(page), false)).toEqual([]);
      await page.locator('article header p').evaluate((node) => { node.textContent = '4 rooms requested · split not set'; });
      expect(replayDetailFailures(checks, await readReplayDetails(page), false)).toContain('wrong_detail_0');
    } finally { await browser.close(); }
  }, 30_000);
});

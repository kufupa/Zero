/**
 * Tool-specific OSRRAV quote facade. This module alone owns raw page operations.
 * Production quote drivers receive only proven, inert operations.
 */
import { LIVE_QUOTE_STAY_SEARCH_PATH, buildExactOsrravSearchBody } from './live-read-manifest.js';
import { HmsRuntimeError, type HmsPage, type HmsReadSession } from './runtime.js';
import type { QuoteStayCandidate } from './quote-stay-candidate.js';

export interface QuoteStayFacade {
  navigate(): Promise<void>;
  collectChromeDefaults(): Promise<Record<string, string>>;
  searchExact(candidate: QuoteStayCandidate, chrome: Record<string, string>): Promise<string>;
}

async function navigateOsrrav(page: HmsPage, origin: string): Promise<void> {
  const html = await page.content().catch(() => '');
  if (/name="roomtypes"/i.test(html)) return;
  if (/data-testid="room-type-rate-availability"/i.test(html)) {
    throw new HmsRuntimeError(
      'SCHEMA_DRIFT',
      'fixture HTML quote surface rejected in live navigate',
    );
  }
  await page.click('text=Front Desk').catch(() => undefined);
  await new Promise((r) => setTimeout(r, 600));
  await page.click('text=Availability').catch(() => undefined);
  await new Promise((r) => setTimeout(r, 600));
  await page.click('text=Room Type and Rate Availability').catch(() => undefined);
  await new Promise((r) => setTimeout(r, 2500));
  let ready = await page.content().catch(() => '');
  if (/name="roomtypes"/i.test(ready)) return;
  await page
    .postForm(`${origin}/web/base/OSRRAV?FUNCTION_CLASS=WEBL&USER_FUNCTION_NAME=OSRRAV`, {
      SYSTEM_FUNCTION_NAME: 'OSRRAV',
      USER_FUNCTION_NAME: 'OSRRAV',
      CURRENT_TAB_NAME: '',
      MENU_MODULE_KEY: '0',
      FUNCTION_CLASS: 'WEBL',
      removescreenflows: 'yes',
    })
    .catch(() => undefined);
  ready = await page.content().catch(() => '');
  if (!/name="roomtypes"/i.test(ready)) {
    throw new HmsRuntimeError('SCHEMA_DRIFT', 'OSRRAV surface not ready');
  }
}

async function collectChromeDefaults(page: HmsPage): Promise<Record<string, string>> {
  return page.evaluate(() => {
    const names = [
      'property',
      'salesstrategy',
      'showunavailable',
      'ratetype',
      'showexclusiverates',
      'showavailableforsale',
      'currency',
      'rowpagesize',
      'hoteldate',
      'firstcolumndate',
      'salesstrategy_display',
      'ratetype_display',
      'currency_display',
      'pagemode',
      'ONLY_DATA_REQUIRED',
    ];
    const out: Record<string, string> = {};
    const doc = (
      globalThis as unknown as {
        document?: {
          querySelector(s: string): { value?: string } | null;
        };
      }
    ).document;
    if (!doc) return out;
    for (const name of names) {
      const input = doc.querySelector(`input[name="${name}"]`);
      if (input) out[name] = String(input.value ?? '');
    }
    return out;
  });
}

export function createQuoteStayFacade(session: HmsReadSession): QuoteStayFacade {
  const page = session.page;
  return {
    async navigate() {
      await navigateOsrrav(page, session.origin);
    },
    async collectChromeDefaults() {
      return collectChromeDefaults(page);
    },
    async searchExact(candidate, chrome) {
      const body = buildExactOsrravSearchBody(candidate, chrome);
      const correlation = page.waitForCorrelatedResponse
        ? page.waitForCorrelatedResponse(LIVE_QUOTE_STAY_SEARCH_PATH)
        : Promise.resolve();
      const [post, correlated] = await Promise.allSettled([
        page.postForm(`${session.origin}${LIVE_QUOTE_STAY_SEARCH_PATH}`, body),
        correlation,
      ]);
      if (post.status === 'rejected') throw post.reason;
      if (correlated.status === 'rejected') {
        throw new HmsRuntimeError('SCHEMA_DRIFT', 'quote search correlation failed');
      }
      return post.value || (await page.content());
    },
  };
}

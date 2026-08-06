/**
 * Tool-specific Guest Stay facade. This module alone owns raw page operations.
 * Production find drivers receive only proven, inert operations.
 */
import {
  buildExactOsressSearchBody,
  LIVE_GUEST_STAY_SEARCH_PATH,
  type ExactReservationCandidate,
} from './live-read-manifest.js';
import { HmsRuntimeError, type HmsPage, type HmsReadSession } from './runtime.js';

export interface FindReservationFacade {
  readonly requireLiveEnvelope: boolean;
  verifyBinding(): Promise<void>;
  searchExact(candidate: ExactReservationCandidate): Promise<string>;
}

function hasSearch(html: string): boolean {
  return /name="search"|ff_confirmationnumber|data-testid="results"/i.test(html);
}

async function exactMenuLabel(page: HmsPage, label: 'Front Desk' | 'Guest Stay') {
  try {
    if (label === 'Front Desk') {
      return await page.evaluateStableDom(() => {
        const text = (globalThis as unknown as { document?: { body?: { innerText?: string } } })
          .document?.body?.innerText ?? '';
        return text.split('\n').some((line) => line.trim() === 'Front Desk');
      });
    }
    return await page.evaluateStableDom(() => {
      const text = (globalThis as unknown as { document?: { body?: { innerText?: string } } })
        .document?.body?.innerText ?? '';
      return text.split('\n').some((line) => line.trim() === 'Guest Stay');
    });
  } catch {
    return false;
  }
}

async function navigate(page: HmsPage, origin: string): Promise<void> {
  let html = await page.content().catch(() => '');
  if (hasSearch(html)) return;
  const fixture = /data-tenant=|data-property-code=/i.test(html);
  if (!fixture) {
    const menuDeadline = Date.now() + 15_000;
    while (!(await exactMenuLabel(page, 'Front Desk')) && Date.now() < menuDeadline) {
      await new Promise((resolve) => setTimeout(resolve, 400));
    }
    if (await exactMenuLabel(page, 'Front Desk')) {
      await page.click('text=Front Desk');
      const guestDeadline = Date.now() + 8_000;
      while (!(await exactMenuLabel(page, 'Guest Stay')) && Date.now() < guestDeadline) {
        await new Promise((resolve) => setTimeout(resolve, 300));
      }
      await page.click('text=Guest Stay');
      const paintDeadline = Date.now() + 15_000;
      while (Date.now() < paintDeadline) {
        if (hasSearch(await page.content().catch(() => ''))) return;
        await new Promise((resolve) => setTimeout(resolve, 300));
      }
      return;
    }
  }
  if (fixture) {
    await page.goto(`${origin}/web/base/OSRESV`, { timeout: 8_000 }).catch(() => undefined);
    html = await page.content().catch(() => '');
    if (hasSearch(html)) return;
    await page.postForm(
      `${origin}/web/base/OSRESV?FUNCTION_CLASS=WEBL&USER_FUNCTION_NAME=OSRESV`,
      {
        SYSTEM_FUNCTION_NAME: 'OSRESV',
        USER_FUNCTION_NAME: 'OSRESV',
        CURRENT_TAB_NAME: '',
        MENU_MODULE_KEY: '0',
        FUNCTION_CLASS: 'WEBL',
        removescreenflows: 'yes',
      },
    ).catch(() => undefined);
  }
}

export function createFindReservationFacade(
  session: HmsReadSession,
): FindReservationFacade {
  const page = session.page;
  return {
    requireLiveEnvelope:
      session.origin === 'https://appsrv-1.legacyhotels.co.za',
    async verifyBinding() {
      const binding = await page.readPropertyBinding();
      if (!binding.tenant || !binding.propertyCode) {
        const title = await page.title();
        if (!/HRCEN|Centurion/i.test(title)) {
          throw new HmsRuntimeError('PROPERTY_MISMATCH', 'property binding missing after login');
        }
      }
      if (!page.url().startsWith(session.origin)) {
        throw new HmsRuntimeError('AUTH_FAILED', 'post-login origin mismatch');
      }
    },
    async searchExact(candidate) {
      await navigate(page, session.origin);
      const html = await page.content();
      if (/name="search"/i.test(html)) {
        await page.fill('input[name="search"]', candidate.value).catch(() => undefined);
      } else if (/name="ff_confirmationnumber"/i.test(html)) {
        await page
          .fill('input[name="ff_confirmationnumber"]', candidate.value)
          .catch(() => undefined);
      }
      const correlation = page.waitForCorrelatedResponse
        ? page.waitForCorrelatedResponse(LIVE_GUEST_STAY_SEARCH_PATH)
        : Promise.resolve();
      const [post, correlated] = await Promise.allSettled([
        page.postForm(
          `${session.origin}${LIVE_GUEST_STAY_SEARCH_PATH}`,
          buildExactOsressSearchBody(candidate),
        ),
        correlation,
      ]);
      if (post.status === 'rejected') throw post.reason;
      if (correlated.status === 'rejected') {
        throw new HmsRuntimeError('SCHEMA_DRIFT', 'search correlation failed');
      }
      return post.value || page.content();
    },
  };
}

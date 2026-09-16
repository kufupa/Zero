/**
 * Tool-specific Guest Stay facade. This module alone owns raw page operations.
 * Production find drivers receive only proven, inert operations.
 */
import {
  buildExactOsressSearchBody,
  LIVE_GUEST_STAY_SEARCH_PATH,
  osressSearchFillValue,
  type ReservationSearchCandidate,
} from './live-read-manifest.js';
import { HmsRuntimeError, type HmsPage, type HmsReadSession } from './runtime.js';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';

export interface FindReservationFacade {
  readonly requireLiveEnvelope: boolean;
  verifyBinding(): Promise<void>;
  searchExact(candidate: ReservationSearchCandidate): Promise<string>;
  /** Refresh the reviewed search surface until a visible result row exists. */
  ensureSearchResultRows(candidate: ReservationSearchCandidate): Promise<number>;
}

function hasSearch(html: string): boolean {
  return /name="search"|ff_confirmationnumber|data-testid="results"|GRID_NAME["']?\s*[:=]\s*["']?OSRESS|function[=:]["']?OSRESV/i.test(
    html,
  );
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

async function clickMenuExact(page: HmsPage, label: 'Front Desk' | 'Guest Stay'): Promise<boolean> {
  try {
    // Soft-capture + wrapPlaywrightPage text= walker: ExtJS tree labels.
    await page.click(`text=${label}`);
    return true;
  } catch {
    return false;
  }
}

async function navigate(page: HmsPage, origin: string): Promise<void> {
  let html = await page.content().catch(() => '');
  if (/name="search"/i.test(html)) return;
  const fixture = /data-tenant=|data-property-code=/i.test(html);
  if (!fixture) {
    // Soft-capture proven path: Front Desk → Guest Stay, then wait for search input.
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const menuDeadline = Date.now() + 12_000;
      while (!(await exactMenuLabel(page, 'Front Desk')) && Date.now() < menuDeadline) {
        await new Promise((resolve) => setTimeout(resolve, 400));
      }
      await clickMenuExact(page, 'Front Desk');
      await new Promise((resolve) => setTimeout(resolve, 2500));
      const guestDeadline = Date.now() + 8_000;
      while (!(await exactMenuLabel(page, 'Guest Stay')) && Date.now() < guestDeadline) {
        await new Promise((resolve) => setTimeout(resolve, 300));
      }
      await clickMenuExact(page, 'Guest Stay');
      await new Promise((resolve) => setTimeout(resolve, 5000));
      html = await page.content().catch(() => '');
      if (/name="search"/i.test(html)) return;
    }
    // Live SPA open via XHR only. Never page.goto(OSRESV) — POST logindisp bounce.
    await page
      .postForm(`${origin}/web/base/OSRESV?FUNCTION_CLASS=WEBL&USER_FUNCTION_NAME=OSRESV`, {
        SYSTEM_FUNCTION_NAME: 'OSRESV',
        USER_FUNCTION_NAME: 'OSRESV',
        CURRENT_TAB_NAME: '',
        MENU_MODULE_KEY: '0',
        FUNCTION_CLASS: 'WEBL',
        removescreenflows: 'yes',
      })
      .catch(() => undefined);
    const readyDeadline = Date.now() + 10_000;
    while (Date.now() < readyDeadline) {
      if (/name="search"/i.test(await page.content().catch(() => ''))) return;
      await new Promise((resolve) => setTimeout(resolve, 300));
    }
    return;
  }
  await page.goto(`${origin}/web/base/OSRESV`, { timeout: 8_000 }).catch(() => undefined);
  html = await page.content().catch(() => '');
  if (hasSearch(html)) return;
  await page
    .postForm(`${origin}/web/base/OSRESV?FUNCTION_CLASS=WEBL&USER_FUNCTION_NAME=OSRESV`, {
      SYSTEM_FUNCTION_NAME: 'OSRESV',
      USER_FUNCTION_NAME: 'OSRESV',
      CURRENT_TAB_NAME: '',
      MENU_MODULE_KEY: '0',
      FUNCTION_CLASS: 'WEBL',
      removescreenflows: 'yes',
    })
    .catch(() => undefined);
  const readyDeadline = Date.now() + 15_000;
  while (Date.now() < readyDeadline) {
    if (hasSearch(await page.content().catch(() => ''))) return;
    await new Promise((resolve) => setTimeout(resolve, 300));
  }
}

function emitOsressDiagnostic(body: string): void {
  if (process.env.HMS_PROOF_DIAGNOSTICS !== '1') return;
  const text = body;
  const title = /<title>([^<]{0,80})<\/title>/i.exec(text)?.[1]?.trim() ?? '';
  const safeTitle = /^[A-Za-z0-9 .:_-]{0,80}$/.test(title) ? title : undefined;
  process.stderr.write(
    `${JSON.stringify({
      type: 'HMS_PROOF_DIAGNOSTIC',
      stage: 'osress_response',
      code: /pageData\s*:/.test(text) || /"pageData"\s*:/.test(text)
        ? 'HAS_PAGEDATA_MARKER'
        : /type=["']password["']/i.test(text) || /name=["']userid["']/i.test(text)
          ? 'HTML_LOGIN_FORM'
          : /Unable to retrieve|success"\s*:\s*false/i.test(text)
            ? 'HTML_ERROR_SIGNAL'
            : /^\s*</.test(text)
              ? 'HTML_OTHER'
              : 'NO_PAGEDATA_MARKER',
      bytes: text.length,
      startsJson: text.trimStart().startsWith('{'),
      startsHtml: /^\s*</.test(text),
      ...(safeTitle ? { title: safeTitle } : {}),
    })}\n`,
  );
}

async function dumpOsressBody(body: string): Promise<void> {
  const attemptDir = process.env.HMS_PROOF_ATTEMPT_DIR;
  if (attemptDir && /^\/tmp\/nava-fast-find\.[A-Za-z0-9]+$/.test(attemptDir)) {
    await writeFile(join(attemptDir, 'osress-last-response.txt'), body, {
      encoding: 'utf8',
      mode: 0o600,
    }).catch(() => undefined);
  }
}

export function createFindReservationFacade(
  session: HmsReadSession,
): FindReservationFacade {
  const page = session.page;
  const requireLiveEnvelope =
    session.origin === 'https://appsrv-1.legacyhotels.co.za';
  return {
    requireLiveEnvelope,
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
      if (!/name="search"/i.test(html) && !/name="ff_confirmationnumber"/i.test(html)) {
        throw new HmsRuntimeError(
          'SCHEMA_DRIFT',
          'Guest Stay search field missing after navigate',
        );
      }
      const selector = /name="search"/i.test(html)
        ? 'input[name="search"]'
        : 'input[name="ff_confirmationnumber"]';
      // Fill for video/visibility.
      await page.fill(selector, osressSearchFillValue(candidate));
      // Prefer reviewed dataspy scaffold now that Guest Stay UI context is open.
      // ExtJS Enter returns pageData but often does not pin the confirmation slot
      // the way buildExactOsressSearchBody does.
      const correlation = page.waitForCorrelatedResponse
        ? page.waitForCorrelatedResponse(LIVE_GUEST_STAY_SEARCH_PATH)
        : Promise.resolve('');
      const [post, correlated] = await Promise.allSettled([
        page.postForm(
          `${session.origin}${LIVE_GUEST_STAY_SEARCH_PATH}`,
          buildExactOsressSearchBody(candidate),
        ),
        correlation,
      ]);
      let body =
        (post.status === 'fulfilled' ? post.value : '') ||
        (correlated.status === 'fulfilled' ? correlated.value : '');
      const bounced =
        !body ||
        body.length < 32 ||
        /logindisp/i.test(body) ||
        (!/pageData/i.test(body) && /^\s*</.test(body));
      if (bounced) {
        // Soft-capture fallback: ExtJS Enter (authenticated XHR).
        const again = page.waitForCorrelatedResponse
          ? page.waitForCorrelatedResponse(LIVE_GUEST_STAY_SEARCH_PATH)
          : Promise.resolve('');
        const press = (page as HmsPage & {
          press?: (selector: string, key: string) => Promise<void>;
        }).press;
        if (typeof press === 'function') {
          await press.call(page, selector, 'Enter');
          body = (await again.catch(() => '')) || body || (await page.content());
        } else if (post.status === 'rejected' && correlated.status === 'rejected') {
          // Attach a rejection handler even though no keyboard fallback exists
          // on this adapter, so the already-started correlation does not leak
          // an unhandled promise rejection.
          void again.catch(() => '');
          // Minimal test/adapter pages may not expose keyboard input. Preserve
          // the original transport failure instead of masking it with a
          // TypeError from the optional fallback.
          throw post.reason ?? correlated.reason;
        } else {
          // The initial response is usable (or already classified below), but
          // still consume the optional correlation promise before returning.
          void again.catch(() => '');
        }
      }
      if (!body || body.length < 32) {
        throw new HmsRuntimeError('SCHEMA_DRIFT', 'search correlation failed');
      }
      await dumpOsressBody(body);
      if (requireLiveEnvelope) emitOsressDiagnostic(body);
      return body;
    },
    async ensureSearchResultRows(candidate) {
      const countRows = async (): Promise<number> =>
        page.evaluateStableDom(() => {
          const doc = (globalThis as unknown as {
            document?: { querySelectorAll(sel: string): { length: number } };
          }).document;
          if (!doc) return 0;
          return doc.querySelectorAll('.x-grid3-row, .x-grid-row, tr.x-grid3-row').length;
        });
      const waitRows = async (budgetMs: number): Promise<number> => {
        const deadline = Date.now() + budgetMs;
        let rowCount = 0;
        while (Date.now() < deadline) {
          rowCount = await countRows();
          if (rowCount > 0) return rowCount;
          await new Promise((resolve) => setTimeout(resolve, 400));
        }
        return rowCount;
      };

      let rowCount = await waitRows(6_000);
      if (rowCount < 1) {
        const htmlNow = await page.content().catch(() => '');
        const selector = /name="search"/i.test(htmlNow)
          ? 'input[name="search"]'
          : 'input[name="ff_confirmationnumber"]';
        await page.fill(selector, osressSearchFillValue(candidate)).catch(() => undefined);
        await page.press(selector, 'Enter').catch(() => undefined);
        rowCount = await waitRows(10_000);
      }
      return rowCount;
    },
  };
}

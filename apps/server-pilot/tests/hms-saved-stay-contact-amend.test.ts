import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { existsSync } from 'node:fs';
import { chromium, type Browser, type BrowserContext, type Page } from 'playwright';
import { describe, expect, it } from 'vitest';
import {
  contactAmendOutcome,
  installLabtestContactSaveRouteChain,
  matchesLabtestContactAmendRequest,
} from '../tooling/hms-cloud/guest-stay-amend-contact.mjs';
import { installPageRequestFence } from '../tooling/hms-cloud/page-request-fence.mjs';
import { installReadOnlyGuard } from '../tooling/playwright-quote/hms-read-only-guard.mjs';

const HMS_ORIGIN = 'https://hmsweb.hms.eu1.inforcloudsuite.com';
const SAVE_PATH = '/web/base/OSRESV.HDR';
const requestFrame = {};
const expected = {
  confirmation: '20270000001-1', guestId: '77', arrival: '2027-01-15', departure: '2027-01-16',
  roomType: 'DLX', ratePlan: 'BAR', note: 'synthetic test note',
};
const state = {
  arrivalWire: '01/15/2027', departureWire: '01/16/2027', track: 'TRACK-1',
  native: { PKID: '2', bookingsessionid: '3', reservationid: '4', reservationstayid: '5', recordid: '6' },
};
const data = {
  ...state.native,
  propertycode: 'HRCEN', confirmationnumber: expected.confirmation, guestid: expected.guestId,
  status: 'Reserved', firstname: 'Proof', lastname: 'Labtest', arrivaldate: state.arrivalWire,
  departuredate: state.departureWire, roomtype: expected.roomType, rateplan: expected.ratePlan,
  track: state.track, reservationnote: expected.note, udfchkbox04: '0', udfchar13: '', emailaddress: '',
  guaranteetype: 'NGI', pagemode: 'view', savecctoprofile: '0', savesettlementcctoprofile: '0',
  caller: 'Synthetic Booker', udfchar06: 'Synthetic contact', udfchar02: 'unchanged', extId: 'ignored',
};
const baseline = { values: { ...data }, data: { ...data } };
const contactCases = [
  ['bookerName', 'caller', 'Synthetic Booker Updated'],
  ['bookerContact', 'udfchar06', 'Synthetic contact updated'],
] as const;

const chromiumBinary = [
  process.env.HMS_TEST_CHROMIUM_PATH,
  chromium.executablePath(),
  '/home/ubuntu/.cache/ms-playwright/chromium-1243/chrome-linux64/chrome',
  '/home/orca/.cache/ms-playwright/chromium_headless_shell-1217/chrome-headless-shell-linux64/chrome-headless-shell',
].find((candidate): candidate is string => typeof candidate === 'string' && existsSync(candidate));

function saveBody(fieldName: string, value: string) {
  const body = new URLSearchParams();
  for (const [key, item] of Object.entries(data)) {
    if (key !== 'extId') body.set(key, String(item ?? ''));
  }
  body.set(fieldName, value);
  body.set('SYSTEM_FUNCTION_NAME', 'OSRESV');
  body.set('USER_FUNCTION_NAME', 'OSRESV');
  body.set('CURRENT_TAB_NAME', 'HDR');
  return body;
}

function requestFor(body: URLSearchParams, overrides: {
  url?: string; method?: string; frame?: object; contentType?: string;
} = {}) {
  return {
    url: () => overrides.url || `${HMS_ORIGIN}${SAVE_PATH}?pageaction=SAVE`,
    method: () => overrides.method || 'POST',
    frame: () => overrides.frame || requestFrame,
    postData: () => body.toString(),
    headers: () => ({ 'content-type': overrides.contentType || 'application/x-www-form-urlencoded' }),
  };
}

describe('saved Labtest Booker contact amendment guards', () => {
  it('matches either allowed Booker field only when the full saved-record payload is otherwise unchanged', () => {
    for (const [field, formName, value] of contactCases) {
      const body = saveBody(formName, value);
      expect(matchesLabtestContactAmendRequest(requestFor(body), requestFrame, expected, state, baseline, field, value))
        .toBe(true);
    }
  });

  it('rejects collateral, duplicate, extra, wrong-frame, and wrong-target requests', () => {
    const [field, formName, value] = contactCases[0];
    const match = (body: URLSearchParams, overrides: {
      url?: string; method?: string; frame?: object; contentType?: string;
    } = {}) => matchesLabtestContactAmendRequest(
      requestFor(body, overrides), requestFrame, expected, state, baseline, field, value,
    );

    const collateral = saveBody(formName, value);
    collateral.set('udfchar02', 'unexpected collateral change');
    expect(match(collateral)).toBe(false);

    const duplicate = saveBody(formName, value);
    duplicate.append(formName, 'second value');
    expect(match(duplicate)).toBe(false);

    const extra = saveBody(formName, value);
    extra.set('unexpected', 'not in the saved record');
    expect(match(extra)).toBe(false);

    expect(match(saveBody(formName, value), { frame: {} })).toBe(false);
    expect(match(saveBody(formName, value), { url: `${HMS_ORIGIN}${SAVE_PATH}?pageaction=SAVE&extra=1` })).toBe(false);
    expect(match(saveBody(formName, value), { contentType: 'text/plain' })).toBe(false);
    expect(matchesLabtestContactAmendRequest(requestFor(saveBody(formName, value), { method: 'GET' }),
      requestFrame, expected, state, baseline, field, value)).toBe(false);
    expect(matchesLabtestContactAmendRequest(requestFor(saveBody(formName, value)),
      requestFrame, expected, state, baseline, 'toString', value)).toBe(false);
  });

  it('reports uncertain when any unexpected request was blocked after dispatch, even after HTTP 200', () => {
    const common = { dispatched: true, possiblyDispatched: true, httpStatus: 200, nativeDialog: null, dialogs: 0 };
    expect(contactAmendOutcome({ ...common, blockedAfterDispatch: 0 })).toBe('awaiting_readback');
    expect(contactAmendOutcome({ ...common, blockedAfterDispatch: 1 })).toBe('uncertain');
    expect(contactAmendOutcome({ ...common, httpStatus: null, blockedAfterDispatch: 0 })).toBe('uncertain');
    expect(contactAmendOutcome({ ...common, dispatched: false, possiblyDispatched: false, blockedAfterDispatch: 0 }))
      .toBe('not_dispatched');
  });

  const routeTestName = chromiumBinary
    ? 'the later page writer falls through the page fence before its one context exception'
    : 'the later page writer falls through the page fence before its one context exception (SKIP: Chromium not found)';

  it.skipIf(!chromiumBinary)(routeTestName, async () => {
    const arrivals: string[] = [];
    let protectedHeaderArrivals = 0;
    let delayedSendArrivals = 0;
    let approvedReachedServer = false;
    let approvedResponseReleased = false;
    let releaseApprovedResponse: (() => void) | undefined;
    const server: Server = createServer((request, response) => {
      const pathname = new URL(request.url ?? '/', 'http://127.0.0.1').pathname;
      if (request.method === 'GET' && pathname === SAVE_PATH) protectedHeaderArrivals += 1;
      if (request.method === 'POST' && pathname === '/web/base/send-email') delayedSendArrivals += 1;
      if (request.method === 'POST' && pathname === SAVE_PATH) {
        arrivals.push('POST');
        let body = '';
        request.setEncoding('utf8');
        request.on('data', (chunk: string) => { body += chunk; });
        request.on('end', () => {
          if (new URLSearchParams(body).get('intent') === 'approved-once') {
            approvedReachedServer = true;
            releaseApprovedResponse = () => {
              if (approvedResponseReleased) return;
              approvedResponseReleased = true;
              response.writeHead(200, { 'content-type': 'text/plain' });
              response.end('ok');
            };
            return;
          }
          response.writeHead(200, { 'content-type': 'text/plain' });
          response.end('unexpected');
        });
        return;
      }
      response.writeHead(200, { 'content-type': 'text/plain' });
      response.end('ok');
    });
    let browser: Browser | undefined;
    let context: BrowserContext | undefined;
    let chain: Awaited<ReturnType<typeof installLabtestContactSaveRouteChain>> | undefined;
    let scope: { close: () => void } | undefined;
    try {
      await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
      const address = server.address() as AddressInfo;
      const origin = `http://127.0.0.1:${address.port}`;
      browser = await chromium.launch({ executablePath: chromiumBinary, headless: true });
      context = await browser.newContext();
      await installReadOnlyGuard(context);
      const page = await context.newPage();
      await page.goto(origin);
      const pageFrame = page.mainFrame();
      let passedFence = 0;
      await page.route('**/*', async (route) => {
        if (new URL(route.request().url()).pathname === SAVE_PATH) passedFence += 1;
        return route.fallback();
      });
      const fence = await installPageRequestFence(page, [SAVE_PATH]);
      scope = fence.open();
      let armed = true;
      let candidates = 0;
      let dispatches = 0;
      let blockedRequests = 0;
      let blockedAfterDispatch = 0;
      chain = await installLabtestContactSaveRouteChain(page, {
        frame: pageFrame,
        fence,
        scope,
        isArmed: () => armed,
        matches: (request: any, requestFrame: unknown) => {
          if (requestFrame !== pageFrame || request.method() !== 'POST') return false;
          const url = new URL(request.url());
          return url.pathname === SAVE_PATH && [...url.searchParams].length === 1 && url.searchParams.get('pageaction') === 'SAVE' &&
            new URLSearchParams(request.postData() || '').get('intent') === 'approved-once';
        },
        onCandidate: () => { candidates += 1; },
        onDispatch: () => { dispatches += 1; armed = false; },
        onBlocked: () => {
          blockedRequests += 1;
          if (dispatches > 0) blockedAfterDispatch += 1;
        },
      });

      const post = (targetPage: Page, intent = 'approved-once') => targetPage.evaluate(async (postIntent: string) => {
        try {
          const response = await fetch('/web/base/OSRESV.HDR?pageaction=SAVE', {
            method: 'POST', body: new URLSearchParams({ intent: postIntent }),
          });
          return response.status;
        } catch {
          return 'blocked';
        }
      }, intent);
      const readProtectedHeader = (targetPage: Page) => targetPage.evaluate(async () => {
        try {
          const response = await fetch('/web/base/OSRESV.HDR');
          return response.status;
        } catch {
          return 'blocked';
        }
      });
      const send = (targetPage: Page) => targetPage.evaluate(async () => {
        try {
          const response = await fetch('/web/base/send-email', {
            method: 'POST', body: new URLSearchParams({ intent: 'delayed-synthetic-send' }),
          });
          return response.status;
        } catch {
          return 'blocked';
        }
      });
      const unapproved = await post(page, 'not-approved');
      expect(unapproved).toBe('blocked');
      expect(arrivals).toHaveLength(0);
      expect(passedFence).toBe(0);

      // Hold the one authorized local request in flight, then block another save.
      // The 200 response must not mask the post-dispatch blocked-request signal.
      const approvedResponseStatus = post(page);
      await expect.poll(() => approvedReachedServer, { timeout: 5_000 }).toBe(true);
      expect(dispatches).toBe(1);
      const otherPage = await context.newPage();
      await otherPage.goto(origin);
      const unexpectedDuringResponse = await post(otherPage, 'unexpected-during-response');
      expect(unexpectedDuringResponse).toBe('blocked');
      const unexpectedProtectedRead = await readProtectedHeader(page);
      expect(unexpectedProtectedRead).toBe('blocked');
      expect(protectedHeaderArrivals).toBe(0);
      expect(blockedAfterDispatch).toBe(2);
      expect(releaseApprovedResponse).toBeTypeOf('function');
      releaseApprovedResponse?.();
      const httpStatus = await approvedResponseStatus;
      expect(httpStatus).toBe(200);
      expect(contactAmendOutcome({
        dispatched: true,
        possiblyDispatched: true,
        httpStatus,
        nativeDialog: null,
        dialogs: 0,
        blockedAfterDispatch,
      })).toBe('uncertain');
      expect(arrivals).toEqual(['POST']);
      expect(passedFence).toBe(1);
      expect(candidates).toBe(1);
      expect(dispatches).toBe(1);

      chain.disarm();
      expect(await post(page)).toBe('blocked');
      await chain.close();
      scope.close();
      // close() removes only the one-request context exception. The used page
      // retains its writer-local deny route; other pages use the shared guard.
      expect(await send(page)).toBe('blocked');
      expect(delayedSendArrivals).toBe(0);
      expect(await post(otherPage)).toBe('blocked');
      expect(arrivals).toEqual(['POST']);
      expect(passedFence).toBe(1);
      expect(candidates).toBe(1);
      expect(dispatches).toBe(1);
      expect(blockedRequests).toBeGreaterThanOrEqual(4);
    } finally {
      releaseApprovedResponse?.();
      scope?.close();
      await chain?.close();
      await context?.close();
      await browser?.close();
      if (server.listening) {
        await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
      }
    }
  }, 30_000);
});

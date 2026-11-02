import { beforeEach, describe, expect, it, vi } from 'vitest';
import { blankPartyFields } from '../tooling/hms-cloud/labtest-party-fields.mjs';

const fixture = vi.hoisted(() => ({
  dispatch: undefined as undefined | ((request: unknown, next: () => Promise<unknown>) => Promise<unknown>),
}));
vi.mock('../tooling/hms-cloud/guest-profile.mjs', () => ({
  verifiedLabtestProfileToken: async () => 'synthetic-token',
  isVerifiedLabtestProfileCurrent: () => true,
}));
vi.mock('../tooling/hms-cloud/lookup.mjs', () => ({
  verifiedArSelectionToken: async () => null,
  isVerifiedArSelectionCurrent: () => false,
}));
vi.mock('../tooling/hms-cloud/labtest-preimage.mjs', () => ({ consumeLabtestPreimage: () => true }));
vi.mock('../tooling/hms-cloud/page-request-fence.mjs', () => ({
  installPageRequestFence: async () => ({
    isQuarantined: () => false, quarantine: () => {}, open: () => ({ allow: () => true, close: () => {} }),
  }),
}));
vi.mock('../tooling/hms-cloud/saved-stay-save-route-chain.mjs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../tooling/hms-cloud/saved-stay-save-route-chain.mjs')>();
  return { installLabtestSaveRouteChain: (page: unknown, options: Record<string, unknown>) =>
    actual.installLabtestSaveRouteChain(page, { ...options, dispatchCandidate: fixture.dispatch }) };
});

import { saveNewLabtestStay } from '../tooling/hms-cloud/guest-stay-save.mjs';

const saveInput = { preimageId: 'synthetic', arrival: '2027-12-29', departure: '2027-12-31',
  guestId: '123', roomType: 'STQN', ratePlan: 'BAR', guaranteeType: 'NGI', note: 'Synthetic note' };

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

function simulatedPage() {
  const frame = {};
  const responseReady = deferred<unknown>();
  let pageHandler: ((route: unknown) => Promise<unknown>) | undefined;
  let contextHandler: ((route: unknown) => Promise<unknown>) | undefined;
  let evaluateCount = 0;
  const context = {
    _options: { serviceWorkers: 'block' }, serviceWorkers: () => [],
    route: async (_: string, handler: typeof contextHandler) => { contextHandler = handler; },
  };
  const body = new URLSearchParams({
    ...Object.fromEntries(blankPartyFields.map((name: string) => [name, ''])),
    SYSTEM_FUNCTION_NAME: 'OSRESV', USER_FUNCTION_NAME: 'OSRESV', CURRENT_TAB_NAME: 'HDR',
    propertycode: 'HRCEN', PKID: '@[EMPTY]#@[EMPTY]#HRCEN#', status: 'New', firstname: 'Proof', lastname: 'Labtest',
    guestid: '123', bookingsessionid: 'session', arrivaldate: '12/29/2027', departuredate: '12/31/2027',
    roomtype: 'STQN', rateplan: 'BAR', track: 'TRACK', reservationnote: 'Synthetic note', confirmationnumber: '',
    reservationid: '', reservationstayid: '', recordid: '', udfchkbox04: '0', udfchar13: '', emailaddress: '',
    guaranteecreditcardid: '', leaseguaranteecreditcardid: '', arprofileid: '', araccountid: '', guaranteetype: 'NGI',
    pagemode: 'display', savecctoprofile: '0', savesettlementcctoprofile: '0',
  });
  const request = { frame: () => frame, method: () => 'POST',
    url: () => 'https://hmsweb.hms.eu1.inforcloudsuite.com/web/base/OSRESV.HDR?pageaction=SAVE',
    postData: () => body.toString(), headers: () => ({ 'content-type': 'application/x-www-form-urlencoded' }) };
  const response = { request: () => request, status: () => 200 };
  const route = {
    request: () => request,
    fallback: async () => contextHandler?.(route),
    abort: async () => {},
    continue: async () => { responseReady.resolve(response); },
  };
  const page = {
    on: () => {}, off: () => {}, context: () => context, mainFrame: () => frame,
    route: async (_: string, handler: typeof pageHandler) => { pageHandler = handler; },
    locator: (selector: string) => selector.startsWith('[data-qtip=')
      ? { count: async () => 1, click: async () => { void pageHandler?.(route).catch(() => {}); } }
      : { count: async () => 0, allTextContents: async () => [] },
    evaluate: async () => ++evaluateCount === 1 ? { session: 'session', track: 'TRACK' }
      : { confirmation: '123456-1', status: 'Reserved' },
    waitForResponse: () => responseReady.promise,
    waitForFunction: async () => true,
  };
  return page;
}

// Real writer and route chain with simulated browser, preimage and identity proof. No HMS or DB.
describe('create writer waits for dispatch completion', () => {
  beforeEach(() => { fixture.dispatch = undefined; });

  for (const succeeds of [true, false]) {
    it(`waits for the wrapper and reports ${succeeds ? 'success' : 'uncertainty'} after it settles`, async () => {
      const continued = deferred<void>(), release = deferred<void>();
      fixture.dispatch = async (_request, next) => {
        await next(); continued.resolve(); await release.promise;
        if (!succeeds) throw new Error('simulated_connection_lost');
      };
      let finished = false;
      const result = saveNewLabtestStay(simulatedPage(), saveInput, { timeoutMs: 10000 })
        .then((value: unknown) => { finished = true; return value; });
      await continued.promise;
      await Promise.resolve();
      expect(finished).toBe(false);
      release.resolve();
      expect(await result).toMatchObject(succeeds
        ? { outcome: 'saved_same_form', confirmation: '123456-1' }
        : { outcome: 'uncertain', issue: 'SAVE_DISPATCH_UNCERTAIN' });
    });
  }
});

import { afterEach, describe, expect, it, vi } from 'vitest';
import { dirname } from 'node:path';
import { rm } from 'node:fs/promises';
import { blankPartyFields } from '../tooling/hms-cloud/labtest-party-fields.mjs';

// This exercises callback propagation, not the captured native schema. The real
// 985-key fixture is unavailable here, so only this test's synthetic field-set
// hash is substituted; all other SHA-256 operations use the real implementation.
vi.mock('node:crypto', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:crypto')>();
  return {
    ...actual,
    createHash: (...args: Parameters<typeof actual.createHash>) => {
      const hash = actual.createHash(...args);
      let syntheticSchema = false;
      const wrapped = new Proxy(hash, {
        get(target, key) {
          if (key === 'update') return (value: unknown, ...options: unknown[]) => {
            if (typeof value === 'string' && value.includes('\nzzsynthetic_000')) syntheticSchema = true;
            (target.update as (...args: unknown[]) => unknown)(value, ...options);
            return wrapped;
          };
          if (key === 'digest') return (...options: unknown[]) => syntheticSchema
            ? '03a9432f20d5b59c1cc7daee4e519639b82b978d1e78b2de110964a98828292e'
            : (target.digest as (...args: unknown[]) => unknown)(...options);
          const value = Reflect.get(target, key, target);
          return typeof value === 'function' ? value.bind(target) : value;
        },
      });
      return wrapped;
    },
  };
});

const fixture = vi.hoisted(() => ({ page: null as unknown }));
vi.mock('../tooling/playwright-quote/centurion-stay360.mjs', async (original) => ({
  ...await original<typeof import('../tooling/playwright-quote/centurion-stay360.mjs')>(),
  withCenturionStay360Page: async (operation: (page: unknown) => Promise<unknown>) => operation(fixture.page),
}));
vi.mock('../tooling/playwright-quote/hms-read-only-guard.mjs', async (original) => ({
  ...await original<typeof import('../tooling/playwright-quote/hms-read-only-guard.mjs')>(),
  installReadOnlyGuard: async () => {},
}));
vi.mock('../tooling/hms-cloud/lookup.mjs', async (original) => ({
  ...await original<typeof import('../tooling/hms-cloud/lookup.mjs')>(), openNewGuestStay: async () => {},
}));
vi.mock('../tooling/hms-cloud/guest-profile.mjs', async (original) => ({
  ...await original<typeof import('../tooling/hms-cloud/guest-profile.mjs')>(),
  searchGuestProfiles: async () => ({ outcome: 'matches', searchId: 'g',
    candidates: [{ nativeId: '123', firstName: 'Proof', lastName: 'Labtest' }], coverage: { loaded: 1, possiblyTruncated: false } }),
  selectGuestProfile: async () => ({ outcome: 'selected_unsaved', nativeId: '123' }),
  verifiedLabtestProfileToken: async () => 'synthetic-token', isVerifiedLabtestProfileCurrent: () => true,
}));
vi.mock('../tooling/hms-cloud/labtest-preimage.mjs', async (original) => ({
  ...await original<typeof import('../tooling/hms-cloud/labtest-preimage.mjs')>(),
  searchLabtestPreimage: async () => ({ outcome: 'clear', preimageId: 'synthetic' }),
  consumeLabtestPreimage: () => true,
}));
vi.mock('../tooling/hms-cloud/page-request-fence.mjs', () => ({
  installPageRequestFence: async () => ({
    isQuarantined: () => false, quarantine: () => {}, open: () => ({ allow: () => true, close: () => {} }),
  }),
}));
vi.mock('../tooling/hms-cloud/guest-stay-form.mjs', async (original) => ({
  ...await original<typeof import('../tooling/hms-cloud/guest-stay-form.mjs')>(),
  setGuestStayDate: async (_page: unknown, request: { date: string }) => ({ outcome: 'updated_unsaved',
    actual: request.date, displayed: request.date.endsWith('29') ? '29-DEC-2027' : '31-DEC-2027' }),
  selectGuestStayDropdown: async (_page: unknown, request: { field: string; value: unknown }) => ({
    outcome: 'updated_unsaved', field: request.field, requested: request.value,
    actual: { value: request.value, display: request.field === 'adults' ? '1' : 'Non-Guaranteed Individual' },
    profileProofToken: 'synthetic-token',
  }),
  setGuestStayChildAges: async () => ({ outcome: 'updated_unsaved', requestedChildAges: [], actualChildAges: [],
    ageBandCounts: { child1: 0, child2: 0, child3: 0 }, profileProofToken: 'synthetic-token' }),
  setCmsSendCheckbox: async () => ({ outcome: 'updated_unsaved', actual: false }),
  setGuestStayText: async (_page: unknown, request: { value: string }) => ({ outcome: 'updated_unsaved', actual: request.value }),
  readGuestStayForm: async () => ({ outcome: 'ok', fields: visibleFields() }),
}));
vi.mock('../tooling/hms-cloud/guest-stay-room-rate.mjs', async (original) => ({
  ...await original<typeof import('../tooling/hms-cloud/guest-stay-room-rate.mjs')>(),
  searchRoomTypes: async () => ({ outcome: 'matches', searchId: 'r', coverage: { complete: true }, candidates: [] }),
  inspectRoomRateCandidate: async () => ({ outcome: 'match', candidates: [{ code: 'STQN' }] }),
  selectRoomType: async () => ({ outcome: 'selected_unsaved', selectedField: { value: 'STQN' } }),
}));
vi.mock('../tooling/hms-cloud/guest-stay-rate-plan.mjs', async (original) => ({
  ...await original<typeof import('../tooling/hms-cloud/guest-stay-rate-plan.mjs')>(),
  selectGuestStayRatePlan: async () => ({ outcome: 'selected_unsaved', code: 'BAR' }),
}));

import { createReservation } from '../tooling/hms-cloud/create-reservation.mjs';
import { saveNewLabtestStay } from '../tooling/hms-cloud/guest-stay-save.mjs';

function visibleFields() {
  return Object.entries({ guestid: '123', status: 'Reserved', firstname: 'Proof', lastname: 'Labtest',
    arrivaldate: '29-DEC-2027', departuredate: '31-DEC-2027', adults: '1', children: '0', child1: '0',
    child2: '0', child3: '0', roomtype: 'STQN', rateplan: 'BAR', company: '',
    guaranteetype: 'Non-Guaranteed Individual', reservationnote: 'Synthetic note',
    udfchkbox04: false, udfchar13: '', emailaddress: '' }).map(([name, value]) => ({
      name, value, ...(name === 'reservationnote' ? { rawValue: value } : {}),
    }));
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

function simulatedPage(order: string[], options: { guarantee?: string; bodyGuarantee?: string } = {}) {
  const frame = {}, ready = deferred<unknown>();
  let pageHandler: ((route: unknown) => Promise<unknown>) | undefined;
  let contextHandler: ((route: unknown) => Promise<unknown>) | undefined;
  let evaluateCount = 0;
  const context = {
    _options: { serviceWorkers: 'block' }, serviceWorkers: () => [],
    route: async (_pattern: string, handler: typeof contextHandler) => { contextHandler = handler; },
  };
  const form: Record<string, string> = {
    ...Object.fromEntries(blankPartyFields.map((name: string) => [name, ''])),
    propertycode: 'HRCEN', PKID: '@[EMPTY]#@[EMPTY]#HRCEN#', status: 'New', firstname: 'Proof', lastname: 'Labtest',
    guestid: '123', bookingsessionid: 'session', sessionID: 'synthetic-session', arrivaldate: '12/29/2027',
    departuredate: '12/31/2027', roomtype: 'STQN', rateplan: 'BAR', track: 'TRACK', reservationnote: 'Synthetic note',
    confirmationnumber: '', reservationid: '', reservationstayid: '', recordid: '', udfchkbox04: '0', udfchar13: '',
    emailaddress: '', guaranteecreditcardid: '', leaseguaranteecreditcardid: '', arprofileid: '', araccountid: '',
    guaranteetype: options.guarantee ?? 'NGI', pagemode: 'display', savecctoprofile: '0', savesettlementcctoprofile: '0', adults: '1',
    children: '0', childages: '', child1: '0', child2: '0', child3: '0', activechildcategories: '0',
    updatechildcategories: 'true',
  };
  for (let n = 0; Object.keys(form).length < 985; n += 1) form[`zzsynthetic_${String(n).padStart(3, '0')}`] = '';
  const body = new URLSearchParams({ ...form, SYSTEM_FUNCTION_NAME: 'OSRESV', USER_FUNCTION_NAME: 'OSRESV', CURRENT_TAB_NAME: 'HDR' });
  if (options.bodyGuarantee !== undefined) body.set('guaranteetype', options.bodyGuarantee);
  const request = { frame: () => frame, method: () => 'POST',
    url: () => 'https://hmsweb.hms.eu1.inforcloudsuite.com/web/base/OSRESV.HDR?pageaction=SAVE',
    postData: () => body.toString(), headers: () => ({ 'content-type': 'application/x-www-form-urlencoded' }) };
  const response = { request: () => request, status: () => 200 };
  const route = {
    request: () => request, fallback: async () => contextHandler?.(route), abort: async () => { order.push('abort'); },
    continue: async () => { order.push('continue'); ready.resolve(response); },
  };
  return {
    on: () => {}, off: () => {}, context: () => context, mainFrame: () => frame,
    route: async (_pattern: string, handler: typeof pageHandler) => { pageHandler = handler; },
    screenshot: async () => Buffer.from('synthetic screenshot'),
    locator: (selector: string) => selector.startsWith('[data-qtip=')
      ? { count: async () => 1, click: async () => { void pageHandler?.(route).catch(() => {}); } }
      : { count: async () => 0, allTextContents: async () => [] },
    evaluate: async () => ++evaluateCount === 1
      ? { session: 'session', track: 'TRACK', modelData: form, formData: form, activeChildCategories: '0',
        partyValues: Object.fromEntries(blankPartyFields.map((name: string) => [name, ''])) }
      : { confirmation: '123456-1', status: 'Reserved' },
    waitForResponse: () => ready.promise, waitForFunction: async () => true,
  };
}

const input = { mode: 'commit', propertyCode: 'HRCEN', guest: { profileId: '123' },
  stay: { arrival: '2027-12-29', departure: '2027-12-31', adults: 1, childAges: [] },
  room: { roomType: 'STQN', ratePlan: 'BAR' }, guaranteeType: 'NGI', note: 'Synthetic note', cms: { send: false } };
const directories = new Set<string>();
afterEach(async () => { for (const dir of directories) await rm(dir, { recursive: true, force: true }); directories.clear(); });

// Real create entry, session, serial queue, writer and route chain. Browser,
// staging, identities, census and saved-record readback are simulated.
describe('server-owned create callbacks through the real session and writer', () => {
  for (const succeeds of [true, false]) {
    it(`waits for the dispatched wrapper and reports ${succeeds ? 'saved' : 'uncertain'} after completion`, async () => {
      const order: string[] = [], continued = deferred<void>(), release = deferred<void>();
      fixture.page = simulatedPage(order);
      let finished = false;
      const result = createReservation(input, {
        authorizeCandidate: async () => { order.push('authorize'); return true; },
        dispatchCandidate: async (_request: unknown, next: () => Promise<unknown>) => {
          order.push('lock'); await next(); continued.resolve(); await release.promise;
          if (!succeeds) throw new Error('synthetic_commit_failed');
          order.push('unlock');
        },
        withSavedSession: async (operation: (context: unknown) => Promise<unknown>) => operation({
          runTool: async () => ({ outcome: 'ok', record: { details: { fields: visibleFields(), captureScope: 'synthetic' } } }),
        }),
        census: async () => ({ outcome: 'no_match', coverage: { complete: true }, sameArrival: [] }),
      }).then((value: any) => { finished = true; if (value.screenshots?.before) directories.add(dirname(value.screenshots.before)); return value; });
      const reached = await Promise.race([continued.promise.then(() => true), result.then(() => false)]);
      if (!reached) throw new Error(`Native continuation not reached: ${JSON.stringify(await result)}`);
      await Promise.resolve();
      expect(finished).toBe(false);
      expect(order).toEqual(['authorize', 'lock', 'continue']);
      release.resolve();
      const output = await result;
      expect(output).toMatchObject(succeeds
        ? { outcome: 'saved', save: { outcome: 'saved_same_form', confirmation: '123456-1' } }
        : { outcome: 'uncertain', save: { outcome: 'uncertain', issue: 'SAVE_DISPATCH_UNCERTAIN' } });
      expect(order).toEqual(succeeds ? ['authorize', 'lock', 'continue', 'unlock'] : ['authorize', 'lock', 'continue']);
    }, 15000);
  }
});

// The model-field schema and identity/preimage proofs are mocked above. This
// exercises the real native matcher and route chain, not live HMS or the real schema.
describe('agent guarantee in the real native request guard', () => {
  const selection = { outcome: 'updated_unsaved', field: 'guaranteeType', requested: 'GTDAGT',
    actual: { value: 'GTDAGT', submitted: 'GTDAGT', display: 'Guaranteed By Agent' } };
  const request = { preimageId: 'synthetic', arrival: '2027-12-29', departure: '2027-12-31',
    guestId: '123', roomType: 'STQN', ratePlan: 'BAR', guaranteeType: 'GTDAGT',
    guaranteeSelection: selection, note: 'Synthetic note' };

  it('continues one matching agent-guarantee request', async () => {
    const order: string[] = [];
    const result = await saveNewLabtestStay(simulatedPage(order, { guarantee: 'GTDAGT' }), request, { timeoutMs: 1000 });
    expect(result).toMatchObject({ outcome: 'saved_same_form', requestSeen: true, confirmation: '123456-1' });
    expect(order).toEqual(['continue']);
  }, 5000);

  it('refuses an outgoing non-guaranteed code for the agent guarantee', async () => {
    const order: string[] = [];
    const result = await saveNewLabtestStay(
      simulatedPage(order, { guarantee: 'GTDAGT', bodyGuarantee: 'NGI' }), request, { timeoutMs: 250 },
    );
    expect(result).toMatchObject({ outcome: 'not_dispatched', requestSeen: false });
    expect(order).toEqual(['abort']);
  }, 5000);
});

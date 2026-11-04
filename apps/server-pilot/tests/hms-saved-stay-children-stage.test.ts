import { describe, expect, it, vi } from 'vitest';
import {
  matchesSavedChildAgeRead, matchesSavedChildAgeValidation, matchesSavedChildEditorOpen, planSavedChildOccupancy,
  sameChildAgeMultiset, savedChildDraftDelta, savedChildOccupancy, stageLabtestChildAmendment,
} from '../tooling/hms-cloud/guest-stay-amend-children.mjs';
import { blankSavedPartyFields } from '../tooling/hms-cloud/labtest-party-fields.mjs';

const ORIGIN = 'https://hmsweb.hms.eu1.inforcloudsuite.com';
const READ = '/web/base/OSRESV.HDR.getChildAges';
const frameId = {};
const expected = { confirmation: '20270000001-1', guestId: '77', arrival: '2027-01-15', departure: '2027-01-16',
  roomType: 'DLX', ratePlan: 'BAR', note: '', adults: 2, childCount: 2, childAges: [8, 12] };
const options = { childCount: 2, childAges: [8, 5] };
const parties = Object.fromEntries(blankSavedPartyFields.map((name) => [name, '']));
const snapshot = () => ({
  values: { ...parties, adults: '2', children: '2', child1: '0', child2: '2', child3: '0' },
  data: { ...parties, adults: '2', children: '2', child1: '0', child2: '2', child3: '0', childages: '8,12', successmessages: '', activechildcategories: '' },
  partyControls: [], formDirty: false, recordDirty: false, dirtyFields: [], modifiedFields: [], partyInputsBlank: true,
});
const body = (params: unknown = { propertyCode: 'HRCEN', reservationStayId: '5', childAges: [8, 12] }) =>
  new URLSearchParams({ params: JSON.stringify(params), ONLY_DATA_REQUIRED: 'true' });
const request = (config: { body?: string; method?: string; url?: string; frame?: object; type?: string } = {}) => ({
  url: () => config.url ?? `${ORIGIN}${READ}`,
  method: () => config.method ?? 'POST', frame: () => config.frame ?? frameId,
  postData: () => config.body ?? body().toString(),
  headers: () => ({ 'content-type': config.type ?? 'application/x-www-form-urlencoded; charset=UTF-8' }),
});

describe('saved child occupancy planning and evidence', () => {
  it('preserves explicit zero, empty ages and uncertainty without manufacturing ages', () => {
    expect(planSavedChildOccupancy({ childCount: 0, childAges: [] })).toMatchObject({
      childCount: 0, childAges: [], ageState: 'explicit', derivedBands: { child1: 0, child2: 0, child3: 0 },
      pricing: 'unknown', inventory: 'unknown', saveEligible: false,
    });
    expect(planSavedChildOccupancy({ childCount: 0, childAges: null })).toMatchObject({
      childCount: 0, childAges: null, ageState: 'unknown', derivedBands: null,
    });
    expect(planSavedChildOccupancy({ childCount: null, childAges: null })).toMatchObject({ childCount: null, childAges: null });
    expect(planSavedChildOccupancy({ childCount: 1, childAges: [0] })).toMatchObject({ derivedBands: { child1: 1, child2: 0, child3: 0 } });
    expect(planSavedChildOccupancy({ childCount: 4, childAges: [2, 3, 12, 17] })).toMatchObject({ derivedBands: { child1: 1, child2: 2, child3: 1 } });
  });
  it('refuses absent, invalid, or contradictory inputs', () => {
    for (const input of [null, {}, { childCount: 0, childAges: [8] }, { childCount: 1, childAges: [18] },
      { childCount: 1, childAges: [null] }, { childCount: -1, childAges: [] }, { childCount: 10, childAges: null }]) {
      expect(planSavedChildOccupancy(input as never).outcome).toBe('input_gap');
    }
  });
  it('distinguishes native model ages, absent form ages, missing and blank native ages', () => {
    const value = savedChildOccupancy(snapshot());
    expect(value).toMatchObject({ valid: true, count: 2, ages: [8, 12], ageState: 'native_model',
      fields: { childages: { form: { present: false }, model: { present: true, value: '8,12' } } } });
    const unknown = snapshot(); delete (unknown.data as Record<string, unknown>).childages;
    expect(savedChildOccupancy(unknown)).toMatchObject({ valid: true, ages: null, ageState: 'unknown',
      fields: { childages: { model: { present: false } } } });
    unknown.data.childages = '';
    expect(savedChildOccupancy(unknown)).toMatchObject({ valid: true, ages: null, ageState: 'unknown',
      fields: { childages: { model: { present: true, value: '' } } } });
    unknown.values.children = unknown.data.children = '0';
    unknown.values.child2 = unknown.data.child2 = '0';
    expect(savedChildOccupancy(unknown)).toMatchObject({ valid: true, count: 0, ages: null, ageState: 'unknown' });
    (unknown.data as Record<string, unknown>).childages = [];
    expect(savedChildOccupancy(unknown)).toMatchObject({ valid: true, count: 0, ages: [], ageState: 'native_model' });
  });
  it('rejects mismatched count, bands, duplicate casing and age-band conflicts', () => {
    const mismatch = snapshot(); mismatch.data.children = '1'; expect(savedChildOccupancy(mismatch).valid).toBe(false);
    const sum = snapshot(); sum.values.child1 = sum.data.child1 = '1'; expect(savedChildOccupancy(sum).valid).toBe(false);
    const conflict = snapshot(); conflict.data.childages = '1,12'; expect(savedChildOccupancy(conflict)).toMatchObject({ valid: false, ageState: 'conflicting' });
    const duplicate = snapshot(); (duplicate.data as Record<string, unknown>).CHILDREN = '2'; expect(savedChildOccupancy(duplicate).valid).toBe(false);
  });
  it('requires explicit prior and requested ages before any page action', async () => {
    const page = { route: vi.fn(), on: vi.fn(), context: vi.fn() };
    expect(await stageLabtestChildAmendment(page, { ...expected, childAges: null }, options)).toMatchObject({ issue: 'PREIMAGE_AGES_UNKNOWN' });
    expect(await stageLabtestChildAmendment(page, expected, { childCount: 0, childAges: null })).toMatchObject({ issue: 'EXACT_CHILD_AGES_REQUIRED' });
    expect(page.route).not.toHaveBeenCalled();
  });
});

describe('saved child editor opening side effects', () => {
  it('accepts only the observed native metadata changes with no other mutation', () => {
    const before = snapshot();
    const after = structuredClone(before);
    (after.data as Record<string, unknown>).successmessages = true;
    (after.data as Record<string, unknown>).activechildcategories = 3;
    after.recordDirty = true;
    const native = { activeChildCategories: 3, updateChildCategories: false, confirmChildCategory: false };
    expect(matchesSavedChildEditorOpen(before, after, native)).toBe(true);
    const bad = structuredClone(after); bad.values.children = '3';
    expect(matchesSavedChildEditorOpen(before, bad, native)).toBe(false);
    expect(matchesSavedChildEditorOpen(before, after, { ...native, activeChildCategories: 2 })).toBe(false);
    expect(matchesSavedChildEditorOpen(before, { ...after, dirtyFields: ['children'] }, native)).toBe(false);
  });
});

describe('saved child read candidate', () => {
  it('requires one exact bound read request and rejects lookalikes', () => {
    expect(matchesSavedChildAgeRead(request(), frameId, '5', [8, 12])).toBe(true);
    expect(matchesSavedChildAgeRead(request({ body: body({ propertyCode: 'HRCEN', reservationStayId: '5',
      childAges: [8, 12], extra: 1 }).toString() }), frameId, '5', [8, 12])).toBe(true);
    const duplicate = body(); duplicate.append('params', '{}');
    const bad = [
      request({ method: 'GET' }), request({ frame: {} }), request({ url: `${ORIGIN}${READ}?x=1` }),
      request({ url: `${ORIGIN}/web/base/OSRESV.HDR.validateChildAgeDetails` }),
      request({ type: 'application/json' }), request({ body: duplicate.toString() }),
      request({ body: body({ propertyCode: 'HRCEN', reservationStayId: '', childAges: [8, 12] }).toString() }),
      request({ body: body({ propertyCode: 'HRCEN', reservationStayId: '5', childAges: [8] }).toString() }),
      request({ body: new URLSearchParams({ params: '{"propertyCode":"HRCEN","reservationStayId":"5","reservationStayId":"5","childAges":[8,12]}', ONLY_DATA_REQUIRED: 'true' }).toString() }),
    ];
    for (const candidate of bad) expect(matchesSavedChildAgeRead(candidate, frameId, '5', [8, 12])).toBe(false);
  });
});

describe('unsaved child draft evidence', () => {
  it('compares exact ages as a multiset without losing duplicates', () => {
    expect(sameChildAgeMultiset([8, 12, 5], [5, 8, 12])).toBe(true);
    expect(sameChildAgeMultiset([8, 8, 12], [8, 12, 12])).toBe(false);
    expect(sameChildAgeMultiset([8, 12], [8, 18])).toBe(false);
  });
  it('recognizes only observed form clearing and model changes', () => {
    const before = snapshot();
    const valuesBefore = before.values as Record<string, unknown>;
    const dataBefore = before.data as Record<string, unknown>;
    before.recordDirty = true;
    dataBefore.successmessages = true; dataBefore.activechildcategories = 3;
    dataBefore.updatechildcategories = ''; dataBefore.enablecheckavailability = '0'; dataBefore.ratetax = '0';
    valuesBefore.averagerate = '2,830.00'; dataBefore.averagerate = '2830';
    const after = structuredClone(before);
    const valuesAfter = after.values as Record<string, unknown>;
    const dataAfter = after.data as Record<string, unknown>;
    valuesAfter.children = '3'; valuesAfter.child2 = '3'; valuesAfter.averagerate = '';
    dataAfter.childages = '8,12,5'; dataAfter.updatechildcategories = true;
    dataAfter.enablecheckavailability = '-1'; dataAfter.ratetax = '';
    after.formDirty = true;
    (after.dirtyFields as string[]).push('children', 'child2', 'averagerate');
    (after.modifiedFields as string[]).push('childages', 'updatechildcategories', 'enablecheckavailability', 'ratetax');
    const requested = planSavedChildOccupancy({ childCount: 3, childAges: [8, 12, 5] });
    expect(savedChildDraftDelta(before, after, requested)).toMatchObject({ ok: true, unapprovedFields: [], priceClearedFields: ['averagerate'] });
    const bad = structuredClone(after); (bad.data as Record<string, unknown>).unexpected = 'changed';
    expect(savedChildDraftDelta(before, bad, requested)).toMatchObject({ ok: false, unapprovedFields: ['unexpected'] });
    const wrongAge = structuredClone(after); wrongAge.data.childages = '8,12,6';
    expect(savedChildDraftDelta(before, wrongAge, requested).ok).toBe(false);
  });
});

describe('saved child validation request fence', () => {
  it('accepts the exact observed request and rejects target, payload and frame mismatches', () => {
    const validationPath = '/web/base/OSRESV.HDR.validateChildAgeDetails';
    const native = { propertyCode: 'HRCEN', reservationStayId: '5', adultCount: '2', childCount: '3',
      childAges: [8, 12, 5], updateChildCategories: true, activeChildCategories: 3, confirmChildCategory: false,
      childCategoryCounts: { child1: 0, child2: 2, child3: 0 } };
    const bound = { stayId: '5', adults: 2, ages: [8, 12, 5], priorBands: { child1: 0, child2: 2, child3: 0 } };
    const candidate = (params = native, extras: { body?: string; method?: string; url?: string; frame?: object; type?: string } = {}) => request({
      url: `${ORIGIN}${validationPath}`, body: body(params).toString(), ...extras,
    });
    expect(matchesSavedChildAgeValidation(candidate(), frameId, bound)).toBe(true);
    expect(matchesSavedChildAgeValidation(candidate({ ...native, extra: true } as typeof native), frameId, bound)).toBe(true);
    const duplicates = body(native); duplicates.append('params', '{}');
    for (const invalid of [
      candidate(native, { frame: {} }), candidate(native, { method: 'GET' }),
      candidate(native, { url: `${ORIGIN}${validationPath}?x=1` }), candidate(native, { type: 'application/json' }),
      candidate(native, { body: duplicates.toString() }), candidate({ ...native, reservationStayId: '6' }),
      candidate({ ...native, adultCount: '3' }), candidate({ ...native, childCount: '2' }),
      candidate({ ...native, childAges: [8, 12, 6] }), candidate({ ...native, updateChildCategories: false }),
      candidate({ ...native, activeChildCategories: 2 }), candidate({ ...native, confirmChildCategory: true }),
      candidate({ ...native, childCategoryCounts: { child1: 0, child2: 3, child3: 0 } }),
    ]) expect(matchesSavedChildAgeValidation(invalid, frameId, bound)).toBe(false);
    const duplicateJson = JSON.stringify(native).replace('"reservationStayId":"5"', '"reservationStayId":"5","reservationStayId":"5"');
    const duplicateBody = new URLSearchParams({ params: duplicateJson, ONLY_DATA_REQUIRED: 'true' });
    expect(matchesSavedChildAgeValidation(candidate(native, { body: duplicateBody.toString() }), frameId, bound)).toBe(false);
  });
});

// Exercise actual stage orchestration with synthetic native controls and layered routes.
function fakeContext() {
  const routes: Array<(route: any) => Promise<void>> = [];
  return { routes, _options: { serviceWorkers: 'block' }, serviceWorkers: () => [],
    route: async (_: string, handler: any) => { routes.push(handler); } };
}
function deferredGate() {
  let release!: () => void, entered!: () => void;
  const waiting = new Promise<void>((resolve) => { release = resolve; });
  const started = new Promise<void>((resolve) => { entered = resolve; });
  return { started, release, block: async () => { entered(); await waiting; } };
}
type Gate = ReturnType<typeof deferredGate>;
function fakePage(settings: {
  badResponse?: boolean; unexpectedRequest?: boolean; blankZero?: boolean; changedIdentity?: boolean; extraWindow?: boolean;
  orderedResponse?: boolean; wrongValidationTarget?: boolean; changedTargetAfterApply?: boolean;
  mismatchedNativeCounts?: boolean; mismatchedVisibleCounts?: boolean; mismatchedModelCounts?: boolean; unexpectedSideEffect?: boolean;
  identityGate?: Gate; identityGateAt?: number; readJsonGate?: Gate; validationJsonGate?: Gate; routeGate?: Gate;
} = {}, context = fakeContext()) {
  const pageRoutes: Array<(route: any) => Promise<void>> = [];
  const contextRoutes = context.routes;
  const ages = [8, 12]; let selected = 0; let toggle = false; let identityReads = 0; let pending: ((value: any) => void) | undefined;
  let popupOpen = false; let applied = false;
  const effects = { reads: 0, aborted: 0, writes: 0, popupClosed: 0, afterApplyTargetReads: 0, afterApplySnapshots: 0, applyClicks: 0 };
  const bands = () => ({ child1: ages.filter((age) => age <= 2).length,
    child2: ages.filter((age) => age >= 3 && age <= 12).length, child3: ages.filter((age) => age >= 13).length });
  const parentSnapshot = () => {
    const result = structuredClone(snapshot());
    const values = result.values as Record<string, unknown>, data = result.data as Record<string, unknown>;
    values.averagerate = '2,830.00'; data.averagerate = '2830';
    data.updatechildcategories = ''; data.enablecheckavailability = '0'; data.ratetax = '0';
    if (popupOpen || applied) {
      data.successmessages = true; data.activechildcategories = 3; result.recordDirty = true;
    }
    if (applied) {
      const desired = { children: ages.length, ...bands() };
      for (const [name, value] of Object.entries(desired)) {
        if (values[name] !== String(value)) (result.dirtyFields as string[]).push(name);
        values[name] = String(value);
      }
      values.averagerate = ''; (result.dirtyFields as string[]).push('averagerate');
      data.childages = ages.join(','); data.updatechildcategories = true;
      data.enablecheckavailability = '-1'; data.ratetax = '';
      (result.modifiedFields as string[]).push('childages', 'updatechildcategories', 'enablecheckavailability', 'ratetax');
      result.formDirty = true;
      if (settings.mismatchedModelCounts) { data.children = String(ages.length); (result.modifiedFields as string[]).push('children'); }
      if (settings.unexpectedSideEffect) data.unexpected = 'changed';
    }
    return result;
  };
  const visit = async (req: any) => {
    const handlers = [...pageRoutes].reverse().concat([...contextRoutes].reverse());
    const next = async (i: number): Promise<void> => {
      if (i === handlers.length) { if (req.url().endsWith(READ)) effects.reads++; else effects.writes++; return; }
      await handlers[i]({ request: () => req, fallback: () => next(i + 1), abort: async () => { effects.aborted++; } });
    };
    await next(0);
  };
  const input = (get: () => number) => ({ count: async () => 1, evaluate: async () => ({ visible: String(get()), native: String(get()) }) });
  const popup = {
    count: async () => popupOpen ? 1 : 0,
    waitFor: async (options?: { state?: string }) => {
      if (options?.state === 'hidden' ? popupOpen : !popupOpen) throw Error('popup state mismatch');
    },
    locator: (selector: string) => {
      if (selector === 'a.x-btn:visible') return { filter: () => ({ count: async () => 1, click: async () => {
        effects.applyClicks++;
        const req = request({ frame, url: `${ORIGIN}/web/base/OSRESV.HDR.validateChildAgeDetails`, body: body({
          propertyCode: 'HRCEN', reservationStayId: '5', adultCount: '2', childCount: String(ages.length),
          childAges: [...ages], updateChildCategories: true, activeChildCategories: 3, confirmChildCategory: false,
          childCategoryCounts: { child1: 0, child2: 2, child3: 0 },
        }).toString() });
        const before = effects.writes; await visit(req);
        if (effects.writes > before) {
          applied = true; popupOpen = false; effects.popupClosed++;
          const derived = bands();
          pending?.({ request: () => req, ok: () => true, json: async () => {
            if (settings.validationJsonGate) await settings.validationJsonGate.block();
            return {
              propertyCode: 'HRCEN', reservationStayId: settings.wrongValidationTarget ? '6' : '5', adultCount: 2,
              childCount: ages.length, childAges: settings.orderedResponse ? [...ages] : [...ages].sort((a, b) => a - b),
              updateChildCategories: true, activeChildCategories: 3, confirmChildCategory: false,
              childCategoryCounts: { CHILD1: derived.child1, CHILD2: derived.child2 - (settings.mismatchedNativeCounts ? 1 : 0),
                CHILD3: derived.child3 }, dirtyList: [], gUserID: '', gFunctionName: '', gRemovePooledBean: false, gEntityName: '',
            };
          } });
        }
      } }) };
      if (selector === 'input[name="updatechildcategories"]') return { count: async () => 1, evaluate: async () => toggle, click: async () => { toggle = true; } };
      if (selector === 'input[name="children"]') return {
        ...input(() => ages.length),
        evaluate: async () => ({ visible: settings.blankZero && ages.length === 0 ? '' : String(ages.length),
          native: settings.blankZero && ages.length === 0 ? '' : String(ages.length) }),
        locator: () => ({ locator: (button: string) => ({ click: async () => {
          if (button.endsWith('.down')) ages.pop(); else ages.push(0);
        } }) }),
      };
      throw Error(`unexpected popup locator ${selector}`);
    },
    getByText: (label: string) => {
      const index = Number(label.match(/\d+$/)?.[0]) - 1;
      return { waitFor: async () => {}, locator: () => ({ locator: (selector: string) => {
        if (selector === 'input:visible') return input(() => ages[index]);
        if (selector === '.x-form-arrow-trigger:visible') return { click: async () => { selected = index; } };
        throw Error(`unexpected row locator ${selector}`);
      } }) };
    },
  };
  const frame: any = {
    page: () => page,
    url: () => `${ORIGIN}/record`,
    evaluate: async (_fn: unknown, arg: any) => {
      if (arg?.expected) {
        identityReads++;
        if (settings.identityGate && identityReads === settings.identityGateAt) await settings.identityGate.block();
        if (applied) effects.afterApplyTargetReads++;
        const changed = (settings.changedIdentity && identityReads > 1) || (settings.changedTargetAfterApply && applied);
        return { native: { reservationstayid: changed ? '6' : '5' }, track: 'T', partyPreimage: parties };
      }
      if (Array.isArray(arg) && arg.includes('arprofileid')) {
        if (applied) effects.afterApplySnapshots++;
        return parentSnapshot();
      }
      if (Array.isArray(arg) && arg.includes('children')) {
        const values = parentSnapshot().values as Record<string, unknown>;
        return Object.fromEntries(['children', 'child1', 'child2', 'child3'].map((name) => {
          const value = applied && settings.mismatchedVisibleCounts && name === 'children' ? '1' : values[name];
          return [name, { visible: value, component: value, readOnly: true, disabled: false }];
        }));
      }
      throw Error('unexpected evaluate');
    },
    locator: (selector: string) => {
      if (selector === '.x-window:visible:not(.x-menu)') return { count: async () => settings.extraWindow && popupOpen ? 1 : 0 };
      if (selector === '.x-window:visible') return { count: async () => popupOpen ? (settings.extraWindow ? 2 : 1) : 0 };
      if (selector === '[data-qtip="Enter Child Ages"]:visible') return { count: async () => 1, click: async () => {
        const req = request({ frame }); await visit(req);
        if (effects.reads) { popupOpen = true; pending?.({ request: () => req, ok: () => true,
          json: async () => {
            if (settings.readJsonGate) await settings.readJsonGate.block();
            return { propertyCode: 'HRCEN', reservationStayId: settings.badResponse ? 'other' : '5', childAges: [8, 12], activeChildCategories: 3, updateChildCategories: false, confirmChildCategory: false };
          } }); }
        if (settings.unexpectedRequest) await visit(request({ frame, url: `${ORIGIN}/web/base/OSRESV.HDR.validateChildAgeDetails` }));
      } };
      if (selector === '.x-window[id^="childagespopup"]:visible') return popup;
      if (selector === '.x-boundlist:visible') return { last: () => ({ locator: () => ({
        first: () => ({ waitFor: async () => {} }), evaluateAll: async (_fn: unknown, age: number) => [age],
        nth: (age: number) => ({ click: async () => { ages[selected] = age; } }),
      }) }) };
      throw Error(`unexpected frame locator ${selector}`);
    },
  };
  const page: any = {
    url: () => `${ORIGIN}/main`, title: async () => 'Infor HMS - HRCEN', context: () => context,
    route: async (_: string, handler: any) => {
      if (settings.routeGate && pageRoutes.length === 0) await settings.routeGate.block();
      pageRoutes.push(handler);
    }, on: vi.fn(),
    locator: (selector: string) => selector.includes('iframe:visible')
      ? { count: async () => 1, elementHandle: async () => ({ contentFrame: async () => frame }) }
      : { count: async () => 1 },
    waitForResponse: () => new Promise((resolve) => { pending = resolve; }),
  };
  const visitContext = async (req: any) => {
    const handlers = [...contextRoutes].reverse();
    const next = async (i: number): Promise<void> => {
      if (i === handlers.length) { effects.writes++; return; }
      await handlers[i]({ request: () => req, fallback: () => next(i + 1), abort: async () => { effects.aborted++; } });
    };
    await next(0);
  };
  return { page, frame, visit, visitContext, effects };
}

// Even the exact previously authorized validation must be denied after the attempt.
async function expectQuarantined(fake: ReturnType<typeof fakePage>) {
  await fake.visit(request({ frame: fake.frame, url: `${ORIGIN}/web/base/OSRESV.HDR.validateChildAgeDetails`, body: body({
    propertyCode: 'HRCEN', reservationStayId: '5', adultCount: '2', childCount: '3', childAges: [8, 12, 5],
    updateChildCategories: true, activeChildCategories: 3, confirmChildCategory: false,
    childCategoryCounts: { child1: 0, child2: 2, child3: 0 },
  }).toString() }));
  await fake.visit(request({ frame: fake.frame, url: `${ORIGIN}/web/base/OSRESV.HDR?pageaction=SAVE` }));
  expect(fake.effects).toMatchObject({ reads: 1, writes: 1, aborted: 2 });
}

describe('child staging lifecycle', () => {
  it('allows consecutive fresh pages in the same guarded context while quarantining each owner', async () => {
    const context = fakeContext();
    let callerRequests = 0;
    context.routes.push(async (route) => {
      callerRequests++;
      if (route.request().url().includes('/blocked-by-caller')) return route.abort();
      return route.fallback();
    });
    const first = fakePage({ orderedResponse: true }, context);
    const second = fakePage({ orderedResponse: true }, context);
    const apply = { childCount: 3, childAges: [8, 12, 5], applyToDraft: true };
    expect(await stageLabtestChildAmendment(first.page, expected, apply)).toMatchObject({ outcome: 'applied_to_unsaved_draft' });
    expect(await stageLabtestChildAmendment(second.page, expected, apply)).toMatchObject({ outcome: 'applied_to_unsaved_draft' });
    expect(first.effects).toMatchObject({ reads: 1, writes: 1 });
    expect(second.effects).toMatchObject({ reads: 1, writes: 1 });
    await expectQuarantined(first);
    await expectQuarantined(second);
    expect(callerRequests).toBe(4);

    // An old context guard must defer, not authorize, another page's requests.
    const third = fakePage({}, context);
    await third.visitContext(request({ frame: third.frame, url: `${ORIGIN}/blocked-by-caller` }));
    expect(third.effects).toMatchObject({ writes: 0, aborted: 1 });
    expect(callerRequests).toBe(5);
    // Ownership that Playwright cannot establish is denied, not delegated.
    await third.visitContext(request({ frame: {} }));
    expect(third.effects).toMatchObject({ writes: 0, aborted: 2 });
    expect(callerRequests).toBe(5);
  });
  it('times out a stalled fence installation and quarantines it if installation finishes late', async () => {
    const gate = deferredGate();
    const fake = fakePage({ routeGate: gate });
    const result = stageLabtestChildAmendment(fake.page, expected, { ...options, timeoutMs: 200 });
    await gate.started;
    expect(await result).toMatchObject({ outcome: 'not_staged', issue: 'CHILD_STAGE_TIMEOUT', saveEligible: false });
    gate.release();
    await new Promise((resolve) => setTimeout(resolve, 0));
    await fake.visit(request({ frame: fake.frame }));
    expect(fake.effects).toMatchObject({ reads: 0, writes: 0, aborted: 1 });
  });
  it('times out a stalled record read and refuses later work on the page', async () => {
    const gate = deferredGate();
    const fake = fakePage({ identityGate: gate, identityGateAt: 1 });
    const result = stageLabtestChildAmendment(fake.page, expected, { ...options, timeoutMs: 200 });
    await gate.started;
    expect(await result).toMatchObject({ outcome: 'not_staged', issue: 'CHILD_STAGE_TIMEOUT', saveEligible: false });
    gate.release();
    await new Promise((resolve) => setTimeout(resolve, 0));
    await fake.visit(request({ frame: fake.frame }));
    expect(fake.effects).toMatchObject({ reads: 0, writes: 0, aborted: 1, applyClicks: 0 });
  });
  it('times out a stalled age response body and keeps the page quarantined', async () => {
    const gate = deferredGate();
    const fake = fakePage({ readJsonGate: gate });
    const result = stageLabtestChildAmendment(fake.page, expected, { ...options, timeoutMs: 200 });
    await gate.started;
    expect(await result).toMatchObject({ outcome: 'stage_uncertain', issue: 'CHILD_STAGE_TIMEOUT', saveEligible: false });
    gate.release();
    await new Promise((resolve) => setTimeout(resolve, 0));
    await fake.visit(request({ frame: fake.frame }));
    expect(fake.effects).toMatchObject({ reads: 1, writes: 0, aborted: 1, applyClicks: 0 });
  });
  it('does not click Apply when its final identity read resolves after the deadline', async () => {
    const gate = deferredGate();
    const fake = fakePage({ identityGate: gate, identityGateAt: 3, orderedResponse: true });
    const result = stageLabtestChildAmendment(fake.page, expected, { ...options, applyToDraft: true, timeoutMs: 200 });
    await gate.started;
    expect(await result).toMatchObject({ outcome: 'stage_uncertain', issue: 'CHILD_STAGE_TIMEOUT', saveEligible: false });
    gate.release();
    await new Promise((resolve) => setTimeout(resolve, 0));
    await fake.visit(request({ frame: fake.frame, url: `${ORIGIN}/web/base/OSRESV.HDR.validateChildAgeDetails` }));
    expect(fake.effects).toMatchObject({ reads: 1, writes: 0, aborted: 1, applyClicks: 0 });
  });
  it('reports Apply uncertain when its response body stalls after dispatch', async () => {
    const gate = deferredGate();
    const fake = fakePage({ validationJsonGate: gate, orderedResponse: true });
    const result = stageLabtestChildAmendment(fake.page, expected,
      { childCount: 3, childAges: [8, 12, 5], applyToDraft: true, timeoutMs: 200 });
    await gate.started;
    expect(await result).toMatchObject({ outcome: 'apply_uncertain', issue: 'CHILD_STAGE_TIMEOUT', saveEligible: false });
    expect(fake.effects).toMatchObject({ reads: 1, writes: 1, applyClicks: 1 });
    gate.release();
    await new Promise((resolve) => setTimeout(resolve, 0));
    await expectQuarantined(fake);
    expect(fake.effects.applyClicks).toBe(1);
  });
  it('refuses an unverified or active service-worker context before routing or editing', async () => {
    const fake = fakePage();
    for (const context of [{ _options: {}, serviceWorkers: () => [] },
      { _options: { serviceWorkers: 'block' }, serviceWorkers: () => [{}] },
      { _options: { serviceWorkers: 'block' } }]) {
      fake.page.context = () => context;
      expect(await stageLabtestChildAmendment(fake.page, expected, options)).toMatchObject({
        outcome: 'refused', issue: 'BROWSER_CONTEXT_UNSAFE', saveEligible: false,
      });
    }
    expect(fake.page.on).not.toHaveBeenCalled();
    expect(fake.effects).toMatchObject({ reads: 0, writes: 0 });
  });
  it('stages only popup values, retains saved values and denies late writes', async () => {
    const fake = fakePage();
    const result = await stageLabtestChildAmendment(fake.page, expected, options);
    expect(result).toMatchObject({ outcome: 'staged_in_editor', saveEligible: false, pricing: 'unknown', inventory: 'unknown',
      saved: { count: 2, ages: [8, 12] }, popup: { applied: false,
        childCount: { visible: '2', native: '2' }, childAges: [{ visible: '8', native: '8' }, { visible: '5', native: '5' }] } });
    expect(fake.effects).toMatchObject({ reads: 1, writes: 0 });
    await fake.visit(request({ frame: fake.frame, url: `${ORIGIN}/web/base/OSRESV.HDR.validateChildAgeDetails` }));
    await fake.visit(request({ frame: fake.frame, url: `${ORIGIN}/web/base/OSRESV.HDR?pageaction=SAVE` }));
    await fake.visit(request({ frame: fake.frame }));
    expect(fake.effects).toMatchObject({ reads: 1, writes: 0, aborted: 3 });
    expect(await stageLabtestChildAmendment(fake.page, expected, options)).toMatchObject({ outcome: 'refused' });
  });
  it('keeps a dispatched reordered native response uncertain and quarantines the page', async () => {
    const fake = fakePage();
    const result = await stageLabtestChildAmendment(fake.page, expected, { ...options, applyToDraft: true });
    expect(result).toMatchObject({ outcome: 'apply_uncertain', issue: 'AGE_VALIDATION_ORDER_UNVERIFIED',
      nativeResponseAges: [5, 8], saveEligible: false });
    expect(fake.effects).toMatchObject({ reads: 1, writes: 1 });
    await fake.visit(request({ frame: fake.frame, url: `${ORIGIN}/web/base/OSRESV.HDR.validateChildAgeDetails` }));
    expect(fake.effects).toMatchObject({ reads: 1, writes: 1, aborted: 1 });
  });
  it('verifies ordered Apply against the closed popup and unsaved parent draft', async () => {
    const fake = fakePage({ orderedResponse: true });
    const result = await stageLabtestChildAmendment(fake.page, expected,
      { childCount: 3, childAges: [8, 12, 5], applyToDraft: true });
    expect(result).toMatchObject({
      outcome: 'applied_to_unsaved_draft', nativeValidationVerified: true, nativeResponseAges: [8, 12, 5],
      requested: { childCount: 3, childAges: [8, 12, 5] }, saved: { count: 2, ages: [8, 12] },
      draftVisible: { children: { visible: '3', component: '3' }, child1: { visible: '0', component: '0' },
        child2: { visible: '3', component: '3' }, child3: { visible: '0', component: '0' } },
      draftOccupancy: { children: { form: { present: true, value: '3' }, model: { present: true, value: '2' } },
        child2: { form: { present: true, value: '3' }, model: { present: true, value: '2' } },
        childages: { form: { present: false }, model: { present: true, value: '8,12,5' } } },
      ok: true, unapprovedFields: [], priceClearedFields: ['averagerate'], requiresReprice: true,
      saveEligible: false, pricing: 'unknown', tax: 'unknown', inventory: 'unknown',
    });
    expect(result).toMatchObject({ changedFields: expect.arrayContaining([
      'children', 'child2', 'childages', 'updatechildcategories', 'enablecheckavailability', 'ratetax', 'averagerate',
    ]) });
    expect(fake.effects).toMatchObject({ reads: 1, writes: 1, popupClosed: 1, afterApplyTargetReads: 1, afterApplySnapshots: 1 });
    await expectQuarantined(fake);
  });
  it.each([
    { label: 'validation response target', settings: { wrongValidationTarget: true }, issue: 'AGE_VALIDATION_RESPONSE_UNVERIFIED', postApplyReads: 0 },
    { label: 'parent target after Apply', settings: { changedTargetAfterApply: true }, issue: 'DRAFT_TARGET_UNVERIFIED', postApplyReads: 1 },
    { label: 'native category counts', settings: { mismatchedNativeCounts: true }, issue: 'DRAFT_CHILD_READBACK_UNVERIFIED', postApplyReads: 1 },
    { label: 'visible child count', settings: { mismatchedVisibleCounts: true }, issue: 'DRAFT_CHILD_READBACK_UNVERIFIED', postApplyReads: 1 },
    { label: 'parent model child count', settings: { mismatchedModelCounts: true }, issue: 'DRAFT_SIDE_EFFECTS_UNVERIFIED', postApplyReads: 1 },
    { label: 'unexpected parent side effect', settings: { unexpectedSideEffect: true }, issue: 'DRAFT_SIDE_EFFECTS_UNVERIFIED', postApplyReads: 1 },
  ])('keeps Apply uncertain for mismatched $label', async ({ settings, issue, postApplyReads }) => {
    const fake = fakePage({ orderedResponse: true, ...settings });
    const result = await stageLabtestChildAmendment(fake.page, expected,
      { childCount: 3, childAges: [8, 12, 5], applyToDraft: true });
    expect(result).toMatchObject({ outcome: 'apply_uncertain', issue,
      saveEligible: false, pricing: 'unknown', tax: 'unknown', inventory: 'unknown' });
    if (issue !== 'DRAFT_SIDE_EFFECTS_UNVERIFIED') expect(result).toMatchObject({ nativeResponseAges: [8, 12, 5] });
    if ('mismatchedModelCounts' in settings) expect(result).toMatchObject({
      nativeValidationVerified: true, ok: false, unapprovedFields: ['snapshot'],
    });
    if ('unexpectedSideEffect' in settings) expect(result).toMatchObject({
      nativeValidationVerified: true, ok: false, unapprovedFields: ['unexpected'],
    });
    expect(fake.effects).toMatchObject({ reads: 1, writes: 1, popupClosed: 1,
      afterApplyTargetReads: postApplyReads, afterApplySnapshots: postApplyReads });
    await expectQuarantined(fake);
  });
  it('stages explicit zero when popup displays and reports native zero', async () => {
    const fake = fakePage();
    const result = await stageLabtestChildAmendment(fake.page, expected, { childCount: 0, childAges: [] });
    expect(result).toMatchObject({ outcome: 'staged_in_editor', requested: { childCount: 0, childAges: [] },
      popup: { childCount: { visible: '0', native: '0' }, childAges: [], applied: false }, saveEligible: false });
    expect(fake.effects).toMatchObject({ reads: 1, writes: 0 });
  });
  it('does not mistake a blank popup spinner for explicit zero', async () => {
    const fake = fakePage({ blankZero: true });
    expect(await stageLabtestChildAmendment(fake.page, expected, { childCount: 0, childAges: [] })).toMatchObject({
      outcome: 'stage_uncertain', issue: 'AGE_EDITOR_READBACK_MISMATCH', saveEligible: false,
    });
    expect(fake.effects).toMatchObject({ reads: 1, writes: 0 });
  });
  it('rejects another visible window alongside the child menu', async () => {
    const fake = fakePage({ extraWindow: true });
    expect(await stageLabtestChildAmendment(fake.page, expected, options)).toMatchObject({
      outcome: 'stage_uncertain', issue: 'AGE_EDITOR_NOT_UNIQUE', saveEligible: false,
    });
    expect(fake.effects).toMatchObject({ reads: 1, writes: 0 });
  });
  it('refuses a changed native stay identity after the popup edit', async () => {
    const fake = fakePage({ changedIdentity: true });
    expect(await stageLabtestChildAmendment(fake.page, expected, options)).toMatchObject({
      outcome: 'stage_uncertain', issue: 'SAVED_FORM_CHANGED', saveEligible: false,
    });
    expect(fake.effects).toMatchObject({ reads: 1, writes: 0 });
  });
  it('refuses to edit when native response is for another saved stay', async () => {
    const fake = fakePage({ badResponse: true });
    expect(await stageLabtestChildAmendment(fake.page, expected, options)).toMatchObject({
      outcome: 'stage_uncertain', issue: 'SAVED_AGE_READBACK_UNVERIFIED', saveEligible: false,
    });
    expect(fake.effects).toMatchObject({ reads: 1, writes: 0 });
    await fake.visit(request({ frame: fake.frame }));
    expect(fake.effects.aborted).toBe(1);
  });
  it('stops on any blocked unexpected request before editing the popup', async () => {
    const fake = fakePage({ unexpectedRequest: true });
    expect(await stageLabtestChildAmendment(fake.page, expected, options)).toMatchObject({
      outcome: 'stage_uncertain', issue: 'SAVED_AGE_READBACK_UNVERIFIED', blockedRequests: 1, saveEligible: false,
    });
    expect(fake.effects).toMatchObject({ reads: 1, writes: 0, aborted: 1 });
  });
});

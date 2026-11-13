import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  run: vi.fn(async (_page: unknown, _config: unknown) => ({ outcome: 'not_dispatched' })),
  current: vi.fn(), snapshot: vi.fn(), clean: vi.fn(), parties: vi.fn(), quote: vi.fn(),
}));
vi.mock('../tooling/hms-cloud/quote-read.mjs', () => ({ readQuote: mocks.quote }));
vi.mock('../tooling/hms-cloud/labtest-amend-save.mjs', () => ({ runLabtestAmendSave: mocks.run }));
vi.mock('../tooling/hms-cloud/labtest-record.mjs', () => ({
  currentLabtestRecord: mocks.current, snapshotLabtestRecord: mocks.snapshot,
  cleanLabtestRecord: mocks.clean, unchangedLabtestBusinessParties: mocks.parties,
}));
import { inspectLabtestSavedRoomRateOptions, readLabtestStayAmendmentAvailability, stageLabtestStayAmendment, summarizeSavedStayAmendment } from '../tooling/hms-cloud/guest-stay-amend-date-room-rate.mjs';

const expected = { confirmation: '20270000001-1', guestId: '77', arrival: '2027-01-18',
  departure: '2027-01-20', roomType: 'DLX', ratePlan: 'BAR', note: '' };
const data = {
  propertycode: 'HRCEN', confirmationnumber: expected.confirmation, guestid: expected.guestId,
  status: 'Reserved', firstname: 'Proof', lastname: 'Labtest', PKID: '1', bookingsessionid: '2',
  reservationid: '3', reservationstayid: '4', recordid: '5', guaranteetype: 'NGI',
  udfchkbox04: '0', udfchar13: '', emailaddress: '', reservationnote: '',
  arrivaldate: '01/18/2027', departuredate: '01/20/2027', roomtype: 'DLX', rateplan: 'BAR',
  roomtypeid: '10', rateplanid: '20', nights: '2', grandtotal: '500', tax: '0',
  ratetax: '0', enablecheckavailability: '0',
};
const before = { data: { ...data }, values: { ...data, arrivaldate: '18-JAN-2027', departuredate: '20-JAN-2027',
  grandtotal: '500.00', tax: '0.00' }, partyControls: [], formDirty: false, recordDirty: false,
  dirtyFields: [] as string[], modifiedFields: [] as string[] };
const departureDraft = () => ({ ...structuredClone(before),
  values: { ...before.values, departuredate: '21-JAN-2027', nights: '3', grandtotal: '', tax: '' },
  data: { ...before.data, ratetax: '', enablecheckavailability: '-1' },
  formDirty: true, recordDirty: true, dirtyFields: ['departuredate', 'nights', 'grandtotal', 'tax'],
  modifiedFields: ['ratetax', 'enablecheckavailability'],
});

describe('saved-stay staged amendment diagnostics', () => {
  beforeEach(() => { vi.clearAllMocks(); });
  afterEach(() => { vi.unstubAllGlobals(); });

  it('reports a departure form change with an unchanged native model and cleared price and tax', () => {
    const result = summarizeSavedStayAmendment(before, departureDraft(), 'departure', '2027-01-21');
    expect(result.observed).toMatchObject({ formMatchesRequested: true, modelMatchesRequested: false,
      form: { value: '21-JAN-2027' }, model: { value: '01/20/2027' } });
    expect(result.pricingFields).toContainEqual({ field: 'grandtotal', source: 'form', kind: 'price',
      before: { state: 'value', value: '500.00' }, after: { state: 'blank', value: '' }, change: 'cleared' });
    expect(result.pricingFields).toContainEqual({ field: 'ratetax', source: 'model', kind: 'tax',
      before: { state: 'value', value: '0' }, after: { state: 'blank', value: '' }, change: 'cleared' });
    expect(result.pricing).toEqual({ repricing: 'not_verified', tax: 'not_verified', inventory: 'not_verified', quote: 'not_produced' });
    expect(result.saveEligible).toBe(false);
  });

  it('does not treat missing, null, ambiguous or changed prices as cleared values', () => {
    const after = departureDraft();
    delete (after.data as Record<string, unknown>).tax;
    (after.values as Record<string, unknown>).tax = null;
    (after.values as Record<string, unknown>).GRANDTOTAL = 'not unique';
    const result = summarizeSavedStayAmendment(before, after, 'departure', '2027-01-21');
    expect(result.pricingFields.find((x: { field: string; source: string }) => x.field === 'tax' && x.source === 'model').after.state).toBe('absent');
    expect(result.pricingFields.find((x: { field: string; source: string }) => x.field === 'tax' && x.source === 'form').after.state).toBe('null');
    expect(result.pricingFields.find((x: { field: string; source: string }) => x.field === 'grandtotal' && x.source === 'form').after.state).toBe('ambiguous');
    expect(result.changedFields).toContain('GRANDTOTAL');
  });

  it('rejects invalid dates, unknown inputs and room/rate selections without an explicit native ID', async () => {
    for (const options of [
      { field: 'arrival', value: '2026-12-31' }, { field: 'arrival', value: '2027-02-30' },
      { field: 'departure', value: '2027-01-18' }, { field: 'arrival', value: '2027-01-21' },
      { field: 'roomType', value: 'DLX2' }, { field: 'ratePlan', value: 'BAR2', nativeId: '' },
      { field: 'roomType', value: 'DLX2', nativeId: '42', save: true },
    ]) expect((await stageLabtestStayAmendment(null, expected, options)).outcome).toBe('input_gap');
    expect(mocks.run).not.toHaveBeenCalled();
  });

  it('validates inspection paging and only accepts room or rate fields', async () => {
    expect(await inspectLabtestSavedRoomRateOptions(null, expected, { field: 'departure' })).toMatchObject({ outcome: 'input_gap' });
    expect(await inspectLabtestSavedRoomRateOptions(null, expected, { field: 'roomType', limit: 0 })).toMatchObject({ outcome: 'input_gap' });
    expect(await inspectLabtestSavedRoomRateOptions(null, expected, { field: 'ratePlan', offset: -1 })).toMatchObject({ outcome: 'input_gap' });
    expect(mocks.current).not.toHaveBeenCalled();
  });

  it('uses a disarmed lifecycle and never accepts any Save match for each supported field', async () => {
    for (const options of [
      { field: 'arrival', value: '2027-01-17' }, { field: 'departure', value: '2027-01-21' },
      { field: 'roomType', value: 'DBL', nativeId: '12' }, { field: 'ratePlan', value: 'CORP', nativeId: '40' },
    ]) {
      await stageLabtestStayAmendment({}, expected, options);
      const config = mocks.run.mock.calls.at(-1)![1] as any;
      expect(config.prepareOnly).toBe(true);
      expect(config.matches()).toBe(false);
      expect(await config.validate(null, null, { identityVerified: true, otherStayInputsUnchanged: true, dialogs: 0, networkRequestsBlocked: 0,
        summary: { observed: { formMatchesRequested: true, modelMatchesRequested: true, nativeDateMatchesRequested: true, nativeIdMatchesRequested: true } } }))
        .toEqual({ ok: false, issue: 'REPRICE_AND_INVENTORY_UNVERIFIED' });
    }
  });

  it('recognizes verified unsaved staging but never turns blocked or incomplete staging into success', async () => {
    const page = {};
    for (const [response, outcome] of [
      [{ outcome: 'not_dispatched', issue: 'REPRICE_AND_INVENTORY_UNVERIFIED', nativeDialog: null,
        blockedRequests: 0, networkRequestsBlocked: 0 }, 'updated_unsaved'],
      [{ outcome: 'not_dispatched', issue: 'STAGING_REQUEST_BLOCKED', nativeDialog: null,
        blockedRequests: 0, networkRequestsBlocked: 1 }, 'not_dispatched'],
      [{ outcome: 'not_dispatched', issue: 'REPRICE_AND_INVENTORY_UNVERIFIED', nativeDialog: null,
        blockedRequests: 1, networkRequestsBlocked: 0 }, 'not_dispatched'],
    ] as const) {
      mocks.run.mockResolvedValueOnce(response as never);
      expect(await stageLabtestStayAmendment(page, expected, { field: 'departure', value: '2027-01-21' }))
        .toMatchObject({ outcome, saveEligible: false, saveDispatched: false });
    }
  });

  it('rejects mismatched or unavailable native date and unexpected bound record changes', async () => {
    await stageLabtestStayAmendment({}, expected, { field: 'departure', value: '2027-01-21' });
    const config = mocks.run.mock.calls.at(-1)![1] as any;
    const summary = { observed: { formMatchesRequested: true, nativeDateMatchesRequested: true,
      modelMatchesRequested: false, beforeModel: { state: 'value', value: '01/20/2027' },
      model: { state: 'value', value: '01/20/2027' } } };
    const staged = { identityVerified: true, otherStayInputsUnchanged: true, dialogs: 0, networkRequestsBlocked: 0, summary };
    expect(await config.validate(null, null, staged)).toEqual({ ok: false, issue: 'REPRICE_AND_INVENTORY_UNVERIFIED' });
    staged.otherStayInputsUnchanged = false;
    expect(await config.validate(null, null, staged)).toEqual({ ok: false, issue: 'AMEND_DRAFT_CHANGED' });
    staged.otherStayInputsUnchanged = true;
    summary.observed.nativeDateMatchesRequested = false;
    expect(await config.validate(null, null, staged)).toEqual({ ok: false, issue: 'AMEND_NATIVE_DATE_UNVERIFIED' });
    summary.observed.nativeDateMatchesRequested = true;
    summary.observed.model.value = '01/19/2027';
    expect(await config.validate(null, null, staged)).toEqual({ ok: false, issue: 'AMEND_NATIVE_DATE_UNVERIFIED' });
  });

  it('refuses a context without verifiably blocked service workers before reading or editing', async () => {
    const page = { context: () => ({ _options: {}, serviceWorkers: () => [] }) };
    await stageLabtestStayAmendment(page, expected, { field: 'departure', value: '2027-01-21' });
    const config = mocks.run.mock.calls.at(-1)![1] as any;
    await expect(config.prepare(async <T,>(promise: Promise<T>) => promise)).rejects.toThrow('BROWSER_CONTEXT_UNSAFE');
    expect(mocks.current).not.toHaveBeenCalled();
  });

  it('stages a synthetic date via its saved-form control while denying context traffic', async () => {
    let draft = structuredClone(before);
    let deny: ((route: { abort: () => void }) => void) | undefined;
    const control = { count: vi.fn(async () => 1), evaluate: vi.fn(async (_fn: unknown, arg: unknown) =>
      typeof arg === 'string' ? { componentDate: '2027-01-21', formModelDate: '2027-01-21' } : true),
      fill: vi.fn(async () => { deny?.({ abort: () => {} }); draft = departureDraft(); }), press: vi.fn(async () => {}) };
    const save = { click: vi.fn(async () => { throw new Error('unexpected Save'); }) };
    const frame = { locator: (selector: string) => selector.startsWith('input[') ? control :
      selector.startsWith('[data-qtip') ? save : { count: async () => 0 } };
    const state = { frame, native: { PKID: '1' }, partyPreimage: {} };
    const page = { locator: () => ({ count: async () => 1 }),
      context: () => ({ _options: { serviceWorkers: 'block' }, serviceWorkers: () => [],
        route: async (_pattern: string, handler: typeof deny) => { deny = handler; } }),
      waitForTimeout: async () => {} };
    mocks.current.mockResolvedValue(state);
    mocks.snapshot.mockImplementation(async () => structuredClone(draft));
    mocks.clean.mockReturnValue(true);
    mocks.parties.mockReturnValue(true);
    await stageLabtestStayAmendment(page, expected, { field: 'departure', value: '2027-01-21' });
    const config = mocks.run.mock.calls.at(-1)![1] as any;
    const bounded = async <T,>(promise: Promise<T>) => promise;
    const prepared = await config.prepare(bounded);
    const staged = await config.stage(bounded, prepared);
    const abort = vi.fn();
    deny!({ abort });
    expect(abort).toHaveBeenCalledOnce();
    expect(control.fill).toHaveBeenCalledWith('21-JAN-2027');
    expect(control.press).toHaveBeenCalledWith('Tab');
    expect(staged.identityVerified).toBe(true);
    expect(staged.otherStayInputsUnchanged).toBe(true);
    expect(staged.summary.observed).toMatchObject({ formMatchesRequested: true, modelMatchesRequested: false, nativeDateMatchesRequested: true });
    expect(staged.networkRequestsBlocked).toBe(1);
    expect(await config.validate(bounded, prepared, staged)).toEqual({ ok: false, issue: 'STAGING_REQUEST_BLOCKED' });
    expect(save.click).not.toHaveBeenCalled();
  });

  it('refuses a date stage when an unexpected outer dialog appears', async () => {
    let draft = structuredClone(before);
    let outerWindows = 1;
    const input = { count: async () => 1, evaluate: async (_fn: unknown, arg: unknown) =>
      typeof arg === 'string' ? { componentDate: '2027-01-21', formModelDate: '2027-01-21' } : true,
      fill: async () => { draft = departureDraft(); outerWindows = 2; }, press: async () => {} };
    const frame = { locator: (selector: string) => selector.startsWith('input[') ? input : { count: async () => 0 } };
    const state = { frame, native: { PKID: '1' }, partyPreimage: {} };
    const page = { locator: () => ({ count: async () => outerWindows }),
      context: () => ({ _options: { serviceWorkers: 'block' }, serviceWorkers: () => [], route: async () => {} }),
      waitForTimeout: async () => {} };
    mocks.current.mockResolvedValue(state);
    mocks.snapshot.mockImplementation(async () => structuredClone(draft));
    mocks.clean.mockReturnValue(true); mocks.parties.mockReturnValue(true);
    await stageLabtestStayAmendment(page, expected, { field: 'departure', value: '2027-01-21' });
    const config = mocks.run.mock.calls.at(-1)![1] as any;
    const bounded = async <T,>(promise: Promise<T>) => promise;
    const prepared = await config.prepare(bounded), staged = await config.stage(bounded, prepared);
    expect(staged.dialogs).toBe(1);
    expect(await config.validate(bounded, prepared, staged)).toEqual({ ok: false, issue: 'AMEND_DRAFT_CHANGED' });
  });

  it('refuses option inspection when a different saved field has a stale model', async () => {
    const mismatch = structuredClone(before);
    mismatch.data.departuredate = '01/19/2027';
    mocks.current.mockResolvedValue({ frame: {}, partyPreimage: {} });
    mocks.snapshot.mockResolvedValue(mismatch);
    mocks.clean.mockReturnValue(true);
    mocks.parties.mockReturnValue(true);
    expect(await inspectLabtestSavedRoomRateOptions({}, expected, { field: 'roomType' }))
      .toMatchObject({ outcome: 'refused', issue: 'AMEND_PREIMAGE_UNVERIFIED' });
  });

  it('reports the native saved LOV picker hold without opening it or changing the form', async () => {
    const form = { el: { dom: { contains: () => true } } };
    const element = { id: 'room-inputEl', name: 'roomtype', value: 'DLX', disabled: false, readOnly: false };
    const guest = { id: 'guest-inputEl', offsetWidth: 1, offsetHeight: 1, closest: () => null };
    const setValue = vi.fn(), fireEvent = vi.fn();
    const component = { getXType: () => 'lovfield', getValue: () => 'DLX', up: () => form, setValue, fireEvent,
      isDisabled: () => false, readOnly: false };
    vi.stubGlobal('Ext', { getCmp: (id: string) => id === 'room' ? component : { up: () => form } });
    vi.stubGlobal('document', { querySelectorAll: () => [guest] });
    vi.stubGlobal('getComputedStyle', () => ({ visibility: 'visible' }));
    const input = { count: async () => 1, evaluate: async (fn: any, arg: any) => fn(element, arg) };
    const frame = { locator: (selector: string) => selector.startsWith('input[') ? input : { count: async () => 0 } };
    const state = { frame, native: { PKID: '1' }, partyPreimage: {} };
    const page = { locator: () => ({ count: async () => 1 }), context: () => ({ _options: { serviceWorkers: 'block' }, serviceWorkers: () => [] }) };
    mocks.current.mockResolvedValue(state); mocks.snapshot.mockResolvedValue(structuredClone(before));
    mocks.clean.mockReturnValue(true); mocks.parties.mockReturnValue(true);
    expect(await inspectLabtestSavedRoomRateOptions(page, expected, { field: 'roomType' }))
      .toMatchObject({ outcome: 'unavailable', issue: 'SAVED_NATIVE_PICKER_UNVERIFIED' });
    await stageLabtestStayAmendment(page, expected, { field: 'roomType', value: 'DBL', nativeId: '12' });
    const config = mocks.run.mock.calls.at(-1)![1] as any;
    await expect(config.prepare(async <T,>(promise: Promise<T>) => promise)).rejects.toThrow('SAVED_NATIVE_PICKER_UNVERIFIED');
    expect(setValue).not.toHaveBeenCalled(); expect(fireEvent).not.toHaveBeenCalled();
  });

  it('uses the saved component store only for a unique exact native ID and code', async () => {
    let draft = structuredClone(before);
    const form = { el: { dom: { contains: () => true } } };
    const element = { id: 'room-inputEl', name: 'roomtype', value: 'DLX', disabled: false, readOnly: false,
      dispatchEvent: vi.fn() };
    const guest = { id: 'guest-inputEl', offsetWidth: 1, offsetHeight: 1, closest: () => null };
    const record = (code: string, id: string) => ({ get: (key: string) =>
      ({ roomtypecode: code, roomtypeid: id, value: code, display: code } as Record<string, string>)[key] });
    let records = [record('DLX', '10'), record('DBL', '12')];
    const store = { getCount: () => records.length, getAt: (i: number) => records[i], isLoading: () => false,
      getTotalCount: () => records.length };
    const component = { store, valueField: 'value', displayField: 'display', readOnly: false,
      up: () => form, getValue: () => element.value, isDisabled: () => false,
      setValue: vi.fn((item: ReturnType<typeof record>) => {
        element.value = item.get('roomtypecode');
        draft.values.roomtype = element.value; draft.data.roomtype = element.value;
        draft.data.roomtypeid = item.get('roomtypeid'); draft.formDirty = true; draft.recordDirty = true;
        draft.dirtyFields = ['roomtype']; draft.modifiedFields = ['roomtype', 'roomtypeid'];
      }), fireEvent: vi.fn() };
    vi.stubGlobal('Ext', { getCmp: (id: string) => id === 'room' ? component : { up: () => form } });
    vi.stubGlobal('document', { querySelectorAll: () => [guest] });
    vi.stubGlobal('getComputedStyle', () => ({ visibility: 'visible' }));
    vi.stubGlobal('FocusEvent', class { constructor(_type: string, _options: object) {} });
    const input = { count: async () => 1, evaluate: async (fn: any, arg: any) => fn(element, arg) };
    const frame = { locator: (selector: string) => selector.startsWith('input[') ? input : { count: async () => 0 } };
    const state = { frame, native: { PKID: '1' }, partyPreimage: {} };
    const page = { locator: () => ({ count: async () => 1 }), context: () => ({ _options: { serviceWorkers: 'block' }, serviceWorkers: () => [], route: async () => {} }),
      waitForTimeout: async () => {} };
    mocks.current.mockResolvedValue(state); mocks.snapshot.mockImplementation(async () => structuredClone(draft));
    mocks.clean.mockReturnValue(true); mocks.parties.mockReturnValue(true);
    const bounded = async <T,>(promise: Promise<T>) => promise;
    await stageLabtestStayAmendment(page, expected, { field: 'roomType', value: 'DBL', nativeId: '12' });
    const config = mocks.run.mock.calls.at(-1)![1] as any;
    records = [record('DLX', '10'), record('DBL', '12'), record('DBL', '12')];
    await expect(config.prepare(bounded)).rejects.toThrow('SAVED_OPTION_AMBIGUOUS');
    expect(component.setValue).not.toHaveBeenCalled();
    records = [record('DLX', '10'), record('DBL', '13')];
    await expect(config.prepare(bounded)).rejects.toThrow('SAVED_OPTION_UNAVAILABLE');
    expect(component.setValue).not.toHaveBeenCalled();
    records = [record('DLX', '10'), record('DBL', '12')];
    const prepared = await config.prepare(bounded), staged = await config.stage(bounded, prepared);
    expect(component.setValue).toHaveBeenCalledOnce();
    expect(staged.summary.observed).toMatchObject({ formMatchesRequested: true, modelMatchesRequested: true,
      nativeIdMatchesRequested: true });
    expect(await config.validate(bounded, prepared, staged)).toEqual({ ok: false, issue: 'REPRICE_AND_INVENTORY_UNVERIFIED' });
  });

  it('refuses a clean saved baseline when any date, room or rate disagrees with its model', async () => {
    const frame = { locator: () => ({ count: async () => 1 }) };
    const state = { frame, native: { PKID: '1' }, partyPreimage: {} };
    const page = { context: () => ({ _options: { serviceWorkers: 'block' }, serviceWorkers: () => [] }) };
    const bounded = async <T,>(promise: Promise<T>) => promise;
    mocks.current.mockResolvedValue(state);
    mocks.clean.mockReturnValue(true);
    mocks.parties.mockReturnValue(true);
    await stageLabtestStayAmendment(page, expected, { field: 'departure', value: '2027-01-21' });
    const config = mocks.run.mock.calls.at(-1)![1] as any;
    for (const name of ['arrivaldate', 'departuredate', 'roomtype', 'rateplan']) {
      const mismatch = structuredClone(before);
      (mismatch.data as Record<string, unknown>)[name] = 'other';
      mocks.snapshot.mockResolvedValueOnce(mismatch);
      await expect(config.prepare(bounded)).rejects.toThrow('AMEND_PREIMAGE_UNVERIFIED');
    }
  });

  it('refuses staging when the fresh identity or clean snapshot changes', async () => {
    const control = { count: async () => 1, evaluate: async () => true, fill: vi.fn(), press: vi.fn() };
    const frame = { locator: (selector: string) => selector.startsWith('input[') ? control : { count: async () => 0 } };
    const state = { frame, native: { PKID: '1' }, partyPreimage: {} };
    const page = { locator: () => ({ count: async () => 1 }), context: () => ({ _options: { serviceWorkers: 'block' }, serviceWorkers: () => [], route: async () => {} }),
      waitForTimeout: async () => {} };
    mocks.current.mockResolvedValue(state);
    mocks.snapshot.mockResolvedValueOnce(structuredClone(before))
      .mockResolvedValueOnce({ ...structuredClone(before), data: { ...before.data, guestid: '999' } })
      .mockResolvedValueOnce(structuredClone(before));
    mocks.clean.mockReturnValue(true); mocks.parties.mockReturnValue(true);
    await stageLabtestStayAmendment(page, expected, { field: 'departure', value: '2027-01-21' });
    const config = mocks.run.mock.calls.at(-1)![1] as any;
    const bounded = async <T,>(promise: Promise<T>) => promise;
    const prepared = await config.prepare(bounded), staged = await config.stage(bounded, prepared);
    expect(staged.editIssue).toBe('AMEND_PREIMAGE_CHANGED');
    expect(control.fill).not.toHaveBeenCalled();
  });
});


describe('availability for a verified saved Labtest stay', () => {
  const options = () => ({ change: { departure: '2027-01-21' }, occupancy: { adults: 2, childAges: [8, 12] },
    partyContext: { group: null, organization: '42', bookingAgency: null }, roomQuantity: 1, snapshotPath: '/private/quote.json' });
  const baseline = () => {
    const result = structuredClone(before);
    for (const part of [result.values, result.data]) Object.assign(part, { adults: '2', children: '2', child1: '0', child2: '2', child3: '0' });
    Object.assign(result.data, { childages: '8,12',
      child1label: 'Child 0 - 02', child2label: 'Child 03 - 12', child3label: 'Child 13 - 17',
      child1status: 'ACTIVE', child2status: 'ACTIVE', child3status: 'ACTIVE' });
    return result;
  };
  const setup = () => {
    const snap = baseline();
    const state = { frame: {}, native: { PKID: '1' }, partyPreimage: { groupid: '', companyid: '42', taid1: '' } };
    mocks.current.mockResolvedValue(state); mocks.snapshot.mockResolvedValue(snap);
    mocks.clean.mockReturnValue(true); mocks.parties.mockReturnValue(true);
    mocks.quote.mockResolvedValue({ outcome: 'ok', snapshotPath: '/private/quote.json', view: { options: [] } });
    return { snap, state };
  };
  beforeEach(() => { vi.clearAllMocks(); });
  it('binds the proposal to saved dates, occupancy and party preimage before and after a separate read', async () => {
    setup(); const record = {}, availability = {};
    const result = await readLabtestStayAmendmentAvailability(record, availability, expected, options());
    expect(result).toMatchObject({ outcome: 'ok', savedPreimage: 'verified_labtest_form', saveEligible: false,
      prepared: { savedPreimage: 'verified_labtest_form', criteria: { departureDate: '2027-01-21', partyContext: { organization: '42' } } } });
    expect(mocks.current).toHaveBeenCalledTimes(2);
    expect(mocks.quote).toHaveBeenCalledWith(availability, expect.objectContaining({ roomQuantity: 1 }));
  });
  it('refuses contradictory occupancy or party context before any search', async () => {
    setup(); const bad = options(); bad.occupancy.adults = 3;
    expect(await readLabtestStayAmendmentAvailability({}, {}, expected, bad)).toMatchObject({ outcome: 'refused', issue: 'AMEND_OCCUPANCY_UNVERIFIED' });
    const wrongParty = options(); wrongParty.partyContext.organization = '99';
    expect(await readLabtestStayAmendmentAvailability({}, {}, expected, wrongParty)).toMatchObject({ outcome: 'refused', issue: 'AMEND_PARTY_CONTEXT_MISMATCH' });
    expect(mocks.quote).not.toHaveBeenCalled();
  });
  it('refuses missing child ages and stale baseline', async () => {
    const { snap } = setup(); Object.assign(snap.data, { childages: '' });
    expect(await readLabtestStayAmendmentAvailability({}, {}, expected, options())).toMatchObject({ outcome: 'refused', issue: 'AMEND_OCCUPANCY_UNVERIFIED' });
    const current = baseline(), changed = structuredClone(current); changed.values.departuredate = '22-JAN-2027';
    mocks.snapshot.mockReset().mockResolvedValueOnce(current).mockResolvedValueOnce(changed);
    expect(await readLabtestStayAmendmentAvailability({}, {}, expected, options())).toMatchObject({ outcome: 'refused', issue: 'AMEND_PREIMAGE_CHANGED', saveEligible: false });
  });
  it('accepts a verified zero-child count only with a genuinely blank native age value', async () => {
    const { snap } = setup();
    for (const part of [snap.values, snap.data]) Object.assign(part, { children: '0', child1: '0', child2: '0', child3: '0' });
    Object.assign(snap.data, { childages: '' });
    const zero = options(); zero.occupancy.childAges = [];
    expect(await readLabtestStayAmendmentAvailability({}, {}, expected, zero)).toMatchObject({ outcome: 'ok', savedPreimage: 'verified_labtest_form' });
    mocks.quote.mockClear();
    Object.assign(snap.data, { childages: 'bad' });
    expect(await readLabtestStayAmendmentAvailability({}, {}, expected, zero)).toMatchObject({ outcome: 'refused', issue: 'AMEND_OCCUPANCY_UNVERIFIED' });
    delete (snap.data as Record<string, unknown>).childages;
    expect(await readLabtestStayAmendmentAvailability({}, {}, expected, zero)).toMatchObject({ outcome: 'refused', issue: 'AMEND_OCCUPANCY_UNVERIFIED' });
    Object.assign(snap.data, { childages: '' });
    Object.assign(snap.values, { childages: '8' });
    expect(await readLabtestStayAmendmentAvailability({}, {}, expected, zero)).toMatchObject({ outcome: 'refused', issue: 'AMEND_OCCUPANCY_UNVERIFIED' });
    expect(mocks.quote).not.toHaveBeenCalled();
  });
  it('refuses present form ages that conflict with the native model, including ambiguous field names', async () => {
    const { snap } = setup();
    Object.assign(snap.values, { childages: '8,12' });
    expect(await readLabtestStayAmendmentAvailability({}, {}, expected, options())).toMatchObject({ outcome: 'ok' });
    mocks.quote.mockClear();
    Object.assign(snap.values, { childages: '8,11' });
    expect(await readLabtestStayAmendmentAvailability({}, {}, expected, options())).toMatchObject({ outcome: 'refused', issue: 'AMEND_OCCUPANCY_UNVERIFIED' });
    Object.assign(snap.values, { childages: '' });
    expect(await readLabtestStayAmendmentAvailability({}, {}, expected, options())).toMatchObject({ outcome: 'refused', issue: 'AMEND_OCCUPANCY_UNVERIFIED' });
    delete (snap.values as Record<string, unknown>).childages;
    Object.assign(snap.values, { ChildAges: '8,12' });
    expect(await readLabtestStayAmendmentAvailability({}, {}, expected, options())).toMatchObject({ outcome: 'refused', issue: 'AMEND_OCCUPANCY_UNVERIFIED' });
    for (const part of [snap.values, snap.data]) Object.assign(part, { children: '0', child1: '0', child2: '0', child3: '0' });
    Object.assign(snap.data, { childages: '' });
    const zero = options(); zero.occupancy.childAges = [];
    expect(await readLabtestStayAmendmentAvailability({}, {}, expected, zero)).toMatchObject({ outcome: 'refused', issue: 'AMEND_OCCUPANCY_UNVERIFIED' });
    expect(mocks.quote).not.toHaveBeenCalled();
  });
  it('requires separate record and availability pages', async () => {
    const page = {};
    expect(await readLabtestStayAmendmentAvailability(page, page, expected, options())).toMatchObject({ outcome: 'input_gap', issue: 'SEPARATE_AVAILABILITY_PAGE_REQUIRED' });
    expect(mocks.current).not.toHaveBeenCalled();
  });
  it('does not let caller mutation change criteria during record verification', async () => {
    const { state } = setup();
    let release: () => void = () => {};
    mocks.current.mockImplementationOnce(() => new Promise((resolve) => { release = () => resolve(state); }));
    const mutableExpected = { ...expected }, mutableOptions = options();
    const result = readLabtestStayAmendmentAvailability({}, {}, mutableExpected, mutableOptions);
    mutableExpected.departure = '2027-01-19';
    mutableOptions.change.departure = '2027-01-22';
    mutableOptions.occupancy.childAges[0] = 4;
    release();
    expect(await result).toMatchObject({ outcome: 'ok', prepared: { criteria: { departureDate: '2027-01-21', childAges: [8, 12] } } });
    expect(mocks.current.mock.calls[0][1].departure).toBe('2027-01-20');
  });

});

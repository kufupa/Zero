import { runInNewContext } from 'node:vm';
import { describe, expect, it, vi } from 'vitest';
import { blankSavedPartyFields } from '../tooling/hms-cloud/labtest-party-fields.mjs';

const fixture = vi.hoisted(() => ({
  run: vi.fn(async (_page: unknown, _options: unknown) => ({ outcome: 'not_dispatched' })),
}));
vi.mock('../tooling/hms-cloud/labtest-amend-save.mjs', () => ({ runLabtestAmendSave: fixture.run }));

import { stageLabtestAdultAmendment } from '../tooling/hms-cloud/guest-stay-amend-adults.mjs';

describe('adult amendment save-helper boundary', () => {
  it('always invokes the shared lifecycle in prepare-only mode with no matching Save request', async () => {
    fixture.run.mockClear();
    const page = {};
    const expected = {
      confirmation: '12345678-1', guestId: '42', arrival: '2027-01-15', departure: '2027-01-16',
      roomType: 'DLX', ratePlan: 'BAR', note: '', adults: 1,
    };
    await stageLabtestAdultAmendment(page, expected, { adults: 2 });
    expect(fixture.run).toHaveBeenCalledOnce();
    const config = fixture.run.mock.calls[0]![1] as { prepareOnly: boolean; matches: () => boolean };
    expect(config.prepareOnly).toBe(true);
    expect(config.matches()).toBe(false);
  });
});

// Evaluate the adapter's actual browser callbacks against a small Ext-like form.
// Playwright serializes evaluate results, so snapshots must not alias the live model.
function savedStayPage() {
  const origin = 'https://hmsweb.hms.eu1.inforcloudsuite.com';
  const expected = {
    confirmation: '20270000001-1', guestId: '77', arrival: '2027-01-15', departure: '2027-01-16',
    roomType: 'DLX', ratePlan: 'BAR', note: '', adults: 1,
  };
  const data: Record<string, string> = {
    PKID: '2', bookingsessionid: '3', reservationid: '4', reservationstayid: '5', recordid: '6',
    propertycode: 'HRCEN', status: 'Reserved', firstname: 'Proof', lastname: 'Labtest',
    confirmationnumber: expected.confirmation, guestid: expected.guestId,
    arrivaldate: '01/15/2027', departuredate: '01/16/2027', roomtype: 'DLX', rateplan: 'BAR',
    track: 'TRACK-1', reservationnote: '', guaranteetype: 'NGI', udfchkbox04: '0',
    udfchar13: '', emailaddress: '', adults: '1', averagerate: '2060', ratetax: '0',
    enablecheckavailability: '0', childages: '[]',
    ...Object.fromEntries(blankSavedPartyFields.map((name: string) => [name, ''])),
  };
  const values: Record<string, string> = { ...data, averagerate: '2,060.00' };
  delete values.ratetax;
  delete values.enablecheckavailability;
  const display: Record<string, string> = {
    ...data, arrivaldate: '15-JAN-2027', departuredate: '16-JAN-2027',
    guaranteetype: 'Non-Guaranteed Individual', adults: '1 Adult',
  };
  const names = [
    'confirmationnumber', 'status', 'guestid', 'firstname', 'lastname', 'arrivaldate', 'departuredate',
    'roomtype', 'rateplan', 'track', 'guaranteetype', 'reservationnote', 'udfchkbox04', 'udfchar13',
    'emailaddress', 'adults',
  ];
  const elements = names.map((name) => ({
    name, id: `${name}-inputEl`, value: display[name], offsetWidth: 100, offsetHeight: 20,
    disabled: false, readOnly: false, closest: () => null, dispatchEvent: vi.fn(),
  }));
  const adultInput = elements.find((element) => element.name === 'adults')!;
  const dirtyFields = new Set<string>();
  const record = {
    data, dirty: false, modified: {} as Record<string, string>,
    set(name: string, value: string) {
      if (this.data[name] !== value) {
        this.modified[name] = this.data[name]!;
        this.data[name] = value;
        this.dirty = true;
      }
    },
  };
  const form = {
    el: { dom: { contains: (element: unknown) => elements.includes(element as typeof elements[number]),
      querySelectorAll: () => elements } },
    getRecord: () => record,
    // Model the combo as excluded from generic form update. The explicit native
    // record.set in the adapter must persist the selected adult value in the draft.
    updateRecord: vi.fn(),
    getForm: () => ({
      getValues: () => ({ ...values }),
      isDirty: () => dirtyFields.size > 0,
      getFields: () => ({ items: ['adults', 'averagerate'].map((name) => ({
        getName: () => name, isDirty: () => dirtyFields.has(name),
      })) }),
    }),
  };
  const options = [
    { data: { value: '1', display: '1 Adult' } },
    { data: { value: '2', display: '2 Adults' } },
    { data: { value: '3', display: '3 Adults' } },
  ];
  let selected = options[0]!;
  const combo = {
    store: { getCount: () => options.length, getAt: (index: number) => options[index] },
    valueField: 'value', displayField: 'display', up: () => form, isDisabled: () => false,
    getValue: () => selected,
    setValue: (option: typeof selected) => {
      selected = option;
      adultInput.value = option.data.display;
      values.adults = option.data.value;
      dirtyFields.add('adults');
    },
    fireEvent: (event: string) => {
      if (event === 'select') {
        // Representative observed HMS pricing and availability invalidation.
        values.averagerate = '';
        dirtyFields.add('averagerate');
        record.set('ratetax', '');
        record.set('enablecheckavailability', '-1');
      }
    },
  };
  const components: Record<string, unknown> = {
    guestid: { up: () => form }, adults: combo,
    guaranteetype: { getValue: () => 'NGI' }, udfchkbox04: { getValue: () => false },
  };
  const browser = {
    location: { origin },
    document: { querySelectorAll: (selector: string) => selector === 'input[name="guestid"]'
      ? elements.filter((element) => element.name === 'guestid') : elements },
    Ext: { getCmp: (id: string) => components[id] },
    getComputedStyle: () => ({ visibility: 'visible' }),
    FocusEvent: class { constructor(public type: string, public options: unknown) {} },
  };
  const evaluate = (callback: Function, args: unknown[]) => structuredClone(runInNewContext(
    `(${callback.toString()})(...args)`, { ...browser, args },
  ));
  const save = { count: async () => 1, click: vi.fn() };
  const frame = {
    url: () => `${origin}/record`,
    evaluate: async (callback: Function, arg: unknown) => evaluate(callback, [arg]),
    locator: (selector: string) => {
      if (selector === 'input[name="adults"]:visible') return {
        count: async () => 1,
        evaluate: async (callback: Function, arg: unknown) => evaluate(callback, [adultInput, arg]),
        scrollIntoViewIfNeeded: async () => {},
      };
      if (selector === '[data-qtip="Save Record (Ctrl+S)"]:visible') return save;
      if (selector === '.x-window:visible:not(.x-menu)') return { count: async () => 0 };
      throw new Error(`Unexpected frame selector: ${selector}`);
    },
  };
  const pageRoutes: Array<(route: any) => Promise<void>> = [];
  const context = { route: vi.fn(async (_pattern: string, handler: (route: any) => Promise<void>) => {
    // The real lifecycle installs a context-wide guard; no real network exists here.
    void handler;
  }) };
  const page = {
    url: () => `${origin}/home`, title: async () => 'Infor HMS - HRCEN',
    locator: (selector: string) => {
      if (selector === '.x-window:visible:not(.x-menu) iframe:visible') return {
        count: async () => 1, elementHandle: async () => ({ contentFrame: async () => frame }),
      };
      if (selector === '.x-window:visible:not(.x-menu)') return { count: async () => 1 };
      throw new Error(`Unexpected page selector: ${selector}`);
    },
    context: () => context,
    route: vi.fn(async (_pattern: string, handler: (route: any) => Promise<void>) => { pageRoutes.push(handler); }),
    on: vi.fn(), off: vi.fn(), waitForResponse: vi.fn(),
  };
  return { page, frame, save, pageRoutes, expected, data, values, adultInput, form, options, record };
}

describe('adult amendment real callback chain', () => {
  it.each([
    { name: 'unavailable', requested: 4, issue: 'ADULT_OPTION_UNAVAILABLE', duplicate: false },
    { name: 'duplicate', requested: 2, issue: 'ADULT_OPTION_NOT_UNIQUE', duplicate: true },
  ])('leaves the draft untouched when the requested option is $name', async ({ requested, issue, duplicate }) => {
    fixture.run.mockClear();
    const actual = await vi.importActual<typeof import('../tooling/hms-cloud/labtest-amend-save.mjs')>(
      '../tooling/hms-cloud/labtest-amend-save.mjs',
    );
    fixture.run.mockImplementationOnce(actual.runLabtestAmendSave);
    const stay = savedStayPage();
    if (duplicate) stay.options.push({ data: { value: '2', display: '2 Adults duplicate' } });
    const dataBefore = structuredClone(stay.data);
    const valuesBefore = structuredClone(stay.values);

    const result = await stageLabtestAdultAmendment(stay.page, stay.expected, { adults: requested });

    expect(result).toMatchObject({ outcome: 'not_dispatched', issue });
    expect(stay.adultInput.value).toBe('1 Adult');
    expect(stay.data).toEqual(dataBefore);
    expect(stay.values).toEqual(valuesBefore);
    expect(stay.record.dirty).toBe(false);
    expect(stay.record.modified).toEqual({});
    expect(stay.form.updateRecord).not.toHaveBeenCalled();
    expect(stay.save.click).not.toHaveBeenCalled();
    expect(stay.page.waitForResponse).not.toHaveBeenCalled();
    expect(stay.pageRoutes).toHaveLength(0);
  });

  it('stages the selected adult into the native draft and refuses Save pending repricing', async () => {
    fixture.run.mockClear();
    const actual = await vi.importActual<typeof import('../tooling/hms-cloud/labtest-amend-save.mjs')>(
      '../tooling/hms-cloud/labtest-amend-save.mjs',
    );
    fixture.run.mockImplementationOnce(actual.runLabtestAmendSave);
    const stay = savedStayPage();
    const result = await stageLabtestAdultAmendment(stay.page, stay.expected, { adults: 2 });

    expect(stay.adultInput.value).toBe('2 Adults');
    expect(stay.values.adults).toBe('2');
    expect(stay.data.adults).toBe('2');
    expect(stay.form.updateRecord).toHaveBeenCalledOnce();
    expect(result).toMatchObject({
      outcome: 'not_dispatched', issue: 'OCCUPANCY_REPRICE_REQUIRED', field: 'adults', adults: 2,
      availabilityRepriceRequired: true, saveEligible: false, unapprovedFields: [],
      changedFields: ['adults', 'averagerate', 'enablecheckavailability', 'ratetax'],
      nativeSideEffects: expect.arrayContaining([
        { field: 'averagerate', kind: 'pricing', beforeModel: '2060', afterModel: '2060',
          beforeForm: '2,060.00', afterForm: '' },
        { field: 'enablecheckavailability', kind: 'availability', beforeModel: '0', afterModel: '-1' },
        { field: 'ratetax', kind: 'tax', beforeModel: '0', afterModel: '' },
      ]),
      preview: {
        field: 'adults', from: 1, to: 2, target: { confirmation: stay.expected.confirmation },
        bodyChanges: { adults: '2', averagerate: '' },
        pricing: { state: 'not_repriced', inventory: 'not_verified', tax: 'not_repriced' },
        approval: { ready: false, trustedHumanApproval: 'not_established' },
        nextStep: 'availability_reprice_not_verified', saveEligible: false,
      },
    });
    expect(result.preview.baselineDigest).toMatch(/^[a-f0-9]{64}$/);
    expect(result.preview.stagedDigest).toMatch(/^[a-f0-9]{64}$/);
    expect(result.preview.baselineDigest).not.toBe(result.preview.stagedDigest);
    expect(stay.save.click).not.toHaveBeenCalled();
    expect(stay.page.waitForResponse).not.toHaveBeenCalled();
    const config = fixture.run.mock.calls[0]![1] as { prepareOnly: boolean; matches: () => boolean };
    expect(config.prepareOnly).toBe(true);
    expect(config.matches()).toBe(false);

    // Even a later synthetic Save is denied by the real lifetime page fence.
    expect(stay.pageRoutes).toHaveLength(2);
    const request = {
      url: () => 'https://hmsweb.hms.eu1.inforcloudsuite.com/web/base/OSRESV.HDR?pageaction=SAVE',
      method: () => 'POST', postData: () => '', frame: () => stay.frame,
    };
    const abort = vi.fn();
    await stay.pageRoutes[1]!({
      request: () => request,
      fallback: async () => stay.pageRoutes[0]!({ request: () => request, abort, fallback: vi.fn() }),
      abort: vi.fn(),
    });
    expect(abort).toHaveBeenCalledOnce();
  });
});

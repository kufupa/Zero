import { afterEach, describe, expect, it, vi } from 'vitest';
import { projectNativeSavedStayPreimage, readNativeSavedStayPreimage } from '../tooling/hms-cloud/stay360-native-preimage.mjs';

const expected = { propertyCode: 'HRCEN', confirmation: '123456-1' };
const data = { propertycode: 'HRCEN', confirmationnumber: '123456-1', guestid: '42', status: 'Reserved',
  firstname: 'Proof', lastname: 'Labtest', arrivaldate: '01/10/2027', departuredate: '01/12/2027',
  roomtype: 'STQN', rateplan: 'BAR', adults: '2', children: '0', child1: '0', child2: '0', child3: '0',
  childages: '', reservationstayid: '81', reservationid: '82', recordid: '83' };
const values = { ...data, arrivaldate: '10-JAN-2027', departuredate: '12-JAN-2027' };
const snapshot = () => ({ data: { ...data }, values: { ...values }, formDirty: false, recordDirty: false,
  dirtyFields: [] as string[], modifiedFields: [] as string[] });

describe('bounded native saved-stay preimage', () => {
  it('permits unrelated rate and occupancy differences only in the filing identity view', () => {
    const row = snapshot();
    const changed = { ...row, data: { ...row.data, roomtype: '', rateplan: 'OTHER', adults: '', children: '' },
      values: { ...row.values, roomtype: 'DIFFERENT', rateplan: 'DIFFERENT' } };
    expect(projectNativeSavedStayPreimage(changed, expected)).toBeNull();
    expect(projectNativeSavedStayPreimage(changed, expected, { identityOnly: true })).toMatchObject({
      propertyCode: 'HRCEN', confirmation: '123456-1', guestId: '42', firstName: 'Proof', lastName: 'Labtest',
      arrival: '2027-01-10', departure: '2027-01-12',
    });
    for (const bad of [{ ...changed, formDirty: true }, { ...changed, data: { ...changed.data, guestid: '43' } },
      { ...changed, data: { ...changed.data, propertycode: 'HRDAV' } },
      { ...changed, values: { ...changed.values, arrivaldate: '11-JAN-2027' } }]) {
      expect(projectNativeSavedStayPreimage(bad, expected, { identityOnly: true })).toBeNull();
    }
  });
  it('keeps blank and missing child ages unknown, never inferred as empty', () => {
    const row = snapshot();
    expect(projectNativeSavedStayPreimage(row, expected)).toMatchObject({
      propertyCode: 'HRCEN', confirmation: '123456-1', guestId: '42', reservationStayId: '81', childAges: 'unknown',
    });
    const { childages: _unused, ...withoutAges } = row.data;
    expect(projectNativeSavedStayPreimage({ ...row, data: withoutAges }, expected)?.childAges).toBe('unknown');
  });
  it('retains explicit ages only when count and native bands match', () => {
    const row = snapshot();
    const withChild = { ...row, data: { ...row.data, children: '1', child2: '1', childages: '8' },
      values: { ...row.values, children: '1', child2: '1' } };
    expect(projectNativeSavedStayPreimage(withChild, expected)?.childAges).toEqual([8]);
    expect(projectNativeSavedStayPreimage({ ...withChild, data: { ...withChild.data, childages: '18' } }, expected)?.childAges).toBe('unknown');
    expect(projectNativeSavedStayPreimage({ ...withChild, data: { ...withChild.data, childages: '1' } }, expected)?.childAges).toBe('unknown');
  });
  it('reports guarantee code only when clean model and control agree', () => {
    const row = snapshot();
    const paired = { ...row, data: { ...row.data, guaranteetype: 'GTDAGT' }, controls: { guaranteetype: 'GTDAGT' } };
    expect(projectNativeSavedStayPreimage(paired, expected)?.guaranteeCode).toBe('GTDAGT');
    for (const changed of [
      { ...paired, controls: { guaranteetype: 'NGI' } },
      { ...paired, controls: { guaranteetype: '' } },
      { ...paired, controls: {} },
      { ...paired, data: { ...paired.data, GuaranteeType: 'GTDAGT' } },
    ]) expect(projectNativeSavedStayPreimage(changed, expected)?.guaranteeCode).toBeUndefined();
  });
  it('reports party IDs only when the clean model and same-form visible names agree', () => {
    const row = snapshot();
    const paired = { ...row, data: { ...row.data, companyid: '0042', company: 'Test Company', taid1: '73', ta1: 'Test Agency' },
      controls: { company: 'Test Company', ta1: 'Test Agency' } };
    expect(projectNativeSavedStayPreimage(paired, expected)?.commercial).toEqual({
      company: { name: 'Test Company', nativeId: '0042' }, agency: { name: 'Test Agency', nativeId: '73' },
    });
    for (const changed of [
      { ...paired, controls: { ...paired.controls, company: 'Another Company' } },
      { ...paired, controls: { ...paired.controls, company: '' } },
      { ...paired, data: { ...paired.data, companyid: '0' } },
      { ...paired, data: { ...paired.data, companyid: 'not-an-id' } },
      { ...paired, data: { ...paired.data, companyid: '0042', CompanyID: '0042' } },
      { ...paired, data: { ...paired.data, company: 'Test\u0000Company' } },
    ]) expect(projectNativeSavedStayPreimage(changed, expected)?.commercial?.company).toBeUndefined();
    expect(projectNativeSavedStayPreimage({ ...paired, formDirty: true }, expected)).toBeNull();
    expect(projectNativeSavedStayPreimage({ ...paired, data: { ...paired.data, propertycode: 'HRDAV' } }, expected)).toBeNull();
    expect(projectNativeSavedStayPreimage({ ...paired, data: { ...paired.data, confirmationnumber: '999999-1' } }, expected)).toBeNull();
  });
  it('refuses mismatched identity, dirty forms, duplicate keys and malformed native IDs', () => {
    const row = snapshot();
    for (const bad of [
      { ...row, formDirty: true }, { ...row, recordDirty: true }, { ...row, dirtyFields: ['arrivaldate'] },
      { ...row, data: { ...row.data, confirmationnumber: '999999-1' } },
      { ...row, data: { ...row.data, propertycode: 'HRDAV' } },
      { ...row, data: { ...row.data, guestid: '44' } },
      { ...row, data: { ...row.data, GuestID: '42' } },
      { ...row, data: { ...row.data, reservationstayid: '' } },
      { ...row, values: { ...row.values, arrivaldate: '11-JAN-2027' } },
    ]) expect(projectNativeSavedStayPreimage(bad, expected)).toBeNull();
  });
});


describe('native browser preimage reader', () => {
  afterEach(() => vi.unstubAllGlobals());

  function browserFixture() {
    const guest = { id: 'guestid-inputEl', offsetWidth: 1, offsetHeight: 1, closest: () => null };
    const fields = [{ getName: () => 'guestid', isDirty: () => false }];
    const record = { data: { ...data, secretNotForExport: 'private' }, dirty: false, modified: {} };
    const form = { getFields: () => ({ items: fields }), getValues: () => ({ ...values, secretNotForExport: 'private' }), isDirty: () => false };
    const panel = { el: { dom: { contains: (node: unknown) => node === guest } }, getForm: () => form, getRecord: () => record };
    vi.stubGlobal('document', { querySelectorAll: () => [guest] });
    vi.stubGlobal('getComputedStyle', () => ({ visibility: 'visible' }));
    vi.stubGlobal('Ext', { getCmp: () => ({ up: () => panel }) });
    let observed: unknown;
    const frame = { evaluate: async (callback: (arg: { keys: string[]; formKeys: string[] }) => unknown,
      arg: { keys: string[]; formKeys: string[] }) => { observed = callback(arg); return observed; } };
    return { frame, record, fields, guest, panel, observed: () => observed };
  }

  it('runs the callback and returns only bounded clean fields', async () => {
    const f = browserFixture();
    expect(await readNativeSavedStayPreimage(f.frame, expected)).toMatchObject({
      confirmation: '123456-1', guestId: '42', reservationStayId: '81', childAges: 'unknown',
    });
    expect(JSON.stringify(f.observed())).not.toContain('secretNotForExport');
    expect(JSON.stringify(f.observed())).not.toContain('private');
  });

  it('reads native guarantee only from a unique clean control on the selected form', async () => {
    const f = browserFixture();
    Object.assign(f.record.data, { guaranteetype: 'GTDAGT' });
    const input = { name: 'guaranteetype', id: 'guaranteetype-inputEl', offsetWidth: 1, offsetHeight: 1, closest: () => null };
    const guarantee = { getName: () => 'guaranteetype', isDirty: () => false, getValue: () => 'GTDAGT' };
    f.fields.push(guarantee);
    f.panel.el.dom.contains = (node: unknown) => node === f.guest || node === input;
    vi.stubGlobal('document', { querySelectorAll: (selector: string) => selector.includes('guestid') ? [f.guest] : [input] });
    vi.stubGlobal('Ext', { getCmp: (id: string) => id === 'guaranteetype' ? guarantee : { up: () => f.panel } });
    expect((await readNativeSavedStayPreimage(f.frame, expected))?.guaranteeCode).toBe('GTDAGT');
    guarantee.getValue = () => 'NGI';
    expect((await readNativeSavedStayPreimage(f.frame, expected))?.guaranteeCode).toBeUndefined();
    guarantee.getValue = () => 'GTDAGT';
    vi.stubGlobal('document', { querySelectorAll: (selector: string) => selector.includes('guestid') ? [f.guest] : [input, input] });
    expect((await readNativeSavedStayPreimage(f.frame, expected))?.guaranteeCode).toBeUndefined();
  });

  it('captures party names only from unique visible controls in the selected form', async () => {
    const f = browserFixture();
    Object.assign(f.record.data, { companyid: '0042', company: 'Test Company', taid1: '73', ta1: 'Test Agency' });
    const company = { name: 'company', value: 'Test Company', id: 'company-inputEl', offsetWidth: 1, offsetHeight: 1, closest: () => null };
    const agency = { name: 'ta1', value: 'Test Agency', id: 'ta1-inputEl', offsetWidth: 1, offsetHeight: 1, closest: () => null };
    f.panel.el.dom.contains = (node: unknown) => node === f.guest || node === company || node === agency;
    vi.stubGlobal('document', { querySelectorAll: (selector: string) => selector.includes('guestid') ? [f.guest] : [company, agency] });
    expect((await readNativeSavedStayPreimage(f.frame, expected))?.commercial).toEqual({
      company: { name: 'Test Company', nativeId: '0042' }, agency: { name: 'Test Agency', nativeId: '73' },
    });
    vi.stubGlobal('document', { querySelectorAll: (selector: string) => selector.includes('guestid') ? [f.guest] : [company, company, agency] });
    expect((await readNativeSavedStayPreimage(f.frame, expected))?.commercial?.company).toBeUndefined();
    vi.stubGlobal('document', { querySelectorAll: (selector: string) => selector.includes('guestid') ? [f.guest] : [company, agency] });
    f.panel.el.dom.contains = (node: unknown) => node === f.guest || node === agency;
    expect((await readNativeSavedStayPreimage(f.frame, expected))?.commercial?.company).toBeUndefined();
  });

  it('rejects dirty fields, dirty models, duplicate keys and duplicate guest controls', async () => {
    const f = browserFixture();
    f.fields[0]!.isDirty = () => true;
    expect(await readNativeSavedStayPreimage(f.frame, expected)).toBeNull();
    f.fields[0]!.isDirty = () => false;
    f.record.dirty = true;
    expect(await readNativeSavedStayPreimage(f.frame, expected)).toBeNull();
    f.record.dirty = false;
    Object.assign(f.record.data, { GuestID: '42' });
    expect(await readNativeSavedStayPreimage(f.frame, expected)).toBeNull();
    delete (f.record.data as Record<string, unknown>).GuestID;
    vi.stubGlobal('document', { querySelectorAll: () => [f.guest, f.guest] });
    expect(await readNativeSavedStayPreimage(f.frame, expected)).toBeNull();
  });
});

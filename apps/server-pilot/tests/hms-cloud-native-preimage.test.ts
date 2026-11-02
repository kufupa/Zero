import { describe, expect, it } from 'vitest';
import { projectNativeSavedStayPreimage } from '../tooling/hms-cloud/stay360-native-preimage.mjs';

const expected = { propertyCode: 'HRCEN', confirmation: '123456-1' };
const data = { propertycode: 'HRCEN', confirmationnumber: '123456-1', guestid: '42', status: 'Reserved',
  firstname: 'Proof', lastname: 'Labtest', arrivaldate: '01/10/2027', departuredate: '01/12/2027',
  roomtype: 'STQN', rateplan: 'BAR', adults: '2', children: '0', child1: '0', child2: '0', child3: '0',
  childages: '', reservationstayid: '81', reservationid: '82', recordid: '83' };
const values = { ...data, arrivaldate: '10-JAN-2027', departuredate: '12-JAN-2027' };
const snapshot = () => ({ data: { ...data }, values: { ...values }, formDirty: false, recordDirty: false,
  dirtyFields: [] as string[], modifiedFields: [] as string[] });

describe('bounded native saved-stay preimage', () => {
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

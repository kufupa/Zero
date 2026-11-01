import { describe, expect, it } from 'vitest';
import { blankSavedPartyFields } from '../tooling/hms-cloud/labtest-party-fields.mjs';
import { currentLabtestRecord } from '../tooling/hms-cloud/labtest-record.mjs';

const ORIGIN = 'https://hmsweb.hms.eu1.inforcloudsuite.com';
const expected = {
  confirmation: '1234567-1', guestId: '45678', arrival: '2027-01-25', departure: '2027-01-27',
  roomType: 'DLXKNG', ratePlan: 'BAR', note: 'synthetic linked-organization readback',
};
const organization = { nativeId: '90210', name: 'Synthetic Company' };

function recordPage({ companyId = organization.nativeId, company = organization.name, agency = false,
  companyControl = true } = {}) {
  const data = Object.fromEntries(blankSavedPartyFields.map((name) => [name, '']));
  Object.assign(data, {
    PKID: '11', bookingsessionid: '22', reservationid: '33', reservationstayid: '44', recordid: '55',
    propertycode: 'HRCEN', confirmationnumber: expected.confirmation, guestid: expected.guestId,
    status: 'Reserved', firstname: 'Proof', lastname: 'Labtest', reservationnote: expected.note,
    track: 'COR', guaranteetype: 'NGI', udfchar13: '', emailaddress: '',
    companyid: companyId, company, companyname: '',
  });
  const values = {
    confirmationnumber: expected.confirmation, status: 'Reserved', guestid: expected.guestId,
    firstname: 'Proof', lastname: 'Labtest', arrivaldate: '25-JAN-2027', departuredate: '27-JAN-2027',
    roomtype: expected.roomType, rateplan: expected.ratePlan, track: 'COR',
    guaranteetype: 'Non-Guaranteed Individual', reservationnote: expected.note,
    udfchkbox04: '0', udfchar13: '', emailaddress: '', company,
  };
  if (agency) {
    Object.assign(data, { taid1: '8080', ta1: 'Synthetic Agency' });
    Object.assign(values, { taid1: '8080', ta1: 'Synthetic Agency' });
  }
  const inputs = Object.entries(values)
    .filter(([name]) => name !== 'company' || companyControl)
    .map(([name, value]) => ({
      name, value, id: `${name}-inputEl`, type: name === 'udfchkbox04' ? 'checkbox' : 'text',
      offsetWidth: 100, offsetHeight: 20, closest: () => null,
    }));
  const form = {
    el: { dom: {
      contains: (element: unknown) => inputs.some((candidate) => candidate === element),
      querySelectorAll: () => inputs,
    } },
    getRecord: () => ({ data }),
    getForm: () => ({ getValues: () => values }),
  };
  const previous = new Map<string, PropertyDescriptor | undefined>();
  const globals = {
    document: { querySelectorAll: () => inputs },
    location: { origin: ORIGIN },
    getComputedStyle: () => ({ visibility: 'visible' }),
    Ext: { getCmp: (id: string) => ({
      up: () => form,
      getValue: () => id === 'udfchkbox04' ? false : id === 'guaranteetype' ? 'NGI' : null,
    }) },
  };
  const frame = {
    url: () => `${ORIGIN}/web/base/OSRESV.HDR`,
    evaluate: async (fn: (arg: unknown) => unknown, arg: unknown) => {
      for (const [name, value] of Object.entries(globals)) {
        previous.set(name, Object.getOwnPropertyDescriptor(globalThis, name));
        Object.defineProperty(globalThis, name, { configurable: true, writable: true, value });
      }
      try { return fn(arg); }
      finally {
        for (const name of Object.keys(globals)) {
          const descriptor = previous.get(name);
          if (descriptor) Object.defineProperty(globalThis, name, descriptor);
          else delete (globalThis as Record<string, unknown>)[name];
        }
      }
    },
  };
  return {
    url: () => `${ORIGIN}/web/base/OSRESV.HDR`,
    title: async () => 'Infor HMS - HRCEN',
    locator: () => ({ count: async () => 1, elementHandle: async () => ({
      contentFrame: async () => frame,
    }) }),
  };
}

describe('currentLabtestRecord linked organization readback', () => {
  it('binds a hidden native company ID to the selected ID/name and blank peer fields', async () => {
    const record = await currentLabtestRecord(recordPage(), expected, {
      allowUnchangedBusinessParties: true, expectedOrganization: organization,
    });
    expect(record.partyPreimage).toMatchObject({
      companyid: organization.nativeId, company: organization.name, ta1: '',
    });
  });

  it('refuses unbound, mismatched, or mixed-party hidden IDs', async () => {
    await expect(currentLabtestRecord(recordPage(), expected))
      .rejects.toThrow('LABTEST_LINKED_PARTY_UNVERIFIED');
    await expect(currentLabtestRecord(recordPage(), expected, { allowUnchangedBusinessParties: true }))
      .rejects.toThrow('LABTEST_LINKED_PARTY_UNVERIFIED');
    await expect(currentLabtestRecord(recordPage(), expected, { expectedOrganization: organization }))
      .rejects.toThrow('LABTEST_RECORD_INPUT_INVALID');
    await expect(currentLabtestRecord(recordPage({ companyId: '90211' }), expected, {
      allowUnchangedBusinessParties: true, expectedOrganization: organization,
    })).rejects.toThrow('LABTEST_LINKED_PARTY_UNVERIFIED');
    await expect(currentLabtestRecord(recordPage({ company: 'Different Company' }), expected, {
      allowUnchangedBusinessParties: true, expectedOrganization: organization,
    })).rejects.toThrow('LABTEST_LINKED_PARTY_UNVERIFIED');
    await expect(currentLabtestRecord(recordPage({ companyControl: false }), expected, {
      allowUnchangedBusinessParties: true, expectedOrganization: organization,
    })).rejects.toThrow('LABTEST_LINKED_PARTY_UNVERIFIED');
    await expect(currentLabtestRecord(recordPage({ agency: true }), expected, {
      allowUnchangedBusinessParties: true, expectedOrganization: organization,
    })).rejects.toThrow('LABTEST_LINKED_PARTY_UNVERIFIED');
    await expect(currentLabtestRecord(recordPage(), expected, {
      allowUnchangedBusinessParties: true, expectedOrganization: { ...organization, extra: 'not allowed' },
    })).rejects.toThrow('LABTEST_RECORD_INPUT_INVALID');
  });
});

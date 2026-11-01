import { describe, expect, it } from 'vitest';
import {
  labtestAdultAmendDraftDelta,
  labtestAdultAmendPreview,
  matchesLabtestAdultAmendPreview,
  stageLabtestAdultAmendment,
} from '../tooling/hms-cloud/guest-stay-amend-adults.mjs';

const expected = {
  confirmation: '20270000001-1', guestId: '77', arrival: '2027-01-15', departure: '2027-01-16',
  roomType: 'DLX', ratePlan: 'BAR', note: '', adults: 1,
};
const modelOnlyEffects = [
  'ratetax', 'totalcomptaxamount', 'guesttotalresortfee', 'totalguestcomptaxamount', 'enablecheckavailability',
];
const formEffects = [
  'revenuevalue', 'nightsvalue', 'totalresortfee', 'averagerate', 'totalrate', 'enhancedexptotal',
  'grandtotal', 'totalratewithtax', 'averagenightly', 'total', 'tax', 'guesttotal', 'guesttax',
  'guesttotalwithtax',
];
const beforeData: Record<string, string> = {
  PKID: '2', bookingsessionid: '3', reservationid: '4', reservationstayid: '5', recordid: '6',
  propertycode: 'HRCEN', status: 'Reserved', firstname: 'Proof', lastname: 'Labtest',
  confirmationnumber: expected.confirmation, guestid: expected.guestId,
  arrivaldate: '01/15/2027', departuredate: '01/16/2027', roomtype: expected.roomType,
  rateplan: expected.ratePlan, adults: '1', track: 'TRACK-1', reservationnote: expected.note,
  guaranteetype: 'NGI', udfchkbox04: '0', udfchar13: '', emailaddress: '', pagemode: 'view',
  savecctoprofile: '0', savesettlementcctoprofile: '0',
  nightsvalue: '0', revenuevalue: '0', totalresortfee: '0', averagerate: '2060', totalrate: '2060',
  enhancedexptotal: '0', grandtotal: '2060', totalratewithtax: '2060', averagenightly: '2060',
  total: '2060', tax: '0', guesttotal: '2060', guesttax: '0', guesttotalwithtax: '2060',
  ratetax: '0', totalcomptaxamount: '0', guesttotalresortfee: '0', totalguestcomptaxamount: '0',
  enablecheckavailability: '0', companyid: '', childages: '[]', extId: 'ignored',
};
const beforeValues: Record<string, string> = {
  ...beforeData,
  nightsvalue: '0', revenuevalue: '0.00', totalresortfee: '0.00', averagerate: '2,060.00',
  totalrate: '2,060.00', enhancedexptotal: '0.00', grandtotal: '2,060.00',
  totalratewithtax: '2,060.00', averagenightly: '2,060.00', total: '2,060.00', tax: '0.00',
  guesttotal: '2,060.00', guesttax: '0.00', guesttotalwithtax: '2,060.00',
};
for (const name of modelOnlyEffects) delete beforeValues[name];
const before = {
  data: { ...beforeData }, values: beforeValues, partyControls: [],
  formDirty: false, recordDirty: false, dirtyFields: [] as string[], modifiedFields: [] as string[],
};

function stagedAdultChange() {
  return {
    ...before,
    data: {
      ...before.data, adults: '2', ratetax: '', totalcomptaxamount: '', guesttotalresortfee: '',
      totalguestcomptaxamount: '', enablecheckavailability: '-1',
    },
    values: Object.fromEntries(Object.entries(before.values).map(([name, value]) => [
      name, name === 'adults' ? '2' : formEffects.includes(name) ? '' : value,
    ])),
    formDirty: true,
    recordDirty: true,
    dirtyFields: ['adults', ...formEffects],
    modifiedFields: ['adults', ...modelOnlyEffects],
  };
}

describe('saved Labtest adult occupancy staging', () => {
  it('recognizes the exact observed 19-field invalidation and marks availability re-rate required', () => {
    const after = stagedAdultChange();
    const delta = labtestAdultAmendDraftDelta(before, after, 2);
    expect(delta.ok).toBe(true);
    expect(delta.requiresAvailabilityCheck).toBe(true);
    expect(delta.unapprovedFields).toEqual([]);
    expect(delta.bodyChanges).toEqual(Object.fromEntries(['adults', ...formEffects].map((name) => [
      name, name === 'adults' ? '2' : '',
    ])));
    expect(delta.nativeSideEffects).toHaveLength(19);
    expect(delta.nativeSideEffects.map(({ field }) => field).sort()).toEqual(
      [...formEffects, ...modelOnlyEffects].sort(),
    );
    expect(delta.nativeSideEffects).toContainEqual({
      field: 'averagerate', kind: 'pricing', beforeModel: '2060', afterModel: '2060',
      beforeForm: '2,060.00', afterForm: '',
    });
    expect(delta.nativeSideEffects).toContainEqual({
      field: 'nightsvalue', kind: 'lifetime', beforeModel: '0', afterModel: '0',
      beforeForm: '0', afterForm: '',
    });
    expect(delta.nativeSideEffects).toContainEqual({
      field: 'enablecheckavailability', kind: 'availability', beforeModel: '0', afterModel: '-1',
    });

    const preview = labtestAdultAmendPreview(expected, 2, before, after, delta);
    expect(preview).toMatchObject({ field: 'adults', from: 1, to: 2, nextStep: 'availability_reprice_not_verified', saveEligible: false });
    expect(matchesLabtestAdultAmendPreview(preview, expected, 2, before, after, delta)).toBe(true);
  });

  it('accepts the observed cleared model and form values without allowing a save', () => {
    const original = stagedAdultChange();
    const after = {
      ...original,
      data: { ...original.data, ...Object.fromEntries(formEffects.map((name) => [name, ''])) },
      modifiedFields: [...original.modifiedFields, ...formEffects],
    };
    const delta = labtestAdultAmendDraftDelta(before, after, 2);
    expect(delta.ok).toBe(true);
    expect(delta.unapprovedFields).toEqual([]);
    expect(delta.nativeSideEffects).toContainEqual({
      field: 'averagerate', kind: 'pricing', beforeModel: '2060', afterModel: '',
      beforeForm: '2,060.00', afterForm: '',
    });
    expect(delta.nativeSideEffects).toContainEqual({
      field: 'nightsvalue', kind: 'lifetime', beforeModel: '0', afterModel: '',
      beforeForm: '0', afterForm: '',
    });
    expect(labtestAdultAmendPreview(expected, 2, before, after, delta)).toMatchObject({
      saveEligible: false, nextStep: 'availability_reprice_not_verified',
    });
  });

  it('rejects unobserved child-age, linked-party, price, and lifetime changes', () => {
    const after = stagedAdultChange();
    const childAgeChange = {
      ...after,
      values: { ...after.values, childages: '[changed]' },
      data: { ...after.data, childages: '[changed]' },
    };
    expect(labtestAdultAmendDraftDelta(before, childAgeChange, 2).unapprovedFields).toContain('childages');

    const partyChange = { ...after, data: { ...after.data, companyid: 'company-2' } };
    expect(labtestAdultAmendDraftDelta(before, partyChange, 2).unapprovedFields).toContain('companyid');

    const priceChange = { ...after, data: { ...after.data, averagerate: '2061' } };
    expect(labtestAdultAmendDraftDelta(before, priceChange, 2).unapprovedFields).toContain('averagerate');

    const lifetimeChange = { ...after, data: { ...after.data, revenuevalue: '25' } };
    expect(labtestAdultAmendDraftDelta(before, lifetimeChange, 2).unapprovedFields).toContain('revenuevalue');
  });

  it('binds the staged review to target and full stable preimage, allowing only observed session rotation', () => {
    const after = stagedAdultChange();
    const delta = labtestAdultAmendDraftDelta(before, after, 2);
    const preview = labtestAdultAmendPreview(expected, 2, before, after, delta);
    const newSession = {
      ...before,
      data: { ...before.data, bookingsessionid: 'new-session' },
      values: { ...before.values, bookingsessionid: 'new-session' },
    };
    const stagedNewSession = {
      ...after,
      data: { ...after.data, bookingsessionid: 'new-session' },
      values: { ...after.values, bookingsessionid: 'new-session' },
    };
    const newSessionDelta = labtestAdultAmendDraftDelta(newSession, stagedNewSession, 2);
    expect(matchesLabtestAdultAmendPreview(preview, expected, 2, newSession, stagedNewSession, newSessionDelta)).toBe(true);
    expect(matchesLabtestAdultAmendPreview(preview, { ...expected, confirmation: '20270000002-1' },
      2, before, after, delta)).toBe(false);
    expect(matchesLabtestAdultAmendPreview(preview, expected, 2, before,
      { ...after, values: { ...after.values, companyid: 'changed' } }, delta)).toBe(false);
  });
});

describe('adult amendment preview is diagnostic only', () => {
  it('preserves absent and null child occupancy instead of treating either as zero', () => {
    const nullChildBefore = { ...before, data: { ...before.data, children: null } };
    const after = stagedAdultChange();
    const nullChildAfter = { ...after, data: { ...after.data, children: null } };
    const delta = labtestAdultAmendDraftDelta(nullChildBefore, nullChildAfter, 2);
    const preview = labtestAdultAmendPreview(expected, 2, nullChildBefore, nullChildAfter, delta);
    expect(preview).toMatchObject({
      childOccupancy: {
        children: { model: { present: true, value: null }, form: { present: false } },
        child1: { model: { present: false }, form: { present: false } },
      },
      pricing: { state: 'not_repriced', inventory: 'not_verified', tax: 'not_repriced' },
      approval: { ready: false, trustedHumanApproval: 'not_established' },
      saveEligible: false,
    });
  });

  it('rejects missing or changed baseline fields and forged delta summaries', () => {
    const after = stagedAdultChange();
    const delta = labtestAdultAmendDraftDelta(before, after, 2);
    expect(labtestAdultAmendPreview({ ...expected, guestId: 'other' }, 2, before, after, delta)).toBeNull();
    expect(labtestAdultAmendPreview(expected, 2, before, after, { ...delta, changedFields: ['adults'] })).toBeNull();
    const missing = { ...after, data: { ...after.data } };
    delete missing.data.childages;
    expect(labtestAdultAmendDraftDelta(before, missing, 2).ok).toBe(false);
    const dirty = { ...before, formDirty: true, dirtyFields: ['emailaddress'] };
    expect(labtestAdultAmendDraftDelta(dirty, after, 2).ok).toBe(false);
  });

  it('refuses ambiguous snapshot representations rather than hashing omitted or non-finite values', () => {
    const after = stagedAdultChange();
    for (const value of [undefined, NaN, Infinity]) {
      const b = { ...before, data: { ...before.data, unverified: value } };
      const a = { ...after, data: { ...after.data, unverified: value } };
      const delta = labtestAdultAmendDraftDelta(b, a, 2);
      expect(labtestAdultAmendPreview(expected, 2, b, a, delta)).toBeNull();
    }
  });
});


describe('adult amendment direct input boundary', () => {
  it('rejects unsupported fields, absent adult baseline and invalid requested occupancy before accessing a page', async () => {
    expect(await stageLabtestAdultAmendment(null, { ...expected, childAges: null }, { adults: 2 }))
      .toMatchObject({ outcome: 'input_gap', issue: 'UNSUPPORTED_EXPECTED_FIELD' });
    expect(await stageLabtestAdultAmendment(null, expected, { adults: 2, childAges: [] }))
      .toMatchObject({ outcome: 'input_gap', issue: 'UNSUPPORTED_AMEND_OPTION' });
    expect(await stageLabtestAdultAmendment(null, { ...expected, adults: null }, { adults: 2 }))
      .toMatchObject({ outcome: 'input_gap', issue: 'ADULT_PREIMAGE_REQUIRED' });
    expect(await stageLabtestAdultAmendment(null, expected, { adults: null }))
      .toMatchObject({ outcome: 'input_gap', issue: 'ADULT_COUNT_INVALID' });
  });
});

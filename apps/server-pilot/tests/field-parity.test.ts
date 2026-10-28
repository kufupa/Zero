import { describe, expect, it } from 'vitest';
import {
  aggregateFieldParity,
  buildNavaPrefill,
  linkConfirmationCandidates,
  normalizeSurname,
  scoreFieldParity,
  type FieldParityInput,
} from '../src/ai/field-parity.js';

function sample(overrides: Partial<FieldParityInput> = {}): FieldParityInput {
  return {
    id: 'P001',
    source: {},
    nava: {},
    truth: {},
    provenance: {},
    partyBound: false,
    mailbox: 'other',
    ...overrides,
  };
}

describe('HRDAV field parity', () => {
  it('scores every supplied field as a hit on the happy path', () => {
    const fields = {
      agency: '03', guaranteeType: 'CCIATA', roomType: ['STKNG'], ratePlan: ['BAR'],
      adults: [2], children: [{ child1: 0, child2: 1, child3: 1 }],
      arrivalDate: '2027-04-02', departureDate: '2027-04-04', mealPlan: 'bb',
      marketSegment: 'Wholesale', sourceOfBusiness: 'Travel Agent', track: 'STO',
      cmsSendMail: true, cmsMessageId: '03', bookerEmail: 'booker@example.test', reservationNote: true,
    };
    const result = scoreFieldParity(sample({ source: fields, nava: fields, truth: fields }));
    expect(result.fields.length).toBe(Object.keys(fields).length);
    expect(result.fields.every((field) => field.verdict === 'hit')).toBe(true);
  });

  it('maps child ages 5 and 14 to child2=1 and child3=1 without losing adult parity', () => {
    const result = scoreFieldParity(sample({
      source: { adults: [2], children: [5, 14] },
      nava: { adults: [2], children: [{ child1: 0, child2: 1, child3: 1 }] },
      truth: { adults: ['2'], children: { child1: '0', child2: '1', child3: '1' } },
      provenance: { adults: 'extract', children: 'extract' },
    }));
    expect(result.fields.find((field) => field.field === 'children')?.verdict).toBe('hit');
    expect(result.fields.find((field) => field.field === 'adults')?.verdict).toBe('hit');
  });

  it('counts children named without ages as an extraction miss, while adults still score', () => {
    const result = scoreFieldParity(sample({
      source: { adults: [2], children: { count: 2, ages: null } },
      nava: { adults: [2], children: null },
      truth: { adults: [2], children: { child1: 0, child2: 1, child3: 1 } },
      provenance: { adults: 'extract', children: 'extract' },
    }));
    expect(result.fields.find((field) => field.field === 'children')).toMatchObject({ verdict: 'miss', cause: 'extract' });
    expect(result.fields.find((field) => field.field === 'adults')?.verdict).toBe('hit');
  });

  it('distinguishes agency hit, lookup miss, extraction miss, and not-in-email exclusion', () => {
    const hit = scoreFieldParity(sample({ source: { agency: 'Acme Travel' }, nava: { agency: '03' }, truth: { agency: '03' }, provenance: { agency: 'lookup' }, partyBound: true }));
    const lookup = scoreFieldParity(sample({ source: { agency: 'Acme Travel' }, nava: { agency: '08' }, truth: { agency: '03' }, provenance: { agency: 'lookup' }, partyBound: true }));
    const extract = scoreFieldParity(sample({ source: { agency: 'Acme Travel' }, nava: {}, truth: { agency: '03' }, provenance: { agency: 'extract' } }));
    const absent = scoreFieldParity(sample({ source: {}, nava: {}, truth: { agency: '03' } }));
    expect(hit.fields[0]?.verdict).toBe('hit');
    expect(lookup.fields[0]).toMatchObject({ verdict: 'miss', cause: 'lookup' });
    expect(extract.fields[0]).toMatchObject({ verdict: 'miss', cause: 'extract' });
    expect(absent.fields[0]).toMatchObject({ verdict: 'excluded', cause: 'not_in_email' });
  });

  it('maps HRDAV room labels through the create-prefill builder and scores wrong native room as extraction', async () => {
    const built = await buildNavaPrefill({
      propertyCode: 'HRDAV',
      payload: {
        agency: 'Acme Travel',
        stays: [{
          requested: { arrival: '2027-04-02', departure: '2027-04-04' },
          guests: [{ name: 'Jamie Smith' }],
          rows: [{ roomType: 'Standard King', rooms: 1, adultsPerRoom: 2, childAges: [], board: 'bb' }],
        }],
      },
      partyMatch: { boundParty: { name: 'Acme Travel', nativeId: '03', kind: 'agency' } },
      preparedRateRun: { rateCode: 'BAR' },
    });
    expect(built.nava.roomType).toEqual(['STKNG']);
    expect(built.nava.agency).toBe('03');
    expect(built.nava.ratePlan).toEqual(['BAR']);
    const wrongRoom = scoreFieldParity(sample({
      source: { roomType: ['Standard King'] }, nava: { roomType: ['SKNG'] },
      truth: { roomType: ['STQN'] }, provenance: { roomType: 'extract' },
    }));
    expect(wrongRoom.fields[0]).toMatchObject({ verdict: 'miss', cause: 'extract' });
  });

  it('attributes a guarantee mismatch to the profile default', () => {
    const result = scoreFieldParity(sample({
      source: {}, nava: { guaranteeType: 'Awaiting Voucher' }, truth: { guaranteeType: 'CCIATA' },
      provenance: { guaranteeType: 'default' },
    }));
    expect(result.fields[0]).toMatchObject({ verdict: 'miss', cause: 'default' });
  });

  it('scores CMS defaults and reports an HMS blank as staff-left-blank', () => {
    const hit = scoreFieldParity(sample({
      source: { cmsSendMail: true, bookerEmail: 'booker@example.test' },
      nava: { cmsSendMail: true, cmsMessageId: '03', bookerEmail: 'booker@example.test' },
      truth: { cmsSendMail: 'Y', cmsMessageId: '03', bookerEmail: 'booker@example.test' },
      provenance: { cmsMessageId: 'default' }, partyBound: true,
    }));
    const blank = scoreFieldParity(sample({
      source: {}, nava: { cmsMessageId: '01' }, truth: { cmsMessageId: '' },
      provenance: { cmsMessageId: 'default' },
    }));
    expect(hit.fields.every((field) => field.verdict === 'hit')).toBe(true);
    expect(blank.fields[0]).toMatchObject({ verdict: 'excluded', cause: 'truth_drift', note: 'staff_left_blank' });
  });

  it('scores room-level values as multisets and keeps a two-room/one-confirmation result partial', () => {
    const result = scoreFieldParity(sample({
      source: { roomType: ['Standard King', 'Standard Twin'] },
      nava: { roomType: ['STWN', 'STKNG'] }, truth: { roomType: ['STKNG'] },
      provenance: { roomType: 'extract' },
    }));
    const roomVerdicts = result.fields.filter((field) => field.field === 'roomType');
    expect(roomVerdicts.map((field) => field.verdict)).toEqual(['hit', 'excluded']);
    expect(aggregateFieldParity([result]).fields.find((field) => field.field === 'roomType'))
      .toMatchObject({ n: 1, hit: 1, excluded: 1 });
  });

  it('normalizes compound, titled, hyphenated, and diacritic surnames', () => {
    expect(normalizeSurname('van der Merwe')).toBe('van der merwe');
    expect(normalizeSurname('Mr J Smith')).toBe('smith');
    expect(normalizeSurname('Dlamini-Nkosi')).toBe('dlamini nkosi');
    expect(normalizeSurname('José Núñez')).toBe('nunez');
  });

  it('prefers the confirmation whose arrival matches when surname has multiple candidates', () => {
    const linked = linkConfirmationCandidates({
      surname: 'Smith', arrival: '2027-04-02', candidates: [
        { confirmationNumber: '123456-1', sameThread: false, truth: { lastname: 'Smith', arrivaldate: '2027-04-04', createdby: 'STAFF' } },
        { confirmationNumber: '654321-1', sameThread: false, truth: { lastname: 'Mr J Smith', arrivaldate: '2027-04-02', createdby: 'STAFF' } },
      ],
    });
    expect(linked.accepted[0]?.confirmationNumber).toBe('654321-1');
  });

  it('excludes Labtest and Nava-created reservations from accepted truth', () => {
    const lab = linkConfirmationCandidates({
      surname: 'Labtest', arrival: '2027-04-02', candidates: [
        { confirmationNumber: '123456-1', sameThread: true, truth: { lastname: 'Labtest', arrivaldate: '2027-04-02', createdby: 'STAFF' } },
      ],
    });
    const nava = linkConfirmationCandidates({
      surname: 'Smith', arrival: '2027-04-02', candidates: [
        { confirmationNumber: '123456-1', sameThread: true, truth: { lastname: 'Smith', arrivaldate: '2027-04-02', createdby: 'NAVAAI' } },
      ],
    });
    expect(lab.excluded).toBe('labtest');
    expect(nava.excluded).toBe('nava_created');
  });

  it('leaves surname matches unlinked when no confirmation arrives within three days', () => {
    const linked = linkConfirmationCandidates({
      surname: 'Smith', arrival: '2027-04-02', candidates: [
        { confirmationNumber: '123456-1', sameThread: true, truth: { lastname: 'Smith', arrivaldate: '2027-04-06', createdby: 'STAFF' } },
      ],
    });
    expect(linked.accepted).toEqual([]);
    expect(linked.reason).toBe('unlinked');
  });
});

import { describe, expect, it } from 'vitest';
import { assertHmsCreatePlanQuote, assertOneRoomCaseScope, prepareHmsCreatePlanInput } from '../src/ai/hms-create-plan.js';
import { quoteDigest, type QuoteRevision } from '../src/quote-proposal/quote-revision.js';
import { CASE_READ, CASE_STAY_ID, PLAN_NOW, quotedPlanFixture } from './helpers/hms-create-plan-fixture.js';

function rehash(revision: QuoteRevision): QuoteRevision {
  const { id: _id, ...data } = revision;
  return { ...data, id: `quote:${quoteDigest(data)}` };
}

describe('one-room HMS create plan contract', () => {
  it('refuses a case with another displayed room or an unknown case read', () => {
    expect(() => assertOneRoomCaseScope(CASE_READ, {}, CASE_STAY_ID)).not.toThrow();
    expect(() => assertOneRoomCaseScope(null, {}, CASE_STAY_ID)).toThrow('case_scope_unverified');
    expect(() => assertOneRoomCaseScope(CASE_READ, {}, 'arbitrary-room')).toThrow('case_room_identity_changed');
    expect(() => assertOneRoomCaseScope({ ...CASE_READ, stays: [...CASE_READ.stays, CASE_READ.stays[0]] }, {}, CASE_STAY_ID))
      .toThrow('case_multiple_rooms_unsupported');
    expect(() => assertOneRoomCaseScope(CASE_READ, { 'stays[case-stay].rows[case-row].count': 2 }, CASE_STAY_ID))
      .toThrow('case_multiple_rooms_unsupported');
    expect(() => assertOneRoomCaseScope(CASE_READ, { 'stays[case-stay].rows[other].count': 1 }, CASE_STAY_ID))
      .toThrow('case_multiple_rooms_unsupported');
    const multipleGuests = { ...CASE_READ, stays: [{ ...CASE_READ.stays[0]!,
      guests: [{ name: 'One Guest', confirmationNumber: null }, { name: 'Another Guest', confirmationNumber: null }] }] };
    expect(() => assertOneRoomCaseScope(multipleGuests, {}, CASE_STAY_ID)).toThrow('case_multiple_guests_unsupported');
  });

  it('refuses to create when the case identifies an existing reservation or change', () => {
    const stay = CASE_READ.stays[0]!;
    const cases = [
      { ...CASE_READ, confirmationNumbers: ['123456-1'] },
      { ...CASE_READ, stays: [{ ...stay, guests: [{ name: 'Existing Guest', confirmationNumber: '123456-1' }] }] },
      { ...CASE_READ, stays: [{ ...stay, booked: { arrival: '2027-09-10', departure: '2027-09-11' } }] },
      { ...CASE_READ, action: 'amend' },
      { ...CASE_READ, stays: [{ ...stay, action: 'cancel' }] },
    ];
    for (const caseRead of cases) {
      expect(() => assertOneRoomCaseScope(caseRead, {}, CASE_STAY_ID)).toThrow('existing_booking_unsupported');
    }
    expect(() => assertOneRoomCaseScope(CASE_READ, {}, CASE_STAY_ID, 'Booking reference 123456-1'))
      .toThrow('existing_booking_unsupported');
  });

  it('accepts only the matching, fresh native quote with every nightly amount', async () => {
    const { revision, input } = await quotedPlanFixture();
    const parsed = prepareHmsCreatePlanInput.parse(input);
    expect(() => assertHmsCreatePlanQuote(revision, parsed, PLAN_NOW)).not.toThrow();
    expect(revision.groups[0]!.nightly.map((night) => night.amountMinor)).toEqual([10001, 12050]);
    expect(revision.totalMinor).toBe(22051);
    expect(() => assertHmsCreatePlanQuote(revision, parsed, new Date('2026-10-30T12:00:00Z'))).toThrow('quote_expired');
  });

  it.each(['arrival', 'adults', 'childAges', 'roomType', 'ratePlan'] as const)(
    'refuses a changed %s even if the old price remains visible', async (field) => {
      const { revision, input } = await quotedPlanFixture();
      const changed = { ...input.stay, [field]: {
        arrival: '2027-09-13', adults: 1, childAges: [7], roomType: 'SKNG', ratePlan: 'BARRO',
      }[field] };
      const parsed = prepareHmsCreatePlanInput.parse({ ...input, stay: changed });
      expect(() => assertHmsCreatePlanQuote(revision, parsed, PLAN_NOW)).toThrow('quote_scope_changed');
    },
  );

  it('refuses altered quote evidence and inconsistent rehashed nightly totals', async () => {
    const { revision, input } = await quotedPlanFixture();
    const changed = structuredClone(revision);
    changed.groups[0]!.nightly[0]!.amountMinor = 1;
    expect(() => assertHmsCreatePlanQuote(changed, prepareHmsCreatePlanInput.parse(input), PLAN_NOW)).toThrow('quote_invalid');
    const inconsistent = rehash(changed);
    expect(() => assertHmsCreatePlanQuote(inconsistent,
      prepareHmsCreatePlanInput.parse({ ...input, revisionId: inconsistent.id }), PLAN_NOW)).toThrow('quote_prices_unverified');
  });

  it('binds agency to the quoted native ID and refuses unverified company create', async () => {
    const { revision, input } = await quotedPlanFixture();
    const revised = structuredClone(revision);
    revised.groups[0]!.context = { agency: { id: 'ag-1', name: 'Example Agency' } };
    const withAgency = rehash(revised);
    const base = { ...input, revisionId: withAgency.id,
      stay: { ...input.stay, bookingAgency: { nativeId: 'ag-1', name: 'Example Agency' } } };
    expect(() => assertHmsCreatePlanQuote(withAgency, prepareHmsCreatePlanInput.parse(base), PLAN_NOW)).not.toThrow();
    expect(() => assertHmsCreatePlanQuote(withAgency, prepareHmsCreatePlanInput.parse({
      ...base, stay: { ...base.stay, bookingAgency: { nativeId: 'ag-2', name: 'Example Agency' } },
    }), PLAN_NOW)).toThrow('agency_scope_changed');
    expect(() => assertHmsCreatePlanQuote(withAgency, prepareHmsCreatePlanInput.parse({
      ...base, stay: { ...base.stay, organization: { nativeId: 'co-1', name: 'Example Company' } },
    }), PLAN_NOW)).toThrow('company_create_unverified');
  });

  it('rejects sends, recipients, unknown actions and a blank CMS choice instead of dropping them', async () => {
    const { input } = await quotedPlanFixture();
    for (const stay of [
      { ...input.stay, confirmationRecipient: { mode: 'self', address: 'staff@example.invalid' } },
      { ...input.stay, confirmationSendMail: true },
      { ...input.stay, nativeAddOns: [{ id: 'unobserved' }] },
      { ...input.stay, cmsMessageId: '' },
    ]) expect(prepareHmsCreatePlanInput.safeParse({ ...input, stay }).success).toBe(false);
    expect(prepareHmsCreatePlanInput.safeParse({ ...input, parentStayId: 'room0' }).success).toBe(false);
    expect(prepareHmsCreatePlanInput.safeParse({ ...input, stay: { ...input.stay, confirmationSendMail: false } }).success).toBe(true);
  });
});

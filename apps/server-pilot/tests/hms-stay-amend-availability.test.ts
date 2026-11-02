import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ readQuote: vi.fn() }));
vi.mock('../tooling/hms-cloud/quote-read.mjs', () => ({ readQuote: mocks.readQuote }));
import { prepareStayAmendmentAvailability, readStayAmendmentAvailability } from '../tooling/hms-cloud/guest-stay-amend-availability.mjs';

const input = () => ({
  existing: { propertyCode: 'HRCEN', arrival: '2027-03-15', departure: '2027-03-17', roomType: 'STQN', ratePlan: 'BAR' },
  change: { departure: '2027-03-18', roomType: 'DLX', ratePlan: 'CORP' },
  occupancy: { adults: 2, childAges: [8] },
  partyContext: { group: null, organization: '42', bookingAgency: null },
  roomQuantity: 1,
});

describe('saved stay amendment availability', () => {
  beforeEach(() => vi.resetAllMocks());

  it('constructs the proposed scenario with explicit occupants, parties and room quantity', () => {
    const request = input();
    const result = prepareStayAmendmentAvailability(request);
    expect(result).toMatchObject({ outcome: 'prepared', changedFields: ['departure', 'roomType', 'ratePlan'],
      savedPreimage: 'caller_supplied_unverified', saveEligible: false, roomQuantity: 1,
      criteria: { propertyCode: 'HRCEN', arrivalDate: '2027-03-15', departureDate: '2027-03-18',
        adults: 2, childAges: [8], roomTypes: ['DLX'], ratePlans: ['CORP'], partyContext: { organization: '42' } } });
    request.occupancy.childAges[0] = 3;
    expect(result.criteria.childAges).toEqual([8]);
  });

  it('rejects unknown or inconsistent stay and change inputs', () => {
    for (const change of [{}, { arrival: '2027-02-30' }, { arrival: '2027-03-17' },
      { roomType: '' }, { propertyCode: 'HRDAV' }, { roomType: 'STQN' }]) {
      expect(prepareStayAmendmentAvailability({ ...input(), change }).outcome).toBe('input_gap');
    }
    expect(prepareStayAmendmentAvailability({ ...input(), existing: { ...input().existing, ratePlan: '' } }).issue)
      .toBe('EXISTING_STAY_REQUIRED');
  });

  it('accepts native codes beyond the saved-stage guard without accepting list delimiters', () => {
    const request = input();
    request.change = { ...request.change, roomType: 'DLX_KING', ratePlan: 'CORPORATE-RATE-WITH-A-LONG-NAME' };
    expect(prepareStayAmendmentAvailability(request)).toMatchObject({ outcome: 'prepared',
      criteria: { roomTypes: ['DLX_KING'], ratePlans: ['CORPORATE-RATE-WITH-A-LONG-NAME'] } });
    request.change.ratePlan = 'BAR,OTHER';
    expect(prepareStayAmendmentAvailability(request).issue).toBe('AMEND_CHANGE_INVALID');
  });

  it('does not infer absent child ages, room counts or party identities', () => {
    expect(prepareStayAmendmentAvailability({ ...input(), occupancy: { adults: 2 } }).issue).toBe('OCCUPANCY_REQUIRED');
    expect(prepareStayAmendmentAvailability({ ...input(), roomQuantity: 0 }).issue).toBe('ROOM_QUANTITY_REQUIRED');
    expect(prepareStayAmendmentAvailability({ ...input(), partyContext: { organization: '42' } }).issue).toBe('PARTY_CONTEXT_REQUIRED');
    expect(prepareStayAmendmentAvailability({ ...input(), partyContext: { ...input().partyContext, group: '' } }).issue).toBe('PARTY_CONTEXT_REQUIRED');
  });

  it('runs the quote reader with the exact proposed criteria and preserves unknowns', async () => {
    const result = { outcome: 'ok', snapshotPath: '/private/quote.json', view: { options: [], coverage: { missingRows: 'unknown' } } };
    mocks.readQuote.mockResolvedValue(result);
    const page = {};
    const response = await readStayAmendmentAvailability(page, input(), { snapshotPath: '/private/quote.json' });
    expect(mocks.readQuote).toHaveBeenCalledWith(page, { criteria: response.prepared.criteria, roomQuantity: 1,
      snapshotPath: '/private/quote.json', view: { nightLimit: 31 } });
    expect(response).toMatchObject({ outcome: 'ok', availability: result.view, saveEligible: false,
      pricing: { repricing: 'not_verified', tax: 'unknown', inventory: 'not_verified', quote: 'not_produced' } });
  });

  it('propagates unavailable search without interpreting it as no availability', async () => {
    mocks.readQuote.mockResolvedValue({ outcome: 'criteria_unavailable', issue: 'PARTY_NOT_SELECTED', snapshotPath: '/private/a.json', view: { options: [] } });
    expect(await readStayAmendmentAvailability({}, input(), { snapshotPath: '/private/a.json' })).toMatchObject({
      outcome: 'criteria_unavailable', issue: 'PARTY_NOT_SELECTED', saveEligible: false,
    });
    mocks.readQuote.mockResolvedValueOnce({ outcome: 'execution_failure', stage: 'setting_criteria', issue: 'PARTY_SELECTION_NOT_VERIFIED' });
    expect(await readStayAmendmentAvailability({}, input(), { snapshotPath: '/private/a.json' })).toMatchObject({
      outcome: 'execution_failure', stage: 'setting_criteria', issue: 'PARTY_SELECTION_NOT_VERIFIED', saveEligible: false,
    });
    mocks.readQuote.mockClear();
    expect((await readStayAmendmentAvailability({}, input(), { snapshotPath: '' })).issue).toBe('PRIVATE_SNAPSHOT_PATH_REQUIRED');
    expect(mocks.readQuote).not.toHaveBeenCalled();
  });
});

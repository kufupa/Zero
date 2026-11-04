import { describe, expect, it } from 'vitest';
import { projectCloudAvailability, runCloudAvailability, type CloudAvailabilityGroupRead } from '../src/ai/hms-cloud-availability-reader.js';
import { CENTURION_HMS_READ_TARGET } from '../src/hms/hms-read-target.js';
import { buildCloudRateCandidates } from '../src/ai/rate-options.js';
import type { RateContext } from '../src/ai/hms-availability.js';

const request = {
  kind: 'availability' as const,
  arrival: '2027-01-10',
  departure: '2027-01-12',
  rooms: [{ roomType: 'Superior', quantity: 2, adults: 2, childAges: [] }],
};

function readView(displayedTextStatus: string = 'captured', datesMatch = true) {
  return {
    outcome: 'ok',
    observedAt: '2026-11-02T10:00:00.000Z',
    roomQuantity: { requested: 2, basis: 'one_room_type_per_night', combinedAvailability: 'unknown' },
    coverage: {
      roomCatalog: { complete: true, loaded: 9, total: 9 },
      rateCatalog: { complete: false, loaded: 50, total: 95 },
      checkedCriteriaMatch: { property: true, dates: datesMatch, occupancy: true, partyContext: true, roomTypes: true, ratePlans: true },
      page: { returned: 1, nextOffset: null },
      nights: { total: 2, returned: 2, nextOffset: null, matchesAppliedCriteria: true },
    },
    options: [{
      room: { code: 'SUP', label: 'Superior' },
      rate: { code: 'BAR', label: 'Best Available', promotioncode: 'PROMO-A' },
      category: 'positive_stock',
      reasons: [],
      nights: [
        { date: '2027-01-10', roomsAvailable: 3, reasons: [], price: { responseValue: '1250.00', currency: 'ZAR', displayedTextStatus } },
        { date: '2027-01-11', roomsAvailable: 0, reasons: [] as string[], price: { responseValue: '1250.00', currency: 'ZAR', displayedTextStatus } },
      ],
    }],
  };
}

describe('Cloud HMS read result projection', () => {
  it('labels nightly observations as estimates and leaves totals and entitlements unknown', () => {
    const reads: CloudAvailabilityGroupRead[] = [{ outcome: 'ok', view: readView() }];
    const result = projectCloudAvailability(request, reads);
    expect(result.outcome).toBe('read');
    if (result.outcome !== 'read') throw new Error('expected read result');
    expect(result.priceEvidence).toEqual({
      label: 'estimate',
      priceBasis: 'unknown',
      quantityBasis: 'unknown',
      comparisonBasis: 'one_room_type_per_night',
      combinedAvailability: 'unknown',
      tax: 'unknown',
      officialTotal: 'unknown',
      contractRate: 'unknown',
    });
    expect(result.searchOutcome).toBe('partial');
    expect(result.groups[0]?.id).toBe('group-1');
    expect(result.coverage.truncated).toBe(true);
    expect(result.groups[0]?.options[0]?.availability).toBe('unknown');
    expect(result.groups[0]?.options[0]?.rateScope).toBe('unknown');
    expect(result.groups[0]?.options[0]?.promotionCode).toBe('PROMO-A');
    expect(result.groups[0]?.options[0]?.nightly).toEqual([
      expect.objectContaining({
        date: '2027-01-10', availableCount: 3, requestedCount: 2, stockStatus: 'available',
        price: { status: 'known', amount: '1250.00', currency: 'ZAR' },
      }),
      expect.objectContaining({
        date: '2027-01-11', availableCount: 0, requestedCount: 2, stockStatus: 'sold',
        price: { status: 'known', amount: '1250.00', currency: 'ZAR' },
      }),
    ]);
    expect(JSON.stringify(result)).not.toContain('grandTotal');
    expect(JSON.stringify(result)).not.toContain('displayedText');
  });

  it('suppresses options when applied criteria are not verified and retains coverage', () => {
    const view = readView('captured', false);
    const result = projectCloudAvailability(request, [{ outcome: 'ok', view }]);
    expect(result.outcome).toBe('read');
    if (result.outcome !== 'read') throw new Error('expected read result');
    expect(result.groups[0]?.id).toBe('group-1');
    expect(result.groups[0]?.outcome).toBe('criteria_unavailable');
    expect(result.groups[0]?.options).toEqual([]);
    expect(result.groups[0]?.coverage.checkedCriteriaMatch).toEqual({
      property: true, dates: false, occupancy: true, partyContext: true, roomTypes: true, ratePlans: true,
    });
    expect(result.coverage.readGroupCount).toBe(0);
  });

  it('keeps unknown stock unknown and withholds unverified criteria', () => {
    const unknownNight = readView();
    unknownNight.options[0]!.nights[1]!.reasons.push('unknown');
    const observed = projectCloudAvailability(request, [{ outcome: 'ok', view: unknownNight }]);
    expect(observed.outcome).toBe('read');
    if (observed.outcome !== 'read') throw new Error('expected read result');
    expect(observed.groups[0]?.options[0]?.nightly[1]?.stockStatus).toBe('unknown');

    const unchecked = readView();
    unchecked.coverage.checkedCriteriaMatch.partyContext = false;
    const suppressed = projectCloudAvailability(request, [{ outcome: 'ok', view: unchecked }]);
    expect(suppressed.outcome).toBe('read');
    if (suppressed.outcome !== 'read') throw new Error('expected read result');
    expect(suppressed.groups[0]?.outcome).toBe('criteria_unavailable');
    expect(suppressed.groups[0]?.options).toEqual([]);
    expect(suppressed.searchOutcome).toBe('partial');
  });

  it('does not label conditional HMS stock available', () => {
    const conditional = readView();
    conditional.options[0]!.nights[0]!.reasons.push('conditions_present');
    const result = projectCloudAvailability(request, [{ outcome: 'ok', view: conditional }]);
    expect(result.outcome).toBe('read');
    if (result.outcome !== 'read') throw new Error('expected read result');
    expect(result.groups[0]?.options[0]?.nightly[0]).toEqual(expect.objectContaining({
      availableCount: 3, stockStatus: 'unknown', reasons: ['conditions_present'],
    }));
  });

  it('marks a negative native inventory unavailable rather than selectable as unchecked', () => {
    const view = readView();
    view.options[0]!.nights[1]!.roomsAvailable = -1;
    // An unknown price does not erase the independent negative inventory observation.
    view.options[0]!.nights[1]!.reasons = ['negative_stock', 'unknown'];
    const result = projectCloudAvailability(request, [{ outcome: 'ok', view }]);
    if (result.outcome !== 'read') throw new Error('expected read result');
    const context: RateContext = {
      propertyCode: 'HRCEN', workflow: 'amend', arrival: request.arrival, departure: request.departure,
      roomCode: 'SUP', quantity: 2, adults: 2, childAges: [], board: null, currency: 'ZAR',
      agencyId: null, organizationId: null, guestProfileId: null, sourceOfBusiness: null, track: null,
      guaranteeType: null, typedRatePlan: null, savedTarget: null, retainRates: 'no',
    };
    expect(buildCloudRateCandidates(context, result.groups)[0]).toMatchObject({ state: 'unavailable' });
  });

  it('refuses an unsupported target before opening a Cloud session', async () => {
    const result = await runCloudAvailability({
      request, target: { ...CENTURION_HMS_READ_TARGET, origin: 'https://wrong-origin.example' },
    });
    expect(result).toEqual([{ outcome: 'execution_failure', issue: 'CLOUD_READ_TARGET_UNSUPPORTED' }]);
  });

  it('uses the oldest valid observed-group timestamp, or unknown if one is missing', () => {
    const twoGroups = { ...request, rooms: [request.rooms[0]!, { ...request.rooms[0]!, roomType: 'Deluxe' }] };
    const oldView = { ...readView(), observedAt: '2026-10-31T09:00:00.000Z' };
    const recentView = { ...readView(), observedAt: '2026-11-02T10:00:00.000Z' };
    const complete = projectCloudAvailability(twoGroups, [
      { outcome: 'ok', view: oldView }, { outcome: 'ok', view: recentView },
    ]);
    expect(complete.outcome).toBe('read');
    if (complete.outcome !== 'read') throw new Error('expected read result');
    expect(complete.observedAt).toBe('2026-10-31T09:00:00.000Z');

    const untimed = projectCloudAvailability(twoGroups, [
      { outcome: 'ok', view: { ...oldView, observedAt: null } },
      { outcome: 'ok', view: recentView },
    ]);
    expect(untimed.outcome).toBe('read');
    if (untimed.outcome !== 'read') throw new Error('expected read result');
    expect(untimed.groups[0]?.observedAt).toBeNull();
    expect(untimed.observedAt).toBeNull();
  });

  it('keeps same-rate options distinct when HMS supplies promotion codes', () => {
    const view = readView();
    const second = structuredClone(view.options[0]);
    second.rate.promotioncode = 'PROMO-B';
    view.options.push(second);
    const result = projectCloudAvailability(request, [{ outcome: 'ok', view }]);
    expect(result.outcome).toBe('read');
    if (result.outcome !== 'read') throw new Error('expected read result');
    expect(result.groups[0]?.options.map((option) => option.promotionCode)).toEqual(['PROMO-A', 'PROMO-B']);
  });

  it('withholds an uncorrelated displayed price while preserving coverage', () => {
    const result = projectCloudAvailability(request, [{ outcome: 'ok', view: readView('unavailable') }]);
    expect(result.outcome).toBe('read');
    if (result.outcome !== 'read') throw new Error('expected read result');
    expect(result.groups[0]?.options[0]?.nightly[0]?.price).toEqual({
      status: 'unknown', amount: null, currency: null,
    });
    expect(result.groups[0]?.coverage).toEqual(expect.objectContaining({
      rateCatalog: { complete: false, loaded: 50, total: 95 },
    }));
  });

});

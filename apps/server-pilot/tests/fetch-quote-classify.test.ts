import { expect, it } from 'vitest';
import { extractOptions, groupOutcomeFromOptions } from '../tooling/playwright-quote/fetch-quote.mjs';
import { multipleSource } from '../tooling/playwright-quote/fetch-quote-fixtures.mjs';

const hrcenRequest = {
  propertyCode: 'HRCEN',
  arrivalDate: '2026-09-24',
  departureDate: '2026-09-27',
  rooms: [{ quantity: 2, adults: 1, children: 0, childAges: [] }],
};

it('keeps HRCEN BAR public and verified on existing fixtures', () => {
  const fixture = multipleSource();
  const result = extractOptions(hrcenRequest, hrcenRequest.rooms[0], [
    { data: fixture.data, calendar: fixture.calendar },
  ]);
  expect(result.options.length).toBeGreaterThan(0);
  for (const option of result.options) {
    expect(option.rate.code).toBe('BAR');
    expect(option.rateScope).toBe('public');
    expect(option.eligibility).toBe('verified');
  }
});

it('classifies an HRDAV wholesale BWS1B row with agency context as contextual and verified', () => {
  // Codes/labels from HRDAV observedStrategyRatePlans.WS (wholesale-shop.png,
  // docs/research/2026-10-25-hrdav-dom-read.md). Amounts are fixture, not live prices.
  const open = {
    israteavailable: true,
    restricted: false,
    combClosed: false,
    combClosedToArrival: false,
    combClosedToDeparture: false,
    combMinLOSToArrival: 0,
    combMinLOSToDeparture: 0,
    combMaxLOSToArrival: null,
    combMaxLOSToDeparture: null,
    combMinLOSToThrough: null,
    combMaxLOSToThrough: null,
  };
  const columns = Object.fromEntries([1, 2].map((n) => [`col${n}`, { ...open, value: 2500 }]));
  const stay = {
    propertyCode: 'HRDAV',
    arrivalDate: '2027-02-16',
    departureDate: '2027-02-17',
    rooms: [{ quantity: 1, adults: 1, children: 0, childAges: [] }],
    search: { salesStrategy: 'Wholesale' },
    rateContext: { agency: { name: 'Example Agency' } },
  };
  const data = {
    datesList: ['02/16/2027', '02/17/2027'],
    children: [{
      isprop: true,
      issummary: false,
      code: 'HRDAV',
      currency: 'ZAR',
      children: [{
        code: 'STKNG',
        desc: 'Standard King',
        buildingCode: null,
        children: [{
          code: 'BWS1B',
          desc: 'Wholesale Best Available Rate 1',
          currency: 'ZAR',
          isNegotiatedRate: false,
          restricted: false,
          minLOS: null,
          maxLOS: null,
          minLeadTime: null,
          maxLeadTime: null,
          haspolicies: true,
          columns,
        }],
        columns: Object.fromEntries([1, 2].map((n) => [`col${n}`, { value: 84 }])),
      }],
    }],
  };
  const calendar = {
    headers: ['16-FEB-2027Tuesday', '17-FEB-2027Wednesday'],
    options: [{
      room: { code: 'STKNG', inventory: ['84', '84'] },
      rate: 'BWS1B: Wholesale Best Available Rate 1',
      board: 'Bed & Breakfast NR',
      prices: ['R2,500.00', 'R2,500.00'],
    }],
  };
  const result = extractOptions(
    stay,
    stay.rooms[0],
    [{ data, calendar, criteria: { salesStrategy: 'WS', travelAgencyID: '23' } }],
    { agency: { id: '23' } },
  );
  const option = result.options.find((row) => row.rate.code === 'BWS1B');
  expect(option?.rateScope).toBe('contextual');
  expect(option?.eligibility).toBe('verified');
  expect(option?.matchStatus).toBe('match');
});

it('does not verify an HRDAV wholesale row from company context alone', () => {
  const open = {
    israteavailable: true,
    restricted: false,
    combClosed: false,
    combClosedToArrival: false,
    combClosedToDeparture: false,
    combMinLOSToArrival: 0,
    combMinLOSToDeparture: 0,
    combMaxLOSToArrival: null,
    combMaxLOSToDeparture: null,
    combMinLOSToThrough: null,
    combMaxLOSToThrough: null,
  };
  const columns = Object.fromEntries([1, 2].map((n) => [`col${n}`, { ...open, value: 2500 }]));
  const stay = {
    propertyCode: 'HRDAV',
    arrivalDate: '2027-02-16',
    departureDate: '2027-02-17',
    rooms: [{ quantity: 1, adults: 1, children: 0, childAges: [] }],
    search: { salesStrategy: 'Wholesale' },
    rateContext: { organization: { name: 'Example Company' } },
  };
  const data = {
    datesList: ['02/16/2027', '02/17/2027'],
    children: [{
      isprop: true,
      issummary: false,
      code: 'HRDAV',
      currency: 'ZAR',
      children: [{
        code: 'STKNG',
        desc: 'Standard King',
        buildingCode: null,
        children: [{
          code: 'BWS1B',
          desc: 'Wholesale Best Available Rate 1',
          currency: 'ZAR',
          isNegotiatedRate: false,
          restricted: false,
          minLOS: null,
          maxLOS: null,
          minLeadTime: null,
          maxLeadTime: null,
          haspolicies: true,
          columns,
        }],
        columns: Object.fromEntries([1, 2].map((n) => [`col${n}`, { value: 84 }])),
      }],
    }],
  };
  const calendar = {
    headers: ['16-FEB-2027Tuesday', '17-FEB-2027Wednesday'],
    options: [{
      room: { code: 'STKNG', inventory: ['84', '84'] },
      rate: 'BWS1B: Wholesale Best Available Rate 1',
      board: 'Bed & Breakfast NR',
      prices: ['R2,500.00', 'R2,500.00'],
    }],
  };
  const result = extractOptions(
    stay,
    stay.rooms[0],
    [{ data, calendar, criteria: { salesStrategy: 'WS', organizationID: '1' } }],
    { organization: { id: '1' } },
  );
  const option = result.options.find((row) => row.rate.code === 'BWS1B');
  expect(option?.rateScope).toBe('contextual');
  expect(option?.eligibility).not.toBe('verified');
  expect(option?.matchStatus).toBe('unresolved');
});

it('verifies public BAR/PROMO rows on a two-group shop and keeps unbound WS conditional', () => {
  const open = {
    israteavailable: true,
    restricted: false,
    combClosed: false,
    combClosedToArrival: false,
    combClosedToDeparture: false,
    combMinLOSToArrival: 0,
    combMinLOSToDeparture: 0,
    combMaxLOSToArrival: null,
    combMaxLOSToDeparture: null,
    combMinLOSToThrough: null,
    combMaxLOSToThrough: null,
  };
  const columns = Object.fromEntries([1, 2].map((n) => [`col${n}`, { ...open, value: 2500 }]));
  const windowFor = (room: string, rates: { code: string; desc: string }[], strategy: string) => ({
    data: {
      datesList: ['02/07/2027', '02/08/2027'],
      children: [{
        isprop: true,
        issummary: false,
        code: 'HRDAV',
        currency: 'ZAR',
        children: [{
          code: room,
          desc: room,
          buildingCode: null,
          children: rates.map((row) => ({
            code: row.code,
            desc: row.desc,
            currency: 'ZAR',
            isNegotiatedRate: false,
            restricted: false,
            minLOS: null,
            maxLOS: null,
            minLeadTime: null,
            maxLeadTime: null,
            haspolicies: true,
            columns,
          })),
          columns: Object.fromEntries([1, 2].map((n) => [`col${n}`, { value: 84 }])),
        }],
      }],
    },
    calendar: {
      headers: ['07-FEB-2027Sunday', '08-FEB-2027Monday'],
      options: rates.map((row) => ({
        room: { code: room, inventory: ['84', '84'] },
        rate: `${row.code}: ${row.desc}`,
        board: 'Bed & Breakfast NR',
        prices: ['R2,500.00', 'R2,500.00'],
      })),
    },
    criteria: { salesStrategy: strategy },
  });
  const mixed = [
    { code: 'BAR', desc: 'Best Available Rate' },
    { code: 'BWS1B', desc: 'Wholesale Best Available Rate 1' },
  ];
  const groups = [{ id: 'g1', room: 'STKNG' }, { id: 'g2', room: 'STWN' }];
  const wholesale = {
    propertyCode: 'HRDAV',
    arrivalDate: '2027-02-07',
    departureDate: '2027-02-08',
    details: 'summary' as const,
    rooms: groups.map((group) => ({
      id: group.id,
      quantity: group.id === 'g1' ? 1 : 2,
      adults: group.id === 'g1' ? 2 : 1,
      children: 0,
      childAges: [],
    })),
    search: { salesStrategy: 'Wholesale' },
    rateContext: { agency: { name: 'Example Agency' } },
  };
  for (const group of groups) {
    const result = extractOptions(
      wholesale,
      wholesale.rooms.find((room) => room.id === group.id)!,
      [{ ...windowFor(group.room, mixed, 'WS') }],
      {},
    );
    const bar = result.options.find((row) => row.rate.code === 'BAR');
    const ws = result.options.find((row) => row.rate.code === 'BWS1B');
    expect(bar?.rateScope).toBe('public');
    expect(bar?.eligibility).toBe('verified');
    expect(bar?.matchStatus).toBe('match');
    expect(ws?.rateScope).toBe('contextual');
    expect(ws?.eligibility).toBe('conditional');
    expect(ws?.matchStatus).toBe('unresolved');
    const grouped = groupOutcomeFromOptions(result.options, { details: 'summary', searchComplete: true });
    expect(grouped.outcome).toBe('quote');
    expect(grouped.requiredFacts).toBe('complete');
    expect(grouped.eligible.some((row) => row.rate.code === 'BAR')).toBe(true);
    expect(grouped.eligible.some((row) => row.rate.code === 'BWS1B')).toBe(false);
  }
  const promotions = { ...wholesale, search: { salesStrategy: 'Promotions' }, rateContext: undefined };
  const promo = extractOptions(promotions, promotions.rooms[0], [
    windowFor('STKNG', [{ code: 'BAR', desc: 'Best Available Rate' }, { code: 'PMO1B', desc: 'Promotion Breakfast' }], 'PROMO'),
  ]);
  expect(promo.options.find((row) => row.rate.code === 'BAR')?.rateScope).toBe('public');
  expect(promo.options.find((row) => row.rate.code === 'BAR')?.eligibility).toBe('verified');
  expect(promo.options.find((row) => row.rate.code === 'PMO1B')?.rateScope).toBe('unknown');
  expect(promo.options.find((row) => row.rate.code === 'PMO1B')?.eligibility).toBe('conditional');
  const barShop = { ...wholesale, search: { salesStrategy: 'BAR' }, rateContext: { organization: { name: 'Example Company' } } };
  const crossed = extractOptions(
    barShop,
    barShop.rooms[0],
    [{ ...windowFor('STKNG', mixed, 'BAR'), criteria: { salesStrategy: 'BAR', organizationID: '1' } }],
    { organization: { id: '1' } },
  );
  expect(crossed.options.find((row) => row.rate.code === 'BAR')?.eligibility).toBe('verified');
  expect(crossed.options.find((row) => row.rate.code === 'BWS1B')?.eligibility).toBe('conditional');
  expect(crossed.options.find((row) => row.rate.code === 'BWS1B')?.matchStatus).toBe('unresolved');
});

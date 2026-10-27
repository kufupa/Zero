import { expect, it } from 'vitest';
import { extractOptions } from '../tooling/playwright-quote/fetch-quote.mjs';
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

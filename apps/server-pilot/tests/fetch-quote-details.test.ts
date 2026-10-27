import { expect, it } from 'vitest';
import {
  detailCandidates,
  detailReadBudgetMs,
  extractOptions,
  groupOutcomeFromOptions,
  stayDates,
  unreadDetails,
} from '../tooling/playwright-quote/fetch-quote.mjs';

it('keeps a 17-row wholesale full read as quote when unread leftover rows stay in evidence', () => {
  expect(detailReadBudgetMs({})).toBe(90_000);
  expect(detailCandidates('full', Array.from({ length: 17 }, (_, i) => ({ id: String(i) }))).length).toBe(17);
  const wsPlans = [
    'BWS1B', 'BWS2B', 'BWS3B', 'NG139B', 'NGD73B', 'NGD77B', 'NGD90B',
    'NGDS1B', 'NGDS2B', 'NGDS8B', 'NGDTSB', 'WSF1B', 'WSF2B', 'WSF3B',
    'WSG5B', 'WSG5DB', 'BWS4B',
  ];
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
    details: 'full',
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
        children: wsPlans.map((code) => ({
          code,
          desc: `Wholesale ${code}`,
          currency: 'ZAR',
          isNegotiatedRate: code === 'BWS4B',
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
  };
  const calendar = {
    headers: ['16-FEB-2027Tuesday', '17-FEB-2027Wednesday'],
    options: wsPlans.map((code) => ({
      room: { code: 'STKNG', inventory: ['84', '84'] },
      rate: `${code}: Wholesale ${code}`,
      board: 'Bed & Breakfast NR',
      prices: ['R2,500.00', 'R2,500.00'],
    })),
  };
  const result = extractOptions(
    stay,
    stay.rooms[0],
    [{ data, calendar, criteria: { salesStrategy: 'WS', travelAgencyID: '23' } }],
    { agency: { id: '23' } },
  );
  expect(result.options).toHaveLength(17);
  const nights = stayDates(stay);
  for (const [index, option] of result.options.entries()) {
    option.details = index < 3
      ? { status: 'complete', nightly: nights.map((date: string) => ({ date })) }
      : unreadDetails();
  }
  const grouped = groupOutcomeFromOptions(result.options, { details: 'full', searchComplete: true });
  expect(grouped.outcome).toBe('quote');
  expect(grouped.requiredFacts).toBe('complete');
  expect(grouped.eligible).toHaveLength(3);
  expect(result.options.filter((option: { details: { status: string } }) => option.details.status === 'not_read')).toHaveLength(14);
});

import { describe, expect, it } from 'vitest';
import {
  buildPreparedStaffQuotePlan,
  quoteShopJobsForPlan,
} from '../src/ai/quote-ready.js';
import {
  buildStaffRatePick,
  rankQuoteSalesStrategies,
  staffRatePickEvidence,
  type LoggedStaffRatePick,
} from '../src/ai/staff-rate-pick-history.js';
import { quoteSalesStrategiesFromRegistry } from '../src/hms/rate-catalogue.js';
import { PROPERTY_REGISTRY } from '../tooling/playwright-quote/property-registry.mjs';

const messageId = 'quote-rate-order-1';
const sourceHash = 'a'.repeat(64);

function stayRow(id: string, arrival: string, departure: string, board: 'dbb' | null = null) {
  return {
    id,
    hotel: null,
    requested: { arrival, departure },
    booked: null,
    totalRooms: 1,
    rows: [
      {
        id: `${id}-row`,
        roomType: 'SKNG',
        rooms: 1,
        adultsPerRoom: 2,
        childAges: [],
        board,
      },
    ],
  };
}

function plan(stays: ReturnType<typeof stayRow>[]) {
  return buildPreparedStaffQuotePlan({
    messageId,
    sourceHash,
    payload: {
      origin: 'person',
      agency: null,
      endClient: null,
      contact: { name: null, email: null, phone: null },
      confirmationNumbers: [],
      stays,
      missing: [],
    },
    now: new Date('2026-10-14T12:00:00.000Z'),
  });
}

function registeredProfiles() {
  return PROPERTY_REGISTRY.properties.filter((property) => property.active && property.profileFile);
}

function pick(input: {
  strategy: string;
  property: string;
  transportId: string;
  at: Date;
  agencyNativeId?: string;
  companyNativeId?: string;
}): LoggedStaffRatePick {
  const built = buildStaffRatePick({
    strategy: input.strategy,
    property: input.property,
    transportId: input.transportId,
    actorUserId: 'staff-actor-1',
    mailKind: 'quote',
    parties: input.agencyNativeId
      ? { agency: { kind: 'agency', nativeId: input.agencyNativeId, name: 'ignored' } }
      : input.companyNativeId
        ? { company: { kind: 'company', nativeId: input.companyNativeId, name: 'ignored' } }
        : undefined,
  });
  if (!built) throw new Error('staff_rate_pick_invalid');
  return { ...built, at: input.at };
}

describe('quote-ready rate order from staff pick history', () => {
  it('ranks a property × strategy × stay matrix of nine configured choices and retains all of them', () => {
    const registered = registeredProfiles();
    expect(registered.length).toBeGreaterThan(0);

    const twoStays = plan([
      stayRow('stay-1', '2026-10-20', '2026-10-23'),
      stayRow('stay-2', '2026-10-24', '2026-10-27'),
    ]);
    expect(twoStays.inputs).toHaveLength(2);

    const nine = registered
      .map((property) => ({
        property,
        strategies: quoteSalesStrategiesFromRegistry(property.propertyCode, null),
      }))
      .find((row) => row.strategies.length === 9);
    expect(nine, 'a registered profile lists nine strategies').toBeTruthy();
    const { property, strategies } = nine!;
    const codes = strategies.map((strategy) => strategy.code);
    expect(new Set(codes).size).toBe(9);

    expect(quoteShopJobsForPlan(twoStays, [])).toEqual([]);
    expect(quoteSalesStrategiesFromRegistry('NOTAPROP', null)).toEqual([]);
    expect(
      quoteShopJobsForPlan(twoStays, quoteSalesStrategiesFromRegistry('NOTAPROP', [{ value: 'BAR', display: 'BAR' }])),
    ).toEqual([]);

    for (const row of registered) {
      const configured = quoteSalesStrategiesFromRegistry(row.propertyCode, null);
      expect(configured.length, `${row.propertyCode} has configured strategies`).toBeGreaterThan(0);
      const jobs = quoteShopJobsForPlan(twoStays, configured);
      expect(jobs).toHaveLength(configured.length * 2);
      const requestValues = configured.map((strategy) => strategy.requestValue);
      expect(jobs.map((job) => job.input.salesStrategy)).toEqual(
        requestValues.flatMap((value) => [value, value]),
      );
      for (const stay of twoStays.inputs) {
        const stayJobs = jobs.filter((job) => job.input.groups[0]?.id === stay.groups[0]?.id);
        expect(stayJobs.map((job) => job.input.salesStrategy)).toEqual(requestValues);
      }
    }

    const dbbPlan = plan([stayRow('stay-dbb', '2026-10-20', '2026-10-23', 'dbb')]);
    expect(dbbPlan.inputs[0]?.groups[0]?.board).toBe('dinner_bb');
    const dbbJobs = quoteShopJobsForPlan(dbbPlan, strategies);
    expect(dbbJobs).toHaveLength(9);
    expect(dbbJobs.map((job) => job.input.salesStrategy)).toEqual(strategies.map((strategy) => strategy.requestValue));
    expect(dbbJobs[0]?.input.salesStrategy).not.toBe('Government');

    const otherTransport = property.transportIds.find((id) => id !== property.mailboxTransportId);
    expect(otherTransport, 'nine-strategy property has a second mailbox').toBeTruthy();
    const mailboxPick = pick({
      strategy: 'WS',
      property: property.propertyCode,
      transportId: property.mailboxTransportId,
      at: new Date('2026-10-20T10:00:00.000Z'),
    });
    const partyPick = pick({
      strategy: 'NC',
      property: property.propertyCode,
      transportId: otherTransport!,
      agencyNativeId: 'agency-17',
      at: new Date('2026-10-21T10:00:00.000Z'),
    });
    const ranked = rankQuoteSalesStrategies(strategies, {
      property: property.propertyCode,
      transportId: property.mailboxTransportId,
      partyRef: { agencyNativeId: 'agency-17' },
      picks: [mailboxPick, partyPick],
    });
    expect(ranked.map((strategy) => strategy.code)).toEqual(
      codes.includes('BAR')
        ? ['BAR', 'WS', 'NC', ...codes.filter((code) => code !== 'BAR' && code !== 'WS' && code !== 'NC')]
        : ['WS', 'NC', ...codes.filter((code) => code !== 'WS' && code !== 'NC')],
    );
    expect(ranked).toHaveLength(9);
    expect(new Set(ranked.map((strategy) => strategy.code))).toEqual(new Set(codes));

    const jobs = quoteShopJobsForPlan(twoStays, strategies, {
      property: property.propertyCode,
      transportId: property.mailboxTransportId,
      partyRef: { agencyNativeId: 'agency-17' },
      picks: [mailboxPick, partyPick],
    });
    expect(jobs).toHaveLength(18);
    expect(jobs.map((job) => job.input.salesStrategy).slice(0, 6)).toEqual(
      ranked.slice(0, 3).flatMap((strategy) => [strategy.requestValue, strategy.requestValue]),
    );
    expect(new Set(jobs.map((job) => job.input.salesStrategy))).toEqual(
      new Set(strategies.map((strategy) => strategy.requestValue)),
    );

    const logged = buildStaffRatePick({
      strategy: 'Government',
      property: property.propertyCode,
      transportId: property.mailboxTransportId,
      actorUserId: 'staff-actor-1',
      mailKind: 'quote',
      parties: { agency: { kind: 'agency', nativeId: 'agency-17', name: 'not-stored@example.test' } },
    });
    expect(logged).toMatchObject({
      strategy: 'GOV',
      property: property.propertyCode,
      transportId: property.mailboxTransportId,
      actorUserId: 'staff-actor-1',
      mailKind: 'quote',
      partyRef: { agencyNativeId: 'agency-17' },
    });
    const evidence = staffRatePickEvidence(logged!);
    expect(JSON.stringify(evidence)).not.toMatch(/@|example\.test|not-stored/i);
    expect(evidence).not.toHaveProperty('name');
    expect(evidence).not.toHaveProperty('email');
    expect(buildStaffRatePick({
      strategy: 'WS',
      property: property.propertyCode,
      transportId: property.mailboxTransportId,
      actorUserId: 'staff@hotel.test',
      mailKind: 'quote',
    })).toBeNull();
  });
});

import { readFileSync } from 'node:fs';
import { RequestContext } from '@mastra/core/request-context';
import { describe, expect, it, vi } from 'vitest';
import {
  CENTURION_HOTEL_RULES,
  createDefaultRunners,
  createReservationistAgent,
  createReservationistTools,
  QUOTE_UNAVAILABLE,
  type ReservationistRunners,
} from '../src/ai/reservationist-agent.js';

function fakeRunners(): ReservationistRunners {
  return {
    quote: vi.fn(async () => ({ outcome: 'quote', groups: [] })),
    party: vi.fn(async () => ({ outcome: 'resolved', candidates: [] })),
    pdf: vi.fn(async () => ({ fileName: 'q.pdf', path: '/tmp/q.pdf', bytes: 10 })),
    validateCreate: vi.fn(async () => ({ ok: true, errors: [] })),
  };
}

function ctx(liveQuoteOk: boolean) {
  return new RequestContext<unknown>([
    ['propertyCode', 'HRCEN'],
    ['hotelRules', CENTURION_HOTEL_RULES],
    ['liveQuoteOk', liveQuoteOk],
  ]);
}

const stay = {
  arrivalDate: '2026-10-02',
  departureDate: '2026-10-04',
  rooms: [{ id: 'group-1', quantity: 1, adults: 2, children: 0, childAges: [] }],
};

type Exec = (input: unknown, context: unknown) => Promise<unknown>;
const exec = (tool: { execute?: unknown }) => tool.execute as Exec;

describe('reservationist tools', () => {
  it('changing legacy gold-derived context cannot control quote execution', async () => {
    const runners = fakeRunners();
    const tools = createReservationistTools(runners);
    const first = await exec(tools.quote_stay)(stay, { requestContext: ctx(false) });
    const second = await exec(tools.quote_stay)(stay, { requestContext: ctx(true) });
    expect(first).toEqual(second);
    expect(runners.quote).toHaveBeenCalledTimes(2);
  });

  it('runs a live v2 quote request when liveQuoteOk', async () => {
    const runners = fakeRunners();
    const tools = createReservationistTools(runners);
    const out = await exec(tools.quote_stay)(stay, { requestContext: ctx(true) });
    expect(runners.quote).toHaveBeenCalledWith({
      schemaVersion: 2,
      propertyCode: 'HRCEN',
      ...stay,
      search: { includeRestricted: false, includeAlternatives: true },
    });
    expect(out).toEqual({ outcome: 'quote', groups: [] });
  });

  it('create is a dry-run validation only', async () => {
    const runners = fakeRunners();
    const tools = createReservationistTools(runners);
    const out = await exec(tools.create_reservation_dry_run)(
      { request: { arrivalDate: '2026-10-02' } },
      { requestContext: ctx(true) },
    );
    expect(runners.validateCreate).toHaveBeenCalledWith({ arrivalDate: '2026-10-02' });
    expect(out).toEqual({ dryRun: true, saved: false, ok: true, errors: [] });
  });

  it('real create validator rejects an incomplete request without HMS', async () => {
    const runners = createDefaultRunners({ signer: { name: 'x', email: 'x@y' }, pdfDir: '/tmp' });
    const out = await runners.validateCreate({ arrival: '2026-10-02' });
    expect(out.ok).toBe(false);
    expect(out.errors.length).toBeGreaterThan(0);
  });

  it('never statically imports Playwright or HMS write tooling', () => {
    const src = readFileSync(new URL('../src/ai/reservationist-agent.ts', import.meta.url), 'utf8');
    expect(src).not.toMatch(/^import[^;]*(playwright|stagehand|fetch-quote|create-lab)/m);
  });
});

describe('reservationist agent', () => {
  it('exposes exactly the four tools and hotel rules from request context', async () => {
    const agent = createReservationistAgent({ model: 'openai/gpt-5', runners: fakeRunners() });
    const tools = await agent.listTools();
    expect(Object.keys(tools).sort()).toEqual([
      'create_reservation_dry_run',
      'party_lookup',
      'quote_proposal_pdf',
      'quote_stay',
    ]);
    const instructions = await agent.getInstructions({ requestContext: ctx(false) });
    expect(String(instructions)).toContain('HRCEN');
    expect(String(instructions)).toContain(CENTURION_HOTEL_RULES);
  });
});

import { fileURLToPath, pathToFileURL } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  buildCreatePrefill,
  buildCreatePrefillDescription,
  buildCreatePrefillInputSchema,
  buildCreatePrefillOutputSchema,
} from '../src/ai/aop/create-prefill.js';
import { CREATE_PREFILL_SOP } from '../src/ai/aop/create-prefill-sop.js';
import type { BookingDraftDefaults } from '../src/ai/booking-draft.js';

const CONF = '9999901-1';
const GUEST = 'Proof Labtest';

const COMPLETE_DEFAULTS: BookingDraftDefaults = {
  track: 'BAR',
  sourceOfBusiness: 'Travel Agent',
  guaranteeType: 'Guaranteed By Agent',
};

const NULL_DEFAULTS: BookingDraftDefaults = {
  track: null,
  sourceOfBusiness: null,
  guaranteeType: null,
};

function instructionLines(sop: string): string[] {
  return sop
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !line.startsWith('//'));
}

function stay(over: Record<string, unknown> = {}) {
  return {
    arrival: '2027-09-14',
    departure: '2027-09-16',
    nights: null,
    rooms: [{ adults: 1, childAges: [] as number[], roomTypeText: 'STQN', guestName: GUEST }],
    boardText: null,
    rateText: 'BAR',
    agencyName: 'Northwind Travel',
    organizationName: null,
    voucherNumber: null,
    bookerName: null,
    bookerEmail: null,
    billingReference: null,
    paidBy: 'agency' as const,
    defaults: COMPLETE_DEFAULTS,
    ...over,
  };
}

async function validateCreate(request: Record<string, unknown>) {
  const mod = (await import(
    pathToFileURL(
      fileURLToPath(new URL('../tooling/playwright-quote/create-request.mjs', import.meta.url)),
    ).href
  )) as {
    loadCreateToolSchema(): Promise<unknown>;
    normalizeCreateLabels(data: unknown): unknown;
    validateCreateRequest(
      data: unknown,
      schema: unknown,
    ): { ok: boolean; errors: unknown[] };
  };
  return mod.validateCreateRequest(
    mod.normalizeCreateLabels(request),
    await mod.loadCreateToolSchema(),
  );
}

describe('buildCreatePrefill', () => {
  it('maps an exact enum room type and leaves a non-code as missing', async () => {
    const hit = await buildCreatePrefill(stay({ rooms: [{ adults: 1, childAges: [], roomTypeText: ' stqn ', guestName: GUEST }] }));
    expect(hit.requests[0]).toMatchObject({ roomType: 'STQN' });
    expect(hit.missing.filter((row) => row.field === 'roomType')).toEqual([]);

    const named = await buildCreatePrefill(
      stay({ rooms: [{ adults: 1, childAges: [], roomTypeText: 'Standard Queen', guestName: GUEST }] }),
    );
    expect(named.requests[0]).toMatchObject({ roomType: 'STQN' });
    expect(named.missing.filter((row) => row.field === 'roomType')).toEqual([]);

    const miss = await buildCreatePrefill(
      stay({ rooms: [{ adults: 1, childAges: [], roomTypeText: 'penthouse loft', guestName: GUEST }] }),
    );
    expect(miss.requests[0]).not.toHaveProperty('roomType');
    expect(miss.missing.some((row) => row.field === 'roomType' && /room type/i.test(row.question))).toBe(true);
    expect(miss.todoNextStep).toMatch(/Key into HMS: missing.*roomType/);
  });

  it('derives departure from arrival plus nights when departure is absent', async () => {
    const result = await buildCreatePrefill(stay({ departure: null, nights: 2 }));
    expect(result.requests[0]).toMatchObject({ arrival: '2027-09-14', departure: '2027-09-16' });
  });

  it('builds one create request per room', async () => {
    const result = await buildCreatePrefill(
      stay({
        rooms: [
          { adults: 1, childAges: [], roomTypeText: 'STQN', guestName: GUEST },
          { adults: 2, childAges: [5], roomTypeText: 'STWN', guestName: 'Pat Labtest' },
        ],
      }),
    );
    expect(result.requests).toHaveLength(2);
    expect(result.schemaErrors).toHaveLength(2);
    expect(result.requests[0]).toMatchObject({
      adults: 1,
      roomType: 'STQN',
      firstName: 'Proof',
      lastName: 'Labtest',
    });
    expect(result.requests[1]).toMatchObject({
      adults: 2,
      childAges: [5],
      roomType: 'STWN',
      firstName: 'Pat',
      lastName: 'Labtest',
    });
  });

  it('asks for the guest name when it is missing', async () => {
    const result = await buildCreatePrefill(
      stay({ rooms: [{ adults: 1, childAges: [], roomTypeText: 'STQN', guestName: null }] }),
    );
    expect(result.requests[0]).not.toHaveProperty('firstName');
    expect(result.requests[0]).not.toHaveProperty('lastName');
    expect(result.missing.some((row) => row.field === 'guestName' && /guest name/i.test(row.question))).toBe(
      true,
    );
    expect(result.todoNextStep).toMatch(/Key into HMS: missing.*guestName/);
  });

  it('puts the voucher number on billingReference', async () => {
    const result = await buildCreatePrefill(stay({ voucherNumber: 'VCH-99901' }));
    expect(result.requests[0]).toMatchObject({ billingReference: 'VCH-99901' });
    void CONF;
  });

  it('schema-validates a complete request', async () => {
    const result = await buildCreatePrefill(stay());
    expect(result.missing).toEqual([]);
    expect(result.todoNextStep).toBe('Key into HMS');
    expect(result.requests[0]).toMatchObject({
      arrival: '2027-09-14',
      departure: '2027-09-16',
      adults: 1,
      roomType: 'STQN',
      ratePlan: 'BAR',
      track: 'BAR',
      sourceOfBusiness: 'Travel Agent',
      guaranteeType: 'Guaranteed By Agent',
      firstName: 'Proof',
      lastName: 'Labtest',
      agency: 'Northwind Travel',
    });
    const checked = await validateCreate(result.requests[0]!);
    expect(checked.ok).toBe(true);
    expect(result.schemaErrors[0]).toEqual([]);
  });

  it('records missing defaults instead of inventing enum codes', async () => {
    const result = await buildCreatePrefill(stay({ defaults: NULL_DEFAULTS }));
    expect(result.requests[0]).not.toHaveProperty('track');
    expect(result.requests[0]).not.toHaveProperty('sourceOfBusiness');
    expect(result.requests[0]).not.toHaveProperty('guaranteeType');
    expect(result.missing.map((row) => row.field)).toEqual(
      expect.arrayContaining(['track', 'sourceOfBusiness', 'guaranteeType']),
    );
  });

  it('prefills Walk in / BAR / Non-Guaranteed Individual for a direct booking', async () => {
    const result = await buildCreatePrefill(
      stay({
        agencyName: null,
        organizationName: null,
        paidBy: 'guest',
        defaults: NULL_DEFAULTS,
        rateText: null,
        rooms: [{ adults: 1, childAges: [], roomTypeText: 'Standard Queen', guestName: GUEST }],
      }),
    );
    expect(result.requests[0]).toMatchObject({
      track: 'BAR',
      sourceOfBusiness: 'Walk in',
      guaranteeType: 'Non-Guaranteed Individual',
      ratePlan: 'BAR',
      roomType: 'STQN',
    });
    expect(result.missing.map((row) => row.field)).not.toEqual(
      expect.arrayContaining(['track', 'sourceOfBusiness', 'guaranteeType', 'ratePlan', 'roomType']),
    );
  });

  it('leaves Track and Source empty when an agency or company party is set', async () => {
    const agency = await buildCreatePrefill(stay({ defaults: NULL_DEFAULTS }));
    expect(agency.requests[0]).not.toHaveProperty('track');
    expect(agency.requests[0]).not.toHaveProperty('sourceOfBusiness');
    const company = await buildCreatePrefill(
      stay({ agencyName: null, organizationName: 'Woolworths Holdings', defaults: NULL_DEFAULTS }),
    );
    expect(company.requests[0]).not.toHaveProperty('track');
    expect(company.requests[0]).not.toHaveProperty('sourceOfBusiness');
  });

  it('leaves Track and Source empty when partyKind is set even if the name is missing', async () => {
    const result = await buildCreatePrefill(
      stay({
        agencyName: null,
        organizationName: null,
        paidBy: null,
        partyKind: 'agency',
        defaults: NULL_DEFAULTS,
      }),
    );
    expect(result.requests[0]).not.toHaveProperty('track');
    expect(result.requests[0]).not.toHaveProperty('sourceOfBusiness');
  });

  it('exports schemas and a description ready for createTool', () => {
    expect(buildCreatePrefillInputSchema.parse(stay()).arrival).toBe('2027-09-14');
    expect(
      buildCreatePrefillOutputSchema.parse({
        requests: [{}],
        missing: [{ field: 'roomType', question: 'Room type code for this booking?' }],
        schemaErrors: [['$.roomType required']],
        todoNextStep: 'Key into HMS: missing roomType',
      }).todoNextStep,
    ).toMatch(/missing roomType/);
    expect(buildCreatePrefillDescription).toMatch(/buildCreatePrefill|create-form|none/i);
  });
});

describe('CREATE_PREFILL_SOP', () => {
  it('is a short create-to-do SOP that never invents codes', () => {
    expect(instructionLines(CREATE_PREFILL_SOP).length).toBeLessThanOrEqual(12);
    expect(CREATE_PREFILL_SOP).toMatch(/buildCreatePrefill/);
    expect(CREATE_PREFILL_SOP).toMatch(/todoNextStep/);
    expect(CREATE_PREFILL_SOP).toMatch(/Key into HMS: missing roomType, ratePlan/);
    expect(CREATE_PREFILL_SOP).toMatch(/never invent|do not invent|never guess/i);
    expect(CREATE_PREFILL_SOP).toMatch(/does not pick the workflow/i);
  });

  it('opens with its own entry condition and never overrides rules globally', () => {
    const first = instructionLines(CREATE_PREFILL_SOP)[0] ?? '';
    expect(first).toMatch(/^Applies only when /);
    expect(first).toMatch(/findFirstStayMatch returned none/);
    expect(CREATE_PREFILL_SOP).toMatch(/Otherwise ignore this section/);
    expect(CREATE_PREFILL_SOP).not.toMatch(
      /Never skip|Never other|Overrides |beats |Pick one workflow|This SOP wins/i,
    );
  });
  it('never treats rate prose as a native rate-plan code', async () => {
    const out = await buildCreatePrefill(stay({ rateText: 'Best Available Rate' }));
    expect(out.requests[0]?.ratePlan).toBeUndefined();
    expect(out.missing.some((row) => row.field === 'ratePlan')).toBe(true);
  });
});

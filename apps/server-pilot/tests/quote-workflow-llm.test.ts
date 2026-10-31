import {
  amendmentFromAnalysis,
  analyseQuoteSelection,
  buildQuoteWorkflowPrompt,
  isNonQuoteLunaWorkflow,
  K2_MAPPING,
  mapLlmDecision,
  partyNotGuest,
  QUOTE_WORKFLOW_PROMPT_VERSION,
  quoteWorkflowLlmEnabled,
} from '../src/ai/quote-workflow-llm.js';
import {
  CENTURION_HOTEL_RULES,
  DAVINCI_HOTEL_RULES,
  lunaAnalysisSchema,
  reservationistDecisionSchema,
} from '../src/ai/reservationist-decision.js';
import { aopQuoteInstructions } from '../src/ai/aop-playbook.js';
import type { SyncedQuoteSelection } from '../src/ai/quote-workflow-synced-selection.js';
import type { ModelAdapter, ModelInvokeInput } from '../src/ai/bedrock/adapter.js';
import { LunaModelAdapter } from '../src/ai/bedrock/luna.js';
import { createHash } from 'node:crypto';
import { zodToJsonSchema } from 'zod-to-json-schema';
import { describe, expect, it } from 'vitest';

const group = {
  arrival: '2026-11-12',
  departure: '2026-11-14',
  dateEvidence: null,
  rooms: 2,
  adultsPerRoom: 1,
  childAges: [] as number[],
  board: 'dbb' as const,
  roomPreference: 'twin',
  guestNames: ['Ann Example', 'Bob Example'],
};

function analysis(overrides: Record<string, unknown> = {}) {
  return {
    workflow: 'create_booking',
    flags: [] as string[],
    groups: [group],
    party: { kind: 'organization' as const, name: 'Acme Mining', reference: null },
    rateClaims: [] as unknown[],
    missing: [{ field: 'shuttle', question: 'Confirm shuttle transfer cost' }],
    evidence: [{ field: 'arrival', quote: 'arriving 12 Nov' }],
    tasks: [{ kind: 'create_booking' as const, groupIndexes: [0], note: 'book named guests' }],
    ...overrides,
  };
}

const selection: SyncedQuoteSelection = {
  subject: 'Booking request',
  bodyText: 'Please book 2 rooms for Ann and Bob arriving 12 Nov, leaving 14 Nov.',
  receivedAt: '2026-10-06T08:00:00.000Z',
  preceding: [{ bodyText: 'Earlier: we need rooms in November.' }],
  attachments: [],
};

function fakeAdapter(output: unknown, seen: ModelInvokeInput[] = []): ModelAdapter {
  return {
    async invoke(input) {
      seen.push(input);
      return {
        modelId: 'gpt-6-luna',
        output: output as Record<string, unknown>,
        usage: {
          inputTokens: 1,
          outputTokens: 1,
          totalTokens: 2,
          latencyMs: 1,
          estimatedCostUsd: 0,
          rateTableVersion: 't',
        },
      };
    },
  };
}

describe('reservationistDecisionSchema', () => {
  it('takes amend and cancel as workflows, as the hotel rules tell the model to', () => {
    for (const workflow of ['amend', 'cancel'] as const) {
      const parsed = reservationistDecisionSchema.parse({
        workflow,
        stayAsk: null,
        missing: [],
        replyDraft: '',
        rationale: 'Existing booking.',
      });
      expect(parsed.workflow).toBe(workflow);
    }
  });
});

describe('lunaAnalysisSchema', () => {
  it('reads a confirmation number the model sent as a bare number as text', () => {
    expect(lunaAnalysisSchema.parse(analysis({ workflow: 'cancel', confirmationNumber: 57291630 })).confirmationNumber).toBe(
      '57291630',
    );
  });

  it('accepts rooms_only_group as an info flag', () => {
    expect(lunaAnalysisSchema.parse(analysis({ flags: ['rooms_only_group'] })).flags).toEqual([
      'rooms_only_group',
    ]);
  });

  it('accepts quote and booking workflows and rejects a ninth task', () => {
    expect(lunaAnalysisSchema.parse(analysis()).workflow).toBe('create_booking');
    expect(lunaAnalysisSchema.parse(analysis({ workflow: 'quote' })).workflow).toBe('quote');
    const nine = Array.from({ length: 9 }, () => ({
      kind: 'quote' as const,
      groupIndexes: [0],
      note: 'x',
    }));
    expect(() => lunaAnalysisSchema.parse(analysis({ tasks: nine }))).toThrow();
  });

  it('keeps optional todoTarget and still parses old payloads without it', () => {
    expect(lunaAnalysisSchema.parse(analysis()).todoTarget).toBeUndefined();
    expect(
      lunaAnalysisSchema.parse(analysis({ workflow: 'hms_todo', todoTarget: 'create' })).todoTarget,
    ).toBe('create');
  });

  it('accepts amend and cancel workflows, with amendment fields optional for old payloads', () => {
    expect(lunaAnalysisSchema.parse(analysis({ workflow: 'amend' })).workflow).toBe('amend');
    expect(lunaAnalysisSchema.parse(analysis({ workflow: 'cancel' })).workflow).toBe('cancel');
    expect(lunaAnalysisSchema.parse(analysis({ workflow: 'amend' })).confirmationNumber).toBe(
      undefined,
    );
  });

  it('keeps the amendment fields the model sends', () => {
    expect(
      lunaAnalysisSchema.parse(
        analysis({
          workflow: 'amend',
          confirmationNumber: '57291630-1',
          guestLastName: 'Example',
          arrival: '2026-11-12',
          departure: '2026-11-17',
          requestedChange: 'Change departure from 15 Nov to 17 Nov',
        }),
      ),
    ).toMatchObject({
      confirmationNumber: '57291630-1',
      guestLastName: 'Example',
      arrival: '2026-11-12',
      departure: '2026-11-17',
      requestedChange: 'Change departure from 15 Nov to 17 Nov',
    });
  });
});

describe('buildQuoteWorkflowPrompt', () => {
  it('uses the hotel rules verbatim and wraps thread, body and attachment text as data', () => {
    const prompt = buildQuoteWorkflowPrompt({
      ...selection,
      attachments: [
        { id: 'a1', filename: 'rooming.pdf', bytesPresent: true, text: 'Guest list: Ann, Bob' },
      ],
    });
    expect(prompt.system).toContain(CENTURION_HOTEL_RULES);
    expect(prompt.system).toMatch(/never output prices/i);
    expect(prompt.system).toMatch(/create_booking/);
    expect(prompt.system).toMatch(/conference_or_group/);
    expect(prompt.system).toMatch(/extras/i);
    expect(prompt.system).toMatch(/single room/i);
    expect(prompt.system).toMatch(/never ask for room type, board or rate/i);
    expect(prompt.system).toMatch(/rooms-only/i);
    expect(prompt.system).toMatch(/stated quantity|room quantity/i);
    expect(prompt.system).toMatch(/venue/i);
    expect(prompt.system).toMatch(/DDR/i);
    expect(prompt.system).toMatch(/delegates/i);
    expect(prompt.system).toMatch(/packages/i);
    expect(prompt.system).toMatch(/rooms_only_group/);
    expect(prompt.system).not.toMatch(
      /Groups of 10\+ rooms, delegates or events set the conference_or_group flag/,
    );
    expect(prompt.user).toContain('2026-10-06');
    expect(prompt.user).toContain('Earlier: we need rooms in November.');
    expect(prompt.user).toContain('Guest list: Ann, Bob');
    expect(prompt.user).toContain('rooming.pdf');
  });

  it('keeps requested dinner boards for the server-side B&B retry', () => {
    const prompt = buildQuoteWorkflowPrompt(selection).system;

    expect(prompt).toContain(
      'Keep the requested dinner board in groups[].board: use "dbb" for DBB/dinner with breakfast and "half_board" for half-board; the server converts either to B&B and adds dinner separately.',
    );
    expect(prompt).not.toContain(
      'Half-board, half board, DBB or dinner with breakfast means quote Bed & Breakfast and show dinner as a separate staff-priced add-on.',
    );
  });

  it('gives quote and availability requests precedence over booking language', () => {
    const prompt = buildQuoteWorkflowPrompt(selection);
    expect(prompt.system).toContain(
      'Quote/quotation, price, rate or availability asks stay workflow=quote despite book/reserve.',
    );
    expect(prompt.system).toContain(
      [
        'Create requires explicit make/confirm and no quote/quotation, price, rate or',
        'availability ask.',
      ].join(' '),
    );
    expect(prompt.system).toContain('"Quote then book if OK" stays workflow=quote.');
    expect(prompt.system).toContain(
      [
        'Use workflow=create_booking only for explicit make/confirm asks without a quote, price,',
        'rate or availability ask.',
      ].join(' '),
    );
    expect(prompt.system).not.toContain(
      '"Quote then book if OK" becomes quote then create_booking.',
    );
  });

  it('adds a staff treat-as-quote override to the prompt', () => {
    const prompt = buildQuoteWorkflowPrompt(selection, { treatAs: 'quote' });
    expect(prompt.system).toMatch(/staff override/i);
    expect(prompt.system).toMatch(/treat this mail as a quote/i);
  });

  it('asks for amendments and cancellations as amend or cancel, and maps invoice asks onto other in this schema', () => {
    const prompt = buildQuoteWorkflowPrompt(selection);
    expect(prompt.system).toMatch(
      /Amendments and cancellations of an existing booking: workflow=amend or cancel\./,
    );
    expect(prompt.system).toMatch(/workflow=send_document/);
    expect(prompt.system).toMatch(/"forward_to_partner", "send_document"/);
    expect(prompt.system).not.toMatch(/Cancellations, amendments, invoices/);
  });

  it('uses Da Vinci hotel rules for an HRDAV quote and never names Centurion', () => {
    const prompt = buildQuoteWorkflowPrompt(selection, { propertyCode: 'HRDAV' });
    expect(prompt.system).toContain(DAVINCI_HOTEL_RULES);
    expect(prompt.system).toMatch(/Da Vinci Hotel and Suites/);
    expect(prompt.system).toMatch(/HRDAV/);
    expect(prompt.system).not.toMatch(/Centurion/);
    expect(prompt.system).not.toMatch(/partner \(Da Vinci/);
    expect(prompt.system).not.toContain(CENTURION_HOTEL_RULES);
  });

  it('keeps Centurion hotel rules when the property is omitted or HRCEN', () => {
    expect(buildQuoteWorkflowPrompt(selection).system).toContain(CENTURION_HOTEL_RULES);
    expect(buildQuoteWorkflowPrompt(selection, { propertyCode: 'HRCEN' }).system).toContain(
      CENTURION_HOTEL_RULES,
    );
  });
});

describe('QUOTE_WORKFLOW_PROMPT_VERSION', () => {
  it('hashes the hotel rules, the mapping and the response schema, so a schema change misses the cache', () => {
    const withSchema = createHash('sha256')
      .update(CENTURION_HOTEL_RULES)
      .update('\n')
      .update(K2_MAPPING)
      .update('\n')
      .update(aopQuoteInstructions())
      .update('\n')
      .update(JSON.stringify(zodToJsonSchema(lunaAnalysisSchema, { $refStrategy: 'none' })))
      .update(
        '\nattachment-review/2\nparty-not-guest/2\nluna-group-dates/1\none-night-default/1\naop-quote-spine/1\nproperty-room-match/1',
      )
      .digest('hex')
      .slice(0, 16);
    const promptOnly = createHash('sha256')
      .update(CENTURION_HOTEL_RULES)
      .update('\n')
      .update(K2_MAPPING)
      .digest('hex')
      .slice(0, 16);
    expect(QUOTE_WORKFLOW_PROMPT_VERSION).toBe(withSchema);
    expect(QUOTE_WORKFLOW_PROMPT_VERSION).not.toBe(promptOnly);
  });
});

describe('mapLlmDecision', () => {
  it.each([
    { arrival: '2027-03-15', departure: '2027-03-12' },
    { arrival: '2027-03-12', departure: '2027-03-12' },
  ])('flags reversed or zero-night dates in the pane warning field', ({ arrival, departure }) => {
    const mapped = mapLlmDecision(
      lunaAnalysisSchema.parse(
        analysis({
          workflow: 'quote',
          groups: [{ ...group, arrival, departure, dateEvidence: '12-14 March' }],
        }),
      ),
      {
        dateAnchor: {
          receivedAt: '2026-12-20T12:00:00.000Z',
          sourceText: 'Please quote 12-14 March.',
        },
      },
    );

    expect(mapped.missing).toContainEqual(
      expect.objectContaining({ field: 'stayDates', question: expect.stringContaining('after arrival') }),
    );
  });

  it('anchors yearless quote dates to received time and preserves an explicit trip year', () => {
    const mapped = mapLlmDecision(
      lunaAnalysisSchema.parse(
        analysis({
          workflow: 'quote',
          groups: [{ ...group, arrival: '2026-03-12', departure: '2026-03-15', dateEvidence: '12-14 March' }],
        }),
      ),
      {
        dateAnchor: {
          receivedAt: '2026-12-20T12:00:00.000Z',
          sourceText: 'Subject: Quote\nPlease quote 12-14 March.',
        },
      },
    );
    const explicit = mapLlmDecision(
      lunaAnalysisSchema.parse(
        analysis({
          workflow: 'quote',
          groups: [{ ...group, arrival: '2026-03-12', departure: '2026-03-15', dateEvidence: '12-14 March 2026' }],
        }),
      ),
      {
        dateAnchor: {
          receivedAt: '2026-12-20T12:00:00.000Z',
          sourceText: 'Subject: Quote\nPlease quote 12-14 March 2026.',
        },
      },
    );

    expect(mapped.groups[0]).toMatchObject({
      arrivalDate: '2027-03-12',
      departureDate: '2027-03-15',
    });
    expect(explicit.groups[0]).toMatchObject({
      arrivalDate: '2026-03-12',
      departureDate: '2026-03-15',
    });
  });

  it.each([
    { label: 'ISO', dateEvidence: '2028-03-12 to 2028-03-15' },
    { label: 'numeric', dateEvidence: '12/03/2028 to 15/03/2028' },
  ])('preserves explicit years in $label date evidence', ({ dateEvidence }) => {
    const mapped = mapLlmDecision(
      lunaAnalysisSchema.parse(
        analysis({
          workflow: 'quote',
          groups: [{ ...group, arrival: '2028-03-12', departure: '2028-03-15', dateEvidence }],
        }),
      ),
      {
        dateAnchor: {
          receivedAt: '2026-12-20T12:00:00.000Z',
          sourceText: `Please quote ${dateEvidence}.`,
        },
      },
    );

    expect(mapped.groups[0]).toMatchObject({
      arrivalDate: '2028-03-12',
      departureDate: '2028-03-15',
    });
  });

  it('anchors each stay from its own date phrase, not another stay’s relative weekday', () => {
    const mapped = mapLlmDecision(
      lunaAnalysisSchema.parse(
        analysis({
          workflow: 'quote',
          groups: [
            {
              ...group,
              arrival: '2026-12-11',
              departure: '2026-12-13',
              dateEvidence: 'next Friday for two nights',
            },
            {
              ...group,
              arrival: '2026-01-04',
              departure: '2026-01-07',
              dateEvidence: '4–6 January',
            },
          ],
        }),
      ),
      {
        dateAnchor: {
          receivedAt: '2026-12-18T12:00:00.000Z',
          sourceText: 'Please quote next Friday for two nights, and 4–6 January.',
        },
      },
    );

    expect(mapped.groups.map(({ arrivalDate, departureDate }) => [arrivalDate, departureDate])).toEqual([
      ['2026-12-25', '2026-12-27'],
      ['2027-01-04', '2027-01-07'],
    ]);
  });

  it('keeps a single stay in the year stated by its subject', () => {
    const mapped = mapLlmDecision(
      lunaAnalysisSchema.parse(
        analysis({
          workflow: 'quote',
          groups: [
            {
              ...group,
              arrival: '2028-03-12',
              departure: '2028-03-15',
              dateEvidence: '12-14 March',
            },
          ],
        }),
      ),
      {
        dateAnchor: {
          receivedAt: '2028-12-20T12:00:00.000Z',
          sourceText: ['Subject: March 2028', 'Please quote 12-14 March.'].join('\n'),
          subjectText: 'March 2028',
        },
      },
    );

    expect(mapped.groups[0]).toMatchObject({
      arrivalDate: '2028-03-12',
      departureDate: '2028-03-15',
    });
  });

  it('scopes a staff date correction to that stay and anchors the other stay', () => {
    const mapped = mapLlmDecision(
      lunaAnalysisSchema.parse(
        analysis({
          workflow: 'quote',
          groups: [
            {
              ...group,
              arrival: '2026-12-11',
              departure: '2026-12-13',
              dateEvidence: 'next Friday for two nights',
            },
            {
              ...group,
              arrival: '2026-01-04',
              departure: '2026-01-07',
              dateEvidence: '4–6 January',
            },
          ],
        }),
      ),
      {
        dateAnchor: {
          receivedAt: '2026-12-18T12:00:00.000Z',
          sourceText: 'Please quote next Friday for two nights, then 4–6 January.',
          staffNote: 'Keep 4–6 January for the second stay.',
        },
      },
    );

    expect(mapped.groups.map(({ arrivalDate, departureDate }) => [arrivalDate, departureDate])).toEqual([
      ['2026-12-25', '2026-12-27'],
      ['2026-01-04', '2026-01-07'],
    ]);
  });

  it('does not use another stay’s explicit year to change next Friday', () => {
    const mapped = mapLlmDecision(
      lunaAnalysisSchema.parse(
        analysis({
          workflow: 'quote',
          groups: [
            {
              ...group,
              arrival: '2026-12-25',
              departure: '2026-12-27',
              dateEvidence: 'next Friday for two nights',
            },
            {
              ...group,
              arrival: '2028-03-12',
              departure: '2028-03-15',
              dateEvidence: '12–14 March 2028',
            },
          ],
        }),
      ),
      {
        dateAnchor: {
          receivedAt: '2026-12-18T12:00:00.000Z',
          sourceText:
            'Please quote next Friday for two nights. Another stay: 12–14 March 2028.',
        },
      },
    );

    expect(mapped.groups.map(({ arrivalDate, departureDate }) => [arrivalDate, departureDate])).toEqual([
      ['2026-12-25', '2026-12-27'],
      ['2028-03-12', '2028-03-15'],
    ]);
  });

  it('preserves a staff date correction ahead of conflicting email dates', () => {
    const mapped = mapLlmDecision(
      lunaAnalysisSchema.parse(
        analysis({
          workflow: 'quote',
          groups: [
            {
              ...group,
              arrival: '2028-03-12',
              departure: '2028-03-15',
              dateEvidence: '12–14 March 2028',
            },
          ],
        }),
      ),
      {
        dateAnchor: {
          receivedAt: '2026-12-20T12:00:00.000Z',
          sourceText: 'Please quote 12–14 March 2027.',
          staffNote: 'Use 12–14 March 2028 instead.',
        },
      },
    );

    expect(mapped.groups[0]).toMatchObject({
      arrivalDate: '2028-03-12',
      departureDate: '2028-03-15',
    });
  });

  it('maps groups to editable stay groups without any price field', () => {
    const mapped = mapLlmDecision(lunaAnalysisSchema.parse(analysis()));
    expect(mapped.intent).toBe('quote');
    expect(mapped.groups).toEqual([
      {
        id: 'g1',
        arrivalDate: '2026-11-12',
        departureDate: '2026-11-14',
        quantity: 2,
        adults: 1,
        childrenAges: [],
        board: 'dinner_bb',
        roomPreference: 'twin',
        organisation: 'Acme Mining',
        specialRequests: [],
        fields: {
          arrivalDate: 'extracted',
          departureDate: 'extracted',
          quantity: 'extracted',
          adults: 'extracted',
          board: 'extracted',
        },
      },
    ]);
    expect(JSON.stringify(mapped.groups)).not.toMatch(/price|rate"|amount/i);
    expect(mapped.ratePlan.source).toBe('party_contract');
  });

  it('carries stated stay totals separately from per-room occupancy', () => {
    const mapped = mapLlmDecision(
      lunaAnalysisSchema.parse(
        analysis({
          workflow: 'quote',
          groups: [{ ...group, adultsPerRoom: 3, adultsTotal: 5, childrenTotal: 0 }],
        }),
      ),
    );

    expect(mapped.groups[0]).toMatchObject({
      quantity: 2,
      adults: 3,
      adultsTotal: 5,
      childrenTotal: 0,
      fields: { adultsTotal: 'extracted', childrenTotal: 'extracted' },
    });
  });

  it('defaults a one-date quote to one night and marks departure defaulted', () => {
    const mapped = mapLlmDecision(
      lunaAnalysisSchema.parse(
        analysis({
          workflow: 'quote',
          groups: [{ ...group, arrival: '2026-11-12', departure: null, dateEvidence: '12 Nov' }],
        }),
      ),
    );

    expect(mapped.groups[0]).toMatchObject({
      arrivalDate: '2026-11-12',
      departureDate: '2026-11-13',
      fields: { arrivalDate: 'extracted', departureDate: 'defaulted' },
    });
    expect(mapped.missingQuoteReplyFields).toEqual([]);
  });

  it('drops the checkout question once the one-night default fills departure', () => {
    const mapped = mapLlmDecision(
      lunaAnalysisSchema.parse(
        analysis({
          workflow: 'quote',
          groups: [{ ...group, arrival: '2026-11-12', departure: null, dateEvidence: '12 Nov' }],
          missing: [{ field: 'departureDate', question: 'What is the checkout date?' }],
        }),
      ),
    );

    expect(mapped.groups[0]?.departureDate).toBe('2026-11-13');
    expect(mapped.missing.map((item) => item.field)).not.toContain('departureDate');
  });

  it('keeps checkout derived from stated nights instead of replacing it with one night', () => {
    const mapped = mapLlmDecision(
      lunaAnalysisSchema.parse(
        analysis({
          workflow: 'quote',
          groups: [{
            ...group,
            arrival: '2026-11-12',
            departure: '2026-11-15',
            dateEvidence: '12 Nov for three nights',
          }],
        }),
      ),
      {
        dateAnchor: {
          receivedAt: '2026-10-06T08:00:00.000Z',
          sourceText: 'Please quote 12 Nov for three nights.',
        },
      },
    );

    expect(mapped.groups[0]).toMatchObject({
      arrivalDate: '2026-11-12',
      departureDate: '2026-11-15',
      fields: { departureDate: 'extracted' },
    });
  });

  it('does not default a checkout when the quote has no arrival', () => {
    const mapped = mapLlmDecision(
      lunaAnalysisSchema.parse(
        analysis({
          workflow: 'quote',
          groups: [{ ...group, arrival: null, departure: null }],
        }),
      ),
    );

    expect(mapped.groups[0]).toMatchObject({
      fields: { arrivalDate: 'missing', departureDate: 'missing' },
    });
    expect(mapped.groups[0]).not.toHaveProperty('departureDate');
    expect(mapped.missingQuoteReplyFields).toContain('Arrival date for stay 1');
    expect(mapped.missingQuoteReplyFields).toContain('Departure date for stay 1');
  });

  it('defaults quote rooms and occupancy to editable values with defaulted provenance', () => {
    const mapped = mapLlmDecision(
      lunaAnalysisSchema.parse(
        analysis({
          workflow: 'quote',
          groups: [{ ...group, rooms: null, adultsPerRoom: null }],
          missing: [
            { field: 'rooms', question: 'How many rooms?' },
            { field: 'adultsPerRoom', question: 'How many adults per room?' },
          ],
        }),
      ),
    );

    expect(mapped.groups[0]).toMatchObject({
      quantity: 1,
      adults: 2,
      fields: { quantity: 'defaulted', adults: 'defaulted' },
    });
    expect(mapped.missing).toEqual([]);
    expect(mapped.missingQuoteReplyFields).toEqual([]);
  });

  it('marks an unresolved quote room type as a defaulted any-type choice', () => {
    const mapped = mapLlmDecision(
      lunaAnalysisSchema.parse(
        analysis({
          workflow: 'quote',
          groups: [{ ...group, roomPreference: 'Twin' }],
        }),
      ),
    );

    expect(mapped.groups[0]).toMatchObject({
      roomPreference: 'Twin',
      fields: { roomPreference: 'defaulted' },
    });
  });

  it('keeps an HRDAV Twin ask defaulted so Get rates still searches every room', () => {
    const mapped = mapLlmDecision(
      lunaAnalysisSchema.parse(
        analysis({
          workflow: 'quote',
          groups: [{ ...group, roomPreference: 'Twin' }],
        }),
      ),
      { propertyCode: 'HRDAV' },
    );

    expect(mapped.groups[0]).toMatchObject({
      roomPreference: 'Twin',
      fields: { roomPreference: 'defaulted' },
    });
  });

  it('defaults occupancy while keeping missing dates and room count in the reply', () => {
    const mapped = mapLlmDecision(
      lunaAnalysisSchema.parse(
        analysis({
          workflow: 'quote',
          groups: [{
            ...group,
            arrival: null,
            departure: '2026-11-14',
            rooms: null,
            adultsPerRoom: null,
            board: 'half_board',
          }],
          missing: [],
        }),
      ),
    );

    expect(mapped.groups[0]).toMatchObject({
      departureDate: '2026-11-14',
      adults: 2,
      board: 'dinner_bb',
      fields: { arrivalDate: 'missing', departureDate: 'extracted', adults: 'defaulted' },
    });
    expect(mapped.missingQuoteReplyFields).toEqual([
      'Arrival date for stay 1',
      'Number of rooms for stay 1',
    ]);
  });

  it('does not apply quote room or occupancy defaults to create_booking', () => {
    const mapped = mapLlmDecision(
      lunaAnalysisSchema.parse(
        analysis({
          workflow: 'create_booking',
          groups: [{ ...group, rooms: null, adultsPerRoom: null }],
        }),
      ),
    );

    expect(mapped.groups[0]).not.toHaveProperty('quantity');
    expect(mapped.groups[0]).not.toHaveProperty('adults');
    expect(mapped.groups[0]?.fields).toMatchObject({ quantity: 'missing', adults: 'missing' });
  });

  it('maps create_booking to intent quote and leaves groups in place', () => {
    const mapped = mapLlmDecision(
      lunaAnalysisSchema.parse(analysis({ workflow: 'create_booking' })),
    );
    expect(mapped.intent).toBe('quote');
    expect(mapped.groups).toHaveLength(1);
  });

  it('defaults unstated board to bb for a private party and marks it defaulted', () => {
    const mapped = mapLlmDecision(
      lunaAnalysisSchema.parse(
        analysis({
          party: { kind: 'private', name: null, reference: null },
          groups: [{ ...group, board: null }],
        }),
      ),
    );
    expect(mapped.groups[0]?.board).toBe('bb');
    expect(mapped.groups[0]?.fields.board).toBe('defaulted');
  });

  it('defaults unstated board to dinner_bb for a government party', () => {
    const mapped = mapLlmDecision(
      lunaAnalysisSchema.parse(
        analysis({
          party: { kind: 'government', name: 'Department of Forestry', reference: null },
          groups: [{ ...group, board: null }],
        }),
      ),
    );
    expect(mapped.groups[0]?.board).toBe('dinner_bb');
    expect(mapped.groups[0]?.fields.board).toBe('defaulted');
  });

  it('keeps a stated board over the party default', () => {
    const mapped = mapLlmDecision(
      lunaAnalysisSchema.parse(
        analysis({
          party: { kind: 'government', name: 'Department of Forestry', reference: null },
          groups: [{ ...group, board: 'bb' }],
        }),
      ),
    );
    expect(mapped.groups[0]?.board).toBe('bb');
    expect(mapped.groups[0]?.fields.board).toBe('extracted');
  });

  it('drops room-type and board questions from missing because the hotel defaults those', () => {
    const mapped = mapLlmDecision(
      lunaAnalysisSchema.parse(
        analysis({
          missing: [
            { field: 'roomType', question: 'Which room type?' },
            { field: 'roomPreference', question: 'Queen or twin?' },
            { field: 'guestNames', question: 'Guest names?' },
            { field: 'board', question: 'Bed and breakfast or dinner?' },
          ],
        }),
      ),
    );
    expect(mapped.missing.map((item) => item.field)).toEqual(['guestNames']);
  });

  it('drops malformed dates and marks them missing', () => {
    const mapped = mapLlmDecision(
      lunaAnalysisSchema.parse(
        analysis({
          workflow: 'quote',
          groups: [{ ...group, arrival: '2026-02-30', departure: null, board: null }],
        }),
      ),
    );
    expect(mapped.groups[0]?.arrivalDate).toBeUndefined();
    expect(mapped.groups[0]?.fields.arrivalDate).toBe('missing');
    expect(mapped.groups[0]?.board).toBe('bb');
    expect(mapped.groups[0]?.fields.board).toBe('defaulted');
    expect(mapped.missing.some((item) => item.field === 'arrivalDate')).toBe(true);
  });

  it('keeps one blank editable stay group when quote has no extracted groups', () => {
    const mapped = mapLlmDecision(
      lunaAnalysisSchema.parse(analysis({ workflow: 'quote', groups: [] })),
    );
    expect(mapped.intent).toBe('quote');
    expect(mapped.groups).toEqual([
      {
        id: 'g1',
        childrenAges: [],
        board: 'bb',
        specialRequests: [],
        fields: {
          arrivalDate: 'missing',
          departureDate: 'missing',
          quantity: 'missing',
          adults: 'missing',
          board: 'defaulted',
        },
      },
    ]);
    expect(mapped.missing.some((item) => item.field === 'stay')).toBe(true);
  });

  it('maps other to other with no groups prefilled', () => {
    const mapped = mapLlmDecision(lunaAnalysisSchema.parse(analysis({ workflow: 'other' })));
    expect(mapped.intent).toBe('other');
    expect(mapped.groups).toEqual([]);
  });

  it('treats skip as a non-quote workflow like other, hiding quote groups', () => {
    expect(isNonQuoteLunaWorkflow('skip')).toBe(true);
    expect(isNonQuoteLunaWorkflow('other')).toBe(true);
    expect(isNonQuoteLunaWorkflow('quote')).toBe(false);
    const mapped = mapLlmDecision(lunaAnalysisSchema.parse(analysis({ workflow: 'skip' })));
    expect(mapped.intent).toBe('other');
    expect(mapped.groups).toEqual([]);
  });

  it('maps amend and cancel to intent other with no groups, so the quote UI stays hidden', () => {
    for (const workflow of ['amend', 'cancel'] as const) {
      const mapped = mapLlmDecision(lunaAnalysisSchema.parse(analysis({ workflow })));
      expect(mapped.intent).toBe('other');
      expect(mapped.groups).toEqual([]);
    }
  });

  it('builds the amendment payload for amend and cancel only', () => {
    // AE2 shape: the guest adds the night before arrival and a later checkout. Booked and requested stay apart.
    expect(
      amendmentFromAnalysis(
        lunaAnalysisSchema.parse(
          analysis({
            workflow: 'amend',
            confirmationNumber: '57291630-1',
            guestLastName: 'Example',
            arrival: '2026-11-01',
            departure: '2026-11-06',
            requestedArrival: '2026-10-31',
            requestedDeparture: '2026-11-07',
            requestedChange: 'Add the night of 31 Oct and check out on 7 Nov',
          }),
        ),
      ),
    ).toEqual({
      kind: 'amend',
      confirmationNumber: '57291630-1',
      guestLastName: 'Example',
      arrival: '2026-11-01',
      departure: '2026-11-06',
      requestedArrival: '2026-10-31',
      requestedDeparture: '2026-11-07',
      requestedChange: 'Add the night of 31 Oct and check out on 7 Nov',
    });
    expect(
      amendmentFromAnalysis(lunaAnalysisSchema.parse(analysis({ workflow: 'cancel' }))),
    ).toEqual({
      kind: 'cancel',
      confirmationNumber: null,
      guestLastName: null,
      arrival: null,
      departure: null,
      requestedArrival: null,
      requestedDeparture: null,
      requestedChange: null,
    });
    expect(
      amendmentFromAnalysis(lunaAnalysisSchema.parse(analysis({ workflow: 'quote' }))),
    ).toBeNull();
  });

  it('quotes a rooms-only group of 15 with quantity 15 and an info chip', () => {
    const mapped = mapLlmDecision(
      lunaAnalysisSchema.parse(
        analysis({
          workflow: 'quote',
          flags: ['rooms_only_group'],
          groups: [{ ...group, rooms: 15, board: null }],
        }),
      ),
    );
    expect(mapped.intent).toBe('quote');
    expect(mapped.groups[0]?.quantity).toBe(15);
    expect(mapped.missing.some((item) => item.field === 'rooms_only_group')).toBe(true);
    expect(mapped.missing.some((item) => /rooms-only|stated quantity/i.test(item.question))).toBe(
      true,
    );
  });

  it('quotes 10+ rooms-only groups even when Luna omits rooms_only_group', () => {
    const mapped = mapLlmDecision(
      lunaAnalysisSchema.parse(
        analysis({
          workflow: 'quote',
          flags: [],
          groups: [{ ...group, rooms: 12 }],
        }),
      ),
    );
    expect(mapped.intent).toBe('quote');
    expect(mapped.groups[0]?.quantity).toBe(12);
    expect(mapped.missing.some((item) => item.field === 'rooms_only_group')).toBe(true);
  });

  it('staff treatAs quote keeps a venue-flagged rooms group on the quote path', () => {
    const mapped = mapLlmDecision(
      lunaAnalysisSchema.parse(
        analysis({
          workflow: 'other',
          flags: ['conference_or_group'],
          groups: [{ ...group, rooms: 15 }],
        }),
      ),
      { treatAs: 'quote' },
    );
    expect(mapped.intent).toBe('quote');
    expect(mapped.groups[0]?.quantity).toBe(15);
  });

  it('maps venue / DDR / delegates / packages to other with a handle-manually reason chip', () => {
    const mapped = mapLlmDecision(
      lunaAnalysisSchema.parse(
        analysis({
          workflow: 'quote',
          flags: ['conference_or_group'],
          groups: [{ ...group, rooms: 15 }],
        }),
      ),
    );
    expect(mapped.intent).toBe('other');
    expect(mapped.groups).toEqual([]);
    expect(mapped.missing.some((item) => item.field === 'handle_manually')).toBe(true);
    expect(
      mapped.missing.some((item) => /venue|DDR|delegates|packages/i.test(item.question)),
    ).toBe(true);
  });

  it('never reads tasks; pane mapping is identical with or without them', () => {
    const withTasks = mapLlmDecision(
      lunaAnalysisSchema.parse(
        analysis({
          flags: ['multi_date'],
          groups: [
            { ...group, arrival: '2026-11-12', departure: '2026-11-14' },
            { ...group, arrival: '2026-12-01', departure: '2026-12-03' },
          ],
          tasks: [
            { kind: 'quote', groupIndexes: [0], note: 'first date option' },
            { kind: 'quote', groupIndexes: [1], note: 'second date option' },
          ],
        }),
      ),
    );
    const withoutTasks = mapLlmDecision(
      lunaAnalysisSchema.parse(
        analysis({
          flags: ['multi_date'],
          groups: [
            { ...group, arrival: '2026-11-12', departure: '2026-11-14' },
            { ...group, arrival: '2026-12-01', departure: '2026-12-03' },
          ],
          tasks: [],
        }),
      ),
    );
    expect(withTasks.groups).toEqual(withoutTasks.groups);
    expect(withTasks.intent).toEqual(withoutTasks.intent);
    expect(withTasks.groups).toHaveLength(2);
  });
});

describe('analyseQuoteSelection', () => {
  it('calls Luna once with scanned PDF bytes as files and returns the mapped analysis', async () => {
    const seen: ModelInvokeInput[] = [];
    const pdf = new TextEncoder().encode('%PDF-1.4 scanned');
    const result = await analyseQuoteSelection({
      selection: {
        ...selection,
        attachments: [{ id: 'a1', filename: 'scan.pdf', bytesPresent: true, pdf }],
      },
      adapter: fakeAdapter(analysis(), seen),
      enabled: true,
      deadlineMs: 1_000,
    });
    expect(seen).toHaveLength(1);
    expect(seen[0]?.files?.[0]).toMatchObject({
      filename: 'scan.pdf',
      mediaType: 'application/pdf',
    });
    expect(seen[0]?.responseSchema).toBeTypeOf('object');
    expect(result.source).toBe('luna');
    if (result.source === 'luna') {
      expect(result.analysis.workflow).toBe('create_booking');
    }
  });

  it('masks Luhn PANs in the body and thread and leaves non-Luhn digits', async () => {
    const seen: ModelInvokeInput[] = [];
    await analyseQuoteSelection({
      selection: {
        ...selection,
        bodyText: 'Pay 4111 1111 1111 1111 then quote.',
        preceding: [{ bodyText: 'Earlier PAN 4111 1111 1111 1111 and ref 4111 1111 1111 1112.' }],
      },
      adapter: fakeAdapter(analysis(), seen),
      enabled: true,
    });
    const user = seen[0]?.userPrompt ?? '';
    expect(user).toContain('[card ••••1111]');
    expect(user).not.toMatch(/4111 1111 1111 1111/);
    expect(user).toContain('4111 1111 1111 1112');
  });

  it('drops evidence quotes that are not a substring of the source text', async () => {
    const result = await analyseQuoteSelection({
      selection,
      adapter: fakeAdapter(
        analysis({
          evidence: [
            { field: 'arrival', quote: 'arriving 12 Nov' },
            { field: 'arrival', quote: 'invented 99 Oct stay' },
          ],
        }),
      ),
      enabled: true,
    });
    expect(result.source).toBe('luna');
    if (result.source === 'luna') {
      expect(result.analysis.evidence).toEqual([{ field: 'arrival', quote: 'arriving 12 Nov' }]);
    }
  });

  it('keeps an amendment confirmation number only when it appears verbatim in the source', async () => {
    const amendSelection: SyncedQuoteSelection = {
      ...selection,
      bodyText: 'Please change booking 57291630-1 so we leave 17 Nov, not 15 Nov.',
    };
    const kept = await analyseQuoteSelection({
      selection: amendSelection,
      adapter: fakeAdapter(analysis({ workflow: 'amend', confirmationNumber: '57291630-1' })),
      enabled: true,
    });
    const invented = await analyseQuoteSelection({
      selection: amendSelection,
      adapter: fakeAdapter(analysis({ workflow: 'amend', confirmationNumber: '99999999-9' })),
      enabled: true,
    });
    expect(kept.source).toBe('luna');
    if (kept.source === 'luna') expect(kept.analysis.confirmationNumber).toBe('57291630-1');
    expect(invented.source).toBe('luna');
    if (invented.source === 'luna') expect(invented.analysis.confirmationNumber).toBeNull();
  });

  it('masks card numbers in the requested change, caps it at 300 characters and drops impossible dates', async () => {
    const result = await analyseQuoteSelection({
      selection,
      adapter: fakeAdapter(
        analysis({
          workflow: 'amend',
          requestedChange: `Card 4111 1111 1111 1111 ${'x'.repeat(400)}`,
          arrival: '2026-02-30',
          departure: '2026-11-17',
          requestedArrival: '2026-10-32',
          requestedDeparture: '2026-11-18',
        }),
      ),
      enabled: true,
    });
    expect(result.source).toBe('luna');
    if (result.source === 'luna') {
      expect(result.analysis.requestedChange).not.toMatch(/4111 1111 1111 1111/);
      expect(result.analysis.requestedChange?.length).toBeLessThanOrEqual(300);
      expect(result.analysis.arrival).toBeNull();
      expect(result.analysis.departure).toBe('2026-11-17');
      expect(result.analysis.requestedArrival).toBeNull();
      expect(result.analysis.requestedDeparture).toBe('2026-11-18');
    }
  });

  it('puts a staff note first as top-priority evidence', () => {
    const prompt = buildQuoteWorkflowPrompt(selection, {
      staffNote: 'They want 4 twins at R1800 B&B',
    });
    expect(prompt.user.startsWith('Staff note (top-priority evidence):')).toBe(true);
    expect(prompt.user).toContain('They want 4 twins at R1800 B&B');
    expect(prompt.system).toMatch(/staff note/i);
  });

  it('keeps rateClaims whose quote is a substring of the staff note', async () => {
    const kept = {
      kind: 'exact' as const,
      amount: '1800',
      currency: 'ZAR',
      basis: 'per_room_per_night' as const,
      taxBasis: 'gross_included' as const,
      quote: 'R1800 B&B',
    };
    const result = await analyseQuoteSelection({
      selection,
      adapter: fakeAdapter(
        analysis({
          rateClaims: [kept],
          evidence: [{ field: 'quantity', quote: '4 twins' }],
        }),
      ),
      enabled: true,
      staffNote: 'Please quote 4 twins at R1800 B&B',
    });
    expect(result.source).toBe('luna');
    if (result.source === 'luna') {
      expect(result.analysis.rateClaims).toEqual([kept]);
      expect(result.analysis.evidence).toEqual([
        { field: 'quantity', quote: '4 twins', source: 'staff_note' },
      ]);
    }
  });

  it('drops rateClaims whose quote is not a substring of the source text', async () => {
    const kept = {
      kind: 'exact' as const,
      amount: '1560',
      currency: 'ZAR',
      basis: 'per_room_per_night' as const,
      taxBasis: 'gross_included' as const,
      quote: 'R1560 B&B',
    };
    const invented = { ...kept, quote: 'R9999 invented', amount: '9999' };
    const result = await analyseQuoteSelection({
      selection: { ...selection, bodyText: `${selection.bodyText} Rate R1560 B&B.` },
      adapter: fakeAdapter(analysis({ rateClaims: [kept, invented] })),
      enabled: true,
    });
    expect(result.source).toBe('luna');
    if (result.source === 'luna') {
      expect(result.analysis.rateClaims).toEqual([kept]);
    }
  });

  it('returns no rateClaims when every claim quote is invented', async () => {
    const invented = {
      kind: 'exact' as const,
      amount: '9999',
      currency: 'ZAR',
      basis: 'per_room_per_night' as const,
      taxBasis: 'gross_included' as const,
      quote: 'R9999 invented nightly',
    };
    const result = await analyseQuoteSelection({
      selection,
      adapter: fakeAdapter(analysis({ rateClaims: [invented] })),
      enabled: true,
    });
    expect(result.source).toBe('luna');
    if (result.source === 'luna') {
      expect(result.analysis.rateClaims).toEqual([]);
    }
  });

  it('passes two quote tasks through unchanged on a multi_date analysis', async () => {
    const payload = analysis({
      workflow: 'quote',
      flags: ['multi_date'],
      groups: [
        { ...group, arrival: '2026-11-12', departure: '2026-11-14' },
        { ...group, arrival: '2026-12-01', departure: '2026-12-03' },
      ],
      tasks: [
        { kind: 'quote', groupIndexes: [0], note: 'first date option' },
        { kind: 'quote', groupIndexes: [1], note: 'second date option' },
      ],
    });
    const result = await analyseQuoteSelection({
      selection,
      adapter: fakeAdapter(payload),
      enabled: true,
    });
    expect(result.source).toBe('luna');
    if (result.source === 'luna') {
      expect(result.analysis.tasks).toEqual(payload.tasks);
      expect(result.analysis.flags).toContain('multi_date');
      expect(result.analysis.groups).toHaveLength(2);
    }
  });

  it('falls back to flagged regex on timeout', async () => {
    const hanging: ModelAdapter = {
      invoke: (input) =>
        new Promise((_, reject) =>
          input.signal?.addEventListener('abort', () => reject(new Error('aborted'))),
        ),
    };
    const result = await analyseQuoteSelection({
      selection,
      adapter: hanging,
      enabled: true,
      deadlineMs: 50,
    });
    expect(result.source).toBe('regex_fallback');
    expect(result.fallbackReason).toBe('timeout');
  });

  it('times out even when the adapter ignores the abort signal', async () => {
    const ignoring: ModelAdapter = { invoke: () => new Promise(() => {}) };
    const started = Date.now();
    const result = await analyseQuoteSelection({
      selection,
      adapter: ignoring,
      enabled: true,
      deadlineMs: 50,
    });
    expect(result.fallbackReason).toBe('timeout');
    expect(Date.now() - started).toBeLessThan(1_000);
  });

  it('falls back to flagged regex on model error or schema mismatch', async () => {
    const failing: ModelAdapter = {
      invoke: async () => {
        throw new Error('boom');
      },
    };
    expect(
      (await analyseQuoteSelection({ selection, adapter: failing, enabled: true })).fallbackReason,
    ).toBe('error');
    const bad = await analyseQuoteSelection({
      selection,
      adapter: fakeAdapter({ workflow: 'quote' }),
      enabled: true,
    });
    expect(bad.source).toBe('regex_fallback');
    expect(bad.fallbackReason).toBe('invalid_output');
  });

  it('falls back with invalid_output when tasks exceed eight', async () => {
    const nine = Array.from({ length: 9 }, () => ({
      kind: 'quote' as const,
      groupIndexes: [0],
      note: 'x',
    }));
    const result = await analyseQuoteSelection({
      selection,
      adapter: fakeAdapter(analysis({ tasks: nine })),
      enabled: true,
    });
    expect(result.source).toBe('regex_fallback');
    expect(result.fallbackReason).toBe('invalid_output');
  });

  it('does not call the model when the kill switch is off', async () => {
    const seen: ModelInvokeInput[] = [];
    const result = await analyseQuoteSelection({
      selection,
      adapter: fakeAdapter(analysis(), seen),
      enabled: false,
    });
    expect(seen).toHaveLength(0);
    expect(result.source).toBe('regex_fallback');
    expect(result.fallbackReason).toBe('disabled');
  });
});

describe('quoteWorkflowLlmEnabled', () => {
  it('defaults on only when Azure env is present and honours off', () => {
    expect(quoteWorkflowLlmEnabled({})).toBe(false);
    expect(
      quoteWorkflowLlmEnabled({ AZURE_OPENAI_BASE_URL: 'https://x', AZURE_FOUNDRY_API_KEY: 'k' }),
    ).toBe(true);
    expect(
      quoteWorkflowLlmEnabled({
        AZURE_OPENAI_BASE_URL: 'https://x',
        AZURE_FOUNDRY_API_KEY: 'k',
        QUOTE_WORKFLOW_LLM: 'off',
      }),
    ).toBe(false);
    expect(quoteWorkflowLlmEnabled({ QUOTE_WORKFLOW_LLM: 'on' })).toBe(true);
    expect(() => quoteWorkflowLlmEnabled({ QUOTE_WORKFLOW_LLM: 'maybe' })).toThrow(
      /QUOTE_WORKFLOW_LLM/,
    );
  });
});

describe('LunaModelAdapter effort + completion', () => {
  function fakeModel(finish: string, captured: unknown[]) {
    return {
      doGenerate: async (options: unknown) => {
        captured.push(options);
        return {
          content: [{ type: 'text', text: '{"ok":true}' }],
          finishReason: { unified: finish, raw: finish },
          usage: { inputTokens: { total: 3 }, outputTokens: { total: 4 } },
          warnings: [],
        };
      },
    } as never;
  }

  it('passes the configured reasoning effort and strictJsonSchema false', async () => {
    const captured: Array<{ providerOptions: { openai: Record<string, unknown> } }> = [];
    const adapter = new LunaModelAdapter({
      model: fakeModel('stop', captured),
      reasoningEffort: 'medium',
      routeId: 'azure_quote',
    });
    const result = await adapter.invoke({
      modelId: 'gpt-6-luna',
      systemPrompt: 's',
      userPrompt: 'u',
      responseSchema: {},
    });
    expect(captured[0]?.providerOptions.openai.reasoningEffort).toBe('medium');
    expect(captured[0]?.providerOptions.openai.strictJsonSchema).toBe(false);
    expect(result.provenance?.routeId).toBe('azure_quote');
    expect(result.provenance?.protocol).toContain('medium');
  });

  it('fails closed when the response is incomplete', async () => {
    const adapter = new LunaModelAdapter({
      model: fakeModel('length', []),
      reasoningEffort: 'medium',
    });
    await expect(
      adapter.invoke({ modelId: 'm', systemPrompt: 's', userPrompt: 'u' }),
    ).rejects.toThrow(/incomplete/);
  });
});

describe('partyNotGuest', () => {
  it('drops a company that is one of the guests', () => {
    expect(
      partyNotGuest({
        groups: [{ ...group, guestNames: ['Karen  Vickers'] }],
        party: { kind: 'organization', name: 'karen vickers', reference: null },
      }),
    ).toEqual({ kind: null, name: null, reference: null });
  });

  it('keeps a real company and a private party', () => {
    const company = { kind: 'organization' as const, name: 'Purple Surgical', reference: null };
    expect(partyNotGuest({ groups: [{ ...group, guestNames: ['Karen Vickers'] }], party: company })).toEqual(company);
    const person = { kind: 'private' as const, name: 'Ann Example', reference: null };
    expect(partyNotGuest({ groups: [group], party: person })).toEqual(person);
  });

  it('rejects an organisation candidate that embeds a guest full name', () => {
    expect(
      partyNotGuest({
        groups: [{ ...group, guestNames: ['Karen Vickers'] }],
        party: { kind: 'organization', name: 'Karen Vickers Travel', reference: null },
      }),
    ).toMatchObject({ kind: null, name: null });
  });
});


import {
  analyseQuoteSelection,
  buildQuoteWorkflowPrompt,
  mapLlmDecision,
  quoteWorkflowLlmEnabled,
} from '../src/ai/quote-workflow-llm.js';
import { CENTURION_HOTEL_RULES, lunaAnalysisSchema } from '../src/ai/reservationist-decision.js';
import type { SyncedQuoteSelection } from '../src/ai/quote-workflow-synced-selection.js';
import type { ModelAdapter, ModelInvokeInput } from '../src/ai/bedrock/adapter.js';
import { LunaModelAdapter } from '../src/ai/bedrock/luna.js';
import { describe, expect, it } from 'vitest';

const group = {
  arrival: '2026-11-12',
  departure: '2026-11-14',
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

describe('lunaAnalysisSchema', () => {
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
    expect(prompt.user).toContain('2026-10-06');
    expect(prompt.user).toContain('Earlier: we need rooms in November.');
    expect(prompt.user).toContain('Guest list: Ann, Bob');
    expect(prompt.user).toContain('rooming.pdf');
  });
});

describe('mapLlmDecision', () => {
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
    expect(JSON.stringify(mapped)).not.toMatch(/price|rate"|amount/i);
  });

  it('maps create_booking to intent quote and leaves groups in place', () => {
    const mapped = mapLlmDecision(
      lunaAnalysisSchema.parse(analysis({ workflow: 'create_booking' })),
    );
    expect(mapped.intent).toBe('quote');
    expect(mapped.groups).toHaveLength(1);
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
    expect(mapped.groups[0]?.board).toBe('unknown');
    expect(mapped.groups[0]?.fields.board).toBe('missing');
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
        board: 'unknown',
        specialRequests: [],
        fields: {
          arrivalDate: 'missing',
          departureDate: 'missing',
          quantity: 'missing',
          adults: 'missing',
          board: 'missing',
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

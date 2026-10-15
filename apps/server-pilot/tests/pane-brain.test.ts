import { readFileSync } from 'node:fs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { RequestContext } from '@mastra/core/request-context';
import { createTool } from '@mastra/core/tools';
import { z } from 'zod';

const analyseSelectionWithAgent = vi.hoisted(() => vi.fn());

vi.mock('../src/ai/agent-pane-adapter.js', () => ({
  analyseSelectionWithAgent,
  agentDecisionToLunaAnalysis: vi.fn(),
}));

vi.mock('../src/ai/bedrock/luna.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/ai/bedrock/luna.js')>();
  return {
    ...actual,
    createAzureLunaModel: () => 'azure-luna-test',
  };
});

import { analyseWithPaneBrain, paneBrain } from '../src/ai/pane-brain.js';
import {
  CENTURION_HOTEL_RULES,
  createReservationistAgent,
  type ReservationistRunners,
  assertAopToolsReadOnly,
  createReservationistTools,
} from '../src/ai/reservationist-agent.js';
import { lunaAnalysisSchema } from '../src/ai/reservationist-decision.js';
import type { SyncedQuoteSelection } from '../src/ai/quote-workflow-synced-selection.js';

const selection: SyncedQuoteSelection = {
  subject: 'Rooms',
  bodyText: 'Please quote two rooms 12-14 November.',
  receivedAt: '2026-10-06T08:00:00.000Z',
  preceding: [],
  attachments: [],
};

function quoteLuna() {
  return lunaAnalysisSchema.parse({
    workflow: 'quote',
    flags: [],
    groups: [
      {
        arrival: '2026-11-12',
        departure: '2026-11-14',
        dateEvidence: null,
        rooms: 1,
        adultsPerRoom: 1,
        childAges: [],
        board: 'bb',
        roomPreference: null,
        guestNames: [],
      },
    ],
    party: { kind: 'organization', name: 'Acme Mining', reference: null },
    rateClaims: [],
    missing: [],
    evidence: [],
    tasks: [{ kind: 'quote', groupIndexes: [0], note: 'quote' }],
  });
}

function quoteAdapter() {
  return {
    invoke: async () => ({
      modelId: 'gpt-6-luna',
      output: quoteLuna(),
      usage: {
        inputTokens: 1,
        outputTokens: 1,
        totalTokens: 2,
        latencyMs: 1,
        estimatedCostUsd: 0,
        rateTableVersion: 't',
      },
    }),
  };
}

function fakeRunners(): ReservationistRunners {
  return {
    quote: vi.fn(async () => ({})),
    party: vi.fn(async () => ({})),
    pdf: vi.fn(async () => ({ fileName: 'q.pdf', path: '/tmp/q.pdf', bytes: 1 })),
    validateCreate: vi.fn(async () => ({ ok: true, errors: [] })),
  };
}

function ctx() {
  return new RequestContext<unknown>([
    ['propertyCode', 'HRCEN'],
    ['hotelRules', CENTURION_HOTEL_RULES],
    ['liveQuoteOk', false],
  ]);
}

describe('paneBrain', () => {
  it('defaults to classifier unless PANE_BRAIN is exactly agent', () => {
    expect(paneBrain({})).toBe('classifier');
    expect(paneBrain({ PANE_BRAIN: undefined })).toBe('classifier');
    expect(paneBrain({ PANE_BRAIN: '' })).toBe('classifier');
    expect(paneBrain({ PANE_BRAIN: 'classifier' })).toBe('classifier');
    expect(paneBrain({ PANE_BRAIN: 'off' })).toBe('classifier');
    expect(paneBrain({ PANE_BRAIN: 'AGENT' })).toBe('classifier');
    expect(paneBrain({ PANE_BRAIN: 'agent' })).toBe('agent');
  });
});

describe('analyseWithPaneBrain producer', () => {
  afterEach(() => {
    analyseSelectionWithAgent.mockReset();
  });

  it('uses the classifier producer when the flag is unset', async () => {
    const result = await analyseWithPaneBrain({
      selection,
      adapter: quoteAdapter(),
      enabled: true,
      env: {},
    });
    expect(analyseSelectionWithAgent).not.toHaveBeenCalled();
    expect(result).toMatchObject({ source: 'luna', analysis: { workflow: 'quote' } });
  });

  it('uses the agent producer with Azure Luna and no HMS runners when PANE_BRAIN=agent', async () => {
    const analysis = quoteLuna();
    analyseSelectionWithAgent.mockResolvedValue({ source: 'luna', analysis });
    const result = await analyseWithPaneBrain({
      selection,
      adapter: quoteAdapter(),
      enabled: true,
      deadlineMs: 25_000,
      treatAs: 'quote',
      staffNote: 'staff note',
      env: { PANE_BRAIN: 'agent' },
    });
    expect(analyseSelectionWithAgent).toHaveBeenCalledOnce();
    const arg = analyseSelectionWithAgent.mock.calls[0]?.[0] as {
      selection: SyncedQuoteSelection;
      model: unknown;
      deadlineMs?: number;
      treatAs?: string;
      staffNote?: string;
      runners?: unknown;
    };
    expect(arg.selection).toBe(selection);
    expect(arg.model).toBe('azure-luna-test');
    expect(arg.deadlineMs).toBe(25_000);
    expect(arg.treatAs).toBe('quote');
    expect(arg.staffNote).toBe('staff note');
    expect(arg.runners).toBeUndefined();
    expect(result).toEqual({ source: 'luna', analysis });
  });

  it('fail-softs to regex fallback when the agent producer throws', async () => {
    analyseSelectionWithAgent.mockRejectedValue(new Error('model down'));
    const result = await analyseWithPaneBrain({
      selection,
      adapter: quoteAdapter(),
      enabled: true,
      env: { PANE_BRAIN: 'agent' },
    });
    expect(result).toEqual({ source: 'regex_fallback', fallbackReason: 'error' });
  });
});

describe('reservationist agent SOP and tool hooks', () => {
  it('omits HMS tools when runners are absent', async () => {
    const agent = createReservationistAgent({ model: 'openai/gpt-5' });
    expect(Object.keys(await agent.listTools())).toEqual([]);
  });

  it('appends aopSops to agent instructions', async () => {
    const agent = createReservationistAgent({
      model: 'openai/gpt-5',
      runners: fakeRunners(),
      aopSops: {
        quote: 'Bind party before BAR.',
        skip: 'OTA and system mail: no action.',
      },
    });
    const instructions = String(await agent.getInstructions({ requestContext: ctx() }));
    expect(instructions).toContain('Bind party before BAR.');
    expect(instructions).toContain('OTA and system mail: no action.');
  });

  it('merges registered aopTools into the toolset', async () => {
    const folioRead = createTool({
      id: 'aop_folio_read',
      description: 'Read-only folio lookup.',
      inputSchema: z.object({ confirmationNumber: z.string() }),
      execute: async () => ({ ok: true }),
    });
    const registry = { aop_folio_read: folioRead };
    expect(assertAopToolsReadOnly({ aop_folio_read: folioRead }, registry)).toEqual(registry);
    const tools = createReservationistTools(fakeRunners(), { aop_folio_read: folioRead }, registry);
    expect(Object.keys(tools).sort()).toEqual([
      'aop_folio_read',
      'create_reservation_dry_run',
      'party_lookup',
      'quote_proposal_pdf',
      'quote_stay',
    ]);
  });

  it('refuses aopTools that are not the exact registered objects', () => {
    const tool = (id: string) =>
      createTool({ id, description: 'x', inputSchema: z.object({}), execute: async () => ({}) });
    const registered = tool('aop_folio_read');
    // An unregistered tool under an allowed-looking id is refused.
    expect(() =>
      createReservationistAgent({ model: 'openai/gpt-5', runners: fakeRunners(), aopTools: { aop_folio_read: tool('aop_folio_read') } }),
    ).toThrow(/AOP_TOOL_REFUSED/);
    // A different object under a registered key is refused.
    expect(() =>
      assertAopToolsReadOnly({ aop_folio_read: tool('aop_folio_read') }, { aop_folio_read: registered }),
    ).toThrow(/AOP_TOOL_REFUSED/);
    for (const id of ['send_reply', 'hms_cancel_reservation']) {
      expect(() =>
        createReservationistAgent({ model: 'openai/gpt-5', runners: fakeRunners(), aopTools: { [id]: tool(id) } }),
      ).toThrow(/AOP_TOOL_REFUSED/);
    }
  });
});

describe('pane-brain source guards', () => {
  it('wires Azure GPT-6 Luna, never Bedrock createLunaModel', () => {
    const src = readFileSync(new URL('../src/ai/pane-brain.ts', import.meta.url), 'utf8');
    expect(src).toMatch(/createAzureLunaModel/);
    expect(src).not.toMatch(/createLunaModel\(/);
  });

  it('analyseSyncedSelection call site uses analyseWithPaneBrain', () => {
    const src = readFileSync(
      new URL('../src/ai/quote-workflow-analyse-selection.ts', import.meta.url),
      'utf8',
    );
    expect(src).toMatch(/analyseWithPaneBrain\(/);
    expect(src).toMatch(/from '\.\/pane-brain\.js'/);
  });
});

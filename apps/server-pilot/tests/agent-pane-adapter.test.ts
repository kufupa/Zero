import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  lunaAnalysisSchema,
  RESERVATIONIST_WORKFLOWS,
  type LunaAnalysis,
  type ReservationistDecision,
} from '../src/ai/reservationist-decision.js';
import type { SyncedQuoteSelection } from '../src/ai/quote-workflow-synced-selection.js';
import type { ReservationistRunners } from '../src/ai/reservationist-agent.js';

const mocks = vi.hoisted(() => ({
  generate: vi.fn(),
  createReservationistAgent: vi.fn(() => ({ generate: mocks.generate })),
}));

vi.mock('../src/ai/reservationist-agent.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/ai/reservationist-agent.js')>();
  return {
    ...actual,
    createReservationistAgent: mocks.createReservationistAgent,
  };
});

import {
  agentDecisionToLunaAnalysis,
  analyseSelectionWithAgent,
} from '../src/ai/agent-pane-adapter.js';
import { createReservationistAgent } from '../src/ai/reservationist-agent.js';

const LUNA_WORKFLOW: Record<ReservationistDecision['workflow'], LunaAnalysis['workflow']> = {
  quote: 'quote',
  create: 'create_booking',
  skip: 'skip',
  spam: 'skip',
  other: 'other',
  amend: 'amend',
  cancel: 'cancel',
  forward_to_partner: 'forward_to_partner',
  send_document: 'send_document',
  payment_ack: 'payment_ack',
  clarify: 'clarify',
  acknowledge: 'acknowledge',
  hms_todo: 'hms_todo',
};

const selection: SyncedQuoteSelection = {
  subject: 'Stay request',
  bodyText:
    'Please quote two rooms arriving 2026-11-12 leaving 2026-11-14. Confirmation 57291630-1.',
  receivedAt: '2026-10-06T08:00:00.000Z',
  preceding: [{ bodyText: 'Earlier thread note about November.' }],
  attachments: [{ id: 'a1', filename: 'request.txt', bytesPresent: false, text: 'Attachment note.' }],
  messageId: 'msg-synth-1',
  fromAddress: 'guest@example.com',
};

function decision(
  workflow: ReservationistDecision['workflow'],
  overrides: Partial<ReservationistDecision> = {},
): ReservationistDecision {
  return {
    workflow,
    stayAsk: null,
    missing: [],
    replyDraft: '',
    rationale: 'Synthetic fixture.',
    ...overrides,
  };
}

function fakeRunners(): ReservationistRunners {
  return {
    quote: vi.fn(async () => ({ status: 'unavailable' })),
    party: vi.fn(async () => ({ status: 'unavailable' })),
    pdf: vi.fn(async () => {
      throw new Error('pdf writes off');
    }),
    validateCreate: vi.fn(async () => ({ ok: false, errors: ['writes off'] })),
  };
}

describe('agentDecisionToLunaAnalysis', () => {
  it.each([...RESERVATIONIST_WORKFLOWS])('maps agent workflow %s onto lunaAnalysisSchema', (workflow) => {
    const analysis = agentDecisionToLunaAnalysis(decision(workflow), selection);
    expect(lunaAnalysisSchema.parse(analysis).workflow).toBe(LUNA_WORKFLOW[workflow]);
  });

  it('maps agent skip and spam onto luna skip, not other', () => {
    expect(agentDecisionToLunaAnalysis(decision('skip'), selection).workflow).toBe('skip');
    expect(agentDecisionToLunaAnalysis(decision('spam'), selection).workflow).toBe('skip');
  });

  it('folds stayAsk into one luna group with per-room adults', () => {
    const analysis = agentDecisionToLunaAnalysis(
      decision('quote', {
        stayAsk: {
          arrivalDate: '2026-11-12',
          departureDate: '2026-11-14',
          adults: 4,
          children: 0,
          rooms: 2,
        },
      }),
      selection,
    );
    const parsed = lunaAnalysisSchema.parse(analysis);
    expect(parsed.groups).toEqual([
      {
        arrival: '2026-11-12',
        departure: '2026-11-14',
        dateEvidence: null,
        rooms: 2,
        adultsPerRoom: 2,
        childAges: [],
        board: null,
        roomPreference: null,
        guestNames: [],
      },
    ]);
    expect(parsed.workflow).toBe('quote');
  });

  it('keeps confirmation numbers that appear in the selection and drops invented ones', () => {
    const kept = agentDecisionToLunaAnalysis(
      decision('amend', { confirmationNumber: '57291630-1', requestedChange: 'Add a night' }),
      selection,
    );
    expect(lunaAnalysisSchema.parse(kept).confirmationNumber).toBe('57291630-1');
    expect(kept.requestedChange).toBe('Add a night');

    const dropped = agentDecisionToLunaAnalysis(
      decision('amend', { confirmationNumber: '99999999-1' }),
      selection,
    );
    expect(lunaAnalysisSchema.parse(dropped).confirmationNumber).toBeNull();
  });

  it('maps missing strings and hms_todo fields onto luna missing rows', () => {
    const analysis = agentDecisionToLunaAnalysis(
      decision('hms_todo', {
        missing: ['arrival'],
        todoTarget: 'post_payment',
        todoReason: 'POP posting is staff-only.',
        todoNextStep: 'Staff posts payment on the folio.',
      }),
      selection,
    );
    const parsed = lunaAnalysisSchema.parse(analysis);
    expect(parsed.missing).toEqual(
      expect.arrayContaining([
        { field: 'arrival', question: 'arrival' },
        {
          field: 'post_payment',
          question: 'POP posting is staff-only. Staff posts payment on the folio.',
        },
      ]),
    );
  });

  it('copies hms_todo create onto analysis.todoTarget', () => {
    const parsed = lunaAnalysisSchema.parse(
      agentDecisionToLunaAnalysis(decision('hms_todo', { todoTarget: 'create' }), selection),
    );
    expect(parsed.workflow).toBe('hms_todo');
    expect(parsed.todoTarget).toBe('create');
  });
});

describe('analyseSelectionWithAgent', () => {
  const azureModel = { id: 'azure-luna-sentinel' };

  beforeEach(() => {
    mocks.generate.mockReset();
    mocks.createReservationistAgent.mockClear();
  });

  it('returns regex_fallback agent_error when generate throws', async () => {
    mocks.generate.mockRejectedValueOnce(new Error('model down'));
    const result = await analyseSelectionWithAgent({
      selection,
      model: azureModel,
      runners: fakeRunners(),
    });
    expect(result).toMatchObject({ source: 'regex_fallback', fallbackReason: 'agent_error' });
    expect(createReservationistAgent).toHaveBeenCalledWith(
      expect.objectContaining({ model: azureModel }),
    );
  });

  it('maps a successful agent decision onto source luna', async () => {
    mocks.generate.mockResolvedValueOnce({
      object: decision('quote', {
        stayAsk: {
          arrivalDate: '2026-11-12',
          departureDate: '2026-11-14',
          adults: 2,
          children: 0,
          rooms: 1,
        },
      }),
      usage: {},
      steps: [],
    });
    const result = await analyseSelectionWithAgent({
      selection,
      model: azureModel,
      runners: fakeRunners(),
      treatAs: 'quote',
      staffNote: 'Use the November dates.',
    });
    expect(result.source).toBe('luna');
    if (result.source === 'luna') {
      expect(lunaAnalysisSchema.parse(result.analysis).workflow).toBe('quote');
      expect(result.analysis.groups[0]?.rooms).toBe(1);
    }
    const prompt = String(mocks.generate.mock.calls.at(-1)?.[0] ?? '');
    expect(prompt).toContain(selection.subject);
    expect(prompt).toContain(selection.bodyText);
    expect(prompt).toContain('Use the November dates.');
    expect(prompt).toContain('Attachment note.');
  });
});

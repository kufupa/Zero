import { describe, expect, it } from 'vitest';
import {
  AOP_QUOTE_SPINE,
  aopQuoteDelivery,
  aopQuoteDraftClauses,
  aopQuoteInstructions,
  baselineQuoteRatePlan,
  decideAopQuoteRatePlan,
  isAopPartyBound,
} from '../src/ai/aop-playbook.js';
import { buildQuoteWorkflowPrompt, mapLlmDecision } from '../src/ai/quote-workflow-llm.js';
import { lunaAnalysisSchema } from '../src/ai/reservationist-decision.js';
import {
  CENTURION_HOTEL_RULES,
  createReservationistAgent,
} from '../src/ai/reservationist-agent.js';
import { buildReplyPlaybook } from '../src/ai/reply-playbooks.js';
import { RequestContext } from '@mastra/core/request-context';
import type { SyncedQuoteSelection } from '../src/ai/quote-workflow-synced-selection.js';

const selection: SyncedQuoteSelection = {
  subject: 'Rooms',
  bodyText: 'Please quote two rooms 12-14 November.',
  receivedAt: '2026-10-06T08:00:00.000Z',
  preceding: [],
  attachments: [],
};

function quoteAnalysis(party: {
  kind: 'agency' | 'organization' | 'government' | 'private' | null;
  name: string | null;
}) {
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
    party: { kind: party.kind, name: party.name, reference: null },
    rateClaims: [],
    missing: [],
    evidence: [],
    tasks: [{ kind: 'quote', groupIndexes: [0], note: 'quote' }],
  });
}

describe('AOP-1 quote spine vs baseline', () => {
  it('bound party does not label the rate as public or BAR, unlike baseline', () => {
    const baseline = baselineQuoteRatePlan();
    const aop = decideAopQuoteRatePlan({ partyBound: true });

    expect(baseline.staffLabel).toMatch(/public|BAR/i);
    expect(aop.staffLabel).not.toMatch(/public|BAR/i);
    expect(aop.source).toBe('party_contract');
    expect(aop.staffLabel).not.toBe(baseline.staffLabel);
  });

  it('missing party says public rate', () => {
    expect(isAopPartyBound({ kind: null, name: null })).toBe(false);
    expect(decideAopQuoteRatePlan({ partyBound: false }).staffLabel).toMatch(/public rate/i);
    expect(decideAopQuoteRatePlan({ partyBound: false }).source).toBe('public_bar');
  });

  it('OTA and system channels skip the hotel quote', () => {
    expect(decideAopQuoteRatePlan({ partyBound: true, channel: 'ota' }).skipQuote).toBe(true);
    expect(decideAopQuoteRatePlan({ partyBound: false, channel: 'system' }).skipQuote).toBe(true);
    expect(decideAopQuoteRatePlan({ partyBound: false, channel: 'direct' }).skipQuote).toBe(false);
  });

  it('delivery is unsent draft, human approval, HMS writes off, never auto-send', () => {
    expect(AOP_QUOTE_SPINE).toMatchObject({
      id: 'AOP-1',
      autoSend: false,
      hmsWrites: false,
      humanApprovalRequired: true,
      draftDelivery: 'unsent_draft',
      skipOta: true,
      partyContractBeforeBar: true,
    });
    expect(aopQuoteDelivery()).toEqual({
      autoSend: false,
      hmsWrites: false,
      humanApprovalRequired: true,
      draftDelivery: 'unsent_draft',
    });
  });
});

describe('AOP-1 injected into analyse / prefill / draft', () => {
  it('mapLlmDecision labels a bound party as contract, not public/BAR', () => {
    const mapped = mapLlmDecision(
      quoteAnalysis({ kind: 'organization', name: 'Acme Mining' }),
    );
    expect(mapped.ratePlan.source).toBe('party_contract');
    expect(mapped.ratePlan.staffLabel).not.toMatch(/public|BAR/i);
    expect(mapped.delivery.autoSend).toBe(false);
    expect(mapped.delivery.hmsWrites).toBe(false);
    expect(mapped.delivery.draftDelivery).toBe('unsent_draft');
  });

  it('mapLlmDecision says public rate when the party is missing', () => {
    const mapped = mapLlmDecision(quoteAnalysis({ kind: null, name: null }));
    expect(mapped.ratePlan.source).toBe('public_bar');
    expect(mapped.ratePlan.staffLabel).toMatch(/public rate/i);
  });

  it('analyse prompt carries the AOP-1 spine', () => {
    const prompt = buildQuoteWorkflowPrompt(selection);
    expect(prompt.system).toContain(aopQuoteInstructions());
    expect(prompt.system).toMatch(/party.*contract.*BAR/i);
    expect(prompt.system).toMatch(/never auto-send/i);
    expect(prompt.system).toMatch(/unsent draft/i);
    expect(prompt.system).toMatch(/skip OTA/i);
  });

  it('reservationist agent instructions include AOP-1', async () => {
    const agent = createReservationistAgent({
      model: 'openai/gpt-5',
      runners: {
        quote: async () => ({}),
        party: async () => ({}),
        pdf: async () => ({ fileName: 'q.pdf', path: '/tmp/q.pdf', bytes: 1 }),
        validateCreate: async () => ({ ok: true, errors: [] }),
      },
    });
    const instructions = await agent.getInstructions({
      requestContext: new RequestContext([
        ['propertyCode', 'HRCEN'],
        ['hotelRules', CENTURION_HOTEL_RULES],
        ['liveQuoteOk', false],
      ]),
    });
    expect(String(instructions)).toContain(aopQuoteInstructions());
  });

  it('quote draft playbook records public rate when party is missing and withholds it when bound', () => {
    const missing = buildReplyPlaybook({
      audience: 'guest',
      requestKind: 'quote',
      asks: [{ code: 'price', label: 'quoted price', required: true }],
      facts: [],
    });
    expect(missing.internalNotes.join(' ')).toMatch(/public rate/i);
    expect(missing.internalNotes.join(' ')).toMatch(/unsent draft/i);
    expect(missing.internalNotes.join(' ')).toMatch(/never auto-send/i);

    const bound = buildReplyPlaybook({
      audience: 'guest',
      requestKind: 'quote',
      asks: [{ code: 'price', label: 'quoted price', required: true }],
      facts: [
        {
          key: 'party.organization',
          label: 'Organisation',
          value: 'Acme Mining',
          source: 'hms',
          authority: 'authorized',
          status: 'known',
        },
      ],
    });
    expect(bound.internalNotes.join(' ')).not.toMatch(/public rate|BAR/i);
    expect(bound.internalNotes.join(' ')).toMatch(/party contract/i);
  });

  it('quote draft clauses change vs baseline when a party is bound', () => {
    const baseline = aopQuoteDraftClauses(false);
    const bound = aopQuoteDraftClauses(true);
    expect(baseline.join(' ')).toMatch(/public rate/i);
    expect(bound.join(' ')).not.toMatch(/public|BAR/i);
    expect(bound.join(' ')).toMatch(/unsent draft/i);
  });
});

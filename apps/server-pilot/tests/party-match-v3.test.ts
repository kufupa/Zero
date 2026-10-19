import {
  applyPartyBindV3,
  partyMatchV3Enabled,
  runPartyMatchV3,
  sanitizePartySearchTerms,
  type PartyMatchV3Row,
} from '../src/ai/party-match-v3.js';
import type { PartyMatchCandidate } from '../src/ai/party-match-v2.js';
import type { ModelAdapter, ModelInvokeResult } from '../src/ai/bedrock/adapter.js';
import { describe, expect, it, vi } from 'vitest';

const TOURVEST_IDS = [
  '280',
  '543',
  '6',
  '123',
  '401',
  '402',
  '403',
  '404',
  '405',
  '406',
  '407',
  '408',
  '409',
] as const;

const tourvestAgency = (nativeId: string, extra: Partial<PartyMatchV3Row> = {}): PartyMatchV3Row => ({
  kind: 'agency',
  nativeId,
  name: 'Tourvest Travel Services',
  ...extra,
});

const TOURVEST_COPIES: PartyMatchV3Row[] = TOURVEST_IDS.map((id) => tourvestAgency(id));

const candidate = (name: string, kind: 'company' | 'agency' = 'agency'): PartyMatchCandidate => ({
  name,
  kind,
  source: kind === 'agency' ? 'extraction_agency' : 'extraction_end_client',
  strength: 'strong',
});

const context = {
  fromAddress: 'desk@example.test',
  displayName: null,
  subject: 'Quote request',
  signatureBlock: '',
  extractedNames: ['Tourvest Travel Services'],
  personNames: [],
};

const usage = {
  inputTokens: 1,
  outputTokens: 1,
  totalTokens: 2,
  latencyMs: 1,
  estimatedCostUsd: 0,
  rateTableVersion: 'test',
} as const;

function invokeResult(output: Record<string, unknown>): ModelInvokeResult {
  return { modelId: 'gpt-6-luna', output, usage };
}

function highPick(nativeId: string, kind: 'company' | 'agency' = 'agency') {
  return {
    pickNativeId: nativeId,
    kind,
    confidence: 'high' as const,
    reason: 'Named in the email.',
    alternatives: [] as string[],
    source: 'llm' as const,
  };
}

describe('PARTY_MATCH_V3 flag', () => {
  it('stays off by default and ignores on/falsey values so the V2 path is unchanged', () => {
    expect(partyMatchV3Enabled({})).toBe(false);
    expect(partyMatchV3Enabled({ PARTY_MATCH_V3: undefined })).toBe(false);
    expect(partyMatchV3Enabled({ PARTY_MATCH_V3: 'on' })).toBe(false);
    expect(partyMatchV3Enabled({ PARTY_MATCH_V3: '0' })).toBe(false);
    expect(partyMatchV3Enabled({ PARTY_MATCH_V3: 'false' })).toBe(false);
    expect(partyMatchV3Enabled({ PARTY_MATCH_V3: '1' })).toBe(true);
    expect(partyMatchV3Enabled({ PARTY_MATCH_V3: 'true' })).toBe(true);
  });
});

describe('sanitizePartySearchTerms', () => {
  it('drops empty or 1–2 character terms and dedupes kind+term', () => {
    expect(
      sanitizePartySearchTerms([
        { kind: 'agency', term: '' },
        { kind: 'agency', term: 'x' },
        { kind: 'agency', term: 'ab' },
        { kind: 'agency', term: 'Tourvest' },
        { kind: 'agency', term: ' tourvest ' },
        { kind: 'company', term: 'Tourvest' },
        { kind: 'agency', term: 'Travel With Flair' },
      ]),
    ).toEqual([
      { kind: 'agency', term: 'Tourvest' },
      { kind: 'company', term: 'Tourvest' },
      { kind: 'agency', term: 'Travel With Flair' },
    ]);
  });
});

describe('PARTY MATCH V3 duplicate bind', () => {
  it('lists every same-name copy when no city, IATA, or sender id disambiguates', () => {
    const result = applyPartyBindV3({
      candidates: [candidate('Tourvest Travel Services')],
      rows: [
        ...TOURVEST_COPIES,
        { kind: 'company', nativeId: 'co-1', name: 'Tourvest Travel Services' },
      ],
      pick: highPick('280'),
      emailText: 'Please quote for Tourvest Travel Services.',
    });
    expect(result.matchStatus).toBe('needs_pick');
    expect(result.boundParty).toBeNull();
    expect(result.suggestions.map((row) => row.nativeId)).toEqual([...TOURVEST_IDS, 'co-1']);
  });

  it('keeps an exact different-name row after the duplicate copies', () => {
    const result = applyPartyBindV3({
      candidates: [candidate('Nexus Travel'), candidate('XL Nexus Travel ATNS')],
      rows: [
        { kind: 'agency', nativeId: 'exact', name: 'Nexus Travel' },
        { kind: 'agency', nativeId: '1', name: 'XL Nexus Travel ATNS' },
        { kind: 'agency', nativeId: '2', name: 'XL Nexus Travel ATNS' },
      ],
      pick: highPick('1'),
      emailText: 'Please quote for Nexus Travel.',
    });
    expect(result.matchStatus).toBe('needs_pick');
    expect(result.suggestions.map((row) => row.nativeId)).toEqual(['1', '2', 'exact']);
  });

  it('binds the Cape Town copy when the email names that city and only one copy has it', () => {
    const rows = TOURVEST_COPIES.map((row) =>
      row.nativeId === '543' ? tourvestAgency('543', { city: 'Cape Town' }) : { ...row, city: 'Johannesburg' },
    );
    const result = applyPartyBindV3({
      candidates: [candidate('Tourvest Travel Services')],
      rows,
      pick: highPick('280'),
      emailText: 'Please quote Cape Town inventory for next month.',
    });
    expect(result).toMatchObject({
      matchStatus: 'bound',
      boundParty: { kind: 'agency', nativeId: '543', name: 'Tourvest Travel Services' },
    });
  });

  it('binds the copy named by sender history when columns do not separate the duplicates', () => {
    const result = applyPartyBindV3({
      candidates: [candidate('Tourvest Travel Services')],
      rows: TOURVEST_COPIES,
      pick: highPick('280'),
      emailText: 'Please quote for Tourvest Travel Services.',
      senderHistory: [{ kind: 'agency', nativeId: '6' }],
    });
    expect(result).toMatchObject({
      matchStatus: 'bound',
      boundParty: { nativeId: '6', kind: 'agency' },
    });
  });
});

describe('PARTY MATCH V3 reservationist loop', () => {
  it('runs round 2 with at most three terms after an empty round 1, then stops', async () => {
    const findParty = vi.fn(async (searches: ReadonlyArray<{ kind: string; term: string }>) =>
      searches.map((search) => ({
        outcome: 'resolved' as const,
        results: [tourvestAgency('280')],
        truncated: false,
        searchedFor: search.term,
      })),
    );
    const adapter: ModelAdapter = {
      invoke: vi.fn(async (input) => {
        if (input.systemPrompt.includes('Propose')) {
          return invokeResult({ searches: [{ kind: 'agency', term: 'x' }] });
        }
        if (String(input.userPrompt).includes('"returnedRows":[]')) {
          return invokeResult({
            pick: null,
            kind: null,
            confidence: 'low',
            reason: 'No rows yet.',
            nextTerms: [
              { kind: 'agency', term: 'Tourvest' },
              { kind: 'agency', term: 'Travel With Flair' },
              { kind: 'agency', term: 'Rennies' },
              { kind: 'agency', term: 'WebBeds' },
              { kind: 'agency', term: 'Cullinan' },
            ],
          });
        }
        return invokeResult({
          pick: '280',
          kind: 'agency',
          confidence: 'high',
          reason: 'Exact agency name.',
          nextTerms: [{ kind: 'agency', term: 'should-not-run' }],
        });
      }),
    };

    const result = await runPartyMatchV3({
      adapter,
      candidates: [candidate('Tourvest Travel Services')],
      context,
      emailText: 'Please quote for Tourvest Travel Services.',
      findParty,
    });

    expect(findParty).toHaveBeenCalledTimes(1);
    expect(findParty.mock.calls[0]?.[0]).toEqual([
      { kind: 'agency', term: 'Tourvest' },
      { kind: 'agency', term: 'Travel With Flair' },
      { kind: 'agency', term: 'Rennies' },
    ]);
    expect(adapter.invoke).toHaveBeenCalledTimes(3);
    expect(result.matchVersion).toBe(2);
    expect(result.matcher).toBe('v3');
    expect(result.pickSource).toBe('llm');
    expect(result.boundParty?.nativeId).toBe('280');
  });

  it('falls back to the V2 deterministic picker when the model throws', async () => {
    const findParty = vi.fn(async (searches: ReadonlyArray<{ kind: string; term: string }>) =>
      searches.map((search) => ({
        outcome: 'resolved' as const,
        results: [{ kind: 'agency' as const, nativeId: '280', name: 'Tourvest Travel Services' }],
        truncated: false,
        searchedFor: search.term,
      })),
    );
    const adapter: ModelAdapter = {
      invoke: vi.fn(async () => {
        throw new Error('model unavailable');
      }),
    };

    const result = await runPartyMatchV3({
      adapter,
      candidates: [candidate('Tourvest Travel Services')],
      context,
      emailText: 'Please quote for Tourvest Travel Services.',
      findParty,
    });

    expect(findParty).toHaveBeenCalledTimes(1);
    expect(result).toMatchObject({
      matchVersion: 2,
      matcher: 'v3',
      pickSource: 'fallback',
      matchStatus: 'bound',
      boundParty: { nativeId: '280', kind: 'agency' },
    });
  });

  it('still searches a two-letter extracted name when the model is unavailable', async () => {
    const findParty = vi.fn(async (searches: ReadonlyArray<{ kind: string; term: string }>) =>
      searches.map((search) => ({
        outcome: 'resolved' as const,
        results: [{ kind: 'agency' as const, nativeId: 'ey', name: 'EY' }],
        truncated: false,
        searchedFor: search.term,
      })),
    );

    const result = await runPartyMatchV3({
      adapter: null,
      candidates: [candidate('EY')],
      context: { ...context, extractedNames: ['EY'] },
      emailText: 'Please quote for EY.',
      findParty,
    });

    expect(findParty).toHaveBeenCalled();
    expect(findParty.mock.calls[0]?.[0]).toEqual(
      expect.arrayContaining([{ kind: 'agency', term: 'EY' }]),
    );
    expect(result.boundParty).toMatchObject({ nativeId: 'ey', kind: 'agency' });
  });
});

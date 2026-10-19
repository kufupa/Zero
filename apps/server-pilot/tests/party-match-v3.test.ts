import {
  applyPartyBindV3,
  partyMatchV3Enabled,
  runPartyMatchV3,
  sanitizePartySearchTerms,
  type PartyMatchV3Row,
} from '../src/ai/party-match-v3.js';
import {
  normalisePartyName,
  pickPartyMatch,
  type PartyMatchCandidate,
} from '../src/ai/party-match-v2.js';
import type { ModelAdapter, ModelInvokeResult } from '../src/ai/bedrock/adapter.js';
import { describe, expect, it, vi, beforeEach } from 'vitest';

vi.mock('../src/ai/party-match-v2.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/ai/party-match-v2.js')>();
  return {
    ...actual,
    pickPartyMatch: vi.fn(actual.pickPartyMatch),
  };
});

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

  it('drops own-brand and country-only searches but keeps distinctive party terms', () => {
    expect(
      sanitizePartySearchTerms([
        { kind: 'agency', term: 'Legacy Hotels' },
        { kind: 'agency', term: 'Argentina' },
        { kind: 'agency', term: 'South Africa' },
        { kind: 'agency', term: 'Nexus' },
      ]),
    ).toEqual([{ kind: 'agency', term: 'Nexus' }]);
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

  it('binds a unique same-kind token match from name-only sender history', () => {
    const result = applyPartyBindV3({
      candidates: [
        candidate('Nexus Travel'),
        {
          name: 'XL Nexus',
          kind: 'agency',
          source: 'sender_history',
          strength: 'strong',
        },
      ],
      rows: [
        { kind: 'agency', nativeId: 'nexus', name: 'XL Nexus' },
        { kind: 'agency', nativeId: 'other', name: 'Beacon Agency' },
        { kind: 'company', nativeId: 'company', name: 'XL Nexus' },
      ],
      pick: highPick('other'),
      emailText: 'Please quote for Nexus Travel.',
      senderHistory: [{ kind: 'agency', nativeId: null, name: 'XL Nexus' }] as never,
    });

    expect(result).toMatchObject({
      matchStatus: 'bound',
      boundParty: { nativeId: 'nexus', kind: 'agency' },
    });
  });

  it('does not bind name-only history when multiple same-kind rows share its token', () => {
    const result = applyPartyBindV3({
      candidates: [
        candidate('Tourvest Travel Services'),
        {
          name: 'Tourvest Travel Services',
          kind: 'agency',
          source: 'sender_history',
          strength: 'strong',
        },
      ],
      rows: TOURVEST_COPIES.slice(0, 2),
      pick: highPick('280'),
      emailText: 'Please quote for Tourvest Travel Services.',
      senderHistory: [
        { kind: 'agency', nativeId: null, name: 'Tourvest Travel Services' },
      ] as never,
    });

    expect(result.matchStatus).toBe('needs_pick');
    expect(result.boundParty).toBeNull();
  });
});

describe('PARTY MATCH V3 reservationist loop', () => {
  it('uses sender history to bind the matching duplicate copy through the full loop', async () => {
    const findParty = vi.fn(async (searches: ReadonlyArray<{ kind: string; term: string }>) =>
      searches.map((search) => ({
        outcome: 'resolved' as const,
        results: TOURVEST_COPIES,
        truncated: false,
        searchedFor: search.term,
      })),
    );

    const adapter: ModelAdapter = {
      invoke: vi.fn(async (input) =>
        input.systemPrompt.includes('Propose')
          ? invokeResult({ searches: [{ kind: 'agency', term: 'Tourvest' }] })
          : invokeResult({
              pick: '280',
              kind: 'agency',
              confidence: 'high',
              reason: 'Exact party name.',
            }),
      ),
    };
    const result = await runPartyMatchV3({
      adapter,
      candidates: [candidate('Tourvest Travel Services')],
      context,
      emailText: 'Please quote for Tourvest Travel Services.',
      senderHistory: [{ kind: 'agency', nativeId: '6' }],
      findParty,
    });

    expect(findParty).toHaveBeenCalled();
    expect(result).toMatchObject({
      matcher: 'v3',
      matchStatus: 'bound',
      boundParty: { kind: 'agency', nativeId: '6' },
    });
  });

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

  it('searches the distinctive word in round 2 when a full name returned 0 rows and the model echoes it', async () => {
    const findParty = vi.fn(async (searches: ReadonlyArray<{ kind: string; term: string }>) =>
      searches.map((search) => ({
        outcome: search.term === 'Limits' ? ('resolved' as const) : ('no_match' as const),
        results:
          search.term === 'Limits'
            ? [{ kind: 'agency' as const, nativeId: '119', name: 'No Limits Travel & Tours' }]
            : [],
        truncated: false,
        searchedFor: search.term,
      })),
    );
    const adapter: ModelAdapter = {
      invoke: vi.fn(async (input) => {
        if (input.systemPrompt.includes('Propose')) {
          return invokeResult({
            searches: [{ kind: 'agency', term: 'No Limits Travel & Tours' }],
          });
        }
        if (String(input.userPrompt).includes('"returnedRows":[]')) {
          return invokeResult({
            pick: null,
            kind: null,
            confidence: 'low',
            reason: 'No rows.',
            nextTerms: [{ kind: 'agency', term: 'No Limits Travel & Tours' }],
          });
        }
        return invokeResult({
          pick: '119',
          kind: 'agency',
          confidence: 'high',
          reason: 'Distinctive word hit.',
        });
      }),
    };

    const result = await runPartyMatchV3({
      adapter,
      candidates: [candidate('No Limits Travel & Tours')],
      context: { ...context, extractedNames: ['No Limits Travel & Tours'] },
      emailText: 'Please quote for No Limits Travel & Tours.',
      findParty,
    });

    const firstPick = vi
      .mocked(adapter.invoke)
      .mock.calls.find(([input]) => input.systemPrompt.includes('Pick the HMS party'))?.[0];
    expect(String(firstPick?.userPrompt)).toContain('"returned":0');
    expect(firstPick?.systemPrompt.toLowerCase()).toMatch(/distinctive/);
    expect(firstPick?.systemPrompt.toLowerCase()).toMatch(/never repeat/);
    expect(findParty).toHaveBeenCalledTimes(2);
    expect(findParty.mock.calls[0]?.[0]).toEqual([
      { kind: 'agency', term: 'No Limits Travel & Tours' },
    ]);
    expect(findParty.mock.calls[1]?.[0]).toEqual([{ kind: 'agency', term: 'Limits' }]);
    expect(result.matchVersion).toBe(2);
    expect(result.boundParty).toMatchObject({ nativeId: '119', kind: 'agency' });
  });

  it('never re-searches a term already tried (same kind and normalised name)', async () => {
    const findParty = vi.fn(async (searches: ReadonlyArray<{ kind: string; term: string }>) =>
      searches.map((search) => ({
        outcome: 'no_match' as const,
        results: [],
        truncated: false,
        searchedFor: search.term,
      })),
    );
    const adapter: ModelAdapter = {
      invoke: vi.fn(async (input) => {
        if (input.systemPrompt.includes('Propose')) {
          return invokeResult({ searches: [{ kind: 'agency', term: 'Tourvest' }] });
        }
        return invokeResult({
          pick: null,
          kind: null,
          confidence: 'low',
          reason: 'No rows.',
          nextTerms: [
            { kind: 'agency', term: 'tourvest' },
            { kind: 'agency', term: 'Travel With Flair' },
          ],
        });
      }),
    };

    await runPartyMatchV3({
      adapter,
      candidates: [candidate('Tourvest Travel Services')],
      context,
      emailText: 'Please quote for Tourvest Travel Services.',
      findParty,
    });

    expect(findParty).toHaveBeenCalledTimes(2);
    expect(findParty.mock.calls[1]?.[0]).toEqual([
      { kind: 'agency', term: 'Travel With Flair' },
    ]);
    const round2 = findParty.mock.calls[1]?.[0] ?? [];
    expect(
      round2.some((search) => normalisePartyName(search.term) === normalisePartyName('Tourvest')),
    ).toBe(false);
  });

  it('keeps the round-2 cap of three after dropping already-tried terms', async () => {
    const findParty = vi.fn(async (searches: ReadonlyArray<{ kind: string; term: string }>) =>
      searches.map((search) => ({
        outcome: 'no_match' as const,
        results: [],
        truncated: false,
        searchedFor: search.term,
      })),
    );
    const adapter: ModelAdapter = {
      invoke: vi.fn(async (input) => {
        if (input.systemPrompt.includes('Propose')) {
          return invokeResult({ searches: [{ kind: 'agency', term: 'Tourvest' }] });
        }
        return invokeResult({
          pick: null,
          kind: null,
          confidence: 'low',
          reason: 'No rows.',
          nextTerms: [
            { kind: 'agency', term: 'Tourvest' },
            { kind: 'agency', term: 'Alpha Agency' },
            { kind: 'agency', term: 'Bravo Agency' },
            { kind: 'agency', term: 'Charlie Agency' },
            { kind: 'agency', term: 'Delta Agency' },
          ],
        });
      }),
    };

    await runPartyMatchV3({
      adapter,
      candidates: [candidate('Tourvest Travel Services')],
      context,
      emailText: 'Please quote for Tourvest Travel Services.',
      findParty,
    });

    expect(findParty.mock.calls[1]?.[0]).toEqual([
      { kind: 'agency', term: 'Alpha Agency' },
      { kind: 'agency', term: 'Bravo Agency' },
      { kind: 'agency', term: 'Charlie Agency' },
    ]);
  });

  it('still searches a shorter form when the tried full name only differed by a legal suffix', async () => {
    const findParty = vi.fn(async (searches: ReadonlyArray<{ kind: string; term: string }>) =>
      searches.map((search) => ({
        outcome: search.term === 'Acme' ? ('resolved' as const) : ('no_match' as const),
        results:
          search.term === 'Acme'
            ? [{ kind: 'agency' as const, nativeId: '77', name: 'Acme' }]
            : [],
        truncated: false,
        searchedFor: search.term,
      })),
    );
    const adapter: ModelAdapter = {
      invoke: vi.fn(async (input) => {
        if (input.systemPrompt.includes('Propose')) {
          return invokeResult({ searches: [{ kind: 'agency', term: 'Acme Ltd' }] });
        }
        if (String(input.userPrompt).includes('"returnedRows":[]')) {
          return invokeResult({
            pick: null,
            kind: null,
            confidence: 'low',
            reason: 'No rows.',
            nextTerms: [{ kind: 'agency', term: 'Acme' }],
          });
        }
        return invokeResult({
          pick: '77',
          kind: 'agency',
          confidence: 'high',
          reason: 'Shorter form hit.',
        });
      }),
    };

    const result = await runPartyMatchV3({
      adapter,
      candidates: [candidate('Acme Ltd')],
      context: { ...context, extractedNames: ['Acme Ltd'] },
      emailText: 'Please quote for Acme Ltd.',
      findParty,
    });

    expect(findParty.mock.calls[0]?.[0]).toEqual([{ kind: 'agency', term: 'Acme Ltd' }]);
    expect(findParty.mock.calls[1]?.[0]).toEqual([{ kind: 'agency', term: 'Acme' }]);
    expect(result.boundParty).toMatchObject({ nativeId: '77', kind: 'agency' });
  });
});

function isV2PickerPrompt(systemPrompt: string): boolean {
  return systemPrompt.includes('records already returned by an HMS search');
}

describe('PARTY MATCH V3 v2 picker after unbound loop', () => {
  beforeEach(async () => {
    const actual = await vi.importActual<typeof import('../src/ai/party-match-v2.js')>(
      '../src/ai/party-match-v2.js',
    );
    vi.mocked(pickPartyMatch).mockReset();
    vi.mocked(pickPartyMatch).mockImplementation(actual.pickPartyMatch);
  });

  it('binds via v2 when the v3 picker returns null and v2 picks a single exact-ish row', async () => {
    const findParty = vi.fn(async (searches: ReadonlyArray<{ kind: string; term: string }>) =>
      searches.map((search) => ({
        outcome: 'resolved' as const,
        results: [{ kind: 'agency' as const, nativeId: '119', name: 'Acme and Travel Tours' }],
        truncated: false,
        searchedFor: search.term,
      })),
    );
    const adapter: ModelAdapter = {
      invoke: vi.fn(async (input) => {
        if (input.systemPrompt.includes('Propose')) {
          return invokeResult({ searches: [{ kind: 'agency', term: 'Acme Travel & Tours' }] });
        }
        if (isV2PickerPrompt(input.systemPrompt)) {
          return invokeResult({
            pickNativeId: '119',
            kind: 'agency',
            confidence: 'high',
            reason: 'Same organisation; word order differs.',
            alternatives: [],
          });
        }
        return invokeResult({
          pick: null,
          kind: null,
          confidence: 'low',
          reason: 'Uncertain.',
        });
      }),
    };

    const result = await runPartyMatchV3({
      adapter,
      candidates: [candidate('Acme Travel & Tours')],
      context: { ...context, extractedNames: ['Acme Travel & Tours'] },
      emailText: 'Please quote for Acme Travel & Tours.',
      findParty,
    });

    expect(findParty).toHaveBeenCalledTimes(1);
    expect(pickPartyMatch).toHaveBeenCalledTimes(1);
    expect(result).toMatchObject({
      matchVersion: 2,
      matcher: 'v3',
      matchStatus: 'bound',
      pickSource: 'llm',
      boundParty: { nativeId: '119', kind: 'agency' },
    });
  });

  it('stays needs_pick when v2 picks a duplicate-name copy with no city or IATA', async () => {
    const findParty = vi.fn(async (searches: ReadonlyArray<{ kind: string; term: string }>) =>
      searches.map((search) => ({
        outcome: 'resolved' as const,
        results: TOURVEST_COPIES,
        truncated: false,
        searchedFor: search.term,
      })),
    );
    const adapter: ModelAdapter = {
      invoke: vi.fn(async (input) => {
        if (input.systemPrompt.includes('Propose')) {
          return invokeResult({ searches: [{ kind: 'agency', term: 'Tourvest' }] });
        }
        if (isV2PickerPrompt(input.systemPrompt)) {
          return invokeResult({
            pickNativeId: '280',
            kind: 'agency',
            confidence: 'high',
            reason: 'Named in the email.',
            alternatives: [],
          });
        }
        return invokeResult({
          pick: null,
          kind: null,
          confidence: 'low',
          reason: 'Uncertain.',
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
    expect(pickPartyMatch).toHaveBeenCalledTimes(1);
    expect(result.matchStatus).toBe('needs_pick');
    expect(result.boundParty).toBeNull();
    expect(result.matcher).toBe('v3');
    expect(result.matchVersion).toBe(2);
  });

  it('does not call the v2 picker when v3 already bound', async () => {
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
          return invokeResult({ searches: [{ kind: 'agency', term: 'Tourvest' }] });
        }
        if (isV2PickerPrompt(input.systemPrompt)) {
          throw new Error('v2 picker should not run');
        }
        return invokeResult({
          pick: '280',
          kind: 'agency',
          confidence: 'high',
          reason: 'Exact agency name.',
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
    expect(pickPartyMatch).not.toHaveBeenCalled();
    expect(result).toMatchObject({
      matchStatus: 'bound',
      pickSource: 'llm',
      boundParty: { nativeId: '280', kind: 'agency' },
    });
  });

  it('keeps the v3 result when the v2 picker throws', async () => {
    vi.mocked(pickPartyMatch).mockRejectedValueOnce(new Error('v2 picker down'));
    const findParty = vi.fn(async (searches: ReadonlyArray<{ kind: string; term: string }>) =>
      searches.map((search) => ({
        outcome: 'resolved' as const,
        results: [{ kind: 'agency' as const, nativeId: '119', name: 'Acme and Travel Tours' }],
        truncated: false,
        searchedFor: search.term,
      })),
    );
    const adapter: ModelAdapter = {
      invoke: vi.fn(async (input) => {
        if (input.systemPrompt.includes('Propose')) {
          return invokeResult({ searches: [{ kind: 'agency', term: 'Acme Travel & Tours' }] });
        }
        return invokeResult({
          pick: null,
          kind: null,
          confidence: 'low',
          reason: 'Uncertain.',
        });
      }),
    };

    const result = await runPartyMatchV3({
      adapter,
      candidates: [candidate('Acme Travel & Tours')],
      context: { ...context, extractedNames: ['Acme Travel & Tours'] },
      emailText: 'Please quote for Acme Travel & Tours.',
      findParty,
    });

    expect(findParty).toHaveBeenCalledTimes(1);
    expect(pickPartyMatch).toHaveBeenCalledTimes(1);
    expect(result.matchStatus).toBe('needs_pick');
    expect(result.boundParty).toBeNull();
    expect(result.pickSource).toBe('llm');
    expect(result.matcher).toBe('v3');
  });
});

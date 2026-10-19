import {
  applyPartyBindRule,
  buildPartyMatchCandidates,
  normalisePartyName,
  partyMatchEmailContext,
  pickPartyMatch,
  planPartySearches,
  type PartyMatchCandidate,
} from '../src/ai/party-match-v2.js';
import type { ModelAdapter } from '../src/ai/bedrock/adapter.js';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { replaceLearnedSenderMapForTests } from '../src/ai/party-sender-map.js';


afterEach(() => {
  vi.unstubAllEnvs();
  replaceLearnedSenderMapForTests(null);
});

const candidate = (name: string, kind: 'company' | 'agency' = 'company'): PartyMatchCandidate => ({
  name,
  kind,
  source: 'extraction_end_client',
  strength: 'strong',
});

describe('PARTY MATCH V2 search plan', () => {
  it('normalises legal forms, punctuation, accents and brackets without losing numeric tokens', () => {
    expect(normalisePartyName('Amícis Health (Pty) Ltd')).toBe('amicis health');
    expect(normalisePartyName('GP Destination Management SL')).toBe('gp destination management');
    expect(normalisePartyName('  Mahindra Group, S.A. ')).toBe('mahindra group');
    expect(normalisePartyName('SA Tours')).toBe('sa tours');
    expect(planPartySearches([candidate('Amícis Health (Pty) Ltd')])[0]?.term).toBe(
      'Amicis Health',
    );
    expect(
      planPartySearches([candidate('360 Degrees Travel Agency')]).map((row) => row.term),
    ).toContain('360 Degrees');
  });

  it.each([
    ['Voerkraal Restaurant', 'Voerkraal Restaurant'],
    ['Mahindra Group', 'Mahindra'],
    ['Purple Surgical', 'Purple'],
    ['Sefako Makgatho Health Science University', 'Sefako'],
    ['GP Destination Management SL', 'Destination'],
    ['Tourvest', 'Tourvest'],
  ])('plans distinctive terms for %s', (name, expected) => {
    expect(planPartySearches([candidate(name)]).map((row) => row.term)).toContain(expected);
  });

  it('puts an agency candidate first, deduplicates searches and caps the email at six', () => {
    const candidates = [
      candidate('Amicis Health (Pty) Ltd'),
      { ...candidate('360 Degrees Travel Agency', 'agency'), source: 'extraction_agency' as const },
    ];
    const searches = planPartySearches(candidates);
    expect(searches[0]).toMatchObject({
      candidateName: '360 Degrees Travel Agency',
      kind: 'agency',
    });
    expect(searches).toHaveLength(6);
    expect(new Set(searches.map((row) => `${row.kind}:${normalisePartyName(row.term)}`)).size).toBe(
      searches.length,
    );
  });

  it('keeps a bracketed acronym last within a candidate plan', () => {
    const searches = planPartySearches([
      {
        ...candidate('Health and Welfare Sector Education Authority (HWSETA)'),
        source: 'signature',
      },
    ]);
    expect(searches[0]?.term).toBe('Health and Welfare Sector Education Authority');
    expect(searches.at(-1)?.term).toBe('HWSETA');
  });

  it('rejects sender/guest person names instead of turning them into party searches', () => {
    const candidates = buildPartyMatchCandidates({
      fromAddress: 'Karen Vickers <karen@example.test>',
      subject: 'Accommodation request for Karen Vickers',
      body: 'Regards,\nKaren Vickers\nAmicis Health (Pty) Ltd',
      payload: {
        agency: 'Karen Vickers',
        endClient: 'Amicis Health (Pty) Ltd',
        contact: { name: 'Karen Vickers' },
      },
      quoteLlmParty: { kind: 'agency', name: 'Karen Vickers', guestNames: ['Karen Vickers'] },
    });
    expect(candidates.map((row) => row.name)).not.toContain('Karen Vickers');
    expect(candidates.map((row) => row.name)).toContain('Amicis Health (Pty) Ltd');

    const mixedSignature = buildPartyMatchCandidates({
      fromAddress: 'karen@example.test',
      body: 'Please arrange the quote.\nRegards, Karen Vickers | Reservations Consultant',
      payload: { agency: 'Karen Vickers Travel' },
    });
    expect(mixedSignature).toContainEqual({
      name: 'Karen Vickers Travel',
      kind: 'agency',
      source: 'extraction_agency',
      strength: 'strong',
    });

    const titledContact = buildPartyMatchCandidates({
      fromAddress: 'karen@example.test',
      payload: { agency: 'Karen Vickers Travel', contact: { name: 'Dr. Karen Vickers' } },
    });
    expect(titledContact).toContainEqual({
      name: 'Karen Vickers Travel',
      kind: 'agency',
      source: 'extraction_agency',
      strength: 'strong',
    });
  });

  it('uses guest names from the existing quote-Luna answer to reject a party-shaped person name', () => {
    const candidates = buildPartyMatchCandidates({
      payload: { agency: 'Karen Vickers' },
      quoteLlmParty: {
        party: { kind: 'agency', name: 'Karen Vickers' },
        groups: [{ guestNames: ['Karen Vickers'] }],
      },
    });
    expect(candidates).toEqual([]);
  });

  it('rejects an extracted end client repeated as a guest before planning HMS searches', () => {
    const candidates = buildPartyMatchCandidates({
      payload: { endClient: 'Karen Vickers' },
      body: 'Guest: Karen Vickers',
    });

    expect(candidates).toEqual([]);
    expect(planPartySearches(candidates)).toEqual([]);
  });

  it('keeps a person-name candidate only when it also contains an organisation word', () => {
    const candidates = buildPartyMatchCandidates({
      payload: { endClient: 'Karen Vickers Travel' },
      body: 'Guest: Karen Vickers',
    });

    expect(candidates).toContainEqual({
      name: 'Karen Vickers Travel',
      kind: 'company',
      source: 'extraction_end_client',
      strength: 'strong',
    });
  });

  it.each([
    ['sender display name', { fromAddress: 'Karen Vickers <karen@example.test>' }],
    ['signature person line', { body: 'Regards,\nKaren Vickers' }],
  ] as const)('prefers %s evidence over an extracted end client', (_source, evidence) => {
    expect(
      buildPartyMatchCandidates({ payload: { endClient: 'Karen Vickers' }, ...evidence }),
    ).toEqual([]);
  });

  it('treats a compact travel domain as a weak agency-first hint', () => {
    const candidates = buildPartyMatchCandidates({
      fromAddress: 'booker@acme-travelagency.co.za',
      payload: { endClient: 'Mahindra Group' },
    });
    expect(candidates).toContainEqual({
      name: 'acme travelagency',
      kind: 'agency',
      source: 'sender_domain_label',
      strength: 'weak',
    });
    expect(planPartySearches(candidates)[0]).toMatchObject({
      kind: 'agency',
      strength: 'weak',
      source: 'sender_domain_label',
    });

    expect(
      buildPartyMatchCandidates({ fromAddress: 'events@tourvestdm.com' }).every(
        (candidateRow) => candidateRow.kind === 'company',
      ),
    ).toBe(true);
  });

  it('keeps a party candidate when the sender organization is repeated in the signature', () => {
    const candidates = buildPartyMatchCandidates({
      fromAddress: 'Northwind Mining <bookings@northwind-mining.com>',
      body: 'Please arrange the quote.\nRegards,\nNorthwind Mining',
      payload: { endClient: 'Northwind Mining' },
    });

    expect(candidates).toContainEqual({
      name: 'Northwind Mining',
      kind: 'company',
      source: 'extraction_end_client',
      strength: 'strong',
    });
  });

  it('recognizes a sender organization with an organisation word in the signature', () => {
    const candidates = buildPartyMatchCandidates({
      fromAddress: 'Northwind Mining <bookings@northwind-mining.com>',
      body: 'Please arrange the quote.\nRegards,\nNorthwind Mining',
    });

    expect(candidates).toContainEqual({
      name: 'Northwind Mining',
      kind: 'company',
      source: 'signature',
      strength: 'strong',
    });
  });
});

describe('party sender history candidates', () => {
  it('keeps learned sender history weak when the flag is off', () => {
    vi.stubEnv('PARTY_HISTORY_BIND', 'off');
    replaceLearnedSenderMapForTests([
      { host: 'agency.example.test', kind: 'agency', name: 'Harbor Travel', support: 2 },
    ]);

    expect(buildPartyMatchCandidates({ fromAddress: 'agent@agency.example.test' })).toContainEqual({
      name: 'Harbor Travel',
      kind: 'agency',
      source: 'sender_domain_alias',
      strength: 'weak',
    });
  });

  it('strengthens learned sender history only after two supports', () => {
    vi.stubEnv('PARTY_HISTORY_BIND', 'on');
    replaceLearnedSenderMapForTests([
      { host: 'agency.example.test', kind: 'agency', name: 'Harbor Travel', support: 2 },
    ]);
    expect(
      buildPartyMatchCandidates({
        fromAddress: 'agent@agency.example.test',
        allowLearnedSenderHistory: false,
      }),
    ).not.toContainEqual(expect.objectContaining({ source: 'sender_history' }));
    expect(
      buildPartyMatchCandidates({
        fromAddress: 'agent@agency.example.test',
        allowLearnedSenderHistory: true,
      }),
    ).toContainEqual({
      name: 'Harbor Travel',
      kind: 'agency',
      source: 'sender_history',
      strength: 'strong',
    });

    replaceLearnedSenderMapForTests([
      { host: 'agency.example.test', kind: 'agency', name: 'Harbor Travel', support: 1 },
    ]);
    expect(
      buildPartyMatchCandidates({
        fromAddress: 'agent@agency.example.test',
        allowLearnedSenderHistory: true,
      }),
    ).toContainEqual({
      name: 'Harbor Travel',
      kind: 'agency',
      source: 'sender_history',
      strength: 'weak',
    });
  });

  it('keeps a conflicting email-stated agency ahead of learned history', () => {
    vi.stubEnv('PARTY_HISTORY_BIND', 'on');
    replaceLearnedSenderMapForTests([
      { host: 'agency.example.test', kind: 'agency', name: 'Harbor Travel', support: 5 },
    ]);

    const candidates = buildPartyMatchCandidates({
      fromAddress: 'agent@agency.example.test',
      payload: { agency: 'Current Travel' },
      allowLearnedSenderHistory: true,
    });
    expect(candidates.slice(0, 2)).toEqual([
      {
        name: 'Current Travel',
        kind: 'agency',
        source: 'extraction_agency',
        strength: 'strong',
      },
      {
        name: 'Harbor Travel',
        kind: 'agency',
        source: 'sender_history',
        strength: 'weak',
      },
    ]);
  });

  it.each([
    { emailName: 'Nexus Travel', historyName: 'XL Nexus' },
    { emailName: 'Rennies BCD', historyName: 'RENNIES TRAVEL' },
  ])('keeps learned history strong when names share distinctive tokens: $emailName', ({ emailName, historyName }) => {
    vi.stubEnv('PARTY_HISTORY_BIND', 'on');
    replaceLearnedSenderMapForTests([
      { host: 'agency.example.test', kind: 'agency', name: historyName, support: 2 },
    ]);

    const history = buildPartyMatchCandidates({
      fromAddress: 'agent@agency.example.test',
      payload: { agency: emailName },
      allowLearnedSenderHistory: true,
    }).find((candidate) => candidate.source === 'sender_history');

    expect(history?.strength).toBe('strong');
  });
});

describe('PARTY MATCH V2 binding', () => {
  it('does not bind a person name or the Dire/Directorate false positive', () => {
    const people = buildPartyMatchCandidates({
      fromAddress: 'Dire Itumeleng <dire@example.test>',
      payload: { agency: 'Dire Itumeleng', contact: { name: 'Dire Itumeleng' } },
      body: 'Travel Agency Details: Dire Itumeleng',
    });
    const result = applyPartyBindRule({
      candidates: people,
      rows: [
        {
          kind: 'company',
          nativeId: 'ict-1',
          name: 'Directorate Information Communication Technology',
        },
      ],
      pick: {
        pickNativeId: 'ict-1',
        kind: 'company',
        confidence: 'high',
        reason: 'Looks similar',
        alternatives: [],
        source: 'llm',
      },
    });
    expect(people).toEqual([]);
    expect(result).toMatchObject({ matchStatus: 'needs_pick', boundParty: null });
  });

  it('keeps Tourvest ambiguous when two HMS rows make the same distinctive claim', () => {
    const result = applyPartyBindRule({
      candidates: [candidate('Tourvest')],
      rows: [
        { kind: 'company', nativeId: '1', name: 'Tourvest Destination Management' },
        { kind: 'company', nativeId: '2', name: 'TOURVEST TRAVEL SERVICES' },
      ],
      pick: {
        pickNativeId: '1',
        kind: 'company',
        confidence: 'high',
        reason: 'Tourvest is named',
        alternatives: ['2'],
        source: 'llm',
      },
    });
    expect(result).toMatchObject({ matchStatus: 'needs_pick', boundParty: null });
    expect(result.suggestions.map((row) => row.nativeId)).toEqual(['1', '2']);
  });

  it('returns the strongest three suggestions when there is no pick', () => {
    const result = applyPartyBindRule({
      candidates: [candidate('Purple Surgical')],
      rows: [
        { kind: 'company', nativeId: 'unrelated', name: 'Northwind Mining' },
        { kind: 'company', nativeId: 'exact', name: 'Purple Surgical' },
        { kind: 'company', nativeId: 'expanded', name: 'Purple Surgical Medical' },
        { kind: 'company', nativeId: 'another', name: 'Cedar Consulting' },
      ],
      pick: {
        pickNativeId: null,
        kind: null,
        confidence: 'low',
        reason: 'The email does not identify a unique party.',
        alternatives: [],
        source: 'llm',
      },
    });
    expect(result.matchStatus).toBe('needs_pick');
    expect(result.suggestions.map((row) => row.nativeId)).toEqual([
      'exact',
      'expanded',
      'unrelated',
    ]);
  });

  it('prefers exact Nexus Travel over a broader row with the same distinctive token', () => {
    const result = applyPartyBindRule({
      candidates: [candidate('Nexus Travel')],
      rows: [
        { kind: 'company', nativeId: 'nexus', name: 'Nexus Travel' },
        { kind: 'company', nativeId: 'xl-nexus', name: 'XL Nexus Travel ATNS' },
      ],
      pick: {
        pickNativeId: 'nexus',
        kind: 'company',
        confidence: 'high',
        reason: 'Exact company name',
        alternatives: ['xl-nexus'],
        source: 'llm',
      },
    });
    expect(result).toMatchObject({ matchStatus: 'bound', boundParty: { nativeId: 'nexus' } });
  });

  it('does not bind a broader row when an exact row makes a stronger claim', () => {
    const result = applyPartyBindRule({
      candidates: [candidate('Nexus Travel')],
      rows: [
        { kind: 'company', nativeId: 'nexus', name: 'Nexus Travel' },
        { kind: 'company', nativeId: 'xl-nexus', name: 'XL Nexus Travel ATNS' },
      ],
      pick: {
        pickNativeId: 'xl-nexus',
        kind: 'company',
        confidence: 'high',
        reason: 'The broader row also contains Nexus Travel.',
        alternatives: ['nexus'],
        source: 'llm',
      },
    });

    expect(result).toMatchObject({ matchStatus: 'needs_pick', boundParty: null });
    expect(result.suggestions.map((row) => row.nativeId)).toEqual(['nexus', 'xl-nexus']);
  });

  it('ignores stronger claims from an unrelated agency candidate when the client row is picked', () => {
    const result = applyPartyBindRule({
      candidates: [
        candidate('Amicis Health'),
        { ...candidate('Northwind Travel', 'agency'), source: 'extraction_agency' },
      ],
      rows: [
        { kind: 'company', nativeId: 'client', name: 'Amicis Health' },
        { kind: 'agency', nativeId: 'agency', name: 'Northwind Travel' },
      ],
      pick: {
        pickNativeId: 'client',
        kind: 'company',
        confidence: 'high',
        reason: 'Exact client row.',
        alternatives: [],
        source: 'llm',
      },
    });

    expect(result).toMatchObject({
      matchStatus: 'bound',
      boundParty: { kind: 'company', nativeId: 'client', name: 'Amicis Health' },
    });
  });

  it('never binds from a sender-domain-only hint, even when the HMS name is exact', () => {
    const result = applyPartyBindRule({
      candidates: [
        { name: 'Nexus', kind: 'agency', source: 'sender_domain_alias', strength: 'weak' },
      ],
      rows: [{ kind: 'agency', nativeId: 'nexus', name: 'Nexus' }],
      pick: {
        pickNativeId: 'nexus',
        kind: 'agency',
        confidence: 'high',
        reason: 'The domain matches.',
        alternatives: [],
        source: 'llm',
      },
    });
    expect(result).toMatchObject({ matchStatus: 'needs_pick', boundParty: null });
  });

  it('fails closed when confidence is not high, a row fails token claims, or HMS rows were truncated', () => {
    const input = {
      candidates: [candidate('Purple Surgical')],
      rows: [{ kind: 'company' as const, nativeId: '1', name: 'Purple Surgical' }],
      pick: {
        pickNativeId: '1',
        kind: 'company' as const,
        confidence: 'medium' as const,
        reason: 'Maybe',
        alternatives: [],
        source: 'llm' as const,
      },
    };
    expect(applyPartyBindRule(input).matchStatus).toBe('needs_pick');
    expect(
      applyPartyBindRule({ ...input, pick: { ...input.pick, confidence: 'high' }, truncated: true })
        .matchStatus,
    ).toBe('needs_pick');
    expect(
      applyPartyBindRule({
        ...input,
        rows: [{ kind: 'company', nativeId: '1', name: 'Purple Restaurants' }],
        pick: { ...input.pick, confidence: 'high' },
      }).boundParty,
    ).toBeNull();

    const overCapRows = [
      input.rows[0]!,
      ...Array.from({ length: 25 }, (_, index) => ({
        kind: 'company' as const,
        nativeId: `other-${index}`,
        name: `Unrelated ${index}`,
      })),
    ];
    expect(
      applyPartyBindRule({
        ...input,
        rows: overCapRows,
        pick: { ...input.pick, confidence: 'high' },
      }).matchStatus,
    ).toBe('needs_pick');
  });
});

describe('PARTY MATCH V2 structured Luna pick', () => {
  it('uses the quote workflow model id/schema and validates a fake client pick', async () => {
    const adapter: ModelAdapter = {
      invoke: vi.fn(async (input) => ({
        modelId: input.modelId,
        output: {
          pickNativeId: 'nexus',
          kind: 'company',
          confidence: 'high',
          reason: 'The exact organisation name is present.',
          alternatives: [],
        },
        usage: {
          inputTokens: 1,
          outputTokens: 1,
          totalTokens: 2,
          latencyMs: 1,
          estimatedCostUsd: 0,
          rateTableVersion: 'test',
        },
      })),
    };
    const result = await pickPartyMatch({
      adapter,
      candidates: [candidate('Nexus Travel')],
      rows: [{ kind: 'company', nativeId: 'nexus', name: 'Nexus Travel' }],
      context: {
        fromAddress: 'agent@nexustravel.co.za',
        displayName: 'Nexus Travel Agent',
        subject: 'Quote request',
        signatureBlock: 'Regards, Nexus Travel',
        extractedNames: ['Nexus Travel'],
        personNames: [],
      },
    });
    expect(result).toMatchObject({ source: 'llm', pickNativeId: 'nexus', confidence: 'high' });
    expect(adapter.invoke).toHaveBeenCalledWith(
      expect.objectContaining({ modelId: 'gpt-6-luna', responseSchema: expect.any(Object) }),
    );
  });

  it('falls back only to one exact normalised-name match when the model is unavailable', async () => {
    const result = await pickPartyMatch({
      adapter: null,
      candidates: [candidate('Amicis Health (Pty) Ltd')],
      rows: [{ kind: 'company', nativeId: '1', name: 'AMICIS HEALTH LIMITED' }],
      context: {
        fromAddress: null,
        displayName: null,
        subject: null,
        signatureBlock: '',
        extractedNames: ['Amicis Health (Pty) Ltd'],
        personNames: [],
      },
    });
    expect(result).toMatchObject({ source: 'fallback', pickNativeId: '1', confidence: 'high' });
  });

  it('does not let no-model fallback bind an exact candidate that is also a guest person name', async () => {
    const context = partyMatchEmailContext({
      payload: { endClient: 'karen vickers' },
      guestNames: ['Karen Vickers'],
    });
    const result = await pickPartyMatch({
      adapter: null,
      candidates: [candidate('karen vickers')],
      rows: [{ kind: 'company', nativeId: 'guest', name: 'karen vickers' }],
      context,
    });

    expect(result).toMatchObject({
      source: 'fallback',
      pickNativeId: null,
      kind: null,
      confidence: 'low',
    });
  });

  it('explains when there is no safe name or no HMS row instead of implying an LLM failure', async () => {
    const context = {
      fromAddress: null,
      displayName: null,
      subject: null,
      signatureBlock: '',
      extractedNames: [],
      personNames: [],
    };
    const noName = await pickPartyMatch({ adapter: null, candidates: [], rows: [], context });
    const noRows = await pickPartyMatch({
      adapter: null,
      candidates: [candidate('Northwind Mining')],
      rows: [],
      context,
    });
    expect(noName.reason).toMatch(/No safe company or agency name/);
    expect(noRows.reason).toMatch(/HMS returned no party rows/);
  });

  it('accepts an explicit no-match from the model', async () => {
    const adapter: ModelAdapter = {
      invoke: vi.fn(async (input) => ({
        modelId: input.modelId,
        output: {
          pickNativeId: null,
          kind: null,
          confidence: 'low',
          reason: 'The email does not identify either returned party.',
          alternatives: ['candidate-1'],
        },
        usage: {
          inputTokens: 1,
          outputTokens: 1,
          totalTokens: 2,
          latencyMs: 1,
          estimatedCostUsd: 0,
          rateTableVersion: 'test',
        },
      })),
    };
    const result = await pickPartyMatch({
      adapter,
      candidates: [candidate('Northwind Mining')],
      rows: [{ kind: 'company', nativeId: 'candidate-1', name: 'Northwind Mining' }],
      context: {
        fromAddress: null,
        displayName: null,
        subject: 'Quote request',
        signatureBlock: '',
        extractedNames: [],
        personNames: [],
      },
    });
    expect(result).toMatchObject({
      source: 'llm',
      pickNativeId: null,
      kind: null,
      confidence: 'low',
    });
  });
});

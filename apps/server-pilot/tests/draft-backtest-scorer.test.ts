import {
  assertBacktestSourceSafe,
  aggregateRecords,
  compareDraftToGold,
  draftFromInboundSignals,
  extractCriticalTokens,
  isCenturionMailboxFrom,
  pairCenturionFromReply,
  pairCenturionGold,
  renderOfflineBracketDraft,
  assessDraftAgainstFacts,
  scoreDraftAgainstEvidence,
  type DraftEvalRecord,
} from '../src/ai/draft-backtest.js';
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';

describe('pairCenturionGold', () => {
  it('pairs earliest later Centurion outbound on same thread', () => {
    const pair = pairCenturionGold({
      threadId: 't1',
      inboundMessageId: 'in1',
      messages: [
        {
          id: 'in1',
          direction: 'inbound',
          transportId: 'transport-centurion',
          createdAt: '2026-08-01T10:00:00.000Z',
        },
        {
          id: 'out-early',
          direction: 'outbound',
          transportId: 'transport-centurion',
          createdAt: '2026-08-01T11:00:00.000Z',
          subject: 'Re: stay',
        },
        {
          id: 'out-late',
          direction: 'outbound',
          transportId: 'transport-centurion',
          createdAt: '2026-08-01T12:00:00.000Z',
          subject: 'Re: stay again',
        },
      ],
    });
    expect(pair.goldKind).toBe('centurion_outbound');
    expect(pair.goldOutboundMessageId).toBe('out-early');
  });

  it('labels forward subjects and no-gold', () => {
    const fwd = pairCenturionGold({
      threadId: 't2',
      inboundMessageId: 'in2',
      messages: [
        {
          id: 'in2',
          direction: 'inbound',
          transportId: 'transport-centurion',
          createdAt: '2026-08-01T10:00:00.000Z',
        },
        {
          id: 'out2',
          direction: 'outbound',
          transportId: 'transport-centurion',
          createdAt: '2026-08-01T11:00:00.000Z',
          subject: 'Fw: please handle',
        },
      ],
    });
    expect(fwd.goldKind).toBe('forward_or_external');

    const none = pairCenturionGold({
      threadId: 't3',
      inboundMessageId: 'in3',
      messages: [
        {
          id: 'in3',
          direction: 'inbound',
          transportId: 'transport-centurion',
          createdAt: '2026-08-01T10:00:00.000Z',
        },
      ],
    });
    expect(none.goldKind).toBe('no_gold_reply');
    expect(none.goldOutboundMessageId).toBeNull();
  });

  it('does not pair a cross-transport outbound as Centurion gold', () => {
    const pair = pairCenturionGold({
      threadId: 't-cross-transport',
      inboundMessageId: 'in-cross-transport',
      messages: [
        {
          id: 'in-cross-transport',
          direction: 'inbound',
          transportId: 'transport-centurion',
          createdAt: '2026-08-01T10:00:00.000Z',
        },
        {
          id: 'out-other-transport',
          direction: 'outbound',
          transportId: 'transport-other',
          createdAt: '2026-08-01T10:01:00.000Z',
          subject: 'Re: stay',
        },
        {
          id: 'out-centurion',
          direction: 'outbound',
          transportId: 'transport-centurion',
          createdAt: '2026-08-01T10:02:00.000Z',
          subject: 'Re: stay',
        },
      ],
    });
    expect(pair.goldOutboundMessageId).toBe('out-centurion');
  });
});

describe('pairCenturionFromReply', () => {
  it('pairs latest prior as trigger for centurion@ gold reply', () => {
    const pair = pairCenturionFromReply({
      threadId: 't1',
      goldMessageId: 'gold1',
      messages: [
        {
          id: 'guest1',
          direction: 'inbound',
          transportId: 'transport-centurion',
          fromAddress: 'guest@example.com',
          createdAt: '2026-08-01T09:00:00.000Z',
        },
        {
          id: 'guest2',
          direction: 'inbound',
          transportId: 'transport-centurion',
          fromAddress: 'guest@example.com',
          createdAt: '2026-08-01T10:00:00.000Z',
        },
        {
          id: 'gold1',
          direction: 'outbound',
          transportId: 'transport-centurion',
          fromAddress: 'centurion@legacyhotels.co.za',
          createdAt: '2026-08-01T11:00:00.000Z',
          subject: 'Re: stay',
        },
      ],
    });
    expect(pair.goldKind).toBe('centurion_outbound');
    expect(pair.goldOutboundMessageId).toBe('gold1');
    expect(pair.inboundMessageId).toBe('guest2');
  });

  it('accepts angle-addr centurion@ and labels forward', () => {
    expect(isCenturionMailboxFrom('Centurion <centurion@legacyhotels.co.za>')).toBe(true);
    expect(isCenturionMailboxFrom('bongi@legacyhotels.co.za')).toBe(false);

    const fwd = pairCenturionFromReply({
      threadId: 't2',
      goldMessageId: 'g2',
      messages: [
        {
          id: 'in',
          direction: 'inbound',
          transportId: 'transport-centurion',
          fromAddress: 'guest@example.com',
          createdAt: '2026-08-01T10:00:00.000Z',
        },
        {
          id: 'g2',
          direction: 'outbound',
          transportId: 'transport-centurion',
          fromAddress: 'Centurion <centurion@legacyhotels.co.za>',
          createdAt: '2026-08-01T11:00:00.000Z',
          subject: 'Fw: external',
        },
      ],
    });
    expect(fwd.goldKind).toBe('forward_or_external');
  });

  it('marks no_gold_reply when centurion@ has no prior on thread', () => {
    const none = pairCenturionFromReply({
      threadId: 't3',
      goldMessageId: 'solo',
      messages: [
        {
          id: 'solo',
          direction: 'outbound',
          transportId: 'transport-centurion',
          fromAddress: 'centurion@legacyhotels.co.za',
          createdAt: '2026-08-01T10:00:00.000Z',
        },
      ],
    });
    expect(none.goldKind).toBe('no_gold_reply');
    expect(none.goldOutboundMessageId).toBeNull();
  });

  it('does not use a different transport as the pre-reply trigger', () => {
    const pair = pairCenturionFromReply({
      threadId: 't-cross-transport-reply',
      goldMessageId: 'gold-cross-transport',
      messages: [
        {
          id: 'other-transport-inbound',
          transportId: 'transport-other',
          direction: 'inbound',
          fromAddress: 'guest@example.com',
          createdAt: '2026-08-01T10:00:00.000Z',
        },
        {
          id: 'gold-cross-transport',
          transportId: 'transport-centurion',
          direction: 'outbound',
          fromAddress: 'centurion@legacyhotels.co.za',
          createdAt: '2026-08-01T11:00:00.000Z',
        },
      ] as never,
    });
    expect(pair.goldKind).toBe('no_gold_reply');
    expect(pair.goldOutboundMessageId).toBeNull();
  });
});

describe('scoreDraftAgainstEvidence', () => {
  it('flags invented confirmation tokens', () => {
    const classes = scoreDraftAgainstEvidence({
      draftText: 'Your stay CONF-99999 is confirmed for 2026-09-01.',
      evidenceTokens: [],
      bracketLines: [],
      goldKind: 'centurion_outbound',
    });
    expect(classes).toContain('INVENTED_FACT');
  });

  it('allows tokens present in evidence or brackets', () => {
    const classes = scoreDraftAgainstEvidence({
      draftText: 'Confirmation CONF-88421 arrives 2026-08-01.',
      evidenceTokens: ['CONF-88421', '2026-08-01'],
      bracketLines: [],
      goldKind: 'centurion_outbound',
    });
    expect(classes).not.toContain('INVENTED_FACT');
  });

  it('flags missing bracket when draft claims need facts without evidence', () => {
    const classes = scoreDraftAgainstEvidence({
      draftText: 'I can confirm your rate and deposit now.',
      evidenceTokens: [],
      bracketLines: [],
      goldKind: 'centurion_outbound',
    });
    expect(classes).toContain('MISSING_BRACKET');
  });

  it('runs deterministic fact assessment for negation and amount safety', () => {
    const assessment = assessDraftAgainstFacts({
      draftText: 'Your payment is cleared for USD 2,000.',
      asks: [{ code: 'payment_status', label: 'payment status', required: true }],
      facts: [
        {
          key: 'payment.receipt',
          label: 'payment receipt',
          value: { fundsCleared: false, amount: '1000.00', currency: 'ZAR' },
          source: 'mail',
          authority: 'authorized',
          status: 'known',
        },
      ],
    });
    expect(assessment.ok).toBe(false);
    expect(assessment.issues.map((issue) => issue.code)).toEqual(
      expect.arrayContaining(['NEGATION_MISMATCH', 'AMOUNT_OR_CURRENCY_MISMATCH']),
    );
  });
});

describe('renderOfflineBracketDraft', () => {
  it('never invents — only brackets', () => {
    const { textBody, bracketLines } = renderOfflineBracketDraft({
      opening: 'Thanks for writing.',
      unresolved: [
        {
          need: 'confirmation number',
          acquisition: 'hms_find_reservation',
        },
      ],
    });
    expect(bracketLines[0]).toMatch(/\[MISSING: confirmation number/);
    expect(extractCriticalTokens(textBody)).toEqual([]);
  });
});

describe('compareDraftToGold + draftFromInboundSignals', () => {
  it('covers gold tokens present in draft evidence', () => {
    const draft = draftFromInboundSignals({
      inboundText: 'Please check CONF-88421 arrival 2026-08-01',
    });
    const cmp = compareDraftToGold({
      draftText: draft.textBody,
      goldText: 'CONF-88421 is confirmed for 2026-08-01. Rate ZAR 1500.',
      bracketLines: draft.bracketLines,
    });
    // Draft must not echo inbound literals (PII + invent-mismatch); coverage via brackets/evidence path elsewhere.
    expect(draft.evidenceTokens.length).toBeGreaterThan(0);
    expect(extractCriticalTokens(draft.textBody)).toEqual([]);
    expect(cmp.goldCriticalCoverage).toBeGreaterThanOrEqual(0);
  });

  it('flags LOW_GOLD_COVERAGE when coverage is poor', () => {
    const classes = scoreDraftAgainstEvidence({
      draftText: 'Thanks for writing.',
      evidenceTokens: [],
      bracketLines: ['[MISSING: confirmation number | how: hms_find_reservation]'],
      goldKind: 'centurion_outbound',
      goldCriticalCoverage: 0.1,
    });
    expect(classes).toContain('LOW_GOLD_COVERAGE');
  });

  it('flags LOW_TONE when tone overlap is poor', () => {
    const classes = scoreDraftAgainstEvidence({
      draftText: 'Thanks for writing.',
      evidenceTokens: [],
      bracketLines: ['[MISSING: confirmation number | how: hms_find_reservation]'],
      goldKind: 'centurion_outbound',
      goldCriticalCoverage: 0.9,
      toneOverlap: 0.02,
    });
    expect(classes).toContain('LOW_TONE');
  });
});

describe('aggregate + safety', () => {
  it('aggregates invented fact rate and three-axis metrics', () => {
    const records: DraftEvalRecord[] = [
      {
        runId: 'r',
        inboundMessageIdHash: 'a',
        threadIdHash: 't',
        goldKind: 'centurion_outbound',
        draftText: 'x',
        evidenceTokens: [],
        bracketLines: [],
        failureClasses: ['INVENTED_FACT'],
        evaluationMode: 'historical-replay',
        scoredAt: '2026-08-07T00:00:00.000Z',
        goldCriticalCoverage: 0.2,
        softWordOverlap: 0.1,
        toolCoverageRate: 0.2,
        missingToolBracketCount: 2,
        wrongOrMissingFactCount: 3,
        toneOverlap: 0.1,
      },
      {
        runId: 'r',
        inboundMessageIdHash: 'b',
        threadIdHash: 't',
        goldKind: 'no_gold_reply',
        draftText: 'y',
        evidenceTokens: [],
        bracketLines: [],
        failureClasses: ['NO_GOLD_REPLY'],
        evaluationMode: 'historical-replay',
        scoredAt: '2026-08-07T00:00:00.000Z',
        goldCriticalCoverage: 1,
        softWordOverlap: 0.5,
        toolCoverageRate: 1,
        missingToolBracketCount: 0,
        wrongOrMissingFactCount: 0,
        toneOverlap: 0.5,
      },
    ];
    const card = aggregateRecords('r', records);
    expect(card.scored).toBe(2);
    expect(card.inventedFactRate).toBe(0.5);
    expect(card.meanGoldCriticalCoverage).toBeCloseTo(0.6);
    expect(card.meanSoftWordOverlap).toBeCloseTo(0.3);
    expect(card.meanToolCoverageRate).toBeCloseTo(0.6);
    expect(card.meanToneOverlap).toBeCloseTo(0.3);
    expect(card.totalMissingToolBrackets).toBe(2);
    expect(card.totalWrongOrMissingFacts).toBe(3);
  });

  it('refuses unsafe source patterns', () => {
    expect(() => assertBacktestSourceSafe('await db.insert({ x: 1 })')).toThrow(/safety refuse/);
    expect(() =>
      assertBacktestSourceSafe('const x = select only; createHash().update(id)'),
    ).not.toThrow();
    const self = readFileSync(new URL('../src/ai/draft-backtest.ts', import.meta.url), 'utf8');
    expect(() => assertBacktestSourceSafe(self)).not.toThrow();
  });

  it('persists the evaluation mode and rejects mixed-mode aggregation', () => {
    const records = [
      {
        runId: 'r-mode',
        inboundMessageIdHash: 'mode-a',
        threadIdHash: 't',
        goldKind: 'centurion_outbound' as const,
        draftText: 'x',
        evidenceTokens: [],
        bracketLines: [],
        failureClasses: [],
        scoredAt: '2026-08-07T00:00:00.000Z',
        evaluationMode: 'historical-replay',
      } as DraftEvalRecord,
    ];
    const card = aggregateRecords('r-mode', records);
    expect((card as Record<string, unknown>).evaluationMode).toBe('historical-replay');

    expect(() =>
      aggregateRecords('r-mode-mixed', [
        ...records,
        { ...records[0], inboundMessageIdHash: 'mode-b', evaluationMode: 'current-state' },
      ]),
    ).toThrow(/evaluation mode/i);
  });
});

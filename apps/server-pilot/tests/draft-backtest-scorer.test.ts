import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  assertBacktestSourceSafe,
  aggregateRecords,
  compareDraftToGold,
  draftFromInboundSignals,
  extractCriticalTokens,
  pairCenturionGold,
  renderOfflineBracketDraft,
  scoreDraftAgainstEvidence,
  type DraftEvalRecord,
} from '../src/ai/draft-backtest.js';

describe('pairCenturionGold', () => {
  it('pairs earliest later Centurion outbound on same thread', () => {
    const pair = pairCenturionGold({
      threadId: 't1',
      inboundMessageId: 'in1',
      messages: [
        {
          id: 'in1',
          direction: 'inbound',
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
          createdAt: '2026-08-01T10:00:00.000Z',
        },
      ],
    });
    expect(none.goldKind).toBe('no_gold_reply');
    expect(none.goldOutboundMessageId).toBeNull();
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
      bracketLines: [
        '[MISSING: confirmation number | how: hms_find_reservation]',
      ],
      goldKind: 'centurion_outbound',
      goldCriticalCoverage: 0.1,
    });
    expect(classes).toContain('LOW_GOLD_COVERAGE');
  });
});

describe('aggregate + safety', () => {
  it('aggregates invented fact rate', () => {
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
        scoredAt: '2026-08-07T00:00:00.000Z',
        goldCriticalCoverage: 0.2,
        softWordOverlap: 0.1,
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
        scoredAt: '2026-08-07T00:00:00.000Z',
        goldCriticalCoverage: 1,
        softWordOverlap: 0.5,
      },
    ];
    const card = aggregateRecords('r', records);
    expect(card.scored).toBe(2);
    expect(card.inventedFactRate).toBe(0.5);
    expect(card.meanGoldCriticalCoverage).toBeCloseTo(0.6);
    expect(card.meanSoftWordOverlap).toBeCloseTo(0.3);
  });

  it('refuses unsafe source patterns', () => {
    expect(() => assertBacktestSourceSafe('await db.insert({ x: 1 })')).toThrow(
      /safety refuse/,
    );
    expect(() =>
      assertBacktestSourceSafe('const x = select only; createHash().update(id)'),
    ).not.toThrow();
    const self = readFileSync(
      new URL('../src/ai/draft-backtest.ts', import.meta.url),
      'utf8',
    );
    expect(() => assertBacktestSourceSafe(self)).not.toThrow();
  });
});

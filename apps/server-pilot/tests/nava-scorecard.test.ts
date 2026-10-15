import { describe, expect, it, vi } from 'vitest';
import type { DB } from '../src/db/client.js';
import { mailActionLabel, message } from '../src/db/schema/mail.js';
import { mailExtraction } from '../src/db/schema/work.js';
import type { QuoteProofSummary } from '../scripts/nava-quote-proof.js';

const modulePath = '../scripts/nava-scorecard.js';

async function loadScorecard() {
  const scorecard = await import(modulePath).catch(() => null);
  expect(scorecard).not.toBeNull();
  return scorecard!;
}

type MessageRow = {
  id: string;
  threadId: string;
  transportId: string;
  direction: 'inbound' | 'outbound';
  receivedAt: Date | null;
};
type ExtractionRow = {
  id: string;
  messageId: string;
  kind: string | null;
  status: 'succeeded' | 'failed';
  createdAt: Date;
};
type LabelRow = {
  id: string;
  messageId: string;
  transportId: string;
  source: 'model' | 'agent' | 'owner';
  action: string;
  needsAction: boolean;
  version: string;
  createdAt: Date;
  updatedAt: Date;
};

function fakeDb(messages: MessageRow[], labels: LabelRow[], extractions: ExtractionRow[]) {
  const calls: Array<{ table: unknown; where: boolean; limit?: number }> = [];
  const ownerMessageIds = new Set(
    labels.filter((row) => row.transportId === 'transport-centurion' && row.source === 'owner' && row.version === 'owner').map((row) => row.messageId),
  );
  const db = {
    select(projection: Record<string, unknown>) {
      let table: unknown;
      let maxRows: number | undefined;
      let usedWhere = false;
      const query: any = {
        from(value: unknown) {
          table = value;
          return query;
        },
        where() {
          usedWhere = true;
          return query;
        },
        orderBy() {
          return query;
        },
        limit(value: number) {
          maxRows = value;
          return query;
        },
        then(resolve: (rows: unknown[]) => unknown, reject: (error: unknown) => unknown) {
          let rows: unknown[];
          if (table === message) {
            rows = messages.filter(
              (row) =>
                (maxRows !== undefined || ownerMessageIds.has(row.id)) &&
                row.transportId === 'transport-centurion' &&
                row.direction === 'inbound' &&
                row.receivedAt !== null &&
                row.receivedAt >= at('2026-10-14T00:00:00Z'),
            );
            rows = rows.sort(
              (a, b) =>
                (b.receivedAt?.getTime() ?? 0) - (a.receivedAt?.getTime() ?? 0) ||
                b.id.localeCompare(a.id),
            );
          } else if (table === mailExtraction) {
            rows = extractions.filter((row) => row.status === 'succeeded');
          } else {
            rows = labels.filter((row) => row.transportId === 'transport-centurion' && row.source === 'owner' && row.version === 'owner');
          }
          if (maxRows !== undefined) rows = rows.slice(0, maxRows);
          calls.push({ table, where: usedWhere, limit: maxRows });
          return Promise.resolve(rows).then(resolve, reject);
        },
      };
      return query;
    },
  };
  return { db: db as unknown as DB, calls };
}

const at = (value: string) => new Date(value);
const messages: MessageRow[] = [
  { id: 'm1', threadId: 't1', transportId: 'transport-centurion', direction: 'inbound', receivedAt: at('2026-10-15T08:00:00Z') },
  { id: 'm2', threadId: 't1', transportId: 'transport-centurion', direction: 'inbound', receivedAt: at('2026-10-15T07:00:00Z') },
  { id: 'm3', threadId: 't2', transportId: 'transport-centurion', direction: 'inbound', receivedAt: at('2026-10-15T06:00:00Z') },
  { id: 'm4', threadId: 't3', transportId: 'transport-centurion', direction: 'inbound', receivedAt: at('2026-10-15T05:00:00Z') },
  { id: 'm5', threadId: 't4', transportId: 'transport-centurion', direction: 'inbound', receivedAt: at('2026-10-15T04:00:00Z') },
  { id: 'old', threadId: 't5', transportId: 'transport-centurion', direction: 'inbound', receivedAt: at('2026-10-12T08:00:00Z') },
  { id: 'sent', threadId: 't1', transportId: 'transport-centurion', direction: 'outbound', receivedAt: at('2026-10-15T09:00:00Z') },
  { id: 'other', threadId: 't6', transportId: 'transport-other', direction: 'inbound', receivedAt: at('2026-10-15T09:00:00Z') },
];

const label = (
  id: string,
  messageId: string,
  source: LabelRow['source'],
  action: string,
  version: string,
  timestamp: string,
): LabelRow => ({
  id,
  messageId,
  transportId: messageId === 'other' ? 'transport-other' : 'transport-centurion',
  source,
  action,
  needsAction: action !== 'no_action',
  version,
  createdAt: at(timestamp),
  updatedAt: at(timestamp),
});
const labels: LabelRow[] = [
  label('m1-owner', 'm1', 'owner', 'new_booking', 'owner', '2026-10-15T08:01:00Z'),
  label('m1-old-owner', 'm1', 'owner', 'cancel', 'owner-old', '2026-10-15T08:03:00Z'),
  label('m1-model', 'm1', 'model', 'cancel', 'v2', '2026-10-15T08:02:00Z'),
  label('m2-owner', 'm2', 'owner', 'quote_availability', 'owner', '2026-10-15T07:01:00Z'),
  label('m2-model', 'm2', 'model', 'quote_availability', 'v2', '2026-10-15T07:02:00Z'),
  label('m3-owner', 'm3', 'owner', 'quote_availability', 'owner', '2026-10-15T06:01:00Z'),
  label('m3-model', 'm3', 'model', 'cancel', 'v2', '2026-10-15T06:02:00Z'),
  label('m4-owner', 'm4', 'owner', 'quote_availability', 'owner', '2026-10-15T05:01:00Z'),
  label('m5-owner', 'm5', 'owner', 'quote_availability', 'owner', '2026-10-15T04:01:00Z'),
  label('old-owner', 'old', 'owner', 'cancel', 'owner', '2026-10-12T08:01:00Z'),
  label('other-owner', 'other', 'owner', 'quote_availability', 'owner', '2026-10-15T09:01:00Z'),
];
const extractions: ExtractionRow[] = [
  { id: 'm1-succeeded', messageId: 'm1', kind: 'booking', status: 'succeeded', createdAt: at('2026-10-15T08:01:00Z') },
  { id: 'm1-failed', messageId: 'm1', kind: 'quote', status: 'failed', createdAt: at('2026-10-15T08:03:00Z') },
  { id: 'm2-succeeded', messageId: 'm2', kind: 'quote', status: 'succeeded', createdAt: at('2026-10-15T07:01:00Z') },
  { id: 'm3-succeeded', messageId: 'm3', kind: 'quote', status: 'succeeded', createdAt: at('2026-10-15T06:01:00Z') },
  { id: 'm4-succeeded', messageId: 'm4', kind: 'quote', status: 'succeeded', createdAt: at('2026-10-15T05:01:00Z') },
  { id: 'old-succeeded', messageId: 'old', kind: 'quote', status: 'succeeded', createdAt: at('2026-10-12T08:01:00Z') },
];

const options = {
  transportId: 'transport-centurion',
  since: at('2026-10-14T00:00:00Z'),
  limit: 3,
};

const quoteProof = {
  pass: false,
  threads: [
    { threadId: 'thread-1', blocker: null, rates: { outcome: 'priced', seconds: 4, cards: 1 } },
    { threadId: 'thread-2', blocker: 'needs_edits:dates,rooms', rates: { outcome: null, seconds: null, cards: 0 } },
  ],
} as unknown as QuoteProofSummary;

describe('Nava scorecard', () => {
  it('requires an ISO since, positive limit, and markdown output path', async () => {
    const api = await loadScorecard();
    expect(
      api.parseNavaScorecardArgs([
        '--since',
        '2026-10-14T00:00:00Z',
        '--limit',
        '3',
        '--out',
        '/tmp/nava-scorecard.md',
      ]),
    ).toMatchObject({ transportId: 'transport-centurion', since: at('2026-10-14T00:00:00Z'), limit: 3 });
    expect(() => api.parseNavaScorecardArgs(['--since', 'yesterday', '--limit', '0', '--out', 'x'])).toThrow();
  });

  it('scores the pane read against owner gold once per thread and keeps gold outside the message limit', async () => {
    const api = await loadScorecard();
    const firstDb = fakeDb(messages, labels, extractions);
    const evaluateQuoteReady = vi.fn(async ({ messageId }: { messageId: string }) => ({
      messageId,
      transportId: 'transport-centurion',
      threadId: messageId === 'm3' ? 't2' : 't1',
      preparationEnabled: true,
      plan: messageId === 'm3' ? { inputs: [{}] } : null,
      reason: messageId === 'm3' ? null : 'not_ready',
    }));
    const score = await api.buildNavaScorecard(firstDb.db, options, {
      quoteProof,
      evaluateQuoteReady,
      now: at('2026-10-15T10:00:00Z'),
    });

    expect(score.schemaVersion).toBe(2);
    expect(score.filters).toMatchObject({ messages: 3, threads: 2 });
    expect(score.classification).toMatchObject({
      ownerGoldLabels: 5,
      ownerGoldThreads: 4,
      ownerGoldMessagesInLimit: 3,
      compared: 3,
      missingPrediction: 1,
      agreement: { correct: 3, denominator: 4, percent: 75 },
    });
    expect(score.classification.confusionPairs).toContainEqual({ owner: 'quote_availability', nava: 'missing', count: 1 });
    expect(score.quoteReadiness).toMatchObject({ prefillable: 1, quoteMessages: 2, quoteThreads: 1, percent: 100 });
    expect(score.quoteReadiness.blockerHistogram).toEqual({});
    expect(score.quoteProof).toMatchObject({ passed: 1, threads: 2, percent: 50 });
    expect(score.quoteProof.blockerHistogram).toEqual({ needs_edits: 1 });
    expect(evaluateQuoteReady).toHaveBeenCalledTimes(1);
    expect(evaluateQuoteReady.mock.calls[0]?.[0]).toMatchObject({ messageId: 'm3' });
    expect(firstDb.calls.some((call) => call.table === message && call.where && call.limit === 3)).toBe(true);
    expect(firstDb.calls.some((call) => call.table === mailActionLabel && call.where)).toBe(true);
    expect(firstDb.calls.some((call) => call.table === mailExtraction && call.where)).toBe(true);

    const baseline = {
      ...score,
      classification: { ...score.classification, agreement: { ...score.classification.agreement, correct: 4, percent: 100 } },
      quoteReadiness: { ...score.quoteReadiness, prefillable: 0, percent: 100 },
      quoteProof: { ...score.quoteProof!, passed: 2, percent: 100 },
    };
    const noReadyQuotes = vi.fn(async ({ messageId }: { messageId: string }) => ({
      messageId,
      transportId: 'transport-centurion',
      threadId: 't2',
      preparationEnabled: true,
      plan: null,
      reason: 'not_ready',
    }));
    const later = await api.buildNavaScorecard(fakeDb(messages, labels, extractions).db, options, {
      quoteProof,
      baseline,
      evaluateQuoteReady: noReadyQuotes,
      now: at('2026-10-15T10:01:00Z'),
    });
    expect(later.regressions.map((item: { section: string }) => item.section)).toEqual([
      'classification',
      'quoteReadiness',
      'quoteProof',
    ]);
    const changedCohort = await api.buildNavaScorecard(fakeDb(messages, labels, extractions).db, options, {
      quoteProof,
      baseline: {
        ...baseline,
        quoteReadiness: { ...baseline.quoteReadiness, cohortHash: 'different-cohort' },
      },
      evaluateQuoteReady,
    });
    expect(changedCohort.regressions.map((item: { section: string }) => item.section)).toEqual([
      'classification',
      'quoteProof',
    ]);
    expect(changedCohort.comparisonSkipped).toEqual(['quoteReadiness']);
    expect(JSON.stringify(later)).not.toMatch(/m1|m2|thread-1|thread-2/);
  });

  it('renders the three score denominators in a compact markdown table', async () => {
    const api = await loadScorecard();
    const db = fakeDb(messages, labels, extractions);
    const score = await api.buildNavaScorecard(db.db, options, {
      quoteProof,
      evaluateQuoteReady: vi.fn(async ({ messageId }: { messageId: string }) => ({
        messageId,
        transportId: 'transport-centurion',
        threadId: messageId === 'm3' ? 't2' : 't1',
        preparationEnabled: true,
        plan: messageId === 'm3' ? { inputs: [{}] } : null,
        reason: messageId === 'm3' ? null : 'not_ready',
      })),
    });
    const markdown = api.formatNavaScorecardMarkdown(score);
    expect(markdown).toContain('| Classification | 3/4 threads (5 owner-label messages) |');
    expect(markdown).toContain('| Quote readiness | 1/1 threads (2 quote messages) |');
    expect(markdown).toContain('| Quote proof | 1/2 threads |');
  });
});

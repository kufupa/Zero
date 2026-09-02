import {
  aggregateThreadReviewResults,
  buildReconciliation,
  INTENT_CLASS_TO_CENSUS_INTENTS,
} from '../scripts/aggregate-thread-review-results';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { afterAll, describe, expect, it } from 'vitest';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

const tempRoots: string[] = [];

async function makeTempRoot(): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), 'thread-review-agg-'));
  tempRoots.push(root);
  return root;
}

afterAll(async () => {
  await Promise.all(tempRoots.map((root) => rm(root, { recursive: true, force: true })));
});

function resultJson(
  batchId: string,
  threadIds: string[],
  intents?: Partial<Record<string, string>>,
): string {
  return JSON.stringify({
    schemaVersion: 1,
    batchId,
    threads: threadIds.map((threadId) => ({
      threadId,
      intentClass: intents?.[threadId] ?? 'booking_new',
      pmsFacts: ['fact'],
      proposedTriageRoute: { slug: 'ops', confidence: 'high' },
      humanLock: { required: false, reason: '' },
      toolDemand:
        threadId === 't-gap'
          ? [
              {
                need: 'check stay balance',
                disposition: 'gap_unlisted',
                verb: 'read',
                hitlRequired: false,
              },
            ]
          : [],
      alreadyHandled: 'inbound_only',
      confidence: 'high',
      anchorQuote: 'q',
    })),
  });
}

describe('aggregateThreadReviewResults', () => {
  it('aggregates counts and enforces exact manifest coverage', async () => {
    const root = await makeTempRoot();
    const reviewRoot = path.join(root, 'thread-review');
    await mkdir(reviewRoot, { recursive: true });
    const manifest = {
      schemaVersion: 1,
      batches: [
        { batchId: 'batch-001', threadIds: ['t-1', 't-2'] },
        { batchId: 'batch-002', threadIds: ['t-gap'] },
      ],
    };
    await writeFile(
      path.join(reviewRoot, 'batch-001.result.json'),
      resultJson('batch-001', ['t-1', 't-2']),
    );
    await writeFile(
      path.join(reviewRoot, 'batch-002.result.json'),
      resultJson('batch-002', ['t-gap']),
    );

    const agg = await aggregateThreadReviewResults({ manifest, resultsRoot: reviewRoot });
    expect(agg.coverage.complete).toBe(true);
    expect(agg.coverage.totalThreads).toBe(3);
    expect(agg.coverage.missingThreads).toEqual([]);
    expect(agg.coverage.duplicateThreads).toEqual([]);
    expect(agg.intentCounts['booking_new']).toBe(3);
    expect(agg.routeCounts.ops).toBe(3);
    expect(agg.humanLockCount).toBe(0);
    expect(agg.toolDemandCounts.gap_unlisted).toBe(1);
    expect(agg.lowConfidenceCount).toBe(0);
  });

  it('reports missing and duplicate coverage instead of failing silently', async () => {
    const root = await makeTempRoot();
    const reviewRoot = path.join(root, 'thread-review');
    await mkdir(reviewRoot, { recursive: true });
    const manifest = {
      schemaVersion: 1,
      batches: [{ batchId: 'batch-001', threadIds: ['t-1', 't-2'] }],
    };
    // Only t-1 present → t-2 missing; t-1 duplicated via a second result file.
    await writeFile(
      path.join(reviewRoot, 'batch-001.result.json'),
      resultJson('batch-001', ['t-1']),
    );
    await writeFile(
      path.join(reviewRoot, 'batch-001.copy.result.json'),
      resultJson('batch-001', ['t-1']),
    );

    await expect(
      aggregateThreadReviewResults({ manifest, resultsRoot: reviewRoot }),
    ).rejects.toThrow(/duplicate result batch/i);
  });

  it('rejects malformed result files', async () => {
    const root = await makeTempRoot();
    const reviewRoot = path.join(root, 'thread-review');
    await mkdir(reviewRoot, { recursive: true });
    const manifest = { schemaVersion: 1, batches: [{ batchId: 'batch-001', threadIds: ['t-1'] }] };
    await writeFile(
      path.join(reviewRoot, 'batch-001.result.json'),
      '{"schemaVersion":1,"batchId":"batch-001","threads":[{"threadId":"t-1"}]}',
    );
    await expect(
      aggregateThreadReviewResults({ manifest, resultsRoot: reviewRoot }),
    ).rejects.toThrow(/intentClass/i);
  });

  it('builds reconciliation against census intent hints', async () => {
    const root = await makeTempRoot();
    const reviewRoot = path.join(root, 'thread-review');
    await mkdir(reviewRoot, { recursive: true });
    // Census hint says new_booking for both; judge agrees on t-1, overturns t-2 to spam_noise.
    const manifest = {
      schemaVersion: 1,
      batches: [{ batchId: 'batch-001', threadIds: ['t-1', 't-2'] }],
    };
    await writeFile(
      path.join(reviewRoot, 'batch-001.result.json'),
      resultJson('batch-001', ['t-1', 't-2'], { 't-2': 'spam_noise' }),
    );
    const hints = { 't-1': 'new_booking', 't-2': 'new_booking' };
    const agg = await aggregateThreadReviewResults({ manifest, resultsRoot: reviewRoot });
    const rec = buildReconciliation(agg.threads, hints);
    expect(rec.compared).toBe(2);
    expect(rec.agreements).toBe(1);
    expect(rec.overturns).toHaveLength(1);
    expect(rec.overturns[0].censusIntent).toBe('new_booking');
    expect(rec.overturns[0].judgeIntent).toBe('spam_noise');
    expect(rec.agreementRate).toBeCloseTo(0.5);
  });

  it('maps every comparable judge intent class to at least one census intent bucket', () => {
    const judgeOnlyClasses = new Set(['internal_test', 'other']);
    for (const [intentClass, mapping] of Object.entries(INTENT_CLASS_TO_CENSUS_INTENTS)) {
      if (judgeOnlyClasses.has(intentClass)) continue;
      expect(mapping.length).toBeGreaterThan(0);
    }
  });
});

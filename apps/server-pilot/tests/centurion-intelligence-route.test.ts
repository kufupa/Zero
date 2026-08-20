import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  createCenturionThreadAuditSafeSource,
  parseCenturionThreadAuditStoredMetricsAndInsights,
  sealCenturionThreadAuditSnapshot,
} from '../src/ops/centurion-thread-audit-snapshot.js';
import {
  centurionIntelligenceRouter,
  decodeCenturionIntelligenceQueueCursor,
  encodeCenturionIntelligenceQueueCursor,
  parseCenturionIntelligenceGetSnapshotInput,
  parseCenturionIntelligenceListQueueInput,
  toCenturionIntelligenceSafeInsights,
} from '../src/trpc/routes/centurion-intelligence.js';
import { createThreadAuditSafeSourceInput } from './fixtures/centurion-thread-audit-snapshot.js';

const CURSOR_KEY = Buffer.alloc(32, 0x5a);
const NOW = new Date('2026-08-10T00:03:00.000Z');
const FUTURE = new Date('2026-08-10T01:03:00.000Z');

function sealedFixture() {
  return sealCenturionThreadAuditSnapshot(
    createCenturionThreadAuditSafeSource(createThreadAuditSafeSourceInput()),
  );
}

describe('Centurion Intelligence reader contract', () => {
  it('exposes exactly the two mailbox reader procedures', () => {
    expect(Object.keys(centurionIntelligenceRouter._def.procedures).sort()).toEqual([
      'getSnapshot',
      'listQueue',
    ]);
  });

  it('strictly parses stored aggregates and removes insight example identifiers', () => {
    const sealed = sealedFixture();
    if (sealed.trustStatus !== 'valid') throw new Error('fixture must be valid');
    const stored = parseCenturionThreadAuditStoredMetricsAndInsights({
      metrics: sealed.metrics,
      insights: sealed.insights,
    });

    expect(stored.metrics.currentWorkQueue.actionRequiredCount).toBe(1);
    expect(toCenturionIntelligenceSafeInsights(stored.insights)).toEqual(
      stored.insights.map(({ examples: _examples, ...insight }) => insight),
    );
    expect(JSON.stringify(toCenturionIntelligenceSafeInsights(stored.insights))).not.toContain(
      'component_',
    );

    expect(() =>
      parseCenturionThreadAuditStoredMetricsAndInsights({
        metrics: sealed.metrics,
        insights: sealed.insights,
        subject: 'forbidden',
      }),
    ).toThrow('CENTURION_THREAD_AUDIT_SNAPSHOT_INVALID');
  });

  it('accepts only diagnostics activity in getSnapshot input', () => {
    expect(
      parseCenturionIntelligenceGetSnapshotInput({
        activity: {
          from: '2026-08-01T00:00:00.000Z',
          to: '2026-08-10T00:00:00.000Z',
        },
      }),
    ).toEqual({
      activity: {
        from: '2026-08-01T00:00:00.000Z',
        to: '2026-08-10T00:00:00.000Z',
      },
    });

    for (const invalid of [
      { transportId: 'transport-other' },
      { queue: 'act_now' },
      {
        activity: {
          from: '2026-08-10T00:00:00.000+01:00',
          to: '2026-08-10T01:00:00.000Z',
        },
      },
      {
        activity: {
          from: '2026-08-10T01:00:00.000Z',
          to: '2026-08-10T00:00:00.000Z',
        },
      },
    ]) {
      expect(() => parseCenturionIntelligenceGetSnapshotInput(invalid)).toThrow(
        'CENTURION_INTELLIGENCE_INPUT_INVALID',
      );
    }
  });

  it('normalizes queue filters but never turns activity into a worklist filter', () => {
    const parsed = parseCenturionIntelligenceListQueueInput({
      queue: 'act_now',
      expectedRevisionToken: `revision_${'a'.repeat(64)}`,
      states: ['action_required', 'action_required'],
      evidenceTiers: ['quoted_reply', 'persisted_reply'],
      ageBuckets: ['over_three_days', 'under_4h'],
      activity: {
        from: '2026-08-01T00:00:00.000Z',
        to: '2026-08-10T00:00:00.000Z',
      },
    });

    expect(parsed).toMatchObject({
      queue: 'act_now',
      states: ['action_required'],
      evidenceTiers: ['persisted_reply', 'quoted_reply'],
      ageBuckets: ['under_4h', 'over_three_days'],
      activityAffectsWorklist: false,
    });
    expect(() =>
      parseCenturionIntelligenceListQueueInput({
        queue: 'act_now',
        expectedRevisionToken: 'revision_bad',
      }),
    ).toThrow('CENTURION_INTELLIGENCE_INPUT_INVALID');
  });

  it('binds signed cursors to scope, revision, queue, normalized filters, tuple, and expiry', () => {
    const request = parseCenturionIntelligenceListQueueInput({
      queue: 'act_now',
      expectedRevisionToken: `revision_${'b'.repeat(64)}`,
      ageBuckets: ['under_4h', 'over_three_days'],
    });
    const cursor = encodeCenturionIntelligenceQueueCursor({
      transportId: 'transport-fixture',
      request,
      tuple: {
        sortGroup: 0,
        sortRank: 7,
        componentId: `component_${'c'.repeat(64)}`,
      },
      key: CURSOR_KEY,
      now: NOW,
    });

    expect(
      decodeCenturionIntelligenceQueueCursor({
        cursor,
        transportId: 'transport-fixture',
        request,
        key: CURSOR_KEY,
        now: NOW,
      }),
    ).toEqual({
      sortGroup: 0,
      sortRank: 7,
      componentId: `component_${'c'.repeat(64)}`,
    });

    for (const invalid of [
      {
        cursor,
        transportId: 'transport-other',
        request,
        key: CURSOR_KEY,
        now: NOW,
      },
      {
        cursor,
        transportId: 'transport-fixture',
        request: { ...request, queue: 'review_today' as const },
        key: CURSOR_KEY,
        now: NOW,
      },
      {
        cursor: `${cursor.slice(0, -1)}A`,
        transportId: 'transport-fixture',
        request,
        key: CURSOR_KEY,
        now: NOW,
      },
      {
        cursor,
        transportId: 'transport-fixture',
        request,
        key: CURSOR_KEY,
        now: FUTURE,
      },
    ]) {
      expect(() => decodeCenturionIntelligenceQueueCursor(invalid)).toThrow(
        'CENTURION_INTELLIGENCE_CURSOR_INVALID',
      );
    }
  });

  it('uses mailbox scope and explicit repeatable-read transactions without raw response fields', () => {
    const source = readFileSync(
      resolve(import.meta.dirname, '../src/trpc/routes/centurion-intelligence.ts'),
      'utf8',
    );

    expect(source).toContain('mailboxProcedure');
    expect(source).toContain('ctx.activeTransportId');
    expect(source).toContain('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ, READ ONLY');
    expect(source).toContain('threadAuditSnapshotComponentThread.isPrimary');
    expect(source).toContain('mailThread.transportId');
    expect(source).not.toMatch(/\bsubject\b|\bsnippet\b|\btextBody\b|\bhtmlBody\b/u);
  });
});

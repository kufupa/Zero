import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  buildActionableUntaggedRepairArtifacts,
  selectActionableRows,
} from '../scripts/emit-centurion-actionable-untagged-manifest.mjs';

describe('emit-centurion-actionable-untagged-manifest', () => {
  const promptHash = createHash('sha256').update('test-prompt').digest('hex');

  it('selects only actionable inbound untagged rows', () => {
    const rows = [
      {
        threadId: 'keep',
        spamAt: null,
        spamUserLockedAt: null,
        hasInbound: true,
        latestInboundId: 'm1',
        latestInboundFrom: 'a@b.com',
        latestInboundCreatedAt: '2026-09-03T10:00:00.000Z',
        subject: 'Bed bugs',
        aiCategorySlugs: [],
      },
      {
        threadId: 'fixture',
        spamAt: null,
        spamUserLockedAt: null,
        hasInbound: true,
        latestInboundId: 'm2',
        latestInboundFrom: 'guest@example.com',
        latestInboundCreatedAt: '2026-07-01T10:00:00.000Z',
        subject: 'Booking',
        aiCategorySlugs: [],
      },
      {
        threadId: 'tagged',
        spamAt: null,
        spamUserLockedAt: null,
        hasInbound: true,
        latestInboundId: 'm3',
        latestInboundFrom: 'a@b.com',
        latestInboundCreatedAt: '2026-09-03T10:00:00.000Z',
        subject: 'Hi',
        aiCategorySlugs: ['bookings'],
      },
    ];
    expect(selectActionableRows(rows).map((r) => r.threadId)).toEqual(['keep']);
  });

  it('builds a bound repair manifest for actionable rows', () => {
    const { manifest, snapshot, actionableCount } = buildActionableUntaggedRepairArtifacts({
      promptHash,
      generatedAt: '2026-09-03T22:00:00.000Z',
      rows: [
        {
          threadId: 'keep',
          spamAt: null,
          spamUserLockedAt: null,
          hasInbound: true,
          latestInboundId: 'm1',
          latestInboundFrom: 'a@b.com',
          latestInboundCreatedAt: '2026-09-03T10:00:00.000Z',
          subject: 'Bed bugs',
          aiCategorySlugs: [],
        },
      ],
    });
    expect(actionableCount).toBe(1);
    expect(snapshot.cohorts.eligible).toHaveLength(1);
    expect(manifest.targets).toHaveLength(1);
    expect(manifest.targets[0]).toMatchObject({
      threadId: 'keep',
      triggerMessageId: 'm1',
      approvedPrimaryFolder: 'unknown-review',
      approvedIsSpam: false,
    });
    expect(manifest.sourceHash).toMatch(/^[a-f0-9]{64}$/);
    expect(manifest.manifestHash).toMatch(/^[a-f0-9]{64}$/);
  });
});

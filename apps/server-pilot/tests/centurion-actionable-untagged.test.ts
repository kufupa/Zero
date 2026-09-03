import { describe, expect, it } from 'vitest';
import {
  classifyDeadLetterReason,
  evaluateActionableInboundUntaggedGate,
  isActionableInboundUntagged,
  isFixtureAllowlistedUntagged,
} from '../src/ops/centurion-actionable-untagged.ts';

describe('centurion actionable inbound untagged gate', () => {
  it('flags clear inbound threads with no category', () => {
    expect(
      isActionableInboundUntagged({
        threadId: 't1',
        spamAt: null,
        hasInbound: true,
        hasCategory: false,
        latestInboundFrom: 'guest@hotel.com',
        subject: 'Bed bugs found during my stay',
      }),
    ).toBe(true);
  });

  it('excludes spam, outbound-only, already tagged, and fixture allowlist', () => {
    expect(
      isActionableInboundUntagged({
        threadId: 'spam',
        spamAt: '2026-09-01T00:00:00.000Z',
        hasInbound: true,
        hasCategory: false,
      }),
    ).toBe(false);
    expect(
      isActionableInboundUntagged({
        threadId: 'out',
        spamAt: null,
        hasInbound: false,
        hasCategory: false,
      }),
    ).toBe(false);
    expect(
      isActionableInboundUntagged({
        threadId: 'tagged',
        spamAt: null,
        hasInbound: true,
        hasCategory: true,
      }),
    ).toBe(false);
    expect(
      isFixtureAllowlistedUntagged({
        latestInboundFrom: 'guest@example.com',
        subject: 'Booking',
      }),
    ).toBe(true);
    expect(
      isActionableInboundUntagged({
        threadId: 'fix',
        spamAt: null,
        hasInbound: true,
        hasCategory: false,
        latestInboundFrom: 'guest@example.com',
        subject: 'Booking',
      }),
    ).toBe(false);
  });

  it('buckets dead-letter reasons without treating RUN_DEADLINE as workflow_failed', () => {
    expect(
      classifyDeadLetterReason({ lastError: 'mail triage workflow failed: failed' }),
    ).toBe('workflow_failed');
    expect(classifyDeadLetterReason({ failureClass: 'RUN_DEADLINE' })).toBe('run_deadline');
    expect(
      classifyDeadLetterReason({
        lastError: 'AI category missing for transport transport-nava: internal-partner',
      }),
    ).toBe('category_missing');
  });

  it('evaluateActionableInboundUntaggedGate fails closed when backlog remains', () => {
    const result = evaluateActionableInboundUntaggedGate([
      {
        threadId: 'keep',
        spamAt: null,
        hasInbound: true,
        hasCategory: false,
        latestInboundFrom: 'a@b.com',
        subject: 'Hi',
      },
      {
        threadId: 'fixture',
        spamAt: null,
        hasInbound: true,
        hasCategory: false,
        latestInboundFrom: 'guest@example.com',
        subject: 'Booking',
      },
    ]);
    expect(result.ok).toBe(false);
    expect(result.actionableCount).toBe(1);
    expect(result.actionableThreadIds).toEqual(['keep']);
  });
});

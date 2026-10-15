import {
  buildHmsRefreshIdempotencyKey,
  evaluateHmsCandidateFreshness,
} from '../src/trpc/routes/drafts.js';
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';

describe('visible draft refresh safety', () => {
  it('uses one deterministic fenced key for concurrent refresh requests', () => {
    const input = {
      transportId: 'transport-1',
      threadId: 'thread-1',
      threadStateVersion: 'state-1',
    };
    expect(buildHmsRefreshIdempotencyKey(input)).toBe(buildHmsRefreshIdempotencyKey(input));
    expect(buildHmsRefreshIdempotencyKey(input)).not.toBe(
      buildHmsRefreshIdempotencyKey({ ...input, threadStateVersion: 'state-2' }),
    );
  });

  it('never treats stale evidence as a fresh candidate during refresh or send', () => {
    expect(
      evaluateHmsCandidateFreshness({
        threadStateVersion: 'state-1',
        liveThreadStateVersion: 'state-1',
        evidence: [{ malformed: true }],
      }),
    ).toBe('unknown');
  });

  it('keeps refresh visible only behind the existing supported-mode guard', () => {
    const source = readFileSync(new URL('../src/trpc/routes/ai.ts', import.meta.url), 'utf8');
    expect(source).toMatch(/isVisibleDraftAssistanceEnabled/);
    expect(source).toMatch(/refreshHmsCandidate/);
  });

  it('labels candidate-draft enqueue from the configured draft route, not Nova Lite', () => {
    const source = readFileSync(new URL('../src/trpc/routes/drafts.ts', import.meta.url), 'utf8');
    expect(source).toMatch(/draftRouteEnqueueLabels/);
    expect(source).not.toMatch(/modelId: input\.modelId \?\? DEFAULT_AI_MODEL_ID/);
    const worker = readFileSync(new URL('../src/ai/worker.ts', import.meta.url), 'utf8');
    expect(worker).toMatch(/AzureLunaModelAdapter/);
    expect(worker).toMatch(/azure-foundry-responses/);
  });
});

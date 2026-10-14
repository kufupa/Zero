import { describe, expect, it } from 'vitest';
import { resolveAiRunDeadlineMs } from '../src/ai/run-deadline.js';

describe('AI run deadlines', () => {
  it('gives max-effort extraction room for translation and post-call work', () => {
    expect(
      resolveAiRunDeadlineMs({
        runKind: 'inbound_extraction',
        configuredDeadlineMs: 150_000,
        extractionEffort: 'max',
      }),
    ).toBe(300_000);
  });

  it('keeps low/medium extraction and unrelated run budgets unchanged', () => {
    expect(
      resolveAiRunDeadlineMs({
        runKind: 'inbound_extraction',
        configuredDeadlineMs: 150_000,
        extractionEffort: 'medium',
      }),
    ).toBe(150_000);
    expect(
      resolveAiRunDeadlineMs({
        runKind: 'read_tool',
        configuredDeadlineMs: 75_000,
        extractionEffort: 'max',
      }),
    ).toBe(75_000);
  });

  it('gives max-effort triage the same outer-run headroom', () => {
    expect(
      resolveAiRunDeadlineMs({
        runKind: 'inbound_triage',
        configuredDeadlineMs: 150_000,
        extractionEffort: 'medium',
      }),
    ).toBe(300_000);
  });
});

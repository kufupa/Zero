import {
  CONNECTED_RUN_BASE_DEADLINE_MS,
  CONNECTED_RUN_VARIANTS_DEADLINE_MS,
  connectedRunDeadlineMs,
} from '../src/hms/connected-run-budget.js';
import { connectedCallTiming } from '../src/hms/connected-call-timing.js';
import { describe, expect, it } from 'vitest';

describe('connected runner bounded timing', () => {
  it('keeps baseline deadline at two minutes when variants are off', () => {
    expect(
      connectedRunDeadlineMs({
        allTools: true,
        notesVariants: false,
        folioVariants: false,
      }),
    ).toBe(CONNECTED_RUN_BASE_DEADLINE_MS);
  });

  it('allows eight-minute deadline only for an opted-in included variant', () => {
    expect(
      connectedRunDeadlineMs({
        allTools: true,
        notesVariants: true,
        folioVariants: false,
      }),
    ).toBe(CONNECTED_RUN_VARIANTS_DEADLINE_MS);
    expect(
      connectedRunDeadlineMs({
        allTools: true,
        notesVariants: false,
        folioVariants: true,
      }),
    ).toBe(CONNECTED_RUN_VARIANTS_DEADLINE_MS);
  });

  it('does not extend deadline when flags are present without full tool probe', () => {
    expect(
      connectedRunDeadlineMs({
        allTools: false,
        notesVariants: true,
        folioVariants: true,
      }),
    ).toBe(CONNECTED_RUN_BASE_DEADLINE_MS);
  });

  it('returns safe call timing metadata without negative duration', () => {
    expect(connectedCallTiming(1_000, 1_250)).toEqual({
      startedAt: '1970-01-01T00:00:01.000Z',
      finishedAt: '1970-01-01T00:00:01.250Z',
      durationMs: 250,
    });
    expect(connectedCallTiming(1_250, 1_000).durationMs).toBe(0);
  });
});

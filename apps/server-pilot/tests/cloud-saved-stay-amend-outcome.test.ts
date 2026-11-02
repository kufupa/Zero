import { describe, expect, it } from 'vitest';
import { classifyUnreconciledCloudAmend } from '../src/ai/cloud-saved-stay-amend-outcome.js';

describe('unreconciled Cloud amendment outcome', () => {
  it('classifies a trusted native not-dispatched outcome as needs-check', () => {
    expect(classifyUnreconciledCloudAmend({ outcome: 'not_dispatched' }))
      .toEqual({ failureClass: 'NEEDS_CHECK', reason: 'AMEND_NOT_DISPATCHED' });
  });
  it.each([
    { outcome: 'awaiting_readback' }, { outcome: 'uncertain' }, { outcome: 'amended' },
    { outcome: 'not_dispatched', possiblyDispatched: true },
    { outcome: 'not_dispatched', saveAttempted: 'unknown' },
    { outcome: 'not_dispatched', dispatched: null },
    { outcome: 'not_dispatched', clickedSave: true },
    { outcome: 'unrecognized' }, null, {},
  ])('keeps possible or unproven dispatch unknown: %o', (result) => {
    expect(classifyUnreconciledCloudAmend(result))
      .toEqual({ failureClass: 'UNKNOWN', reason: 'AMEND_OUTCOME_UNKNOWN' });
  });
  it('does not let a producer claim a readback makes the result successful', () => {
    expect(classifyUnreconciledCloudAmend({ outcome: 'awaiting_readback',
      readbackVerified: true, readback: { confirmation: 'example' } }).failureClass).toBe('UNKNOWN');
  });
});

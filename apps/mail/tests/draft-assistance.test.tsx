import {
  draftApprovalReviewFingerprint,
  resolveDraftReviewState,
} from '../lib/mail/thread-draft-view-model';
import { describe, expect, it } from 'vitest';

describe('visible draft assistance review state', () => {
  const ai = {
    origin: 'ai' as const,
    isStale: false,
    body: '<p>We can help.</p>',
    subject: 'Re: Booking',
    to: ['guest@example.test'],
    cc: [],
    bcc: [],
    attachmentKeys: [],
    evidenceVersion: 'evidence-1',
  };

  it('keeps manual mail on the ordinary path and requires review for AI text', () => {
    expect(resolveDraftReviewState({ ...ai, origin: 'manual' })).toBe('manual');
    expect(resolveDraftReviewState(ai)).toBe('review');
  });

  it('approves only the exact current body, recipients, attachments, and evidence', () => {
    const fingerprint = draftApprovalReviewFingerprint(ai);
    expect(resolveDraftReviewState({ ...ai, approvedFingerprint: fingerprint })).toBe('approved');
    expect(
      resolveDraftReviewState({
        ...ai,
        body: '<p>Edited after review.</p>',
        approvedFingerprint: fingerprint,
      }),
    ).toBe('review');
    expect(
      resolveDraftReviewState({
        ...ai,
        to: ['other@example.test'],
        approvedFingerprint: fingerprint,
      }),
    ).toBe('review');
    expect(
      resolveDraftReviewState({
        ...ai,
        evidenceVersion: 'evidence-2',
        approvedFingerprint: fingerprint,
      }),
    ).toBe('review');
  });

  it('marks stale evidence for re-review without replacing the edited body', () => {
    const fingerprint = draftApprovalReviewFingerprint(ai);
    const changedEvidence = { ...ai, evidenceVersion: 'expired', approvedFingerprint: fingerprint };
    expect(resolveDraftReviewState(changedEvidence)).toBe('review');
    expect(changedEvidence.body).toBe(ai.body);
  });
});

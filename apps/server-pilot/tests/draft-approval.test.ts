import {
  DRAFT_APPROVAL_POLICY_VERSION,
  DRAFT_APPROVAL_VERSION,
  DraftApprovalError,
  buildDraftApproval,
  assertDraftApprovalMatchesPayload,
  type DraftApprovalPayload,
} from '../src/ai/draft-approval.js';
import { describe, expect, it } from 'vitest';

const SIGNING_SECRET = 'u6-test-signing-secret';

const base: DraftApprovalPayload = {
  draftId: 'draft-1',
  generationId: 'generation-1',
  transportId: 'transport-1',
  threadId: 'thread-1',
  revisionId: 'revision-1',
  threadStateVersion: 'thread-state-1',
  evidence: [{ kind: 'hms', id: 'evidence-1', sourceHash: 'source-1' }],
  policyVersion: DRAFT_APPROVAL_POLICY_VERSION,
  approvedByUserId: 'user-1',
  approvedAt: '2026-09-09T10:00:00.000Z',
  origin: 'ai',
  subject: 'Reservation follow-up',
  html: '<p>We can help.</p>',
  text: 'We can help.',
  to: ['guest@example.test'],
  cc: [],
  bcc: [],
  attachments: [],
};

describe('draft approval token', () => {
  it('is closed, deterministic, and binds every send input plus evidence', () => {
    const approval = buildDraftApproval(base, SIGNING_SECRET);

    expect(approval.version).toBe(DRAFT_APPROVAL_VERSION);
    expect(approval.purpose).toBe('draft-only');
    expect(approval.fingerprint).toMatch(/^[a-f0-9]{64}$/);
    expect(approval.bodyDigest).toMatch(/^[a-f0-9]{64}$/);
    expect(approval.recipientDigest).toMatch(/^[a-f0-9]{64}$/);
    expect(approval.attachmentDigest).toMatch(/^[a-f0-9]{64}$/);
    expect(approval.evidenceDigest).toMatch(/^[a-f0-9]{64}$/);
    expect(Object.keys(approval).sort()).toEqual([
      'approvedAt',
      'approvedByUserId',
      'attachmentDigest',
      'bodyDigest',
      'draftId',
      'evidenceDigest',
      'fingerprint',
      'generationId',
      'policyVersion',
      'purpose',
      'recipientDigest',
      'revisionId',
      'signature',
      'threadId',
      'threadStateVersion',
      'transportId',
      'version',
    ]);
    expect(buildDraftApproval(base, SIGNING_SECRET)).toEqual(approval);
    expect(approval.signature).toMatch(/^[a-f0-9]{64}$/);
  });

  it('requires a fresh approval when body, recipient, attachment, policy, or revision changes', () => {
    const approval = buildDraftApproval(base, SIGNING_SECRET);
    expect(() =>
      assertDraftApprovalMatchesPayload(
        approval,
        {
          ...base,
          html: '<p>Changed after review.</p>',
        },
        SIGNING_SECRET,
      ),
    ).toThrow(DraftApprovalError);
    expect(() =>
      assertDraftApprovalMatchesPayload(
        approval,
        {
          ...base,
          to: ['other@example.test'],
        },
        SIGNING_SECRET,
      ),
    ).toThrow(DraftApprovalError);
    expect(() =>
      assertDraftApprovalMatchesPayload(
        approval,
        {
          ...base,
          attachments: [
            {
              filename: 'quote.pdf',
              mimeType: 'application/pdf',
              sizeBytes: 3,
              contentBase64: 'YWJj',
            },
          ],
        },
        SIGNING_SECRET,
      ),
    ).toThrow(DraftApprovalError);
    expect(() =>
      assertDraftApprovalMatchesPayload(
        approval,
        {
          ...base,
          policyVersion: 'different-policy',
        },
        SIGNING_SECRET,
      ),
    ).toThrow(DraftApprovalError);
    expect(() =>
      assertDraftApprovalMatchesPayload(
        approval,
        {
          ...base,
          revisionId: 'revision-2',
        },
        SIGNING_SECRET,
      ),
    ).toThrow(DraftApprovalError);
  });

  it('does not create a token for manual drafts', () => {
    expect(() =>
      buildDraftApproval(
        {
          ...base,
          origin: 'manual',
        },
        SIGNING_SECRET,
      ),
    ).toThrow(DraftApprovalError);
  });

  it('rejects malformed, unknown, or non-draft-purpose tokens', () => {
    const approval = buildDraftApproval(base, SIGNING_SECRET);
    expect(() =>
      assertDraftApprovalMatchesPayload(
        { ...approval, purpose: 'send-anything' } as typeof approval,
        base,
        SIGNING_SECRET,
      ),
    ).toThrow(DraftApprovalError);
    expect(() =>
      assertDraftApprovalMatchesPayload(
        { ...approval, fingerprint: 'not-a-fingerprint' } as typeof approval,
        base,
        SIGNING_SECRET,
      ),
    ).toThrow(DraftApprovalError);
    expect(() => assertDraftApprovalMatchesPayload(approval, base, 'wrong-secret')).toThrow(
      DraftApprovalError,
    );
  });
});

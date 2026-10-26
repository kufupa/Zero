/**
 * mail.send wire schema must accept every approval token drafts.approve can sign:
 * the installed Azure draft route and reservationist tokens carrying resultDigest.
 */
import { describe, expect, it } from 'vitest';
import {
  DRAFT_APPROVAL_POLICY_VERSION,
  buildDraftApproval,
  parseDraftApproval,
  type DraftApprovalPayload,
} from '../src/ai/draft-approval.js';
import { AZURE_DRAFT_ROUTE } from '../src/ai/draft-route-factory.js';
import { sendInput } from '../src/trpc/wire-compat.js';

const SIGNING_SECRET = 'wire-test-signing-secret';
const RELEASE = {
  releaseId: 'wire-release-a',
  releaseVersion: '2026.10.26.1',
  sourceRevision: 'wire-source-a',
  fingerprint: 'e'.repeat(64),
  purpose: 'draft' as const,
  capabilityFamilyVersions: { draft: 'u6-draft-v1' },
  issuedAt: '2026-10-01T00:00:00.000Z',
  expiresAt: '2099-01-01T00:00:00.000Z',
  withdrawn: false,
};
const base: DraftApprovalPayload = {
  draftId: 'draft-1',
  generationId: 'generation-1',
  transportId: 'transport-1',
  threadId: 'thread-1',
  revisionId: 'revision-1',
  threadStateVersion: 'thread-state-1',
  evidence: [],
  policyVersion: DRAFT_APPROVAL_POLICY_VERSION,
  approvedByUserId: 'user-1',
  approvedAt: '2026-10-26T10:00:00.000Z',
  origin: 'ai',
  subject: 'Quote',
  html: '<p>Quote attached.</p>',
  text: 'Quote attached.',
  to: ['guest@example.test'],
  cc: [],
  bcc: [],
  attachments: [],
};
const send = (draftApproval: unknown) => ({
  to: ['guest@example.test'],
  message: '<p>Quote attached.</p>',
  draftId: 'draft-1',
  draftApproval,
});

describe('mail.send wire schema — signed draft approvals', () => {
  it('accepts an approval bound to the Azure draft route and keeps it verifiable', () => {
    const approval = buildDraftApproval(
      { ...base, routeBinding: { ...AZURE_DRAFT_ROUTE, release: RELEASE } },
      SIGNING_SECRET,
    );
    const parsed = sendInput.parse(send(approval));
    expect(parsed.draftApproval?.routeBinding?.protocol).toBe('azure-foundry-responses');
    expect(() => parseDraftApproval(parsed.draftApproval, SIGNING_SECRET)).not.toThrow();
  });

  it('accepts a reservationist approval carrying resultDigest and keeps it verifiable', () => {
    const approval = buildDraftApproval({ ...base, resultDigest: 'a'.repeat(64) }, SIGNING_SECRET);
    const parsed = sendInput.parse(send(approval));
    expect(parsed.draftApproval?.resultDigest).toBe('a'.repeat(64));
    expect(() => parseDraftApproval(parsed.draftApproval, SIGNING_SECRET)).not.toThrow();
  });

  it('rejects a route binding that mixes protocol and egress', () => {
    const approval = buildDraftApproval(
      { ...base, routeBinding: { ...AZURE_DRAFT_ROUTE, release: RELEASE } },
      SIGNING_SECRET,
    );
    const mixed = { ...approval, routeBinding: { ...approval.routeBinding, egress: 'none' } };
    expect(sendInput.safeParse(send(mixed)).success).toBe(false);
  });
});

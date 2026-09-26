import { executeReadToolRun } from '../src/hms/read-service.js';
import { describe, expect, it } from 'vitest';

const baseContext = {
  transportId: 'transport-communications',
  mailboxId: 'mailbox-communications',
  threadId: 'thread-communications',
  triggerMessageId: 'message-communications',
  propertyCode: 'HRCEN',
  parentRef: 'parent-communications',
  branchId: 'sent_email_audit',
  releaseId: 'release-communications',
  signal: new AbortController().signal,
  budget: { total: 0, limit: 3 },
  now: () => new Date('2026-09-15T12:00:00.000Z'),
  requireAdmissionBinding: false,
  requireCurrentAppAccess: false,
};

describe('normal communication read dispatch', () => {
  it('returns typed unavailable instead of rejecting an admitted document branch', async () => {
    const receipt = await executeReadToolRun({
      runKind: 'read_tool',
      executorLane: 'hms',
      draftingEnabled: false,
      request: {
        toolId: 'hms_list_documents',
        candidateId: 'candidate-1',
        documentScope: 'tax_invoice',
      },
      context: {
        ...baseContext,
        requester: {
          authorizationId: 'auth-communications',
          transportId: baseContext.transportId,
          threadId: baseContext.threadId,
          triggerMessageId: baseContext.triggerMessageId,
          allowedClaimKinds: ['document_metadata'],
          expiresAt: '2026-09-15T12:05:00.000Z',
        },
      },
      resultRef: 'read-communications-1',
    });

    expect(receipt.result.toolId).toBe('hms_list_documents');
    expect(receipt.result.status).toBe('manual_required');
    expect(receipt.result.issues[0]?.code).toBe('POLICY_UNAPPROVED');
  });

  it('uses the real typed handler when one is supplied', async () => {
    const receipt = await executeReadToolRun({
      runKind: 'read_tool',
      executorLane: 'hms',
      draftingEnabled: false,
      request: { toolId: 'hms_sent_email_audit', candidateId: 'candidate-2' },
      context: {
        ...baseContext,
        requester: {
          authorizationId: 'auth-communications',
          transportId: baseContext.transportId,
          threadId: baseContext.threadId,
          triggerMessageId: baseContext.triggerMessageId,
          allowedClaimKinds: ['sent_email_audit'],
          expiresAt: '2026-09-15T12:05:00.000Z',
        },
        handlers: {
          readSentEmailAudit: async ({ candidateId }) => ({
            toolId: 'hms_sent_email_audit' as const,
            schemaVersion: 'hms-communications/1',
            status: 'unverified_negative' as const,
            data: null,
            completeness: 'unknown' as const,
            unavailableSections: [{ section: 'sent_email', reasonCode: 'UNVERIFIED_NEGATIVE' as const }],
            scopeRef: candidateId,
            evidence: [],
            page: null,
            issues: [
              {
                code: 'UNVERIFIED_NEGATIVE' as const,
                retryable: false,
                safeNextAction: 'manual_review' as const,
              },
            ],
          }),
        },
      },
      resultRef: 'read-communications-2',
    });

    expect(receipt.result.status).toBe('unverified_negative');
    expect(receipt.result.scopeRef).toBe('candidate-2');
  });
});

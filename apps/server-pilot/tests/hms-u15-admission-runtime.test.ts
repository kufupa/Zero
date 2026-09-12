import {
  createLiveHmsCandidateSessionFactory,
  executeSynchronousHmsFindReservation,
} from '../src/ai/worker.js';
import { assertReadAdmissionIssuer, issueReadAdmission } from '../src/hms/read-admission.js';
import { mintLinkedContextReference } from '../src/hms/context-read-reference.js';
import { readRequestSchema } from '../src/hms/read-service.js';
import { describe, expect, it } from 'vitest';

const now = new Date('2026-09-08T12:00:00.000Z');
const source = {
  userId: 'user-u15',
  mailboxAccessId: 'access-u15',
  transportId: 'transport-u15',
  threadId: 'thread-u15',
  triggerMessageId: 'message-u15',
  releaseId: 'release-u15',
  requestBranchId: 'u15-context',
  propertyCode: 'HRCEN',
  sourceRevision: 'u15-test-source',
  manifestSha256: 'a'.repeat(64),
  captureBindingRef: 'result-u15',
};
const companyReservationRef = 'reservation-u15';

describe('U15 normal admission and queue boundary', () => {
  it('rejects a pre-aborted synchronous entry before loading runtime configuration', async () => {
    await expect(
      executeSynchronousHmsFindReservation({
        userId: '',
        transportId: '',
        threadId: '',
        signal: AbortSignal.abort(),
      }),
    ).rejects.toMatchObject({ code: 'READ_ABORTED' });
  });

  it('does not mint a linked context admission from a caller-selected business reference', () => {
    expect(() =>
      issueReadAdmission({
        source,
        now,
        toolId: 'hms_group_block_read',
        candidateId: 'candidate-u15',
        groupRef: 'GROUP-CALLER-SELECTED',
        parentReadResultRef: 'find-result-u15',
        evidenceExpiresAt: new Date('2026-09-08T12:04:00.000Z'),
      }),
    ).toThrow(/server-owned|context reference|linked/i);
  });

  it.each([
    {
      toolId: 'hms_company_account_read' as const,
      request: { reservationRef: companyReservationRef },
    },
    {
      toolId: 'hms_group_block_read' as const,
      request: { groupRef: 'group-u15', sections: ['summary', 'blocks', 'delegates'] },
    },
    {
      toolId: 'hms_event_read' as const,
      request: { eventRef: 'event-u15' },
    },
    {
      toolId: 'hms_read_notes_traces' as const,
      request: {
        resourceRef: 'notes-u15',
        states: ['open'],
        limit: 20,
        audience: 'customer' as const,
      },
    },
  ])('binds $toolId to the exact parent/read reference', ({ toolId, request }) => {
    const contextReference = mintLinkedContextReference({
      kind:
        toolId === 'hms_company_account_read'
          ? 'company'
          : toolId === 'hms_group_block_read'
            ? 'group'
            : toolId === 'hms_event_read'
              ? 'event'
              : 'notes',
      sourceRef:
        toolId === 'hms_company_account_read'
          ? request.reservationRef
          : toolId === 'hms_group_block_read'
            ? request.groupRef
            : toolId === 'hms_event_read'
              ? request.eventRef
              : request.resourceRef,
      parentReadResultRef: 'find-result-u15',
      propertyCode: 'HRCEN',
      requestBranchId: source.requestBranchId,
      sourceRevision: source.sourceRevision,
      issuedAt: now,
      expiresAt: new Date('2026-09-08T12:04:00.000Z'),
    });
    const issued = issueReadAdmission({
      source,
      now,
      toolId,
      candidateId: 'candidate-u15',
      parentReadResultRef: 'find-result-u15',
      evidenceExpiresAt: new Date('2026-09-08T12:04:00.000Z'),
      ...(toolId === 'hms_company_account_read'
        ? { reservationRef: request.reservationRef, contextReference }
        : toolId === 'hms_group_block_read'
          ? { groupRef: request.groupRef, contextReference, sections: request.sections }
          : toolId === 'hms_event_read'
            ? { eventRef: request.eventRef, contextReference }
            : {
                resourceRef: request.resourceRef,
                contextReference,
                states: request.states,
                limit: request.limit,
                audience: request.audience,
              }),
    });

    const parsed = readRequestSchema.parse(issued.readRequest);
    expect(parsed.toolId).toBe(toolId);
    expect(parsed.admission?.captureRequired).toBe(true);
    expect(parsed.admission?.captureBindingRef).toBe('result-u15');
    expect(parsed.admission?.reservationRef).toBe(
      toolId === 'hms_company_account_read'
        ? contextReference.reference
        : toolId === 'hms_group_block_read'
          ? contextReference.reference
          : toolId === 'hms_event_read'
            ? contextReference.reference
            : contextReference.reference,
    );
    expect(
      assertReadAdmissionIssuer({
        issuer: issued.issuer,
        admission: parsed.admission,
        request: parsed as unknown as Record<string, unknown>,
        transportId: source.transportId,
        threadId: source.threadId,
        triggerMessageId: source.triggerMessageId,
      }).parentReadResultRef,
    ).toBe('find-result-u15');
  });

  it('uses the default linked-session construction and preserves the live source blocker', async () => {
    const keys = [
      'NODE_ENV',
      'PORT',
      'DATABASE_URL',
      'BETTER_AUTH_URL',
      'BETTER_AUTH_SECRET',
      'AWS_REGION',
      'S3_BUCKET',
      'AI_WORKER_LANE',
      'HMS_READ_SERVICE_ENABLED',
      'HMS_DRAFT_ENRICHMENT_MODE',
      'HMS_EXPECTED_PROPERTY_CODE',
      'HMS_EXPECTED_TENANT',
      'HMS_EXPECTED_TRANSPORT_ID',
      'HMS_READ_SECRET_ARN',
      'HMS_CHROMIUM_EXECUTABLE_PATH',
      'HMS_READ_ROLE_PROOF_PATH',
      'HMS_EVIDENCE_HMAC_SECRET_ARN',
      'HMS_EVIDENCE_HMAC_KEY_VERSION',
      'HMS_HEALTH_STATUS_PATH',
      'NAVA_BUILD_COMMIT',
    ];
    const previous = new Map(keys.map((key) => [key, process.env[key]]));
    Object.assign(process.env, {
      NODE_ENV: 'test',
      PORT: '3000',
      DATABASE_URL: 'postgres://u15-local.invalid/db',
      BETTER_AUTH_URL: 'https://u15.local',
      BETTER_AUTH_SECRET: 'x'.repeat(32),
      AWS_REGION: 'test-region',
      S3_BUCKET: 'u15-bucket',
      AI_WORKER_LANE: 'hms',
      HMS_READ_SERVICE_ENABLED: 'true',
      HMS_DRAFT_ENRICHMENT_MODE: 'off',
      HMS_EXPECTED_PROPERTY_CODE: 'HRCEN',
      HMS_EXPECTED_TENANT: 'u15-tenant',
      HMS_EXPECTED_TRANSPORT_ID: source.transportId,
      HMS_READ_SECRET_ARN: 'u15-secret',
      HMS_CHROMIUM_EXECUTABLE_PATH: '/bin/false',
      HMS_READ_ROLE_PROOF_PATH: '/tmp/u15-role-proof.json',
      HMS_EVIDENCE_HMAC_SECRET_ARN: 'u15-evidence-secret',
      HMS_EVIDENCE_HMAC_KEY_VERSION: 'u15-v1',
      HMS_HEALTH_STATUS_PATH: '/tmp/u15-hms-health.json',
      NAVA_BUILD_COMMIT: 'u15-test-source',
    });
    try {
      const activeReadState = {
        releases: new Map([
          [
            'hms_company_account_read',
            {
              releaseId: 'u15-company-release',
              toolId: 'hms_company_account_read',
              evidenceKind: 'hms',
              requestBranches: [
                {
                  id: 'reservation_linked_company_billing',
                  manifestSha256: 'b'.repeat(64),
                },
              ],
            },
          ],
        ]),
        predecessors: new Map(),
        toolIds: new Set(['hms_company_account_read']),
        registry: null,
        handlerPathActive: true,
        cutoverComplete: false,
      };
      const factory = createLiveHmsCandidateSessionFactory({
        runtime: {} as never,
        activeReadState: activeReadState as never,
      });
      const session = await factory({
        transportId: source.transportId,
        threadId: source.threadId,
        triggerMessageId: source.triggerMessageId,
        propertyCode: 'HRCEN',
        lookupCandidates: [],
        signal: new AbortController().signal,
        runId: 'u15-default-session-run',
        readResultRef: 'result-u15',
        readOnly: true,
        readToolId: 'hms_company_account_read',
        readAdmission: {
          releaseId: 'u15-company-release',
          requestBranchId: 'reservation_linked_company_billing',
          manifestSha256: 'b'.repeat(64),
          requesterAuthorizationId: source.mailboxAccessId,
          inputDigest: 'c'.repeat(64),
          captureRequired: true,
          captureBindingRef: 'result-u15',
          reservationRef: companyReservationRef,
          reservationRefIssuedAt: now.toISOString(),
          reservationRefExpiresAt: '2099-09-08T12:05:00.000Z',
        },
      });
      expect(session.readCompanyAccount).toBeTypeOf('function');
      const result = await session.readCompanyAccount!(
        companyReservationRef,
        new AbortController().signal,
      );
      expect(result.status).toBe('manual_required');
      expect(result.data).toMatchObject({
        organizationRef: { state: 'unknown' },
        billingMode: { state: 'unknown' },
      });
      await session.close?.();
    } finally {
      for (const key of keys) {
        const value = previous.get(key);
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    }
  });
});

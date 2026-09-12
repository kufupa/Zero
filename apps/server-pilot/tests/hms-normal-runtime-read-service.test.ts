import {
  executeTrustedSynchronousHmsFindReservation,
  executeReadToolRun,
  NOT_APPLICABLE_MODEL_ID,
} from '../src/hms/read-service.js';
import { issueCurrentAppAccessProof } from '../src/hms/requester-authorization.js';
import { createPropertyReadLock } from '../src/hms/property-read-lock.js';
import { canonicalLookupCandidateId } from '../src/ai/thread-context.js';
import { issueReadAdmission } from '../src/hms/read-admission.js';
import { describe, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';

type TrustedSyncInput = Parameters<typeof executeTrustedSynchronousHmsFindReservation>[0];

function trustedSyncFixture(
  options: {
    now?: Date;
    deadlineAt?: Date;
    candidateValue?: string;
    currentAppAccessProof?: ReturnType<typeof issueCurrentAppAccessProof>;
    signal?: AbortSignal;
    clock?: () => Date;
  } = {},
) {
  const now = options.now ?? new Date('2026-09-10T12:00:00.000Z');
  const deadlineAt = options.deadlineAt ?? new Date(Date.now() + 5 * 60_000);
  const candidateValue = options.candidateValue ?? 'CONF-123456';
  const candidateId = canonicalLookupCandidateId('confirmation', 'CONF-123456');
  const source = {
    userId: 'user-sync',
    mailboxAccessId: 'access-sync',
    transportId: 'transport-sync',
    threadId: 'thread-sync',
    triggerMessageId: 'message-sync',
    releaseId: 'release-sync',
    requestBranchId: 'guest_stay_search',
    propertyCode: 'HRCEN',
    sourceRevision: 'source-sync',
    manifestSha256: 'a'.repeat(64),
    captureBindingRef: 'result-sync',
  };
  const issued = issueReadAdmission({
    source,
    now,
    toolId: 'hms_find_reservation',
    candidateId,
  });
  const currentAppAccessProof =
    options.currentAppAccessProof ??
    issueCurrentAppAccessProof({
      userId: source.userId,
      mailboxAccessId: source.mailboxAccessId,
      transportId: source.transportId,
      threadId: source.threadId,
      triggerMessageId: source.triggerMessageId,
      expiresAt: deadlineAt,
      now,
    });
  const queries: string[] = [];
  const propertyReadLock = createPropertyReadLock({
    tenantId: 'tenant-sync',
    propertyCode: source.propertyCode,
    connectionFactory: async () => ({
      query: async (statement: string) => {
        queries.push(statement);
        return statement.includes('pg_try_advisory_lock')
          ? [{ acquired: true }]
          : [{ released: true }];
      },
      close: async () => undefined,
    }),
  });
  const close = vi.fn(async () => undefined);
  const findReservation = vi.fn(async () => ({
    status: 'matched' as const,
    row: {
      confirmationNumber: 'CONF-123456',
      externalReference: null,
      guestName: 'Private Guest',
      arrivalDate: '2026-09-20',
      departureDate: '2026-09-22',
      reservationStatus: 'confirmed',
      roomType: 'Room',
      ratePlan: null,
    },
    evidenceRef: 'evidence-sync',
    observedAt: now.toISOString(),
    expiresAt: deadlineAt.toISOString(),
  }));
  const sessionFactory = vi.fn(async () => ({
    findReservation,
    propertyReadLock,
    close,
  }));
  const input = {
    issued,
    candidate: { id: candidateId, kind: 'confirmation' as const, value: candidateValue },
    currentAppAccessProof,
    operationId: randomUUID(),
    readResultRef: source.captureBindingRef,
    sourceRevision: source.sourceRevision,
    propertyCode: source.propertyCode,
    transportId: source.transportId,
    threadId: source.threadId,
    triggerMessageId: source.triggerMessageId,
    deadlineAt,
    now,
    signal: options.signal ?? new AbortController().signal,
    ...(options.clock ? { clock: options.clock } : {}),
    sessionFactory,
  } as unknown as TrustedSyncInput;
  return {
    input,
    sessionFactory,
    findReservation,
    close,
    propertyReadLock,
    source,
    now,
    deadlineAt,
  };
}

describe('U8 normal runtime read_tool path', () => {
  it('executes with drafting disabled and records a typed receipt without initializing a model', async () => {
    const model = vi.fn();
    const receipt = await executeReadToolRun({
      runKind: 'read_tool',
      executorLane: 'hms',
      draftingEnabled: false,
      modelFactory: model,
      request: {
        toolId: 'hms_find_reservation',
        candidateId: 'candidate-1',
      },
      context: {
        transportId: 'transport-centurion',
        mailboxId: 'mailbox-centurion',
        threadId: 'thread-1',
        triggerMessageId: 'message-1',
        propertyCode: 'HRCEN',
        parentRef: 'parent-1',
        branchId: 'guest_stay_search',
        releaseId: 'release-1',
        requester: {
          authorizationId: 'auth-1',
          transportId: 'transport-centurion',
          threadId: 'thread-1',
          triggerMessageId: 'message-1',
          allowedClaimKinds: ['reservation_summary'],
          expiresAt: '2026-09-07T12:05:00.000Z',
        },
        signal: new AbortController().signal,
        budget: { total: 0, limit: 3 },
        now: () => new Date('2026-09-07T12:00:00.000Z'),
        handlers: {
          findReservation: async () => ({
            status: 'not_found' as const,
            data: {
              confirmation: null,
              label: null,
              referenceKind: null,
              status: null,
              arrival: null,
              departure: null,
              roomType: null,
            },
            evidenceRef: 'evidence-1',
            observedAt: '2026-09-07T12:00:00.000Z',
            expiresAt: '2026-09-07T12:05:00.000Z',
          }),
        },
      },
      resultRef: 'read-result-1',
    });

    expect(model).not.toHaveBeenCalled();
    expect(receipt.modelId).toBe(NOT_APPLICABLE_MODEL_ID);
    expect(receipt.readResultRef).toBe('read-result-1');
    expect(receipt.result.status).toBe('not_found');
  });

  it('executes a server-issued synchronous find without a workflow run or model', async () => {
    const now = new Date('2026-09-10T12:00:00.000Z');
    const deadlineAt = new Date(Date.now() + 5 * 60_000);
    const candidateId = canonicalLookupCandidateId('confirmation', 'CONF-123456');
    const source = {
      userId: 'user-sync',
      mailboxAccessId: 'access-sync',
      transportId: 'transport-sync',
      threadId: 'thread-sync',
      triggerMessageId: 'message-sync',
      releaseId: 'release-sync',
      requestBranchId: 'guest_stay_search',
      propertyCode: 'HRCEN',
      sourceRevision: 'source-sync',
      manifestSha256: 'a'.repeat(64),
      captureBindingRef: 'result-sync',
    };
    const issued = issueReadAdmission({
      source,
      now,
      toolId: 'hms_find_reservation',
      candidateId,
    });
    const currentAppAccessProof = issueCurrentAppAccessProof({
      userId: source.userId,
      mailboxAccessId: source.mailboxAccessId,
      transportId: source.transportId,
      threadId: source.threadId,
      triggerMessageId: source.triggerMessageId,
      expiresAt: deadlineAt,
      now,
    });
    const queries: string[] = [];
    const propertyReadLock = createPropertyReadLock({
      tenantId: 'tenant-sync',
      propertyCode: source.propertyCode,
      connectionFactory: async () => ({
        query: async (statement: string) => {
          queries.push(statement);
          return statement.includes('pg_try_advisory_lock')
            ? [{ acquired: true }]
            : [{ released: true }];
        },
        close: async () => undefined,
      }),
    });
    const close = vi.fn(async () => undefined);
    const findReservation = vi.fn(async () => ({
      status: 'matched' as const,
      row: {
        confirmationNumber: 'CONF-123456',
        externalReference: null,
        guestName: 'Private Guest',
        arrivalDate: '2026-09-20',
        departureDate: '2026-09-22',
        reservationStatus: 'confirmed',
        roomType: 'Room',
        ratePlan: null,
      },
      evidenceRef: 'evidence-sync',
      observedAt: now.toISOString(),
      expiresAt: deadlineAt.toISOString(),
    }));

    const receipt = await executeTrustedSynchronousHmsFindReservation({
      issued,
      candidate: { id: candidateId, kind: 'confirmation', value: 'CONF-123456' },
      currentAppAccessProof,
      operationId: randomUUID(),
      readResultRef: source.captureBindingRef,
      sourceRevision: source.sourceRevision,
      propertyCode: source.propertyCode,
      transportId: source.transportId,
      threadId: source.threadId,
      triggerMessageId: source.triggerMessageId,
      deadlineAt,
      now,
      signal: new AbortController().signal,
      sessionFactory: async () => ({
        findReservation,
        propertyReadLock,
        close,
      }),
    });

    expect(receipt.result.status).toBe('ok');
    expect(receipt.result.data?.matches).toHaveLength(1);
    expect(findReservation).toHaveBeenCalledTimes(1);
    expect(close).toHaveBeenCalledTimes(1);
    expect(queries.some((statement) => statement.includes('pg_try_advisory_lock'))).toBe(true);
  });

  it('rejects a same-ID candidate whose canonical value was substituted before creating a session', async () => {
    const fixture = trustedSyncFixture({ candidateValue: 'CONF-654321' });

    await expect(executeTrustedSynchronousHmsFindReservation(fixture.input)).rejects.toMatchObject({
      code: 'READ_SYNC_CANDIDATE_MISMATCH',
    });
    expect(fixture.sessionFactory).not.toHaveBeenCalled();
  });

  it('rejects a forged current-app proof before creating a session', async () => {
    const fixture = trustedSyncFixture();
    const forgedProof = { ...fixture.input.currentAppAccessProof };
    const input = {
      ...fixture.input,
      currentAppAccessProof: forgedProof,
    } as TrustedSyncInput;

    await expect(executeTrustedSynchronousHmsFindReservation(input)).rejects.toMatchObject({
      code: 'READ_CURRENT_APP_ACCESS_REQUIRED',
    });
    expect(fixture.sessionFactory).not.toHaveBeenCalled();
  });

  it('rejects an expired current-app proof before creating a session', async () => {
    const issuedAt = new Date('2026-09-10T12:00:00.000Z');
    const proof = issueCurrentAppAccessProof({
      userId: 'user-sync',
      mailboxAccessId: 'access-sync',
      transportId: 'transport-sync',
      threadId: 'thread-sync',
      triggerMessageId: 'message-sync',
      expiresAt: new Date('2026-09-10T12:00:01.000Z'),
      now: issuedAt,
    });
    const fixture = trustedSyncFixture({
      now: new Date('2026-09-10T12:00:02.000Z'),
      currentAppAccessProof: proof,
    });

    await expect(executeTrustedSynchronousHmsFindReservation(fixture.input)).rejects.toMatchObject({
      code: 'READ_CURRENT_APP_ACCESS_EXPIRED',
    });
    expect(fixture.sessionFactory).not.toHaveBeenCalled();
  });

  it('rejects a current-app proof with the wrong thread before creating a session', async () => {
    const fixture = trustedSyncFixture();
    const wrongScopeProof = issueCurrentAppAccessProof({
      userId: 'user-sync',
      mailboxAccessId: 'access-sync',
      transportId: 'transport-sync',
      threadId: 'other-thread',
      triggerMessageId: 'message-sync',
      expiresAt: fixture.deadlineAt,
      now: fixture.now,
    });
    const input = { ...fixture.input, currentAppAccessProof: wrongScopeProof } as TrustedSyncInput;

    await expect(executeTrustedSynchronousHmsFindReservation(input)).rejects.toMatchObject({
      code: 'READ_CURRENT_APP_ACCESS_SCOPE_MISMATCH',
    });
    expect(fixture.sessionFactory).not.toHaveBeenCalled();
  });

  it('rejects a current-app proof with the wrong trigger before creating a session', async () => {
    const fixture = trustedSyncFixture();
    const wrongScopeProof = issueCurrentAppAccessProof({
      userId: 'user-sync',
      mailboxAccessId: 'access-sync',
      transportId: 'transport-sync',
      threadId: 'thread-sync',
      triggerMessageId: 'other-message',
      expiresAt: fixture.deadlineAt,
      now: fixture.now,
    });
    const input = { ...fixture.input, currentAppAccessProof: wrongScopeProof } as TrustedSyncInput;

    await expect(executeTrustedSynchronousHmsFindReservation(input)).rejects.toMatchObject({
      code: 'READ_CURRENT_APP_ACCESS_SCOPE_MISMATCH',
    });
    expect(fixture.sessionFactory).not.toHaveBeenCalled();
  });

  it('rechecks current-app expiry against a fresh clock after session setup', async () => {
    const now = new Date('2026-09-10T12:00:00.000Z');
    const deadlineAt = new Date(Date.now() + 5 * 60_000);
    const proof = issueCurrentAppAccessProof({
      userId: 'user-sync',
      mailboxAccessId: 'access-sync',
      transportId: 'transport-sync',
      threadId: 'thread-sync',
      triggerMessageId: 'message-sync',
      expiresAt: new Date('2026-09-10T12:00:01.000Z'),
      now,
    });
    const clock = vi
      .fn<() => Date>()
      .mockReturnValueOnce(now)
      .mockReturnValue(new Date('2026-09-10T12:00:02.000Z'));
    const fixture = trustedSyncFixture({ now, deadlineAt, currentAppAccessProof: proof, clock });
    const delayedFactory = vi.fn(async () => {
      await Promise.resolve();
      return {
        findReservation: fixture.findReservation,
        propertyReadLock: fixture.propertyReadLock,
        close: fixture.close,
      };
    });
    const input = { ...fixture.input, sessionFactory: delayedFactory } as TrustedSyncInput;

    await expect(executeTrustedSynchronousHmsFindReservation(input)).rejects.toMatchObject({
      code: 'READ_CURRENT_APP_ACCESS_EXPIRED',
    });
    expect(delayedFactory).toHaveBeenCalledTimes(1);
    expect(fixture.findReservation).not.toHaveBeenCalled();
  });

  it('closes a session that resolves after cancellation wins setup', async () => {
    const fixture = trustedSyncFixture();
    const controller = new AbortController();
    let resolveFactory!: (session: {
      findReservation: typeof fixture.findReservation;
      propertyReadLock: typeof fixture.propertyReadLock;
      close: typeof fixture.close;
    }) => void;
    const pendingSession = new Promise<{
      findReservation: typeof fixture.findReservation;
      propertyReadLock: typeof fixture.propertyReadLock;
      close: typeof fixture.close;
    }>((resolve) => {
      resolveFactory = resolve;
    });
    const sessionFactory = vi.fn(async () => pendingSession);
    const input = {
      ...fixture.input,
      signal: controller.signal,
      sessionFactory,
    } as TrustedSyncInput;
    const execution = executeTrustedSynchronousHmsFindReservation(input);
    controller.abort();

    await expect(execution).rejects.toMatchObject({ code: 'READ_ABORTED' });
    resolveFactory({
      findReservation: fixture.findReservation,
      propertyReadLock: fixture.propertyReadLock,
      close: fixture.close,
    });
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(fixture.close).toHaveBeenCalledTimes(1);
  });

  it('rechecks current-app expiry after the property lock wait', async () => {
    const now = new Date('2026-09-10T12:00:00.000Z');
    const deadlineAt = new Date(Date.now() + 5 * 60_000);
    const proof = issueCurrentAppAccessProof({
      userId: 'user-sync',
      mailboxAccessId: 'access-sync',
      transportId: 'transport-sync',
      threadId: 'thread-sync',
      triggerMessageId: 'message-sync',
      expiresAt: new Date('2026-09-10T12:00:01.000Z'),
      now,
    });
    let lockAttempts = 0;
    const delayedPropertyReadLock = createPropertyReadLock({
      tenantId: 'tenant-sync-delayed',
      propertyCode: 'HRCEN',
      connectionFactory: async () => ({
        query: async (statement: string) => {
          if (statement.includes('pg_try_advisory_lock') && lockAttempts++ === 0) {
            return [{ acquired: false }];
          }
          return statement.includes('pg_try_advisory_lock')
            ? [{ acquired: true }]
            : [{ released: true }];
        },
        close: async () => undefined,
      }),
    });
    const clock = vi
      .fn<() => Date>()
      .mockReturnValueOnce(now)
      .mockReturnValueOnce(now)
      .mockReturnValueOnce(now)
      .mockReturnValue(new Date('2026-09-10T12:00:02.000Z'));
    const fixture = trustedSyncFixture({ now, deadlineAt, currentAppAccessProof: proof, clock });
    const sessionFactory = vi.fn(async () => ({
      findReservation: fixture.findReservation,
      propertyReadLock: delayedPropertyReadLock,
      close: fixture.close,
    }));
    const input = { ...fixture.input, sessionFactory } as TrustedSyncInput;

    await expect(executeTrustedSynchronousHmsFindReservation(input)).rejects.toMatchObject({
      code: 'READ_CURRENT_APP_ACCESS_EXPIRED',
    });
    expect(sessionFactory).toHaveBeenCalledTimes(1);
    expect(fixture.findReservation).not.toHaveBeenCalled();
    expect(lockAttempts).toBeGreaterThanOrEqual(2);
  });
});

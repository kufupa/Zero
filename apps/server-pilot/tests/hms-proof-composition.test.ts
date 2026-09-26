import {
  assertPhaseAProofPropertyReadLock,
  assertPhaseAProofScope,
  createPhaseAProofRuntime,
  validatePhaseAProofMilestones,
  writeHmsProofResultSidecar,
} from '../src/ops/hms-proof-composition.js';
import { mkdtemp, readFile, stat, rm } from 'node:fs/promises';
import { afterEach, describe, expect, it } from 'vitest';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const NOW = new Date('2026-09-11T10:00:00.000Z');
const EXPIRES = new Date('2026-09-11T10:05:00.000Z').toISOString();

const baseIssued = () => ({
  accessId: 'mailbox-access-1',
  candidateId: 'candidate-1',
  triggerMessageId: 'message-1',
  issuer: {
    userId: 'service-user-1',
    mailboxAccessId: 'mailbox-access-1',
    transportId: 'transport-1',
    threadId: 'thread-1',
    triggerMessageId: 'message-1',
  },
});

const lock = {
  key: '1234',
  withLock: async <T>(callback: (connection: unknown) => Promise<T>) => callback({}),
};

const tempRoots: string[] = [];
afterEach(async () => {
  await Promise.all(tempRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('Phase A proof composition', () => {
  it('fails closed when the child-only evidence key is absent before loading a secret', async () => {
    let loaded = false;
    await expect(
      createPhaseAProofRuntime(
        {
          secretArn: 'arn:aws:secretsmanager:af-south-1:1:secret:hms',
          chromiumExecutablePath: '/usr/bin/chromium',
          roleProofPath: '/tmp/role-proof',
          activeRegistryPath: '/tmp/active.json',
          releaseRoot: '/tmp/releases',
          healthPath: '/tmp/health.json',
          expectedTenant: 'tenant-1',
          expectedPropertyCode: 'HRCEN',
          expectedTransportId: 'transport-1',
          runDeadlineMs: 150_000,
          circuitCooldownMs: 30_000,
          evidenceHmacSecretArn: 'arn:aws:secretsmanager:af-south-1:1:secret:evidence',
          evidenceHmacKeyVersion: 'evidence-key-v1',
        },
        {
          sourceRevision: 'build-1',
          evidenceKeyRaw: undefined,
          loadSecret: async () => {
            loaded = true;
            return {};
          },
        },
      ),
    ).rejects.toMatchObject({ code: 'EVIDENCE_KEY_MISSING' });
    expect(loaded).toBe(false);
  });

  it('rejects candidate, grant/user, transport, thread, trigger, property, and expiry drift', () => {
    const expected = {
      requestedUserId: 'service-user-1',
      expectedTransportId: 'transport-1',
      expectedThreadId: 'thread-1',
      expectedTriggerMessageId: 'message-1',
      expectedCandidateId: 'candidate-1',
      propertyCode: 'HRCEN',
      expectedPropertyCode: 'HRCEN',
      issued: baseIssued(),
      expiresAt: EXPIRES,
      now: NOW,
    } as const;
    expect(() => assertPhaseAProofScope(expected)).not.toThrow();

    for (const [key, value] of [
      ['expectedCandidateId', 'candidate-2'],
      ['requestedUserId', 'other-user'],
      ['expectedTransportId', 'transport-2'],
      ['expectedThreadId', 'thread-2'],
      ['expectedTriggerMessageId', 'message-2'],
      ['propertyCode', 'OTHER'],
      ['expectedPropertyCode', 'OTHER'],
      ['expiresAt', '2026-09-11T09:59:00.000Z'],
    ] as const) {
      expect(() =>
        assertPhaseAProofScope({
          ...expected,
          [key]: value,
        } as never),
      ).toThrow();
    }

    expect(() =>
      assertPhaseAProofScope({
        ...expected,
        issued: { ...baseIssued(), accessId: 'other-access' },
      }),
    ).toThrow();

    // Wave 0b: surname+dates reuses mail admission; candidate ids may differ.
    expect(() =>
      assertPhaseAProofScope({
        ...expected,
        expectedCandidateId: 'surname-candidate-1',
        allowCandidateIdMismatch: true,
      }),
    ).not.toThrow();
  });

  it('requires the real property lock surface used by the driver', () => {
    expect(() => assertPhaseAProofPropertyReadLock(lock)).not.toThrow();
    expect(() => assertPhaseAProofPropertyReadLock(undefined)).toThrow(/property read lock/i);
    expect(() => assertPhaseAProofPropertyReadLock({ key: '1234' })).toThrow(/property read lock/i);
  });

  it('requires unrecorded authentication before the recorded tool milestones', () => {
    expect(
      validatePhaseAProofMilestones({
        loginStartedAt: '2026-09-11T10:00:01.000Z',
        traceStartedAt: '2026-09-11T10:00:02.000Z',
        toolStartedAt: '2026-09-11T10:00:03.000Z',
        toolFinishedAt: '2026-09-11T10:04:00.000Z',
        traceStoppedAt: '2026-09-11T10:04:01.000Z',
        contextClosedAt: '2026-09-11T10:04:02.000Z',
      }),
    ).toBe(true);
    expect(
      validatePhaseAProofMilestones({
        loginStartedAt: '2026-09-11T10:00:02.000Z',
        traceStartedAt: '2026-09-11T10:00:01.000Z',
        toolStartedAt: '2026-09-11T10:00:03.000Z',
        toolFinishedAt: '2026-09-11T10:04:00.000Z',
        traceStoppedAt: '2026-09-11T10:04:01.000Z',
        contextClosedAt: '2026-09-11T10:04:02.000Z',
      }),
    ).toBe(false);
  });

  it('persists the actual typed result in a private operation-bound sidecar', async () => {
    const root = await mkdtemp(join(tmpdir(), 'hms-proof-sidecar-'));
    tempRoots.push(root);
    const artifactId = 'artifact-1';
    const artifactDir = join(root, artifactId);
    await (await import('node:fs/promises')).mkdir(artifactDir, { mode: 0o700 });
    const written = await writeHmsProofResultSidecar({
      artifactRoot: root,
      artifactId,
      operationId: 'operation-1',
      sourceRevision: 'build-1',
      receiptSha256: 'a'.repeat(64),
      expiresAt: EXPIRES,
      roleProofSha256: 'b'.repeat(64),
      roleProofExpiresAt: EXPIRES,
      sessionAuthorization: {
        releaseId: '00000000-0000-4000-8000-0000000000a1',
        requestBranchId: 'guest_stay_search',
        manifestSha256: 'c'.repeat(64),
        roleProofSha256: 'b'.repeat(64),
        credentialVersionHmacSha256: 'd'.repeat(64),
        runtimeFingerprintSha256: 'e'.repeat(64),
        privateDigestKeyVersion: 'evidence-key-v1',
        sourceRevision: 'build-1',
      },
      issuedAdmission: {
        accessId: 'mailbox-access-1',
        triggerMessageId: 'message-1',
        candidateId: 'candidate-1',
        admission: {
          requesterAuthorizationId: 'mailbox-access-1',
          inputDigest: 'f'.repeat(64),
          captureBindingRef: 'operation-1',
        },
        issuer: {
          issuerId: 'issuer-1',
          userId: 'service-user-1',
          mailboxAccessId: 'mailbox-access-1',
          transportId: 'transport-1',
          threadId: 'thread-1',
          triggerMessageId: 'message-1',
        },
      },
      currentAppAccessProof: {
        userId: 'service-user-1',
        mailboxAccessId: 'mailbox-access-1',
        transportId: 'transport-1',
        threadId: 'thread-1',
        triggerMessageId: 'message-1',
        expiresAt: EXPIRES,
      },
      input: { candidateId: 'candidate-1' },
      result: {
        status: 'ok',
        data: { matchCount: 1 },
      },
    } as never);
    const body = JSON.parse(await readFile(join(root, written.relativePath), 'utf8')) as Record<
      string,
      any
    >;
    expect(body.result).toEqual({ status: 'ok', data: { matchCount: 1 } });
    expect(body.request).toEqual({ candidateId: 'candidate-1' });
    expect(body.provenance.issuerId).toBe('issuer-1');
    expect((await stat(join(root, written.relativePath))).mode & 0o777).toBe(0o600);
    expect(written.sha256).toMatch(/^[a-f0-9]{64}$/);
  });
});

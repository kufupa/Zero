import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  createThreadAuditSafeSourceInput,
  THREAD_AUDIT_SNAPSHOT_TIMES,
} from './fixtures/centurion-thread-audit-snapshot.js';
import {
  classifyCenturionThreadAuditPublication,
  publishCenturionThreadAuditSnapshot,
  sealCenturionThreadAuditSnapshot,
  type CenturionThreadAuditPublisherStore,
} from '../src/ops/centurion-thread-audit-publisher.js';
import {
  createCenturionThreadAuditSafeSource,
  evaluateCenturionThreadAuditSnapshotStaleness,
  parseSealedCenturionThreadAuditSnapshotBytes,
  serializeSealedCenturionThreadAuditSnapshot,
} from '../src/ops/centurion-thread-audit-snapshot.js';
import {
  formatCenturionThreadAuditSnapshotReceipt,
  parseCenturionThreadAuditSnapshotArgs,
  runCenturionThreadAuditSnapshotCli,
} from '../scripts/publish-centurion-thread-audit-snapshot.ts';

describe('Centurion thread audit snapshot envelope', () => {
  it('keeps publisher CLI imports NodeNext-safe', () => {
    const source = readFileSync(
      resolve(
        import.meta.dirname,
        '../scripts/publish-centurion-thread-audit-snapshot.ts',
      ),
      'utf8',
    );

    expect(source).not.toMatch(/from\s+['"][^'"]+\.ts['"]/u);
  });

  it('derives source-stable component IDs without Task 4/6 random references', () => {
    const first = sealCenturionThreadAuditSnapshot(
      createCenturionThreadAuditSafeSource(createThreadAuditSafeSourceInput()),
    );
    const second = sealCenturionThreadAuditSnapshot(
      createCenturionThreadAuditSafeSource(
        createThreadAuditSafeSourceInput({
          caseRefA: `case_${'1'.repeat(64)}`,
          caseRefB: `case_${'2'.repeat(64)}`,
        }),
      ),
    );

    expect(first.trustStatus).toBe('valid');
    expect(first.components.map((component) => component.componentId)).toEqual(
      second.components.map((component) => component.componentId),
    );
    expect(first.payloadDigest).toBe(second.payloadDigest);
    expect(JSON.stringify(first)).not.toContain(`case_${'d'.repeat(64)}`);
    expect(JSON.stringify(first)).not.toContain(`run_${'f'.repeat(64)}`);
  });

  it('fails closed for non-uniform or raw-shaped safe-source input', () => {
    const multiCorpus = structuredClone(createThreadAuditSafeSourceInput());
    multiCorpus.task4.sourceCorpora.push({
      ...multiCorpus.task4.sourceCorpora[0]!,
      sourceManifestDigest: '9'.repeat(64),
    });

    const crossTransport = structuredClone(createThreadAuditSafeSourceInput());
    crossTransport.task4.components[0]!.sourceMembership[0]!.transportId =
      'transport-other';

    const rawShaped = structuredClone(
      createThreadAuditSafeSourceInput(),
    ) as Record<string, unknown>;
    (rawShaped.task4 as Record<string, unknown>).subject = 'forbidden';

    for (const input of [multiCorpus, crossTransport, rawShaped]) {
      expect(() => createCenturionThreadAuditSafeSource(input)).toThrow(
        'CENTURION_THREAD_AUDIT_SNAPSHOT_INVALID',
      );
    }
  });

  it('requires Task6 facts to bind exactly canonical corpus digest', () => {
    const extraDigest = structuredClone(createThreadAuditSafeSourceInput());
    (
      extraDigest.task6Facts as unknown as {
        input: { sourceDigests: string[] };
      }
    ).input.sourceDigests.push('9'.repeat(64));

    const mixedDigest = structuredClone(createThreadAuditSafeSourceInput());
    (
      mixedDigest.task6Facts as unknown as {
        input: { sourceDigests: string[] };
      }
    ).input.sourceDigests.splice(0, 1, '8'.repeat(64));

    expect(
      (extraDigest.task6Facts as unknown as {
        input: { sourceDigests: string[] };
      }).input.sourceDigests,
    ).toEqual(['a'.repeat(64), '9'.repeat(64)]);
    expect(
      (mixedDigest.task6Facts as unknown as {
        input: { sourceDigests: string[] };
      }).input.sourceDigests,
    ).toEqual(['8'.repeat(64)]);

    for (const input of [extraDigest, mixedDigest]) {
      expect(() => createCenturionThreadAuditSafeSource(input)).toThrow(
        'CENTURION_THREAD_AUDIT_SNAPSHOT_INVALID',
      );
    }
  });

  it('rejects canonical source digest reused across components', () => {
    const duplicateMembership = structuredClone(
      createThreadAuditSafeSourceInput(),
    );
    duplicateMembership.task4.components[1]!.sourceMembership[0]!.sourceDigest =
      duplicateMembership.task4.components[0]!.sourceMembership[0]!.sourceDigest;

    expect(() => createCenturionThreadAuditSafeSource(duplicateMembership)).toThrow(
      'CENTURION_THREAD_AUDIT_SNAPSHOT_INVALID',
    );
  });

  it('validates supplied incomplete bindings before omitting them', () => {
    const malformed = structuredClone(
      createThreadAuditSafeSourceInput({ valid: false }),
    );
    malformed.task4.components[0]!.sourceMembership[0]!.transportId =
      'transport-other';

    expect(() => createCenturionThreadAuditSafeSource(malformed)).toThrow(
      'CENTURION_THREAD_AUDIT_SNAPSHOT_INVALID',
    );
  });

  it('rejects malformed, oversized, and reconciliation-invalid source material', () => {
    const malformedDigest = structuredClone(createThreadAuditSafeSourceInput());
    (
      malformedDigest.task4.sourceCorpora[0] as unknown as {
        sourceManifestDigest: string;
      }
    ).sourceManifestDigest = 'not-a-digest';

    const badTimestamp = structuredClone(createThreadAuditSafeSourceInput());
    (badTimestamp.task4 as unknown as { verifiedAt: string }).verifiedAt =
      'not-a-timestamp';

    const reconciliationMismatch = structuredClone(
      createThreadAuditSafeSourceInput(),
    );
    (
      reconciliationMismatch.task4.reconciliation as unknown as {
        messageCount: number;
      }
    ).messageCount = 4;

    const oversized = structuredClone(createThreadAuditSafeSourceInput());
    const sourceMembership = (
      oversized.task4.components[0] as unknown as {
        sourceMembership: Array<{
          sourceDigest: string;
          transportId: string;
          threadId: string;
        }>;
      }
    ).sourceMembership;
    for (let index = 0; index < 255; index += 1) {
      sourceMembership.push({
        sourceDigest: index.toString(16).padStart(64, '0'),
        transportId: 'transport-fixture',
        threadId: `thread-fixture-extra-${index}`,
      });
    }

    for (const input of [
      malformedDigest,
      badTimestamp,
      reconciliationMismatch,
      oversized,
    ]) {
      expect(() => createCenturionThreadAuditSafeSource(input)).toThrow(
        'CENTURION_THREAD_AUDIT_SNAPSHOT_INVALID',
      );
    }
  });

  it('caps distinct mappings, not repeated source membership', () => {
    const repeated = structuredClone(createThreadAuditSafeSourceInput());
    const membership = repeated.task4.components[0]!.sourceMembership;
    for (let index = 0; index < 255; index += 1) {
      membership.push({
        sourceDigest: index.toString(16).padStart(64, '0'),
        transportId: 'transport-fixture',
        threadId: 'thread-fixture-a',
      });
    }

    expect(() => createCenturionThreadAuditSafeSource(repeated)).not.toThrow();
  });

  it('rejects forged component-derived aggregate metrics', () => {
    const safe = createCenturionThreadAuditSafeSource(
      createThreadAuditSafeSourceInput(),
    );
    expect(() =>
      sealCenturionThreadAuditSnapshot({
        ...safe,
        metrics: {
          ...safe.metrics,
          currentWorkQueue: {
            ...safe.metrics.currentWorkQueue,
            actionRequiredCount: 99,
          },
        },
      }),
    ).toThrow('CENTURION_THREAD_AUDIT_SNAPSHOT_INVALID');
  });

  it('keeps semantic digest stable across timestamp changes but seals metadata bytes', () => {
    const baseline = sealCenturionThreadAuditSnapshot(
      createCenturionThreadAuditSafeSource(createThreadAuditSafeSourceInput()),
    );
    const later = sealCenturionThreadAuditSnapshot(
      createCenturionThreadAuditSafeSource(
        createThreadAuditSafeSourceInput({
          attemptedAt: '2026-08-10T01:00:00.000Z',
          verifiedAt: '2026-08-10T01:01:00.000Z',
          publishedAt: '2026-08-10T01:02:00.000Z',
        }),
      ),
    );

    expect(later.payloadDigest).toBe(baseline.payloadDigest);
    expect(later.sealedEnvelopeDigest).not.toBe(baseline.sealedEnvelopeDigest);

    const mutated = {
      ...baseline,
      verifiedAt: THREAD_AUDIT_SNAPSHOT_TIMES.attemptedAt,
    };
    expect(() =>
      parseSealedCenturionThreadAuditSnapshotBytes(
        JSON.stringify(mutated),
      ),
    ).toThrow('CENTURION_THREAD_AUDIT_SNAPSHOT_SEALED_DIGEST_INVALID');
  });

  it('requires canonical exact bytes for a sealed candidate', () => {
    const sealed = sealCenturionThreadAuditSnapshot(
      createCenturionThreadAuditSafeSource(createThreadAuditSafeSourceInput()),
    );
    const bytes = serializeSealedCenturionThreadAuditSnapshot(sealed);

    expect(parseSealedCenturionThreadAuditSnapshotBytes(bytes)).toEqual(sealed);
    expect(() =>
      parseSealedCenturionThreadAuditSnapshotBytes(`${bytes}\n`),
    ).toThrow('CENTURION_THREAD_AUDIT_SNAPSHOT_ENVELOPE_BYTES_INVALID');

    const futureIngestCutoff = {
      ...createCenturionThreadAuditSafeSource(createThreadAuditSafeSourceInput()),
      sourceIngestCutoffAt: '2026-08-10T00:02:00.001Z',
    };
    expect(() => sealCenturionThreadAuditSnapshot(futureIngestCutoff)).toThrow(
      'CENTURION_THREAD_AUDIT_SNAPSHOT_INVALID',
    );
  });

  it('keeps incomplete envelopes provenance-only and derives staleness safely', () => {
    const incomplete = sealCenturionThreadAuditSnapshot(
      createCenturionThreadAuditSafeSource(
        createThreadAuditSafeSourceInput({ valid: false }),
      ),
    );
    const valid = sealCenturionThreadAuditSnapshot(
      createCenturionThreadAuditSafeSource(createThreadAuditSafeSourceInput()),
    );

    expect(incomplete).toMatchObject({
      trustStatus: 'incomplete',
      trustReasonCode: 'pending_manual_adjudication',
    });
    expect(JSON.stringify(incomplete)).not.toContain(`case_${'d'.repeat(64)}`);
    expect(JSON.stringify(incomplete)).not.toContain(`run_${'f'.repeat(64)}`);
    expect('messageCount' in incomplete).toBe(false);
    expect('metrics' in incomplete).toBe(false);
    expect('components' in incomplete).toBe(false);
    expect(
      parseSealedCenturionThreadAuditSnapshotBytes(
        serializeSealedCenturionThreadAuditSnapshot(incomplete),
      ),
    ).toEqual(incomplete);

    expect(
      evaluateCenturionThreadAuditSnapshotStaleness({
        envelope: valid,
        now: new Date('2026-08-11T00:01:00.001Z'),
      }),
    ).toEqual({ stale: true, reason: 'verified_age' });
    expect(
      evaluateCenturionThreadAuditSnapshotStaleness({
        envelope: valid,
        now: new Date(valid.verifiedAt),
        maxSourceCutoffLagMs: 0,
      }),
    ).toEqual({ stale: true, reason: 'source_cutoff_lag' });
    expect(
      evaluateCenturionThreadAuditSnapshotStaleness({
        envelope: {
          ...valid,
          sourceEventCutoffAt: valid.verifiedAt,
          sourceIngestCutoffAt: '2026-08-08T00:01:00.000Z',
        },
        now: new Date(valid.verifiedAt),
      }),
    ).toMatchObject({ stale: true });
    expect(
      evaluateCenturionThreadAuditSnapshotStaleness({
        envelope: incomplete,
        now: new Date('2030-01-01T00:00:00.000Z'),
      }),
    ).toEqual({ stale: false, reason: null });
  });
});

describe('Centurion thread audit snapshot publication', () => {
  it('preserves intrinsic incomplete trust reason in stored header values', async () => {
    const store = await import('../src/ops/centurion-thread-audit-store.js');
    const incomplete = sealCenturionThreadAuditSnapshot(
      createCenturionThreadAuditSafeSource(
        createThreadAuditSafeSourceInput({ valid: false }),
      ),
    );

    expect(
      store.centurionThreadAuditSnapshotHeaderValues({
        envelope: incomplete,
        publicationIncarnationId: 'incarnation-test',
        publicationRevisionToken: 'revision-test',
      }).trustReasonCode,
    ).toBe('pending_manual_adjudication');
    expect(
      store.centurionThreadAuditSnapshotHeaderValues({
        envelope: incomplete,
        publicationIncarnationId: 'incarnation-test',
        publicationRevisionToken: 'revision-test',
        forceIncomplete: true,
      }).trustReasonCode,
    ).toBe('source_not_ready');
  });

  it('classifies idempotent, recovery, mismatch, and replacement safely', () => {
    const valid = sealCenturionThreadAuditSnapshot(
      createCenturionThreadAuditSafeSource(createThreadAuditSafeSourceInput()),
    );
    const incomplete = sealCenturionThreadAuditSnapshot(
      createCenturionThreadAuditSafeSource(
        createThreadAuditSafeSourceInput({ valid: false }),
      ),
    );
    const current = {
      publicationIncarnationId: 'incarnation-current',
      sourceIdentityDigest: valid.sourceIdentityDigest,
      payloadDigest: valid.payloadDigest,
      sealedEnvelopeDigest: valid.sealedEnvelopeDigest,
      trustStatus: 'valid' as const,
    };

    expect(
      classifyCenturionThreadAuditPublication({ current, candidate: valid }),
    ).toMatchObject({ disposition: 'NOOP_SAME_PAYLOAD' });
    expect(
      classifyCenturionThreadAuditPublication({
        current: { ...current, trustStatus: 'incomplete' },
        candidate: valid,
      }),
    ).toMatchObject({ disposition: 'PUBLISHED_RECOVERED' });
    expect(
      classifyCenturionThreadAuditPublication({
        current: {
          ...current,
          trustStatus: 'incomplete',
          sealedEnvelopeDigest: '0'.repeat(64),
        },
        candidate: valid,
      }),
    ).toMatchObject({ disposition: 'REJECTED_PAYLOAD_MISMATCH' });
    expect(
      classifyCenturionThreadAuditPublication({
        current: {
          ...current,
          sourceIdentityDigest: incomplete.sourceIdentityDigest,
          payloadDigest: incomplete.payloadDigest,
          sealedEnvelopeDigest: incomplete.sealedEnvelopeDigest,
          trustStatus: 'incomplete',
        },
        candidate: incomplete,
      }),
    ).toMatchObject({ disposition: 'NOOP_INCOMPLETE' });
    expect(
      classifyCenturionThreadAuditPublication({
        current,
        candidate: { ...valid, payloadDigest: '0'.repeat(64) },
      }),
    ).toMatchObject({ disposition: 'REJECTED_PAYLOAD_MISMATCH' });
    expect(
      classifyCenturionThreadAuditPublication({
        current,
        candidate: { ...valid, sourceIdentityDigest: '1'.repeat(64) },
      }),
    ).toMatchObject({ disposition: 'PUBLISHED' });
  });

  it('runs dry-run and apply from same exact sealed bytes', async () => {
    const sealed = sealCenturionThreadAuditSnapshot(
      createCenturionThreadAuditSafeSource(createThreadAuditSafeSourceInput()),
    );
    const bytes = serializeSealedCenturionThreadAuditSnapshot(sealed);
    const dryRun = parseCenturionThreadAuditSnapshotArgs([
      '--dry-run',
      '--candidate',
      '/private/audit-snapshot.json',
    ]);
    const apply = parseCenturionThreadAuditSnapshotArgs([
      '--apply',
      '--candidate',
      '/private/audit-snapshot.json',
      '--expected-payload-digest',
      sealed.payloadDigest,
      '--expected-sealed-envelope-digest',
      sealed.sealedEnvelopeDigest,
    ]);
    let appliedBytes: string | undefined;

    const dryReceipt = await runCenturionThreadAuditSnapshotCli(dryRun, {
      readVerifiedCandidate: () => bytes,
      publish: async () => {
        throw new Error('dry run must not publish');
      },
    });
    const applyReceipt = await runCenturionThreadAuditSnapshotCli(apply, {
      readVerifiedCandidate: () => bytes,
      publish: async ({ envelopeBytes }) => {
        appliedBytes = envelopeBytes;
        return {
          disposition: 'PUBLISHED',
          trustStatus: 'valid',
          publicationIncarnationId: 'incarnation-next',
        };
      },
    });

    expect(dryReceipt).toMatchObject({
      mode: 'dry_run',
      sourceIdentityDigest: sealed.sourceIdentityDigest,
      payloadDigest: sealed.payloadDigest,
      sealedEnvelopeDigest: sealed.sealedEnvelopeDigest,
    });
    expect(appliedBytes).toBe(bytes);
    expect(applyReceipt).toMatchObject({
      mode: 'apply',
      disposition: 'PUBLISHED',
      trustStatus: 'valid',
    });
    const recoveryReceipt = await runCenturionThreadAuditSnapshotCli(apply, {
      readVerifiedCandidate: () => bytes,
      publish: async () => ({
        disposition: 'PUBLISHED',
        trustStatus: 'incomplete',
        publicationIncarnationId: 'incarnation-recovered-incomplete',
      }),
    });
    expect(recoveryReceipt).toMatchObject({
      trustStatus: 'incomplete',
      messageCount: null,
      componentCount: null,
      persistedThreadCount: null,
    });
    expect(formatCenturionThreadAuditSnapshotReceipt(applyReceipt)).not.toContain(
      'threadId',
    );
    expect(() =>
      parseCenturionThreadAuditSnapshotArgs([
        '--dry-run',
        '--apply',
        '--candidate',
        '/private/audit-snapshot.json',
        '--expected-payload-digest',
        sealed.payloadDigest,
        '--expected-sealed-envelope-digest',
        sealed.sealedEnvelopeDigest,
      ]),
    ).toThrow('CENTURION_THREAD_AUDIT_SNAPSHOT_MODE_CONFLICT');
    expect(() =>
      parseCenturionThreadAuditSnapshotArgs([
        '--candidate',
        '   ',
      ]),
    ).toThrow('CENTURION_THREAD_AUDIT_SNAPSHOT_CANDIDATE_REQUIRED');
  });

  it('rejects external sealing and returns safe stale/version dispositions', async () => {
    const sealed = sealCenturionThreadAuditSnapshot(
      createCenturionThreadAuditSafeSource(createThreadAuditSafeSourceInput()),
    );
    const sealedBytes = serializeSealedCenturionThreadAuditSnapshot(sealed);

    expect(() =>
      parseCenturionThreadAuditSnapshotArgs([
        '--seal',
        '--safe-source',
        '/private/source.json',
        '--sealed-output',
        '/private/candidate.json',
      ]),
    ).toThrow('CENTURION_THREAD_AUDIT_SNAPSHOT_EXTERNAL_SEAL_DISABLED');
    expect(() =>
      parseCenturionThreadAuditSnapshotArgs([
        '--sealed-envelope',
        '/private/forged-envelope.json',
      ]),
    ).toThrow('CENTURION_THREAD_AUDIT_SNAPSHOT_ARGUMENT_UNKNOWN');

    const dryRun = parseCenturionThreadAuditSnapshotArgs([
      '--candidate',
      '/private/audit-snapshot-candidate.json',
    ]);
    const staleReceipt = await runCenturionThreadAuditSnapshotCli(dryRun, {
      readVerifiedCandidate: () => sealedBytes,
      now: () => new Date('2026-08-11T00:01:00.001Z'),
      publish: async () => {
        throw new Error('stale candidate must not publish');
      },
    } as never);
    expect(staleReceipt).toMatchObject({
      mode: 'dry_run',
      disposition: 'REJECTED_STALE_SOURCE',
      trustStatus: null,
      messageCount: null,
    });

    const unsupportedBytes = JSON.stringify({
      ...sealed,
      schema: 'centurion_thread_audit_snapshot_v9',
    });
    const unsupportedReceipt = await runCenturionThreadAuditSnapshotCli(dryRun, {
      readVerifiedCandidate: () => unsupportedBytes,
      now: () => new Date(sealed.verifiedAt),
    } as never);
    expect(unsupportedReceipt).toMatchObject({
      mode: 'dry_run',
      disposition: 'REJECTED_UNSUPPORTED_VERSION',
      trustStatus: null,
      messageCount: null,
    });

    const apply = parseCenturionThreadAuditSnapshotArgs([
      '--apply',
      '--candidate',
      '/private/audit-snapshot-candidate.json',
      '--expected-payload-digest',
      sealed.payloadDigest,
      '--expected-sealed-envelope-digest',
      sealed.sealedEnvelopeDigest,
    ]);
    for (const command of [dryRun, apply]) {
      await expect(
        runCenturionThreadAuditSnapshotCli(command, {
          readVerifiedCandidate: () => {
            throw new Error('CENTURION_THREAD_AUDIT_SNAPSHOT_UNSUPPORTED_VERSION');
          },
        }),
      ).resolves.toEqual({
        mode: command.kind,
        disposition: 'REJECTED_UNSUPPORTED_VERSION',
        trustStatus: null,
        sourceIdentityDigest: '',
        payloadDigest: '',
        sealedEnvelopeDigest: '',
        attemptedAt: '',
        verifiedAt: '',
        publishedAt: '',
        messageCount: null,
        componentCount: null,
        persistedThreadCount: null,
      });
    }
  });

  it('rolls back failed valid materialization before recovery CAS', async () => {
    const candidate = sealCenturionThreadAuditSnapshot(
      createCenturionThreadAuditSafeSource(createThreadAuditSafeSourceInput()),
    );
    const current = {
      publicationIncarnationId: 'incarnation-current',
      publicationRevisionToken: 'revision-current',
      sourceIdentityDigest: '0'.repeat(64),
      payloadDigest: '1'.repeat(64),
      sealedEnvelopeDigest: '2'.repeat(64),
      trustStatus: 'valid' as const,
    };
    let primaryLockActive = false;
    let recoveryInput:
      | {
          expectedPublicationIncarnationId: string;
          publicationIncarnationId: string;
        }
      | undefined;
    const store: CenturionThreadAuditPublisherStore = {
      withTransportLock: async (_transportId, work) => {
        primaryLockActive = true;
        try {
          return await work(current);
        } finally {
          primaryLockActive = false;
        }
      },
      replaceCurrent: async () => {
        throw new Error('synthetic write failure');
      },
      replaceCurrentWithIncompleteAfterFailure: async (input) => {
        expect(primaryLockActive).toBe(false);
        recoveryInput = input;
        return true;
      },
    };

    const receipt = await publishCenturionThreadAuditSnapshot({
      envelopeBytes: serializeSealedCenturionThreadAuditSnapshot(candidate),
      store,
      dependencies: {
        now: () => new Date('2026-08-10T00:03:00.000Z'),
        issueOpaqueId: (kind) => `opaque-${kind}`,
      },
    });

    expect(receipt).toMatchObject({
      disposition: 'PUBLISHED',
      trustStatus: 'incomplete',
      publicationIncarnationId: 'opaque-incarnation',
      componentCount: null,
    });
    expect(recoveryInput).toMatchObject({
      expectedPublicationIncarnationId: 'incarnation-current',
      publicationIncarnationId: 'opaque-incarnation',
    });
  });
});

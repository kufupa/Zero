import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import {
  collectBusinessNotFoundAssignments,
  collectRawPageDriverAccess,
} from '../src/hms/production-boundary.js';
import {
  mintReadCandidateChildren,
  resolveReadCandidateChild,
} from '../src/hms/candidate-graph.js';
import {
  evidenceArtifactForBinding,
  negativeResultCertificateV1Schema,
  toBusinessNotFoundToolStatus,
  validateNegativeResultCertificate,
} from '../src/hms/negative-result.js';
import {
  hmsProtectedArtifactIndexEntryV1Schema,
  loadExclusiveReceipt,
  writeProtectedArtifactIndex,
} from '../src/hms/artifact-index.js';
import {
  hmsBrowserArtifactReceiptV2Schema,
  hmsReadRoleProofSchema,
  hmsReadRoleProofV1Schema,
  loadActiveReadRegistry,
  promoteReadTool,
  rollbackReadTool,
  type HmsPortfolioToolReleaseV1,
} from '../src/hms/release-kernel.js';
import {
  markAiRunSucceeded,
  mergeTerminalRunMetrics,
  nextReadBudget,
  reserveReadAttempt,
  type AiRunFence,
} from '../src/ai/run-ledger.js';
import {
  createCandidateTools,
  createMockCandidateSession,
} from '../src/ai/candidate-draft-agent.js';
import { aiWorkflowRun, mailThread, message } from '../src/db/schema/mail.js';
import {
  TEST_DB_AVAILABLE,
  probeTestDb,
  withSeededTestDb,
} from './helpers/test-db.js';

const reachable = await probeTestDb();

function okReservationResult() {
  return {
    status: 'ok' as const,
    draftReady: true,
    data: {
      matches: [
        {
          confirmationNumber: 'CONF-1',
          externalReference: null,
          guestName: 'Guest',
          arrivalDate: '2026-08-01',
          departureDate: '2026-08-03',
          reservationStatus: 'Confirmed',
          roomType: 'STD',
          ratePlan: null,
        },
      ],
      matchCount: 1,
      capped: false,
    },
    unresolvedFields: [],
    evidence: {
      kind: 'hms' as const,
      id: 'ev-fence-1',
      toolId: 'hms_find_reservation',
      toolVersion: '1',
      propertyCode: 'CENTURION',
      observedAt: new Date(Date.now() - 60_000).toISOString(),
      expiresAt: new Date(Date.now() + 60 * 60_000).toISOString(),
      claimKeys: ['reservation.status'],
      sourceHash: 'a'.repeat(64),
    },
  };
}

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('read facade boundary', () => {
  it('production drivers cannot import HmsPage or call raw page APIs', () => {
    expect(collectRawPageDriverAccess()).toEqual([]);
  });

  it('production negative paths cannot assign promoted business-not-found terminals', () => {
    expect(collectBusinessNotFoundAssignments()).toEqual([]);
  });

  it('detects element-access raw page calls on drivers', async () => {
    const root = await mkdtemp(join(tmpdir(), 'hms-boundary-elem-'));
    roots.push(root);
    const file = join(root, 'sneaky-driver.ts');
    await writeFile(
      file,
      [
        'export async function run(page: Record<string, unknown>) {',
        "  await (page as { ['goto']: (u: string) => Promise<void> })['goto']('x');",
        '}',
        '',
      ].join('\n'),
    );
    expect(collectRawPageDriverAccess([file])).toEqual([
      expect.objectContaining({ api: 'goto' }),
    ]);
  });

  it('detects assignment of promoted negative terminals to status/outcome/terminalCode', async () => {
    const root = await mkdtemp(join(tmpdir(), 'hms-boundary-neg-'));
    roots.push(root);
    const file = join(root, 'sneaky-adapter.ts');
    await writeFile(
      file,
      [
        "export type Status = 'ok' | 'not_found';",
        'export function run(): { status: Status } {',
        "  let status: Status = 'ok';",
        "  status = 'not_found';",
        '  return { status };',
        '}',
        "export const receipt = { terminalCode: 'BUSINESS_NOT_FOUND' };",
        '',
      ].join('\n'),
    );
    const hits = collectBusinessNotFoundAssignments([file]);
    expect(hits.map((h) => h.value).sort()).toEqual([
      'BUSINESS_NOT_FOUND',
      'not_found',
    ]);
  });

  it('allows type-union string literals in type positions', async () => {
    const root = await mkdtemp(join(tmpdir(), 'hms-boundary-union-'));
    roots.push(root);
    const file = join(root, 'union-driver.ts');
    await writeFile(
      file,
      [
        "export type SearchResult = { outcome: 'not_found' } | { outcome: 'matched' };",
        "export function isMissing(r: SearchResult) { return r.outcome === 'not_found'; }",
        '',
      ].join('\n'),
    );
    expect(collectBusinessNotFoundAssignments([file])).toEqual([]);
  });
});

describe('durable read budget metrics', () => {
  it('fails closed on non-finite or negative persisted counters', () => {
    expect(
      nextReadBudget({ total: 0, byTool: {} }, 'reservation', 'hms_find_reservation'),
    ).toEqual({ total: 1, byTool: { hms_find_reservation: 1 } });
    expect(
      nextReadBudget(
        { total: Number.NaN, byTool: {} },
        'reservation',
        'hms_find_reservation',
      ),
    ).toBeNull();
    expect(
      nextReadBudget(
        { total: Number.POSITIVE_INFINITY, byTool: {} },
        'reservation',
        'hms_find_reservation',
      ),
    ).toBeNull();
    expect(
      nextReadBudget(
        { total: 0, byTool: { hms_find_reservation: 'many' } as never },
        'reservation',
        'hms_find_reservation',
      ),
    ).toBeNull();
    expect(
      nextReadBudget({ total: -1, byTool: {} }, 'reservation', 'hms_find_reservation'),
    ).toBeNull();
    expect(
      nextReadBudget(
        { total: 3, byTool: { hms_find_reservation: 0 } },
        'reservation',
        'hms_find_reservation',
      ),
    ).toBeNull();
  });

  it('terminal merge cannot overwrite reserved budget', () => {
    expect(
      mergeTerminalRunMetrics(
        { readBudget: { total: 2, byTool: { hms_find_reservation: 2 } }, prior: 1 },
        { readBudget: { total: 0, byTool: {} }, terminal: 1 },
      ),
    ).toEqual({
      readBudget: { total: 2, byTool: { hms_find_reservation: 2 } },
      prior: 1,
      terminal: 1,
    });
  });

  it('artifact-reservation budget permits exactly three PDFs and retains consumption', () => {
    let budget = { total: 0, byTool: {} };
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const next = nextReadBudget(
        budget,
        'artifact_reservation',
        'mail_read_artifact',
      );
      expect(next).not.toBeNull();
      budget = next!;
    }
    expect(
      nextReadBudget(
        budget,
        'artifact_reservation',
        'mail_read_artifact',
      ),
    ).toBeNull();
    expect(
      nextReadBudget(
        budget,
        'artifact_reservation',
        'hms_find_reservation',
      ),
    ).toMatchObject({
      total: 4,
      byTool: { mail_read_artifact: 3, hms_find_reservation: 1 },
    });
    expect(
      mergeTerminalRunMetrics(
        { readBudget: budget },
        { readBudget: { total: 0, byTool: {} } },
      ),
    ).toEqual({ readBudget: budget });
  });
});

describe.skipIf(!TEST_DB_AVAILABLE || !reachable)('durable read budget DB fencing', () => {
  async function withRun(
    cb: (input: {
      db: Parameters<typeof reserveReadAttempt>[3];
      fence: AiRunFence;
      runId: string;
      now: Date;
    }) => Promise<void>,
  ) {
    await withSeededTestDb(async (db) => {
      const [thread] = await db.select().from(mailThread).limit(1);
      const [trigger] = await db
        .select()
        .from(message)
        .where(eq(message.threadId, thread!.id))
        .limit(1);
      const now = new Date('2026-08-05T12:00:00.000Z');
      const runId = randomUUID();
      const fence: AiRunFence = {
        runId,
        claimOwner: 'owner-a',
        claimToken: randomUUID(),
        deadlineAt: new Date(now.getTime() + 60_000),
      };
      await db.insert(aiWorkflowRun).values({
        id: runId,
        transportId: thread!.transportId,
        threadId: thread!.id,
        triggerMessageId: trigger!.id,
        runKind: 'inbound_triage',
        idempotencyKey: `hms-budget-${runId}`,
        modelId: 'test',
        promptVersion: 'test',
        state: 'running',
        executorLane: 'hms',
        claimOwner: fence.claimOwner,
        claimToken: fence.claimToken,
        claimedAt: now,
        deadlineAt: fence.deadlineAt,
        createdAt: now,
        updatedAt: now,
      });
      await cb({ db, fence, runId, now });
    });
  }

  it('reserves monotonically and rejects stale token', async () => {
    await withRun(async ({ db, fence, now }) => {
      await expect(
        reserveReadAttempt(fence, 'reservation', 'hms_find_reservation', db, now),
      ).resolves.toEqual({
        total: 1,
        byTool: { hms_find_reservation: 1 },
      });
      await expect(
        reserveReadAttempt(
          { ...fence, claimToken: randomUUID() },
          'reservation',
          'hms_find_reservation',
          db,
          now,
        ),
      ).resolves.toBeNull();
    });
  });

  it('rejects exhausted per-tool and total caps', async () => {
    await withRun(async ({ db, fence, runId, now }) => {
      await db
        .update(aiWorkflowRun)
        .set({
          metrics: {
            readBudget: {
              total: 2,
              byTool: { hms_find_reservation: 2 },
            },
          },
        })
        .where(eq(aiWorkflowRun.id, runId));
      await expect(
        reserveReadAttempt(fence, 'reservation', 'hms_find_reservation', db, now),
      ).resolves.toEqual({
        total: 3,
        byTool: { hms_find_reservation: 3 },
      });
      await expect(
        reserveReadAttempt(fence, 'reservation', 'hms_find_reservation', db, now),
      ).resolves.toBeNull();

      await db
        .update(aiWorkflowRun)
        .set({
          metrics: {
            readBudget: {
              total: 1,
              byTool: { hms_find_reservation: 0 },
            },
          },
        })
        .where(eq(aiWorkflowRun.id, runId));
      await expect(
        reserveReadAttempt(fence, 'quote', 'hms_find_reservation', db, now),
      ).resolves.toBeNull();
    });
  });

  it('terminal merge preserves budget and reclaimed owner fences prior owner', async () => {
    await withRun(async ({ db, fence, runId, now }) => {
      await reserveReadAttempt(fence, 'reservation', 'hms_find_reservation', db, now);
      const nextFence = {
        ...fence,
        claimOwner: 'owner-b',
        claimToken: randomUUID(),
      };
      await db
        .update(aiWorkflowRun)
        .set({
          claimOwner: nextFence.claimOwner,
          claimToken: nextFence.claimToken,
          updatedAt: new Date(now.getTime() + 1),
        })
        .where(eq(aiWorkflowRun.id, runId));
      await expect(
        reserveReadAttempt(fence, 'reservation', 'hms_find_reservation', db, now),
      ).resolves.toBeNull();
      await expect(
        reserveReadAttempt(nextFence, 'reservation', 'hms_find_reservation', db, now),
      ).resolves.toEqual({
        total: 2,
        byTool: { hms_find_reservation: 2 },
      });
      const terminal = await markAiRunSucceeded(
        {
          runId,
          claimOwner: nextFence.claimOwner,
          claimToken: nextFence.claimToken,
          expectedStates: ['running'],
          metrics: { readBudget: { total: 0, byTool: {} }, terminal: 1 },
        },
        db,
      );
      expect(terminal?.metrics).toMatchObject({
        readBudget: { total: 2, byTool: { hms_find_reservation: 2 } },
        terminal: 1,
      });
    });
  });
});

describe('durable read fence before tool I/O', () => {
  const fence: AiRunFence = {
    runId: randomUUID(),
    claimOwner: 'owner-a',
    claimToken: randomUUID(),
    deadlineAt: new Date(Date.now() + 150_000),
  };

  it('reserves once per tool call and passes the run plan kind', async () => {
    const findReservation = vi.fn(async () => okReservationResult());
    const reserve = vi.fn(async () => ({
      total: 1,
      byTool: { hms_find_reservation: 1 },
    }));
    const session = createMockCandidateSession({
      readFence: fence,
      readPlanKind: 'reservation',
      lookupCandidates: new Map([
        ['cand-1', { id: 'cand-1', kind: 'confirmation', value: 'CONF-1' }],
      ]),
      findReservation,
    });
    const bundle = createCandidateTools(session, { reserveReadAttempt: reserve });
    await bundle.tools.hms_find_reservation.execute!(
      { candidateId: 'cand-1' },
      { abortSignal: new AbortController().signal },
    );
    expect(reserve).toHaveBeenCalledWith(fence, 'reservation', 'hms_find_reservation');
    expect(findReservation).toHaveBeenCalledTimes(1);
  });

  it('refuses tool I/O when the reservation returns null', async () => {
    const findReservation = vi.fn(async () => okReservationResult());
    const session = createMockCandidateSession({
      readFence: fence,
      readPlanKind: 'reservation',
      lookupCandidates: new Map([
        ['cand-1', { id: 'cand-1', kind: 'confirmation', value: 'CONF-1' }],
      ]),
      findReservation,
    });
    const bundle = createCandidateTools(session, {
      reserveReadAttempt: async () => null,
    });
    await expect(
      bundle.tools.hms_find_reservation.execute!(
        { candidateId: 'cand-1' },
        { abortSignal: new AbortController().signal },
      ),
    ).rejects.toThrow(/LEASE_LOST/);
    expect(findReservation).not.toHaveBeenCalled();
    expect(bundle.calls).toEqual([
      expect.objectContaining({ toolId: 'hms_find_reservation', ok: false }),
    ]);
  });

  it('skips reservation when no fence is bound (fixture sessions)', async () => {
    const reserve = vi.fn(async () => null);
    const session = createMockCandidateSession({
      lookupCandidates: new Map([
        ['cand-1', { id: 'cand-1', kind: 'confirmation', value: 'CONF-1' }],
      ]),
      findReservation: async () => okReservationResult(),
    });
    const bundle = createCandidateTools(session, { reserveReadAttempt: reserve });
    await expect(
      bundle.tools.hms_find_reservation.execute!(
        { candidateId: 'cand-1' },
        { abortSignal: new AbortController().signal },
      ),
    ).resolves.toMatchObject({ status: 'ok' });
    expect(reserve).not.toHaveBeenCalled();
  });
});

describe('candidate parent/child graph', () => {
  it('binds child to session, parent, tool, property, scope, and expiry', () => {
    const input = {
      sessionId: randomUUID(),
      parentEvidenceId: randomUUID(),
      tools: ['hms_read_folio'] as const,
      propertyCode: 'HRCEN',
      scopeHash: 'a'.repeat(64),
      expiresAt: new Date(Date.now() + 60_000),
    };
    const [child] = mintReadCandidateChildren({ ...input, tools: [...input.tools] });
    expect(
      resolveReadCandidateChild({
        candidates: [child!],
        id: child!.id,
        sessionId: input.sessionId,
        parentEvidenceId: input.parentEvidenceId,
        toolId: 'hms_read_folio',
        propertyCode: input.propertyCode,
        scopeHash: input.scopeHash,
      }),
    ).toEqual(child);
    expect(() =>
      resolveReadCandidateChild({
        candidates: [child!],
        id: child!.id,
        sessionId: randomUUID(),
        parentEvidenceId: input.parentEvidenceId,
        toolId: 'hms_read_folio',
        propertyCode: input.propertyCode,
        scopeHash: input.scopeHash,
      }),
    ).toThrow(/binding/);
    expect(() =>
      resolveReadCandidateChild({
        candidates: [child!, child!],
        id: child!.id,
        sessionId: input.sessionId,
        parentEvidenceId: input.parentEvidenceId,
        toolId: 'hms_read_folio',
        propertyCode: input.propertyCode,
        scopeHash: input.scopeHash,
      }),
    ).toThrow(/cardinality/);
  });

  it('refuses more than two reservation followup child tools', () => {
    expect(() =>
      mintReadCandidateChildren({
        sessionId: randomUUID(),
        parentEvidenceId: randomUUID(),
        tools: [
          'hms_list_documents',
          'hms_sent_email_audit',
          'hms_read_folio',
        ],
        propertyCode: 'HRCEN',
        scopeHash: 'a'.repeat(64),
        expiresAt: new Date(Date.now() + 60_000),
      }),
    ).toThrow(/max reservation followups/);
  });
});

describe('negative quarantine', () => {
  it('constructs BUSINESS_NOT_FOUND only after all independent gates verify', async () => {
    const { canonicalNegativeCertificateSha256, hmsEvidenceBindingV1Schema } =
      await import('../src/hms/negative-result.js');
    const binding = hmsEvidenceBindingV1Schema.parse({
      toolId: 'hms_find_reservation',
      toolVersion: '1.2.0',
      operationId: randomUUID(),
      discoveryOperationId: 'guest_stay_search',
      candidateSnapshotSha256: 'a'.repeat(64),
      propertyCode: 'HRCEN',
      credentialVersionHmacSha256: 'b'.repeat(64),
      runtimeFingerprintSha256: 'c'.repeat(64),
      privateDigestKeyVersion: 'v1',
      roleProofSha256: 'd'.repeat(64),
      requestBranchId: 'guest_stay_search',
      sourceRevision: 'rev1',
      verifierVersion: '1',
    });
    const ref = () => ({ evidenceId: randomUUID(), sha256: 'e'.repeat(64) });
    const certificate = negativeResultCertificateV1Schema.parse({
      schemaVersion: 1,
      verifierVersion: '1',
      binding,
      candidateSource: ref(),
      surface: ref(),
      nativeRequestDifferential: ref(),
      response: ref(),
      parserConservation: ref(),
      scopeCompleteness: ref(),
      controlPair: ref(),
      candidateExhaustion: ref(),
      issuedAt: new Date(Date.now() - 1_000).toISOString(),
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
    });
    const digest = canonicalNegativeCertificateSha256(certificate);
    await expect(
      validateNegativeResultCertificate({
        certificate,
        certificateSha256: digest,
        verifyEvidence: async (_gate, gateRef, b) =>
          evidenceArtifactForBinding(gateRef, b),
      }),
    ).resolves.toMatchObject({ status: 'BUSINESS_NOT_FOUND' });
    await expect(
      validateNegativeResultCertificate({
        certificate,
        certificateSha256: digest,
        verifyEvidence: async (gate, gateRef, b) =>
          gate === 'nativeRequestDifferential'
            ? null
            : evidenceArtifactForBinding(gateRef, b),
      }),
    ).resolves.toEqual({
      status: 'UNVERIFIED_NEGATIVE',
      diagnostic: 'REQUEST_DRIFT',
    });
  });

  it('maps only validated certificates to model-visible not_found', async () => {
    const { canonicalNegativeCertificateSha256, hmsEvidenceBindingV1Schema } =
      await import('../src/hms/negative-result.js');
    const quarantined = {
      status: 'UNVERIFIED_NEGATIVE',
      diagnostic: 'REQUEST_DRIFT',
    } as const;
    expect(toBusinessNotFoundToolStatus(quarantined)).toBe('unverified_negative');

    const binding = hmsEvidenceBindingV1Schema.parse({
      toolId: 'hms_find_reservation',
      toolVersion: '1.2.0',
      operationId: randomUUID(),
      discoveryOperationId: 'guest_stay_search',
      candidateSnapshotSha256: 'a'.repeat(64),
      propertyCode: 'HRCEN',
      credentialVersionHmacSha256: 'b'.repeat(64),
      runtimeFingerprintSha256: 'c'.repeat(64),
      privateDigestKeyVersion: 'v1',
      roleProofSha256: 'd'.repeat(64),
      requestBranchId: 'guest_stay_search',
      sourceRevision: 'rev1',
      verifierVersion: '1',
    });
    const ref = () => ({ evidenceId: randomUUID(), sha256: 'e'.repeat(64) });
    const certificate = negativeResultCertificateV1Schema.parse({
      schemaVersion: 1,
      verifierVersion: '1',
      binding,
      candidateSource: ref(),
      surface: ref(),
      nativeRequestDifferential: ref(),
      response: ref(),
      parserConservation: ref(),
      scopeCompleteness: ref(),
      controlPair: ref(),
      candidateExhaustion: ref(),
      issuedAt: new Date(Date.now() - 1_000).toISOString(),
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
    });
    const validated = await validateNegativeResultCertificate({
      certificate,
      certificateSha256: canonicalNegativeCertificateSha256(certificate),
      verifyEvidence: async (_gate, gateRef, b) =>
        evidenceArtifactForBinding(gateRef, b),
    });
    expect(toBusinessNotFoundToolStatus(validated)).toBe('not_found');
  });

  it('refuses forged business-not-found objects that skipped validation', () => {
    const forged = {
      status: 'BUSINESS_NOT_FOUND',
      certificateSha256: 'a'.repeat(64),
    } as unknown as Parameters<typeof toBusinessNotFoundToolStatus>[0];
    expect(toBusinessNotFoundToolStatus(forged)).toBe('unverified_negative');

    const forgedWithGuessedBrand = {
      status: 'BUSINESS_NOT_FOUND',
      certificateSha256: 'a'.repeat(64),
      validated: true,
      brand: 'hms.validatedBusinessNotFound',
    } as unknown as Parameters<typeof toBusinessNotFoundToolStatus>[0];
    expect(toBusinessNotFoundToolStatus(forgedWithGuessedBrand)).toBe(
      'unverified_negative',
    );
  });
});

describe('protected artifact index and exclusive receipt', () => {
  it('accepts metadata-only index entries and rejects guest/mail fields', async () => {
    const root = await mkdtemp(join(tmpdir(), 'hms-artifact-index-'));
    roots.push(root);
    const entry = hmsProtectedArtifactIndexEntryV1Schema.parse({
      schemaVersion: 1,
      artifactId: randomUUID(),
      toolId: 'hms_find_reservation',
      toolVersion: '1.2.0',
      releaseId: randomUUID(),
      kinds: ['trace', 'receipt'],
      receiptSchema: 'v1',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
    });
    await writeProtectedArtifactIndex(join(root, 'index.v1.json'), [entry]);
    expect(() =>
      hmsProtectedArtifactIndexEntryV1Schema.parse({
        ...entry,
        guestName: 'forbidden',
      }),
    ).toThrow();
  });

  it('loads exactly one receipt and rejects zero or dual files', async () => {
    const root = await mkdtemp(join(tmpdir(), 'hms-receipt-xor-'));
    roots.push(root);
    await expect(loadExclusiveReceipt(root)).rejects.toThrow(/exactly one/i);
    await writeFile(join(root, 'receipt.v1.json'), '{"schemaVersion":1}\n');
    await expect(loadExclusiveReceipt(root)).resolves.toMatchObject({
      schema: 'v1',
      receipt: { schemaVersion: 1 },
    });
    await writeFile(join(root, 'receipt.v2.json'), '{"schemaVersion":2}\n');
    await expect(loadExclusiveReceipt(root)).rejects.toThrow(/exactly one/i);
  });
});

describe('v1/v2 compatibility and atomic release registry', () => {
  it('accepts role proof v1/v2 and discriminated receipt v2', () => {
    const v1 = hmsReadRoleProofV1Schema.parse({
      schemaVersion: 1,
      propertyCode: 'HRCEN',
      allowedSurfaces: ['Guest Stay'],
      deniedActions: [
        'new_record', 'save', 'delete', 'duplicate', 'check_in', 'check_out',
        'document_generate', 'document_send',
      ],
      issuedAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
      evidenceRef: 'opaque',
      evidenceSha256: 'd'.repeat(64),
    });
    expect(hmsReadRoleProofSchema.parse(v1).schemaVersion).toBe(1);
    const common = {
      schemaVersion: 2 as const,
      artifactId: randomUUID(),
      operationId: randomUUID(),
      toolId: 'hms_find_reservation' as const,
      discoveryOperationId: 'guest_stay_search' as const,
      toolVersion: '1.2.0',
      sourceRevision: 'rev',
      credentialVersionHmacSha256: 'a'.repeat(64),
      runtimeFingerprintSha256: 'b'.repeat(64),
      privateDigestKeyVersion: 'v1',
      traceSha256: '1'.repeat(64),
      videoSha256: null,
      operationOutcome: 'succeeded' as const,
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
    };
    expect(
      hmsBrowserArtifactReceiptV2Schema.parse({
        ...common,
        executionClass: 'discovery',
        structuralSignatureSha256: 'c'.repeat(64),
        candidateSnapshotSha256: null,
      }).executionClass,
    ).toBe('discovery');
    expect(() =>
      hmsBrowserArtifactReceiptV2Schema.parse({
        ...common,
        executionClass: 'discovery',
        structuralSignatureSha256: 'c'.repeat(64),
        candidateSnapshotSha256: null,
        roleProofSha256: 'e'.repeat(64),
      }),
    ).toThrow();
    expect(() =>
      hmsBrowserArtifactReceiptV2Schema.parse({
        ...common,
        executionClass: 'proof',
        requestBranchId: 'guest_stay_search',
        candidateSnapshotSha256: 'c'.repeat(64),
        candidateHmacSha256: 'd'.repeat(64),
        scopeHmacSha256: 'e'.repeat(64),
        resultHmacSha256: 'f'.repeat(64),
        sourceRefHmacSha256: '1'.repeat(64),
        roleProofSha256: '2'.repeat(64),
        discoveryReceiptSha256: '3'.repeat(64),
        oracleArtifactSha256: '4'.repeat(64),
        extra: true,
      }),
    ).toThrow();
  });

  it('promotes idempotently, retains predecessor, and rolls back', async () => {
    const root = await mkdtemp(join(tmpdir(), 'hms-release-'));
    roots.push(root);
    const path = join(root, 'active.json');
    const release = (id: string, predecessorReleaseId: string | null) =>
      ({
        schemaVersion: 1,
        releaseId: id,
        toolId: 'hms_find_reservation',
        toolVersion: '1.2.0',
        toolsetVersion: '3.0.0',
        toolsetFingerprint: '1'.repeat(64),
        sourceSha256: '2'.repeat(64),
        planSha256: '3'.repeat(64),
        gateSha256: '4'.repeat(64),
        requestManifestSha256: '5'.repeat(64),
        roleProofSha256: '6'.repeat(64),
        discoverySha256: '7'.repeat(64),
        liveProofSha256: '8'.repeat(64),
        receiptSha256: '9'.repeat(64),
        shadowSha256: 'a'.repeat(64),
        predecessorReleaseId,
        rollbackAction: predecessorReleaseId ? 'restore_predecessor' : 'disable',
      }) satisfies HmsPortfolioToolReleaseV1;
    const first = release(randomUUID(), null);
    const second = release(randomUUID(), first.releaseId);
    expect((await promoteReadTool({ path, release: first })).generation).toBe(1);
    expect((await promoteReadTool({ path, release: first })).generation).toBe(1);
    expect((await promoteReadTool({ path, release: second })).generation).toBe(2);
    const rolled = await rollbackReadTool({ path, toolId: 'hms_find_reservation' });
    expect(rolled.active.hms_find_reservation).toBe(first.releaseId);
    expect((await loadActiveReadRegistry(path)).generation).toBe(3);
  });

  it('ignores interrupted temp writes after final atomic rename wins', async () => {
    const root = await mkdtemp(join(tmpdir(), 'hms-release-interrupt-'));
    roots.push(root);
    const path = join(root, 'active.json');
    const release = {
      schemaVersion: 1,
      releaseId: randomUUID(),
      toolId: 'hms_find_reservation',
      toolVersion: '1.2.0',
      toolsetVersion: '3.0.0',
      toolsetFingerprint: '1'.repeat(64),
      sourceSha256: '2'.repeat(64),
      planSha256: '3'.repeat(64),
      gateSha256: '4'.repeat(64),
      requestManifestSha256: '5'.repeat(64),
      roleProofSha256: '6'.repeat(64),
      discoverySha256: '7'.repeat(64),
      liveProofSha256: '8'.repeat(64),
      receiptSha256: '9'.repeat(64),
      shadowSha256: 'a'.repeat(64),
      predecessorReleaseId: null,
      rollbackAction: 'disable',
    } satisfies HmsPortfolioToolReleaseV1;
    await promoteReadTool({ path, release });
    await writeFile(`${path}.orphan.tmp`, '{"corrupt":true}\n');
    expect((await loadActiveReadRegistry(path)).active.hms_find_reservation).toBe(
      release.releaseId,
    );
    expect((await promoteReadTool({ path, release })).generation).toBe(1);
  });
});

import { describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import portfolioCases from '../evals/hms/portfolio-cases.v3.json';
import {
  MAX_RESERVATION_FOLLOWUPS,
  buildWorkflowSummaryClaim,
  candidateReadPlanSchema,
  executableToolIdsForPlan,
  followupToToolId,
  planCandidateReads,
  portfolioAblationForPromotedReleases,
  promotedPortfolioReleaseOrder,
  replayLoadCapacity,
  type CandidateReadPlan,
} from '../src/hms/candidate-read-plan';
import {
  READ_TOOLS,
  isProductionActiveReadTool,
  productionActiveReadToolIds,
  type AblationOutcome,
} from '../src/hms/read-tools';
import {
  hmsBrowserArtifactReceiptV2Schema,
  hmsPortfolioToolReleaseV2Schema,
  hmsReadRoleProofV2Schema,
  loadHmsReadRoleProofV2,
  loadHmsReadRoleProofV2ForTool,
  roleProofV2Path,
  validateRoleProofV2ForTool,
} from '../src/hms/release-kernel.js';

describe('CandidateReadPlan closed union', () => {
  it('accepts reservation with at most two unique followups', () => {
    const plan = candidateReadPlanSchema.parse({
      kind: 'reservation',
      find: true,
      followups: ['documents', 'folio'],
    });
    expect(plan.followups).toHaveLength(2);
    expect(MAX_RESERVATION_FOLLOWUPS).toBe(2);
  });

  it('rejects more than two reservation followups', () => {
    expect(() =>
      candidateReadPlanSchema.parse({
        kind: 'reservation',
        find: true,
        followups: ['documents', 'sent_email', 'folio'],
      }),
    ).toThrow();
  });

  it('rejects duplicate followups', () => {
    expect(() =>
      candidateReadPlanSchema.parse({
        kind: 'reservation',
        find: true,
        followups: ['folio', 'folio'],
      }),
    ).toThrow();
  });

  it('plans at most two deterministic followups from signals', () => {
    const plan = planCandidateReads({
      authoredSegment:
        'Please send the tax invoice and confirm the folio balance and company billing terms.',
      attachmentCount: 0,
      hasExactReservationCandidate: true,
      hasQuoteCandidate: false,
      hasGroupRef: false,
      hasEventRef: false,
    });
    expect(plan.kind).toBe('reservation');
    if (plan.kind !== 'reservation') throw new Error('expected reservation');
    expect(plan.followups.length).toBeLessThanOrEqual(MAX_RESERVATION_FOLLOWUPS);
    expect(plan.followups.length).toBe(2);
    expect(new Set(plan.followups).size).toBe(plan.followups.length);
  });

  it('never invents model-driven tool loops — plan is code-owned closed union', () => {
    const plan = planCandidateReads({
      authoredSegment: 'What is available for these dates?',
      attachmentCount: 0,
      hasExactReservationCandidate: false,
      hasQuoteCandidate: true,
      hasGroupRef: false,
      hasEventRef: false,
    });
    expect(plan).toEqual({ kind: 'quote', quote: true });
    expect(candidateReadPlanSchema.safeParse({ kind: 'custom', tools: ['x'] }).success).toBe(
      false,
    );
  });
});

describe('production executable steps stay decoupled from blocked surfaces', () => {
  it('includes soft-proven PMS tools on production allowlist; gated stay fail-closed', () => {
    const active = productionActiveReadToolIds().sort();
    // Quote is discovery-only until a trusted current-rate authority is
    // wired and live-proven through normal composition.
    expect(active).toEqual(['hms_find_reservation']);
    for (const blocked of [
      'hms_read_folio',
      'hms_list_documents',
      'hms_sent_email_audit',
      'hms_company_account_read',
      'hms_group_block_read',
      'hms_event_read',
      'mail_read_artifact',
    ] as const) {
      expect(isProductionActiveReadTool(blocked)).toBe(false);
    }
  });

  it('filters planned followups out of production executable steps', () => {
    const plan: CandidateReadPlan = {
      kind: 'reservation',
      find: true,
      followups: ['documents', 'company'],
    };
    expect(executableToolIdsForPlan(plan, 'fixture')).toEqual([
      'hms_find_reservation',
      followupToToolId('documents'),
      followupToToolId('company'),
    ]);
    expect(executableToolIdsForPlan(plan, 'production')).toEqual([
      'hms_find_reservation',
    ]);
  });

  it('yields production executable for promoted quote; group/event stay fail-closed', () => {
    expect(
      executableToolIdsForPlan({ kind: 'quote', quote: true }, 'production'),
    ).toEqual([]);
    expect(
      executableToolIdsForPlan({ kind: 'group', group: true }, 'production'),
    ).toEqual([]);
    expect(
      executableToolIdsForPlan({ kind: 'event', event: true }, 'production'),
    ).toEqual([]);
  });
});

describe('workflow summary claim', () => {
  it('emits one typed claim with evidence IDs for whole-claim selection', () => {
    const claim = buildWorkflowSummaryClaim({
      plan: { kind: 'reservation', find: true, followups: [] },
      evidenceIds: ['ev-find-1', 'ev-find-1'],
      childClaimIds: ['claim-a'],
    });
    expect(claim.kind).toBe('workflow_summary');
    expect(claim.value).toEqual({
      planKind: 'reservation',
      evidenceIds: ['ev-find-1'],
      childClaimIds: ['claim-a'],
      toolIds: ['hms_find_reservation'],
    });
    expect(claim.evidenceId).toBe('ev-find-1');
    expect(claim.id).toMatch(/^[a-f0-9]{16}$/);
  });
});

describe('cumulative ablation across promoted releases only', () => {
  it('release order is currently promoted tools only', () => {
    expect(promotedPortfolioReleaseOrder()).toEqual(['hms_find_reservation']);
    expect(promotedPortfolioReleaseOrder()).not.toContain('hms_read_folio');
    expect(promotedPortfolioReleaseOrder()).not.toContain('hms_company_account_read');
    expect(promotedPortfolioReleaseOrder()).not.toContain('hms_group_block_read');
    expect(promotedPortfolioReleaseOrder()).not.toContain('hms_event_read');
    expect(promotedPortfolioReleaseOrder()).not.toContain('mail_read_artifact');
  });

  it('ablation membership does not overlap and never requires blocked live promotion', () => {
    const baseline = Object.fromEntries(
      portfolioCases.cases.map((c) => [
        c.threadId,
        c.labelStatus === 'adjudicated' && c.outcome === 'full'
          ? ('full' as AblationOutcome)
          : ('abstain' as AblationOutcome),
      ]),
    );
    const report = portfolioAblationForPromotedReleases({
      cases: portfolioCases.cases,
      outcomesByToolStep: {
        baseline,
      },
    });
    expect(report.steps.map((s) => s.toolId)).toEqual([
      'baseline',
      'hms_find_reservation',
    ]);
    expect(report.denominator).toBe(56);
    for (const blocked of [
      'hms_read_folio',
      'hms_company_account_read',
      'hms_group_block_read',
      'hms_event_read',
      'mail_read_artifact',
    ]) {
      expect(report.steps.some((s) => s.toolId === blocked)).toBe(false);
    }
  });
});

describe('load/capacity replay (promoted tools only)', () => {
  it('aggregates 1/5/20 queue samples without blocked tool membership', () => {
    const report = replayLoadCapacity([
      {
        queuedRuns: 1,
        queueWaitMs: 10,
        toolLatencyMs: 100,
        endToEndLatencyMs: 200,
        memoryBytes: 1_000,
        captureBytes: 100,
        contextClosed: true,
        deadlineAborts: 0,
      },
      {
        queuedRuns: 5,
        queueWaitMs: 50,
        toolLatencyMs: 120,
        endToEndLatencyMs: 400,
        memoryBytes: 2_000,
        captureBytes: 200,
        contextClosed: true,
        deadlineAborts: 0,
      },
      {
        queuedRuns: 20,
        queueWaitMs: 200,
        toolLatencyMs: 150,
        endToEndLatencyMs: 900,
        memoryBytes: 4_000,
        captureBytes: 400,
        contextClosed: true,
        deadlineAborts: 1,
      },
    ]);
    expect(report.toolIds).toEqual([
      'hms_find_reservation',
    ]);
    expect(Object.keys(report.byConcurrency).sort()).toEqual(['1', '20', '5']);
    expect(report.byConcurrency['20']?.deadlineAborts).toBe(1);
    expect(report.byConcurrency['1']?.samples).toBe(1);
  });
});

describe('Phase B evidence schemas (role proof / receipt / release v2)', () => {
  const sha = (ch: string) => ch.repeat(64);

  function validRoleProofV2(
    overrides: Record<string, unknown> = {},
  ) {
    const now = Date.now();
    return hmsReadRoleProofV2Schema.parse({
      schemaVersion: 2,
      attestationKind: 'operator_observed_runtime',
      toolId: 'hms_find_reservation',
      discoveryOperationId: 'guest_stay_search',
      operationId: randomUUID(),
      observerSourceRevision: 'abc1234',
      evidenceArtifactId: randomUUID(),
      privateDigestKeyVersion: 'v1',
      actorHmacSha256: sha('1'),
      credentialVersionHmacSha256: sha('2'),
      runtimeFingerprintSha256: sha('3'),
      roleFingerprintSha256: sha('4'),
      propertyCode: 'HRCEN',
      currency: 'ZAR',
      credentialMode: 'view_only',
      allowedSurfaces: ['guest_stay'],
      deniedActions: [...READ_TOOLS.hms_find_reservation.deniedActions],
      issuedAt: new Date(now - 60_000).toISOString(),
      expiresAt: new Date(now + 86_400_000).toISOString(),
      evidenceSha256: sha('5'),
      ...overrides,
    });
  }

  it('requires operator_observed_runtime and TTL >0 <=30d', () => {
    expect(() =>
      hmsReadRoleProofV2Schema.parse({
        ...validRoleProofV2(),
        attestationKind: 'self_asserted',
      }),
    ).toThrow();
    const now = new Date();
    expect(() =>
      validateRoleProofV2ForTool(
        validRoleProofV2({
          issuedAt: now.toISOString(),
          expiresAt: now.toISOString(),
        }),
        READ_TOOLS.hms_find_reservation,
        now,
      ),
    ).toThrow(/TTL/);
    const issued = new Date(now.getTime() - 60_000);
    const tooLong = new Date(issued.getTime() + 31 * 24 * 60 * 60 * 1000);
    expect(() =>
      validateRoleProofV2ForTool(
        validRoleProofV2({
          issuedAt: issued.toISOString(),
          expiresAt: tooLong.toISOString(),
        }),
        READ_TOOLS.hms_find_reservation,
        now,
      ),
    ).toThrow(/30d/);
  });

  it('binds tool/discovery/operation and rejects cross-operation swap + mail', () => {
    const proof = validRoleProofV2();
    expect(() =>
      validateRoleProofV2ForTool(proof, READ_TOOLS.hms_find_reservation, new Date()),
    ).not.toThrow();
    expect(() =>
      validateRoleProofV2ForTool(
        validRoleProofV2({ discoveryOperationId: 'folio_summary' }),
        READ_TOOLS.hms_find_reservation,
        new Date(),
      ),
    ).toThrow(/discoveryOperationId/);
    expect(() =>
      validateRoleProofV2ForTool(proof, READ_TOOLS.mail_read_artifact, new Date()),
    ).toThrow(/mail_read_artifact/);
    expect(roleProofV2Path('/opt/nava', 'hms_find_reservation')).toMatch(
      /role-proofs[/\\]hms_find_reservation\.v2\.json$/,
    );
  });

  it('loads v2 role proof from path helper and rejects cross-tool file', async () => {
    const root = await mkdtemp(join(tmpdir(), 'hms-role-proof-v2-'));
    await mkdir(join(root, 'role-proofs'), { recursive: true });
    const proof = validRoleProofV2();
    const path = roleProofV2Path(root, 'hms_find_reservation');
    await writeFile(path, `${JSON.stringify(proof)}\n`, { mode: 0o600 });

    await expect(
      loadHmsReadRoleProofV2ForTool(root, READ_TOOLS.hms_find_reservation),
    ).resolves.toMatchObject({ toolId: 'hms_find_reservation', schemaVersion: 2 });

    await expect(
      loadHmsReadRoleProofV2(path, READ_TOOLS.hms_read_folio),
    ).rejects.toMatchObject({ code: 'ROLE_SCOPE_INVALID' });

    await expect(
      loadHmsReadRoleProofV2ForTool(root, READ_TOOLS.mail_read_artifact),
    ).rejects.toMatchObject({ code: 'ROLE_SCOPE_INVALID' });
  });

  it('discriminates discovery|proof receipts and blocks mail toolId', () => {
    const common = {
      schemaVersion: 2 as const,
      artifactId: randomUUID(),
      operationId: randomUUID(),
      toolId: 'hms_find_reservation' as const,
      discoveryOperationId: 'guest_stay_search' as const,
      toolVersion: '1.2.0',
      sourceRevision: 'rev',
      credentialVersionHmacSha256: sha('a'),
      runtimeFingerprintSha256: sha('b'),
      privateDigestKeyVersion: 'v1',
      traceSha256: sha('c'),
      videoSha256: null,
      operationOutcome: 'succeeded' as const,
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
    };
    const discovery = hmsBrowserArtifactReceiptV2Schema.parse({
      ...common,
      executionClass: 'discovery',
      structuralSignatureSha256: sha('d'),
      candidateSnapshotSha256: null,
    });
    expect(discovery.executionClass).toBe('discovery');
    expect('roleProofSha256' in discovery).toBe(false);
    const proof = hmsBrowserArtifactReceiptV2Schema.parse({
      ...common,
      executionClass: 'proof',
      requestBranchId: 'guest_stay_search',
      candidateSnapshotSha256: sha('e'),
      candidateHmacSha256: sha('f'),
      scopeHmacSha256: sha('1'),
      resultHmacSha256: sha('2'),
      sourceRefHmacSha256: sha('3'),
      roleProofSha256: sha('4'),
      discoveryReceiptSha256: sha('5'),
      oracleArtifactSha256: sha('6'),
    });
    expect(proof.executionClass).toBe('proof');
    expect(() =>
      hmsBrowserArtifactReceiptV2Schema.parse({
        ...common,
        toolId: 'mail_read_artifact',
        executionClass: 'discovery',
        structuralSignatureSha256: sha('d'),
        candidateSnapshotSha256: null,
      }),
    ).toThrow();
  });

  it('discriminates HMS|mail release v2 with live_verified|shadow_enabled', () => {
    const base = {
      schemaVersion: 2 as const,
      releaseId: randomUUID(),
      toolsetVersion: '3.0.0',
      toolsetFingerprint: sha('1'),
      sourceRevision: 'rev',
      phaseAPlanSha256: sha('2'),
      phaseBPlanSha256: sha('3'),
      gateSha256: sha('4'),
      runtimeAbiVersion: '1',
      runtimeFingerprintSha256: sha('5'),
      implementationSha256: sha('6'),
      requesterPolicySha256: sha('7'),
      privateDigestKeyVersion: 'v1',
      liveProofSha256: sha('8'),
      receiptSha256: sha('9'),
      rollbackAction: 'disable' as const,
    };
    const hmsLive = hmsPortfolioToolReleaseV2Schema.parse({
      ...base,
      qualification: 'live_verified',
      shadowSha256: null,
      predecessorReleaseId: null,
      evidenceKind: 'hms',
      toolId: 'hms_find_reservation',
      toolVersion: '1.2.0',
      requestBranches: [
        {
          id: 'guest_stay_search',
          discoveryOperationId: 'guest_stay_search',
          manifestSha256: sha('a'),
          discoverySha256: sha('b'),
          parserSchemaSha256: sha('c'),
        },
      ],
      credentialVersionHmacSha256: sha('d'),
      roleProofSha256: sha('e'),
    });
    expect(hmsLive.evidenceKind).toBe('hms');
    expect(hmsLive.qualification).toBe('live_verified');
    const mailShadow = hmsPortfolioToolReleaseV2Schema.parse({
      ...base,
      qualification: 'shadow_enabled',
      shadowSha256: sha('f'),
      predecessorReleaseId: randomUUID(),
      evidenceKind: 'mail',
      toolId: 'mail_read_artifact',
      toolVersion: '2',
      grantPolicySha256: sha('1'),
      s3IdentitySha256: sha('2'),
      parserSandboxSha256: sha('3'),
      rollbackAction: 'restore_predecessor',
    });
    expect(mailShadow.evidenceKind).toBe('mail');
    expect(() =>
      hmsPortfolioToolReleaseV2Schema.parse({
        ...base,
        qualification: 'shadow_enabled',
        shadowSha256: null,
        predecessorReleaseId: randomUUID(),
        evidenceKind: 'hms',
        toolId: 'hms_find_reservation',
        toolVersion: '1.2.0',
        requestBranches: [
          {
            id: 'guest_stay_search',
            discoveryOperationId: 'guest_stay_search',
            manifestSha256: sha('a'),
            discoverySha256: sha('b'),
            parserSchemaSha256: sha('c'),
          },
        ],
        credentialVersionHmacSha256: sha('d'),
        roleProofSha256: sha('e'),
      }),
    ).toThrow();
    expect(() =>
      hmsPortfolioToolReleaseV2Schema.parse({
        ...hmsLive,
        evidenceKind: 'mail',
        toolId: 'mail_read_artifact',
        toolVersion: '2',
      }),
    ).toThrow();
  });
});

// Task 13 cutover suites live in hms-registry-cutover.test.ts (imported APIs).

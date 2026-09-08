/**
 * Task 13: plan-scoped immutable registry cutover + authorization + CAS.
 * Exercised via the brief suite list (imported alongside portfolio-release).
 */
import {
  HMS_RUNTIME_ABI_VERSION,
  emptyActiveRegistryV2,
  fingerprintActiveSet,
  hmsPortfolioToolReleaseV2Schema,
  isRegistryCutoverComplete,
  loadActiveReadRegistryV2,
  loadValidatedActiveReadSet,
  promoteReadToolV2,
  rollbackReadToolV2,
  validateReleasePredecessorRules,
  type HmsPortfolioToolReleaseV2,
  type HmsSessionAuthorization,
  type MailArtifactAuthorization,
} from '../src/hms/release-kernel.js';
import {
  IncompleteRestoreError,
  SOURCE_REGISTRY_INCOMPLETE_RESTORE_EXIT,
  assertCandidateDoesNotOrphanReleases,
  assertCandidatePreservesActiveTools,
  runSourceRegistryTransaction,
} from '../src/hms/source-registry-transaction.js';
import {
  FIND_RESERVATION_IMPL_V1,
  FIND_RESERVATION_IMPL_V2,
  MAIL_ARTIFACT_IMPL_V1,
  assertHandlerIndexCovers,
  createReadToolHandler,
  hasHandlerFor,
} from '../src/hms/read-handler-index.js';
import {
  MAX_TOTAL_READ_ATTEMPTS,
  canScoreFull,
  executableReadStepsForPlan,
  selectRequestedFollowupClasses,
  type CandidateBinding,
} from '../src/hms/candidate-read-plan.js';
import { fingerprintReadToolRegistry, productionActiveReadToolIds } from '../src/hms/read-tools.js';
import { requestPolicyManifestSchema } from '../src/hms/contracts.js';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

function hex(n: number | string): string {
  return String(n).repeat(64).slice(0, 64);
}

function baseReleaseFields() {
  return {
    schemaVersion: 2 as const,
    toolsetVersion: '3.0.0',
    toolsetFingerprint: fingerprintReadToolRegistry(),
    sourceRevision: 'abc1234',
    phaseAPlanSha256: hex(1),
    phaseBPlanSha256: hex(2),
    gateSha256: hex(3),
    runtimeAbiVersion: HMS_RUNTIME_ABI_VERSION,
    runtimeFingerprintSha256: hex(4),
    requesterPolicySha256: hex(5),
    privateDigestKeyVersion: 'v1',
    liveProofSha256: hex(6),
    receiptSha256: hex(7),
  };
}

function findRelease(
  overrides: Partial<HmsPortfolioToolReleaseV2> & {
    releaseId: string;
    implementationSha256: string;
    predecessorReleaseId: string | null;
    rollbackAction: 'disable' | 'restore_predecessor';
  },
): HmsPortfolioToolReleaseV2 {
  return hmsPortfolioToolReleaseV2Schema.parse({
    ...baseReleaseFields(),
    qualification: 'live_verified',
    shadowSha256: null,
    evidenceKind: 'hms',
    toolId: 'hms_find_reservation',
    toolVersion: '1.2.0',
    requestBranches: [
      {
        id: 'guest_stay_search',
        discoveryOperationId: 'guest_stay_search',
        manifestSha256: hex(8),
        discoverySha256: hex(9),
        parserSchemaSha256: hex('a'),
      },
    ],
    credentialVersionHmacSha256: hex('b'),
    roleProofSha256: hex('c'),
    ...overrides,
  });
}

function mailRelease(
  overrides: Partial<HmsPortfolioToolReleaseV2> & {
    releaseId: string;
    implementationSha256: string;
    predecessorReleaseId: string | null;
    rollbackAction: 'disable' | 'restore_predecessor';
  },
): HmsPortfolioToolReleaseV2 {
  return hmsPortfolioToolReleaseV2Schema.parse({
    ...baseReleaseFields(),
    qualification: 'live_verified',
    shadowSha256: null,
    evidenceKind: 'mail',
    toolId: 'mail_read_artifact',
    toolVersion: '2',
    grantPolicySha256: hex('d'),
    s3IdentitySha256: hex('e'),
    parserSandboxSha256: hex('f'),
    ...overrides,
  });
}

describe('Task 13 registry v2 cutover + plan-scoped authorization', () => {
  it('fails closed on missing/invalid registry', async () => {
    const root = await mkdtemp(join(tmpdir(), 'reg-missing-'));
    await expect(loadActiveReadRegistryV2(join(root, 'missing.json'))).rejects.toThrow(/missing/);
    await writeFile(join(root, 'bad.json'), '{"schemaVersion":1}\n');
    await expect(loadActiveReadRegistryV2(join(root, 'bad.json'))).rejects.toThrow();
  });

  it('fixture constants cannot activate production without registry', () => {
    expect(productionActiveReadToolIds()).toEqual([]);
    expect(
      isRegistryCutoverComplete({
        activeToolIds: new Set(),
        handlerPathActive: false,
      }),
    ).toBe(false);
  });

  it('handler index covers active + differing predecessor', () => {
    expect(hasHandlerFor('hms_find_reservation', FIND_RESERVATION_IMPL_V1)).toBe(true);
    expect(hasHandlerFor('mail_read_artifact', MAIL_ARTIFACT_IMPL_V1)).toBe(true);
    assertHandlerIndexCovers({
      active: new Map([
        ['hms_find_reservation', { implementationSha256: FIND_RESERVATION_IMPL_V2 }],
      ]),
      immediatePredecessor: new Map([
        ['hms_find_reservation', { implementationSha256: FIND_RESERVATION_IMPL_V1 }],
      ]),
    });
    expect(() =>
      assertHandlerIndexCovers({
        active: new Map([
          ['hms_find_reservation', { implementationSha256: FIND_RESERVATION_IMPL_V1 }],
        ]),
        immediatePredecessor: new Map([
          ['hms_find_reservation', { implementationSha256: FIND_RESERVATION_IMPL_V1 }],
        ]),
      }),
    ).toThrow(/differ/);
  });

  it('createReadToolHandler rejects mail/HMS auth swaps and digest mismatches', () => {
    const release = findRelease({
      releaseId: randomUUID(),
      implementationSha256: FIND_RESERVATION_IMPL_V1,
      predecessorReleaseId: null,
      rollbackAction: 'disable',
      requestBranches: [
        {
          id: 'guest_stay_search',
          discoveryOperationId: 'guest_stay_search',
          manifestSha256: createHash('sha256')
            .update(
              JSON.stringify(
                requestPolicyManifestSchema.parse({
                  rules: [
                    {
                      id: 'r1',
                      origin: 'https://example.test',
                      method: 'GET',
                      path: '/x',
                      resourceTypes: ['document'],
                      redirectPolicy: 'same-reviewed-chain',
                    },
                  ],
                }),
              ),
            )
            .digest('hex'),
          discoverySha256: hex(9),
          parserSchemaSha256: hex('a'),
        },
      ],
    });
    const manifest = requestPolicyManifestSchema.parse({
      rules: [
        {
          id: 'r1',
          origin: 'https://example.test',
          method: 'GET',
          path: '/x',
          resourceTypes: ['document'],
          redirectPolicy: 'same-reviewed-chain',
        },
      ],
    });
    const auth: HmsSessionAuthorization = {
      operationId: randomUUID(),
      toolId: 'hms_find_reservation',
      discoveryOperationId: 'guest_stay_search',
      releaseId: release.releaseId,
      requestBranchId: 'guest_stay_search',
      manifest,
      manifestSha256: createHash('sha256').update(JSON.stringify(manifest)).digest('hex'),
      roleProofPath: '/tmp/proof.v2.json',
      roleProofSha256: hex('c'),
      credentialVersionHmacSha256: hex('b'),
      runtimeFingerprintSha256: release.runtimeFingerprintSha256,
      privateDigestKeyVersion: release.privateDigestKeyVersion,
      sourceRevision: release.sourceRevision,
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
    };
    expect(createReadToolHandler(release, auth).toolId).toBe('hms_find_reservation');

    const mail = mailRelease({
      releaseId: randomUUID(),
      implementationSha256: MAIL_ARTIFACT_IMPL_V1,
      predecessorReleaseId: null,
      rollbackAction: 'disable',
    });
    const mailAuth: MailArtifactAuthorization = {
      operationId: randomUUID(),
      releaseId: mail.releaseId,
      grantPolicySha256: hex('d'),
      s3IdentitySha256: hex('e'),
      runtimeFingerprintSha256: mail.runtimeFingerprintSha256,
      privateDigestKeyVersion: mail.privateDigestKeyVersion,
      sourceRevision: mail.sourceRevision,
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
    };
    // Align release IDs so auth-kind mismatch is the signal (not releaseId).
    const mailAuthOnFind: MailArtifactAuthorization = {
      ...mailAuth,
      releaseId: release.releaseId,
      runtimeFingerprintSha256: release.runtimeFingerprintSha256,
      privateDigestKeyVersion: release.privateDigestKeyVersion,
      sourceRevision: release.sourceRevision,
    };
    expect(() => createReadToolHandler(release, mailAuthOnFind)).toThrow(
      /MailArtifact|mail release|HMS release rejects/i,
    );
    const hmsAuthOnMail: HmsSessionAuthorization = {
      ...auth,
      releaseId: mail.releaseId,
      runtimeFingerprintSha256: mail.runtimeFingerprintSha256,
      privateDigestKeyVersion: mail.privateDigestKeyVersion,
      sourceRevision: mail.sourceRevision,
    };
    expect(() => createReadToolHandler(mail, hmsAuthOnMail)).toThrow(
      /MailArtifact|mail release|HMS|grantPolicy/i,
    );
  });

  it('rejects swapped runtime ABI / fingerprint / implementation', async () => {
    const root = await mkdtemp(join(tmpdir(), 'reg-swap-'));
    const releaseRoot = join(root, 'releases');
    const registryPath = join(root, 'active.json');
    const release = findRelease({
      releaseId: randomUUID(),
      implementationSha256: FIND_RESERVATION_IMPL_V1,
      predecessorReleaseId: null,
      rollbackAction: 'disable',
    });
    await promoteReadToolV2({ path: registryPath, release, releaseRoot });

    await expect(
      loadValidatedActiveReadSet({
        registryPath,
        releaseRoot,
        runtimeAbiVersion: 'wrong-abi',
        runtimeFingerprintSha256: release.runtimeFingerprintSha256,
        availableImplementationDigests: new Map([
          ['hms_find_reservation', new Set([FIND_RESERVATION_IMPL_V1])],
        ]),
      }),
    ).rejects.toThrow(/ABI/);

    await expect(
      loadValidatedActiveReadSet({
        registryPath,
        releaseRoot,
        runtimeAbiVersion: HMS_RUNTIME_ABI_VERSION,
        runtimeFingerprintSha256: hex(0),
        availableImplementationDigests: new Map([
          ['hms_find_reservation', new Set([FIND_RESERVATION_IMPL_V1])],
        ]),
      }),
    ).rejects.toThrow(/fingerprint/);

    await expect(
      loadValidatedActiveReadSet({
        registryPath,
        releaseRoot,
        runtimeAbiVersion: HMS_RUNTIME_ABI_VERSION,
        runtimeFingerprintSha256: release.runtimeFingerprintSha256,
        availableImplementationDigests: new Map([
          ['hms_find_reservation', new Set([FIND_RESERVATION_IMPL_V2])],
        ]),
      }),
    ).rejects.toThrow(/unloadable/);
  });

  it('first-release rollback disables; upgrade restores differing digest; noop repeat', async () => {
    const root = await mkdtemp(join(tmpdir(), 'reg-rb-'));
    const releaseRoot = join(root, 'releases');
    const registryPath = join(root, 'active.json');
    const first = findRelease({
      releaseId: randomUUID(),
      implementationSha256: FIND_RESERVATION_IMPL_V1,
      predecessorReleaseId: null,
      rollbackAction: 'disable',
    });
    validateReleasePredecessorRules(first, null);
    await promoteReadToolV2({ path: registryPath, release: first, releaseRoot });

    const second = findRelease({
      releaseId: randomUUID(),
      implementationSha256: FIND_RESERVATION_IMPL_V2,
      predecessorReleaseId: first.releaseId,
      rollbackAction: 'restore_predecessor',
    });
    validateReleasePredecessorRules(second, first.releaseId);
    await promoteReadToolV2({ path: registryPath, release: second, releaseRoot });

    let reg = await loadActiveReadRegistryV2(registryPath);
    expect(reg.active.hms_find_reservation).toBe(second.releaseId);
    expect(reg.immediatePredecessor.hms_find_reservation).toBe(first.releaseId);

    reg = await rollbackReadToolV2({
      path: registryPath,
      toolId: 'hms_find_reservation',
    });
    expect(reg.active.hms_find_reservation).toBe(first.releaseId);

    reg = await rollbackReadToolV2({
      path: registryPath,
      toolId: 'hms_find_reservation',
    });
    expect(reg.active.hms_find_reservation).toBeUndefined();

    const again = await rollbackReadToolV2({
      path: registryPath,
      toolId: 'hms_find_reservation',
    });
    expect(again.generation).toBe(reg.generation);
  });

  it('executable plan: quote without reservation; omissions block Full; cap six', () => {
    const authId = 'auth-1';
    const requester = {
      schemaVersion: 1 as const,
      authorizationId: authId,
      operationId: 'op-1',
      mailboxGrantSha256: hex(1),
      threadIdHmacSha256: hex(2),
      threadStateVersion: '1',
      requesterIdentityHmacSha256: hex(3),
      requesterClass: 'reservation_guest' as const,
      inquiryClass: 'quote_request' as const,
      allowedClaimKinds: ['quote' as const],
      privateDigestKeyVersion: 'v1',
      issuedAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
    };
    const quoteRelease = hmsPortfolioToolReleaseV2Schema.parse({
      ...baseReleaseFields(),
      releaseId: randomUUID(),
      qualification: 'live_verified',
      shadowSha256: null,
      predecessorReleaseId: null,
      rollbackAction: 'disable',
      evidenceKind: 'hms',
      toolId: 'hms_quote_stay',
      toolVersion: '2.0.0',
      implementationSha256: hex(9),
      requestBranches: [
        {
          id: 'quote_availability_search',
          discoveryOperationId: 'quote_availability_search',
          manifestSha256: hex(8),
          discoverySha256: hex(9),
          parserSchemaSha256: hex('a'),
        },
      ],
      credentialVersionHmacSha256: hex('b'),
      roleProofSha256: hex('c'),
    });
    const candidates = new Map<string, CandidateBinding>([
      [
        'cand-quote',
        {
          candidateId: 'cand-quote',
          toolId: 'hms_quote_stay',
          allowedRequestBranchIds: ['quote_availability_search'],
          parentEvidenceId: null,
          requesterAuthorizationId: authId,
        },
      ],
    ]);
    const quotePlan = executableReadStepsForPlan(
      { kind: 'quote', quote: true },
      new Map([['hms_quote_stay', quoteRelease]]),
      candidates,
      requester,
      { authoredSegment: 'What rates are available?' },
    );
    expect(quotePlan.steps).toHaveLength(1);
    expect(canScoreFull(quotePlan)).toBe(true);

    // Group / event: one direct candidate, no reservation prerequisite.
    const groupRelease = hmsPortfolioToolReleaseV2Schema.parse({
      ...baseReleaseFields(),
      releaseId: randomUUID(),
      qualification: 'live_verified',
      shadowSha256: null,
      predecessorReleaseId: null,
      rollbackAction: 'disable',
      evidenceKind: 'hms',
      toolId: 'hms_group_block_read',
      toolVersion: '1.0.0',
      implementationSha256: hex(3),
      requestBranches: [
        {
          id: 'group_block_list',
          discoveryOperationId: 'group_block_list',
          manifestSha256: hex(8),
          discoverySha256: hex(9),
          parserSchemaSha256: hex('a'),
        },
      ],
      credentialVersionHmacSha256: hex('b'),
      roleProofSha256: hex('c'),
    });
    const eventRelease = hmsPortfolioToolReleaseV2Schema.parse({
      ...baseReleaseFields(),
      releaseId: randomUUID(),
      qualification: 'live_verified',
      shadowSha256: null,
      predecessorReleaseId: null,
      rollbackAction: 'disable',
      evidenceKind: 'hms',
      toolId: 'hms_event_read',
      toolVersion: '1.0.0',
      implementationSha256: hex(4),
      requestBranches: [
        {
          id: 'event_list',
          discoveryOperationId: 'event_list',
          manifestSha256: hex(8),
          discoverySha256: hex(9),
          parserSchemaSha256: hex('a'),
        },
      ],
      credentialVersionHmacSha256: hex('b'),
      roleProofSha256: hex('c'),
    });
    const groupPlan = executableReadStepsForPlan(
      { kind: 'group', group: true },
      new Map([['hms_group_block_read', groupRelease]]),
      new Map([
        [
          'cand-group',
          {
            candidateId: 'cand-group',
            toolId: 'hms_group_block_read',
            allowedRequestBranchIds: ['group_block_list'],
            parentEvidenceId: null,
            requesterAuthorizationId: authId,
          },
        ],
      ]),
      requester,
      { authoredSegment: 'Please check group block G-100 status' },
    );
    expect(groupPlan.steps).toHaveLength(1);
    expect(groupPlan.steps[0]!.toolId).toBe('hms_group_block_read');
    expect(canScoreFull(groupPlan)).toBe(true);

    const eventPlan = executableReadStepsForPlan(
      { kind: 'event', event: true },
      new Map([['hms_event_read', eventRelease]]),
      new Map([
        [
          'cand-event',
          {
            candidateId: 'cand-event',
            toolId: 'hms_event_read',
            allowedRequestBranchIds: ['event_list'],
            parentEvidenceId: null,
            requesterAuthorizationId: authId,
          },
        ],
      ]),
      requester,
      { authoredSegment: 'Confirm banquet event booking for Friday' },
    );
    expect(eventPlan.steps).toHaveLength(1);
    expect(eventPlan.steps[0]!.toolId).toBe('hms_event_read');
    expect(canScoreFull(eventPlan)).toBe(true);

    const find = findRelease({
      releaseId: randomUUID(),
      implementationSha256: FIND_RESERVATION_IMPL_V1,
      predecessorReleaseId: null,
      rollbackAction: 'disable',
    });
    const docs = hmsPortfolioToolReleaseV2Schema.parse({
      ...baseReleaseFields(),
      releaseId: randomUUID(),
      qualification: 'live_verified',
      shadowSha256: null,
      predecessorReleaseId: null,
      rollbackAction: 'disable',
      evidenceKind: 'hms',
      toolId: 'hms_list_documents',
      toolVersion: '1.0.0',
      implementationSha256: hex(1),
      requestBranches: [
        {
          id: 'tax_invoice_documents',
          discoveryOperationId: 'tax_invoice_list',
          manifestSha256: hex(8),
          discoverySha256: hex(9),
          parserSchemaSha256: hex('a'),
        },
      ],
      credentialVersionHmacSha256: hex('b'),
      roleProofSha256: hex('c'),
    });
    const folio = hmsPortfolioToolReleaseV2Schema.parse({
      ...baseReleaseFields(),
      releaseId: randomUUID(),
      qualification: 'live_verified',
      shadowSha256: null,
      predecessorReleaseId: null,
      rollbackAction: 'disable',
      evidenceKind: 'hms',
      toolId: 'hms_read_folio',
      toolVersion: '1.0.0',
      implementationSha256: hex(2),
      requestBranches: [
        {
          id: 'folio_summary',
          discoveryOperationId: 'folio_summary',
          manifestSha256: hex(8),
          discoverySha256: hex(9),
          parserSchemaSha256: hex('a'),
        },
      ],
      credentialVersionHmacSha256: hex('b'),
      roleProofSha256: hex('c'),
    });
    const parentEv = randomUUID();
    const resCandidates = new Map<string, CandidateBinding>([
      [
        'find',
        {
          candidateId: 'find',
          toolId: 'hms_find_reservation',
          allowedRequestBranchIds: ['guest_stay_search'],
          parentEvidenceId: null,
          requesterAuthorizationId: authId,
        },
      ],
      [
        'docs',
        {
          candidateId: 'docs',
          toolId: 'hms_list_documents',
          allowedRequestBranchIds: ['tax_invoice_documents'],
          parentEvidenceId: parentEv,
          requesterAuthorizationId: authId,
        },
      ],
      [
        'folio',
        {
          candidateId: 'folio',
          toolId: 'hms_read_folio',
          allowedRequestBranchIds: ['folio_summary'],
          parentEvidenceId: parentEv,
          requesterAuthorizationId: authId,
        },
      ],
    ]);
    const requested = selectRequestedFollowupClasses(
      'tax invoice and folio balance and company billing and sent email',
    );
    expect(requested.length).toBeGreaterThan(2);
    const overflow = executableReadStepsForPlan(
      {
        kind: 'reservation',
        find: true,
        followups: ['documents', 'folio'],
      },
      new Map([
        ['hms_find_reservation', find],
        ['hms_list_documents', docs],
        ['hms_read_folio', folio],
      ]),
      resCandidates,
      { ...requester, inquiryClass: 'invoice_request' },
      {
        authoredSegment: 'tax invoice and folio balance',
        requestedFollowupClasses: requested,
      },
    );
    expect(overflow.status).toBe('manual_required');
    expect(overflow.omittedRequestClasses.length).toBeGreaterThan(0);
    expect(canScoreFull(overflow)).toBe(false);
    expect(overflow.steps.length).toBeLessThanOrEqual(MAX_TOTAL_READ_ATTEMPTS);

    expect(() =>
      executableReadStepsForPlan(
        { kind: 'quote', quote: true },
        new Map([['hms_quote_stay', quoteRelease]]),
        candidates,
        { ...requester, authorizationId: 'other-thread' },
      ),
    ).toThrow(/requester authorization/);

    expect(() =>
      executableReadStepsForPlan(
        {
          kind: 'reservation',
          find: true,
          followups: ['documents'],
        },
        new Map([
          ['hms_find_reservation', find],
          ['hms_list_documents', docs],
        ]),
        new Map([
          [
            'find',
            {
              candidateId: 'find',
              toolId: 'hms_find_reservation',
              allowedRequestBranchIds: ['guest_stay_search'],
              parentEvidenceId: null,
              requesterAuthorizationId: authId,
            },
          ],
          [
            'docs',
            {
              candidateId: 'docs',
              toolId: 'hms_list_documents',
              allowedRequestBranchIds: ['sent_email_documents'],
              parentEvidenceId: parentEv,
              requesterAuthorizationId: authId,
            },
          ],
        ]),
        requester,
        { authoredSegment: 'please send tax invoice' },
      ),
    ).toThrow(/sibling-branch/);
  });

  it('candidate deploy refuses orphaning; CAS crash restores; incomplete exit 20', async () => {
    assertCandidateDoesNotOrphanReleases({
      requiredDigests: new Map([
        ['hms_find_reservation', new Set([FIND_RESERVATION_IMPL_V1, FIND_RESERVATION_IMPL_V2])],
      ]),
      availableDigests: new Map([
        ['hms_find_reservation', new Set([FIND_RESERVATION_IMPL_V1, FIND_RESERVATION_IMPL_V2])],
      ]),
    });
    expect(() =>
      assertCandidateDoesNotOrphanReleases({
        requiredDigests: new Map([['hms_find_reservation', new Set([FIND_RESERVATION_IMPL_V1])]]),
        availableDigests: new Map([['hms_find_reservation', new Set([FIND_RESERVATION_IMPL_V2])]]),
      }),
    ).toThrow(/orphan/);

    assertCandidatePreservesActiveTools({
      currentActive: { hms_find_reservation: 'r-find' },
      candidateActive: {
        hms_find_reservation: 'r-find',
        mail_read_artifact: 'r-mail',
      },
    });
    expect(() =>
      assertCandidatePreservesActiveTools({
        currentActive: {
          hms_find_reservation: 'r-find',
          hms_quote_stay: 'r-quote',
        },
        candidateActive: { hms_find_reservation: 'r-find' },
      }),
    ).toThrow(/drop active tool hms_quote_stay/);

    const root = await mkdtemp(join(tmpdir(), 'cas-'));
    const activeRegistry = join(root, 'active.json');
    const candidateRegistry = join(root, 'candidate.json');
    const backupRoot = join(root, 'backup');
    const toolsetFingerprint = fingerprintReadToolRegistry();
    const currentPointers = {
      sourceRevision: 'rev-old',
      registryPath: activeRegistry,
      activeSetFingerprint: fingerprintActiveSet({
        generation: 1,
        toolsetVersion: '3.0.0',
        toolsetFingerprint,
        active: { hms_find_reservation: randomUUID() },
        immediatePredecessor: {},
      }),
    };
    const candidatePointers = {
      sourceRevision: 'rev-new',
      registryPath: activeRegistry,
      activeSetFingerprint: fingerprintActiveSet({
        generation: 2,
        toolsetVersion: '3.0.0',
        toolsetFingerprint,
        active: {
          hms_find_reservation: randomUUID(),
          mail_read_artifact: randomUUID(),
        },
        immediatePredecessor: {},
      }),
    };
    await writeFile(
      activeRegistry,
      `${JSON.stringify({
        ...emptyActiveRegistryV2({
          toolsetVersion: '3.0.0',
          toolsetFingerprint,
        }),
        generation: 1,
        activeSetFingerprint: currentPointers.activeSetFingerprint,
      })}\n`,
    );
    await writeFile(
      candidateRegistry,
      `${JSON.stringify({
        ...emptyActiveRegistryV2({
          toolsetVersion: '3.0.0',
          toolsetFingerprint,
        }),
        generation: 2,
        activeSetFingerprint: candidatePointers.activeSetFingerprint,
      })}\n`,
    );

    let currentSource = 'rev-old';
    for (const crashAt of [
      'before_source_switch',
      'after_source_switch',
      'before_registry_rename',
      'after_registry_rename',
      'before_pm2_restart',
      'after_pm2_restart',
      'before_health_verdict',
    ] as const) {
      currentSource = 'rev-old';
      await writeFile(
        activeRegistry,
        `${JSON.stringify({
          marker: 'prior',
          activeSetFingerprint: currentPointers.activeSetFingerprint,
        })}\n`,
      );
      const result = await runSourceRegistryTransaction({
        current: currentPointers,
        candidate: candidatePointers,
        candidateRegistryFile: candidateRegistry,
        activeRegistryPath: activeRegistry,
        backupRoot,
        hooks: {
          crashAt,
          switchSource: async (rev) => {
            currentSource = rev;
          },
          restartWorker: async () => undefined,
          verifyHealth: async (expected) => {
            if (currentSource !== expected.sourceRevision) {
              throw new Error('source mismatch after restore');
            }
          },
        },
      });
      expect(result.status).toBe('restored');
      expect(currentSource).toBe('rev-old');
    }

    const applied = await runSourceRegistryTransaction({
      current: currentPointers,
      candidate: candidatePointers,
      candidateRegistryFile: candidateRegistry,
      activeRegistryPath: activeRegistry,
      backupRoot,
      hooks: {
        switchSource: async (rev) => {
          currentSource = rev;
        },
        restartWorker: async () => undefined,
        verifyHealth: async (expected) => {
          if (currentSource !== expected.sourceRevision) {
            throw new Error('health mismatch');
          }
        },
      },
    });
    expect(applied.status).toBe('applied');

    await expect(
      runSourceRegistryTransaction({
        current: currentPointers,
        candidate: candidatePointers,
        candidateRegistryFile: candidateRegistry,
        activeRegistryPath: activeRegistry,
        backupRoot,
        hooks: {
          crashAt: 'after_source_switch',
          switchSource: async (rev) => {
            if (rev === 'rev-old') throw new Error('restore source failed');
            currentSource = rev;
          },
          restartWorker: async () => undefined,
          verifyHealth: async () => undefined,
        },
      }),
    ).rejects.toMatchObject({
      name: 'IncompleteRestoreError',
      exitCode: SOURCE_REGISTRY_INCOMPLETE_RESTORE_EXIT,
    });
    expect(IncompleteRestoreError).toBeTruthy();
  });

  it('cutover complete only when find+mail seeds and handler path active', () => {
    expect(
      isRegistryCutoverComplete({
        activeToolIds: new Set(['hms_find_reservation', 'mail_read_artifact']),
        handlerPathActive: true,
      }),
    ).toBe(true);
    expect(
      isRegistryCutoverComplete({
        activeToolIds: new Set(['hms_find_reservation']),
        handlerPathActive: true,
      }),
    ).toBe(false);
  });
});

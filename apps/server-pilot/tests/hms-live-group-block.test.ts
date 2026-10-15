import {
  createLiveGroupBlockDriver,
  GROUP_BLOCK_AGGREGATE_COUNTS_BLOCKER,
  observeGroupBlockAggregate,
  parseGroupBlockListTransport,
} from '../src/hms/live-group-block-driver.js';
import {
  parseGroupReadCandidateFromAuthoredSegment,
  type GroupReadCandidate,
} from '../src/hms/group-read-candidate.js';
import { GROUP_BLOCK_READ_PRIVACY_POLICY } from '../src/hms/group-block-read-contract.js';
import { buildLiveGroupBlockListManifest } from '../src/hms/live-read-manifest.js';
import type { HmsSessionAuthorization } from '../src/hms/release-kernel.js';
import { HmsRuntimeError } from '../src/hms/runtime.js';
import { READ_TOOLS } from '../src/hms/read-tools.js';
import {
  createPropertyReadLock,
  isPropertyReadLockHeld,
} from '../src/hms/property-read-lock.js';
import { createHash, randomUUID } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { existsSync } from 'node:fs';
import { join } from 'node:path';

const ORIGIN = 'https://appsrv-1.legacyhotels.co.za';

function testPropertyReadLock() {
  return createPropertyReadLock({
    tenantId: 'HMS_LEGACY',
    propertyCode: 'HRCEN',
    username: 'synthetic-user',
    connectionFactory: async () => ({
      query: vi.fn(async (sql: string) =>
        sql.includes('pg_try_advisory_lock') ? [{ acquired: true }] : [{ released: true }],
      ),
      close: vi.fn(async () => undefined),
    }),
  });
}

function auth(overrides: Partial<HmsSessionAuthorization> = {}): HmsSessionAuthorization {
  const manifest = buildLiveGroupBlockListManifest(ORIGIN);
  return {
    operationId: randomUUID(),
    toolId: 'hms_group_block_read',
    discoveryOperationId: 'group_block_list',
    releaseId: randomUUID(),
    requestBranchId: 'group_block_list',
    manifest,
    manifestSha256: createHash('sha256').update(JSON.stringify(manifest)).digest('hex'),
    roleProofPath: '/tmp/role-proof-group.v2.json',
    roleProofSha256: 'b'.repeat(64),
    credentialVersionHmacSha256: 'c'.repeat(64),
    runtimeFingerprintSha256: 'd'.repeat(64),
    privateDigestKeyVersion: 'v1',
    sourceRevision: 'test-rev',
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
    ...overrides,
  };
}

function candidate(overrides: Partial<GroupReadCandidate> = {}): GroupReadCandidate {
  const parsed = parseGroupReadCandidateFromAuthoredSegment(
    'Please check group block G-100 status start 2026-09-01 end 2026-09-03',
  );
  if (!parsed) throw new Error('fixture candidate parse failed');
  return { ...parsed, ...overrides };
}

function auditSpecForReceipt() {
  return {
    operationId: randomUUID(),
    toolId: 'hms_group_block_read' as const,
    toolVersion: '1.0.0',
    dependencyRevision: 'playwright-1.52.0-chromium-1169',
    sourceRevision: 'test-rev',
    executionClass: 'normal' as const,
    inputClass: 'authorized_exact' as const,
    requestBranchId: 'group_block_list',
    roleProofSha256: 'b'.repeat(64),
    roleProofExpiresAt: new Date(Date.now() + 60_000).toISOString(),
  };
}

function completeReceiptFor(
  auditSpec: ReturnType<typeof auditSpecForReceipt>,
): Record<string, unknown> {
  return {
    schemaVersion: 1,
    artifactState: 'complete',
    artifactId: 'group-artifact-receipt-matrix',
    operationId: auditSpec.operationId,
    sourceRevision: auditSpec.sourceRevision,
    toolId: auditSpec.toolId,
    toolVersion: auditSpec.toolVersion,
    dependencyRevision: auditSpec.dependencyRevision,
    playwrightRevision: '1.52.0',
    chromiumRevision: '1169',
    executionClass: auditSpec.executionClass,
    inputClass: auditSpec.inputClass,
    credentialMode: 'view_only',
    roleProofSha256: auditSpec.roleProofSha256,
    roleProofExpiresAt: auditSpec.roleProofExpiresAt,
    requestBranchId: auditSpec.requestBranchId,
    operationOutcome: 'succeeded',
    requestRules: [],
    blockedRequests: 0,
    mutationRequests: 0,
    popupCount: 0,
    downloadCount: 0,
    webSocketCount: 0,
    milestones: {},
    terminalCode: 'OK',
    terminalStage: 'tool',
    expiresAt: '2099-09-07T12:05:00.000Z',
    trace: { sha256: 'a'.repeat(64), bytes: 1 },
    video: null,
  };
}

function groupRuntimeForReceipt(transport: string, receipt: Record<string, unknown>) {
  const postForm = vi.fn(async (url: string) => (url.endsWith('GSGRPB.LST') ? transport : ''));
  return {
    openReadSession: vi.fn(async () => ({
      origin: ORIGIN,
      page: {
        postForm,
        waitForCorrelatedResponse: vi.fn(async () => undefined),
        content: vi.fn(async () => transport),
      },
      terminal: () => false,
      violation: () => null,
      close: vi.fn(async () => undefined),
      lastReceipt: () => receipt as never,
    })),
  };
}

const receiptMutations: readonly {
  label: string;
  mutate: (receipt: Record<string, unknown>) => void;
}[] = [
  { label: 'missing schema version', mutate: (receipt) => delete receipt.schemaVersion },
  { label: 'incomplete artifact state', mutate: (receipt) => (receipt.artifactState = 'staging') },
  { label: 'missing artifact identity', mutate: (receipt) => (receipt.artifactId = '') },
  { label: 'source revision mismatch', mutate: (receipt) => (receipt.sourceRevision = 'other') },
  {
    label: 'dependency revision mismatch',
    mutate: (receipt) => (receipt.dependencyRevision = 'other'),
  },
  {
    label: 'write-capable credentials',
    mutate: (receipt) => (receipt.credentialMode = 'write_capable'),
  },
  { label: 'role proof mismatch', mutate: (receipt) => (receipt.roleProofSha256 = 'c'.repeat(64)) },
  { label: 'wrong request branch', mutate: (receipt) => (receipt.requestBranchId = 'event_list') },
  { label: 'failed operation outcome', mutate: (receipt) => (receipt.operationOutcome = 'failed') },
  { label: 'unsafe terminal code', mutate: (receipt) => (receipt.terminalCode = 'TOOL_ERROR') },
  {
    label: 'expired artifact',
    mutate: (receipt) => (receipt.expiresAt = '2020-01-01T00:00:00.000Z'),
  },
  {
    label: 'malformed trace digest',
    mutate: (receipt) => (receipt.trace = { sha256: 'bad', bytes: 1 }),
  },
  { label: 'unsafe blocked request', mutate: (receipt) => (receipt.blockedRequests = 1) },
  { label: 'unsafe mutation request', mutate: (receipt) => (receipt.mutationRequests = 1) },
  { label: 'popup event', mutate: (receipt) => (receipt.popupCount = 1) },
  { label: 'download event', mutate: (receipt) => (receipt.downloadCount = 1) },
  { label: 'websocket event', mutate: (receipt) => (receipt.webSocketCount = 1) },
  {
    label: 'malformed request-rule count',
    mutate: (receipt) => (receipt.requestRules = [{ ruleId: 'list', count: -1 }]),
  },
];

describe('group read candidate parser', () => {
  it('parses exact reference + bounded dates', () => {
    const c = parseGroupReadCandidateFromAuthoredSegment(
      'group booking G-100 start date 2026-09-01 end date 2026-09-03',
    );
    expect(c?.exactGroupReference).toBe('G-100');
    expect(c?.startDate).toBe('2026-09-01');
    expect(c?.endDate).toBe('2026-09-03');
    expect(c?.exactGroupReferenceHash).toMatch(/^[a-f0-9]{64}$/);
  });

  it('rejects zero / multiple / conflicting candidates', () => {
    expect(parseGroupReadCandidateFromAuthoredSegment('hello')).toBeNull();
    expect(
      parseGroupReadCandidateFromAuthoredSegment(
        'group G-1 and group G-2 start 2026-09-01 end 2026-09-02',
      ),
    ).toBeNull();
    expect(
      parseGroupReadCandidateFromAuthoredSegment(
        'group G-1 start 2026-09-01 end 2026-09-02 start 2026-10-01 end 2026-10-02',
      ),
    ).toBeNull();
  });

  it('rejects date windows beyond max days', () => {
    expect(
      parseGroupReadCandidateFromAuthoredSegment('group G-1 start 2026-01-01 end 2026-03-15'),
    ).toBeNull();
  });

  it('rejects oversized authored segments', () => {
    expect(
      parseGroupReadCandidateFromAuthoredSegment(
        `${'x'.repeat(20_000)} group G-1 start 2026-09-01 end 2026-09-02`,
      ),
    ).toBeNull();
  });
});

describe('live group block aggregate (blocked counts)', () => {
  it('parses only the reviewed GSGRPB.LST identity/status/date fields', () => {
    const parsed = parseGroupBlockListTransport(
      JSON.stringify({
        pageData: {
          grid: {
            GRIDRESULT: {
              GRID: {
                DATA: [
                  {
                    groupbookingreferencenumber: 'G-100',
                    status: 'Tentative',
                    startdate: '01-SEP-2026',
                    enddate: '03-SEP-2026',
                    contactfirstname: 'Private',
                    con: 10,
                  },
                ],
              },
            },
          },
        },
      }),
    );
    expect(parsed.envelopeRecognized).toBe(true);
    expect(parsed.rows).toEqual([
      {
        groupRef: 'G-100',
        status: 'tentative',
        startDate: '2026-09-01',
        endDate: '2026-09-03',
      },
    ]);
    expect(JSON.stringify(parsed)).not.toContain('Private');
  });

  it('rejects generic DATA payloads and semantic aliases as source evidence', () => {
    const generic = parseGroupBlockListTransport(
      JSON.stringify({
        DATA: [
          {
            groupcode: 'G-100',
            state: 'Tentative',
            fromdate: '2026-09-01',
            todate: '2026-09-03',
          },
        ],
      }),
    );
    expect(generic.envelopeRecognized).toBe(false);
    expect(generic.rows).toEqual([]);

    const aliasDrift = parseGroupBlockListTransport(
      JSON.stringify({
        pageData: {
          grid: {
            GRIDRESULT: {
              GRID: {
                DATA: [
                  {
                    groupcode: 'G-100',
                    status: 'Tentative',
                    startdate: '01-SEP-2026',
                    enddate: '03-SEP-2026',
                  },
                ],
              },
            },
          },
        },
      }),
    );
    expect(aliasDrift.envelopeRecognized).toBe(true);
    expect(aliasDrift.rows).toEqual([]);
  });

  it('returns source-bound summary facts while keeping counts and delegates unavailable', async () => {
    const transport = JSON.stringify({
      pageData: {
        grid: {
          GRIDRESULT: {
            GRID: {
              DATA: [
                {
                  groupbookingreferencenumber: 'G-100',
                  status: 'Tentative',
                  startdate: '01-SEP-2026',
                  enddate: '03-SEP-2026',
                },
              ],
            },
          },
        },
      },
    });
    const postForm = vi.fn(async (url: string) => (url.endsWith('GSGRPB.LST') ? transport : ''));
    const close = vi.fn(async () => undefined);
    const auditSpec = {
      operationId: randomUUID(),
      toolId: 'hms_group_block_read' as const,
      toolVersion: '1.0.0',
      dependencyRevision: 'playwright-1.52.0-chromium-1169',
      sourceRevision: 'test-rev',
      executionClass: 'normal' as const,
      inputClass: 'authorized_exact' as const,
      requestBranchId: 'group_block_list',
      roleProofSha256: 'b'.repeat(64),
      roleProofExpiresAt: auth().expiresAt,
    };
    const receipt = {
      schemaVersion: 1 as const,
      artifactState: 'complete' as const,
      artifactId: 'group-artifact-1',
      operationId: auditSpec.operationId,
      sourceRevision: auditSpec.sourceRevision,
      toolId: auditSpec.toolId,
      toolVersion: auditSpec.toolVersion,
      dependencyRevision: auditSpec.dependencyRevision,
      playwrightRevision: '1.52.0',
      chromiumRevision: '1169',
      executionClass: auditSpec.executionClass,
      inputClass: auditSpec.inputClass,
      credentialMode: 'view_only' as const,
      roleProofSha256: auditSpec.roleProofSha256,
      roleProofExpiresAt: auditSpec.roleProofExpiresAt,
      requestBranchId: auditSpec.requestBranchId,
      operationOutcome: 'succeeded' as const,
      requestRules: [],
      blockedRequests: 0,
      mutationRequests: 0,
      popupCount: 0,
      downloadCount: 0,
      webSocketCount: 0,
      milestones: {},
      terminalCode: 'OK' as const,
      terminalStage: 'tool' as const,
      expiresAt: '2099-09-07T12:05:00.000Z',
      trace: { sha256: 'a'.repeat(64), bytes: 1 },
      video: null,
    } as never;
    const propertyReadLock = testPropertyReadLock();
    const runtime = {
      openReadSession: vi.fn(async () => {
        expect(isPropertyReadLockHeld(propertyReadLock.key)).toBe(true);
        return {
        origin: ORIGIN,
        page: {
          postForm,
          waitForCorrelatedResponse: vi.fn(async () => undefined),
          content: vi.fn(async () => transport),
        },
        terminal: () => false,
        violation: () => null,
        close,
        lastReceipt: () => receipt,
        };
      }),
    };
    const result = await createLiveGroupBlockDriver({
      runtime: runtime as never,
      transportId: 'transport-u15',
      auditSpec,
      propertyReadLock,
    }).observeGroupBlockContext(auth(), candidate(), new AbortController().signal);

    expect(result.status).toBe('partial');
    expect(result.data).toMatchObject({
      summary: {
        state: 'available',
        data: {
          groupRef: { state: 'known', value: 'G-100' },
          status: { state: 'known', value: 'tentative' },
          startDate: { state: 'known', value: '2026-09-01' },
          endDate: { state: 'known', value: '2026-09-03' },
        },
      },
      blocks: { state: 'unavailable', reasonCode: 'SURFACE_UNPROVEN' },
      delegates: { state: 'unavailable', reasonCode: 'SOURCE_UNAVAILABLE' },
    });
    expect(postForm).toHaveBeenCalledWith(`${ORIGIN}/web/base/GSGRPB`, expect.any(Object));
    expect(postForm).toHaveBeenCalledWith(`${ORIGIN}/web/base/GSGRPB.LST`, expect.any(Object));
    expect(runtime.openReadSession).toHaveBeenCalledWith(
      expect.objectContaining({
        transportId: 'transport-u15',
        auditSpec,
        sessionAuthorization: expect.objectContaining({
          toolId: 'hms_group_block_read',
          requestBranchId: 'group_block_list',
          manifestSha256: expect.any(String),
        }),
      }),
    );
    expect(close).toHaveBeenCalledWith({
      outcome: 'succeeded',
      terminalCode: 'OK',
      complete: true,
    });
    expect(result.evidence[0]).toMatchObject({
      artifactRef: 'group-artifact-1',
      manifestSha256: expect.any(String),
      scopeVerified: true,
    });
  });

  it('fail-closes with BLOCKED_GROUP_BLOCK_AGGREGATE_COUNTS_UNPROVEN', async () => {
    const driver = createLiveGroupBlockDriver();
    const result = await driver.observeGroupBlockAggregate(
      auth(),
      candidate(),
      new AbortController().signal,
    );
    expect(result.status).toBe('manual_required');
    expect(result.unresolvedFields).toContain(GROUP_BLOCK_AGGREGATE_COUNTS_BLOCKER);
    expect(JSON.stringify(result)).not.toContain('recipientClass');
    expect(JSON.stringify(result)).not.toContain('inquiryClass');
    expect(JSON.stringify(result)).not.toContain('contactfirstname');
    expect(JSON.stringify(result)).not.toContain('rooming');
  });

  it('binds blocked aggregate evidence to the explicit property', async () => {
    const result = await createLiveGroupBlockDriver({ propertyCode: 'DVIN' }).observeGroupBlockAggregate(
      auth(),
      candidate(),
      new AbortController().signal,
    );

    expect(result.evidence?.propertyCode).toBe('DVIN');
  });

  it.each(receiptMutations)('rejects a finalized receipt with %s', async ({ mutate }) => {
    const transport = JSON.stringify({
      pageData: {
        grid: {
          GRIDRESULT: {
            GRID: {
              DATA: [
                {
                  groupbookingreferencenumber: 'G-100',
                  status: 'Tentative',
                  startdate: '01-SEP-2026',
                  enddate: '03-SEP-2026',
                },
              ],
            },
          },
        },
      },
    });
    const auditSpec = auditSpecForReceipt();
    const receipt = completeReceiptFor(auditSpec);
    mutate(receipt);
    const result = await createLiveGroupBlockDriver({
      runtime: groupRuntimeForReceipt(transport, receipt) as never,
      transportId: 'transport-u15',
      auditSpec,
      propertyReadLock: testPropertyReadLock(),
    }).observeGroupBlockContext(auth(), candidate(), new AbortController().signal);

    expect(result.status).toBe('manual_required');
    expect(result.data?.summary).toMatchObject({ state: 'unavailable' });
    expect(result.evidence[0]?.scopeVerified).toBe(false);
  });

  it('rejects stale / cross-tool / unknown branch / hash mismatch', async () => {
    const signal = new AbortController().signal;
    await expect(
      observeGroupBlockAggregate(
        auth({ expiresAt: new Date(Date.now() - 1000).toISOString() }),
        candidate(),
        signal,
      ),
    ).rejects.toBeInstanceOf(HmsRuntimeError);

    await expect(
      observeGroupBlockAggregate(auth({ toolId: 'hms_event_read' as never }), candidate(), signal),
    ).rejects.toBeInstanceOf(HmsRuntimeError);

    await expect(
      observeGroupBlockAggregate(
        auth({ requestBranchId: 'event_list' as never }),
        candidate(),
        signal,
      ),
    ).rejects.toBeInstanceOf(HmsRuntimeError);

    await expect(
      observeGroupBlockAggregate(
        auth(),
        candidate({ exactGroupReferenceHash: '0'.repeat(64) }),
        signal,
      ),
    ).rejects.toBeInstanceOf(HmsRuntimeError);
  });

  it('denies rooming / edit / save actions in registry policy', () => {
    for (const action of GROUP_BLOCK_READ_PRIVACY_POLICY.deniedActions) {
      expect(READ_TOOLS.hms_group_block_read.deniedActions).toContain(action);
    }
  });

  it('authors aggregate-list manifest for observed GSGRPB.LST surface', () => {
    const path = join(
      process.cwd(),
      'src/hms/request-manifests/hms_group_block_read.aggregate-list.1.0.0.json',
    );
    expect(existsSync(path)).toBe(true);
    // Live promote stays false until con/blk/pickup/remaining proven list-only.
    expect(READ_TOOLS.hms_group_block_read.promotionEvidence.discovery).toBe(false);
    expect(READ_TOOLS.hms_group_block_read.promotionEvidence.live).toBe(false);
  });

  it('observations cannot self-assert requester trust fields', async () => {
    const result = await observeGroupBlockAggregate(
      auth(),
      candidate(),
      new AbortController().signal,
    );
    const serialized = JSON.stringify(result);
    expect(serialized).not.toMatch(/authorized_group_contact|third_party|unknown/);
    expect(serialized).not.toMatch(/existing_group_status|claimEligibility/);
  });
});

import { createHash, randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  createLiveGroupBlockDriver,
  GROUP_BLOCK_AGGREGATE_COUNTS_BLOCKER,
  observeGroupBlockAggregate,
} from '../src/hms/live-group-block-driver.js';
import {
  GROUP_BLOCK_READ_PRIVACY_POLICY,
} from '../src/hms/group-block-read-contract.js';
import {
  parseGroupReadCandidateFromAuthoredSegment,
  type GroupReadCandidate,
} from '../src/hms/group-read-candidate.js';
import type { HmsSessionAuthorization } from '../src/hms/release-kernel.js';
import { HmsRuntimeError } from '../src/hms/runtime.js';
import { READ_TOOLS } from '../src/hms/read-tools.js';
import { buildLiveGroupBlockListManifest } from '../src/hms/live-read-manifest.js';
import { existsSync } from 'node:fs';
import { join } from 'node:path';

const ORIGIN = 'https://appsrv-1.legacyhotels.co.za';

function auth(
  overrides: Partial<HmsSessionAuthorization> = {},
): HmsSessionAuthorization {
  const manifest = buildLiveGroupBlockListManifest(ORIGIN);
  return {
    operationId: randomUUID(),
    toolId: 'hms_group_block_read',
    discoveryOperationId: 'group_block_list',
    releaseId: randomUUID(),
    requestBranchId: 'group_block_list',
    manifest,
    manifestSha256: createHash('sha256')
      .update(JSON.stringify(manifest))
      .digest('hex'),
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

function candidate(
  overrides: Partial<GroupReadCandidate> = {},
): GroupReadCandidate {
  const parsed = parseGroupReadCandidateFromAuthoredSegment(
    'Please check group block G-100 status start 2026-09-01 end 2026-09-03',
  );
  if (!parsed) throw new Error('fixture candidate parse failed');
  return { ...parsed, ...overrides };
}

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
      parseGroupReadCandidateFromAuthoredSegment(
        'group G-1 start 2026-01-01 end 2026-03-15',
      ),
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
  it('fail-closes with BLOCKED_GROUP_BLOCK_AGGREGATE_COUNTS_UNPROVEN', async () => {
    const driver = createLiveGroupBlockDriver();
    const result = await driver.observeGroupBlockAggregate(
      auth(),
      candidate(),
      new AbortController().signal,
    );
    expect(result.status).toBe('manual_required');
    expect(result.unresolvedFields).toContain(
      GROUP_BLOCK_AGGREGATE_COUNTS_BLOCKER,
    );
    expect(JSON.stringify(result)).not.toContain('recipientClass');
    expect(JSON.stringify(result)).not.toContain('inquiryClass');
    expect(JSON.stringify(result)).not.toContain('contactfirstname');
    expect(JSON.stringify(result)).not.toContain('rooming');
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
      observeGroupBlockAggregate(
        auth({ toolId: 'hms_event_read' as never }),
        candidate(),
        signal,
      ),
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
    expect(READ_TOOLS.hms_group_block_read.promotionEvidence.discovery).toBe(
      false,
    );
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

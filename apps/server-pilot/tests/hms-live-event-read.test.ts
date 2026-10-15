import { createHash, randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  createLiveEventReadDriver,
  EVENT_READ_SURFACE_BLOCKER,
  observeEventListSummary,
} from '../src/hms/live-event-read-driver.js';
import {
  EVENT_READ_PRIVACY_POLICY,
} from '../src/hms/event-read-contract.js';
import {
  parseEventReadCandidateFromAuthoredSegment,
  type EventReadCandidate,
} from '../src/hms/event-read-candidate.js';
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
  // Placeholder chrome-only manifest — event surface unproven; auth still typed.
  const manifest = buildLiveGroupBlockListManifest(ORIGIN);
  return {
    operationId: randomUUID(),
    toolId: 'hms_event_read',
    discoveryOperationId: 'event_list',
    releaseId: randomUUID(),
    requestBranchId: 'event_list',
    manifest,
    manifestSha256: createHash('sha256')
      .update(JSON.stringify(manifest))
      .digest('hex'),
    roleProofPath: '/tmp/role-proof-event.v2.json',
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
  overrides: Partial<EventReadCandidate> = {},
): EventReadCandidate {
  const parsed = parseEventReadCandidateFromAuthoredSegment(
    'Please check event confirmation E-500 status',
  );
  if (!parsed) throw new Error('fixture candidate parse failed');
  return { ...parsed, ...overrides };
}

describe('event read candidate parser', () => {
  it('parses exact event reference', () => {
    const c = parseEventReadCandidateFromAuthoredSegment(
      'event reservation E-500 please confirm',
    );
    expect(c?.exactEventReference).toBe('E-500');
    expect(c?.exactEventReferenceHash).toMatch(/^[a-f0-9]{64}$/);
  });

  it('rejects zero / multiple candidates', () => {
    expect(parseEventReadCandidateFromAuthoredSegment('hello')).toBeNull();
    expect(
      parseEventReadCandidateFromAuthoredSegment(
        'event E-1 and event confirmation E-2',
      ),
    ).toBeNull();
  });

  it('rejects oversized authored segments', () => {
    expect(
      parseEventReadCandidateFromAuthoredSegment(
        `${'x'.repeat(20_000)} event E-1`,
      ),
    ).toBeNull();
  });
});

describe('live event list summary (blocked surface)', () => {
  it('fail-closes with BLOCKED_EVENT_READ_SURFACE_UNPROVEN', async () => {
    const driver = createLiveEventReadDriver();
    const result = await driver.observeEventListSummary(
      auth(),
      candidate(),
      new AbortController().signal,
    );
    expect(result.status).toBe('manual_required');
    expect(result.unresolvedFields).toContain(EVENT_READ_SURFACE_BLOCKER);
    expect(JSON.stringify(result)).not.toContain('recipientClass');
    expect(JSON.stringify(result)).not.toContain('inquiryClass');
    expect(JSON.stringify(result)).not.toContain('contactName');
    expect(JSON.stringify(result)).not.toContain('notes');
  });

  it('binds blocked evidence to the explicit property', async () => {
    const result = await createLiveEventReadDriver('DVIN').observeEventListSummary(
      auth(),
      candidate(),
      new AbortController().signal,
    );

    expect(result.evidence?.propertyCode).toBe('DVIN');
  });

  it('rejects stale / cross-tool / unknown branch / hash mismatch', async () => {
    const signal = new AbortController().signal;
    await expect(
      observeEventListSummary(
        auth({ expiresAt: new Date(Date.now() - 1000).toISOString() }),
        candidate(),
        signal,
      ),
    ).rejects.toBeInstanceOf(HmsRuntimeError);

    await expect(
      observeEventListSummary(
        auth({ toolId: 'hms_group_block_read' as never }),
        candidate(),
        signal,
      ),
    ).rejects.toBeInstanceOf(HmsRuntimeError);

    await expect(
      observeEventListSummary(
        auth({ requestBranchId: 'group_block_list' as never }),
        candidate(),
        signal,
      ),
    ).rejects.toBeInstanceOf(HmsRuntimeError);

    await expect(
      observeEventListSummary(
        auth(),
        candidate({ exactEventReferenceHash: '0'.repeat(64) }),
        signal,
      ),
    ).rejects.toBeInstanceOf(HmsRuntimeError);
  });

  it('denies contact / detail / mutation actions in registry policy', () => {
    for (const action of EVENT_READ_PRIVACY_POLICY.deniedActions) {
      expect(READ_TOOLS.hms_event_read.deniedActions).toContain(action);
    }
  });

  it('does not author event-list manifest while surface absent', () => {
    const path = join(
      process.cwd(),
      'src/hms/request-manifests/hms_event_read.event-list.1.0.0.json',
    );
    expect(existsSync(path)).toBe(false);
    expect(READ_TOOLS.hms_event_read.promotionEvidence.discovery).toBe(false);
    expect(READ_TOOLS.hms_event_read.promotionEvidence.live).toBe(false);
  });

  it('observations cannot self-assert requester trust fields', async () => {
    const result = await observeEventListSummary(
      auth(),
      candidate(),
      new AbortController().signal,
    );
    const serialized = JSON.stringify(result);
    expect(serialized).not.toMatch(/authorized_event_contact|third_party|unknown/);
    expect(serialized).not.toMatch(/existing_event_status|claimEligibility/);
  });
});

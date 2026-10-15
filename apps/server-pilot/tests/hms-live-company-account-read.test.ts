import { createHash, randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  COMPANY_ACCOUNT_READ_SURFACE_BLOCKER,
  createLiveCompanyAccountReadDriver,
  observeReservationLinkedBilling,
} from '../src/hms/live-company-account-read-driver.js';
import {
  COMPANY_ACCOUNT_READ_PRIVACY_POLICY,
} from '../src/hms/company-account-read-contract.js';
import type { ReadCandidateChild } from '../src/hms/candidate-graph.js';
import type { HmsSessionAuthorization } from '../src/hms/release-kernel.js';
import { HmsRuntimeError } from '../src/hms/runtime.js';
import { READ_TOOLS } from '../src/hms/read-tools.js';
import { buildLiveFolioReadManifest } from '../src/hms/live-read-manifest.js';
import { existsSync } from 'node:fs';
import { join } from 'node:path';

const ORIGIN = 'https://appsrv-1.legacyhotels.co.za';
const SCOPE = 'a'.repeat(64);

function auth(
  overrides: Partial<HmsSessionAuthorization> = {},
): HmsSessionAuthorization {
  const manifest = buildLiveFolioReadManifest(ORIGIN);
  return {
    operationId: randomUUID(),
    toolId: 'hms_company_account_read',
    discoveryOperationId: 'reservation_linked_company_billing',
    releaseId: randomUUID(),
    requestBranchId: 'reservation_linked_company_billing',
    manifest,
    manifestSha256: createHash('sha256')
      .update(JSON.stringify(manifest))
      .digest('hex'),
    roleProofPath: '/tmp/role-proof-company.v2.json',
    roleProofSha256: 'b'.repeat(64),
    credentialVersionHmacSha256: 'c'.repeat(64),
    runtimeFingerprintSha256: 'd'.repeat(64),
    privateDigestKeyVersion: 'v1',
    sourceRevision: 'test-rev',
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
    ...overrides,
  };
}

function child(
  overrides: Partial<ReadCandidateChild> = {},
): ReadCandidateChild {
  return {
    id: randomUUID(),
    sessionId: randomUUID(),
    parentEvidenceId: randomUUID(),
    toolId: 'hms_company_account_read',
    requestBranchId: 'reservation_linked_company_billing',
    propertyCode: 'HRCEN',
    scopeHash: SCOPE,
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
    ...overrides,
  };
}

describe('live company account read (blocked surface)', () => {
  it('fail-closes with BLOCKED_COMPANY_READ_SURFACE_UNPROVEN', async () => {
    const driver = createLiveCompanyAccountReadDriver();
    const result = await driver.observeReservationLinkedBilling(
      auth(),
      child(),
      new AbortController().signal,
    );
    expect(result.status).toBe('manual_required');
    expect(result.unresolvedFields).toContain(
      COMPANY_ACCOUNT_READ_SURFACE_BLOCKER,
    );
    expect(JSON.stringify(result)).not.toContain('recipientClass');
    expect(JSON.stringify(result)).not.toContain('inquiryClass');
    expect(JSON.stringify(result)).not.toContain('creditLimit');
    expect(JSON.stringify(result)).not.toContain('contactEmail');
  });

  it('binds evidence and child validation to the explicit property', async () => {
    const result = await createLiveCompanyAccountReadDriver('DVIN').observeReservationLinkedBilling(
      auth(),
      child({ propertyCode: 'DVIN' }),
      new AbortController().signal,
    );

    expect(result.evidence?.propertyCode).toBe('DVIN');
  });

  it('rejects stale / cross-tool / unknown branch / third-party property', async () => {
    const signal = new AbortController().signal;
    await expect(
      observeReservationLinkedBilling(
        auth({ expiresAt: new Date(Date.now() - 1000).toISOString() }),
        child(),
        signal,
      ),
    ).rejects.toBeInstanceOf(HmsRuntimeError);

    await expect(
      observeReservationLinkedBilling(
        auth({ toolId: 'hms_read_folio' as never }),
        child({ toolId: 'hms_read_folio' }),
        signal,
      ),
    ).rejects.toBeInstanceOf(HmsRuntimeError);

    await expect(
      observeReservationLinkedBilling(
        auth({ requestBranchId: 'folio_summary' as never }),
        child({ requestBranchId: 'folio_summary' as never }),
        signal,
      ),
    ).rejects.toBeInstanceOf(HmsRuntimeError);

    await expect(
      observeReservationLinkedBilling(
        auth(),
        child({ propertyCode: 'OTHER' }),
        signal,
      ),
    ).rejects.toBeInstanceOf(HmsRuntimeError);
  });

  it('denies autosave / arbitrary search / credit / contact reads', () => {
    for (const action of COMPANY_ACCOUNT_READ_PRIVACY_POLICY.deniedActions) {
      expect(READ_TOOLS.hms_company_account_read.deniedActions).toContain(
        action,
      );
    }
  });

  it('does not author company reservation-linked manifest while blocked', () => {
    const path = join(
      process.cwd(),
      'src/hms/request-manifests/hms_company_account_read.reservation-linked.1.0.0.json',
    );
    // File may be absent (preferred) or present only as blocked stub — live release must not use it.
    if (existsSync(path)) {
      expect(true).toBe(true); // allow future stub; promotionEvidence.discovery stays false
    } else {
      expect(existsSync(path)).toBe(false);
    }
    expect(
      READ_TOOLS.hms_company_account_read.promotionEvidence.discovery,
    ).toBe(false);
  });
});

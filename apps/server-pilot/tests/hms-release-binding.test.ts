import {
  assertFinancePromotionEligible,
  buildFinanceRelease,
  financeArtifactSha256,
  financeReleaseManifestSha256,
} from '../scripts/materialize-finance-release.js';
import {
  HMS_RUNTIME_ABI_VERSION,
  emptyActiveRegistryV2,
  hmsPortfolioToolReleaseV2Schema,
  type HmsSessionAuthorization,
} from '../src/hms/release-kernel.js';
import {
  assertQuotePromotionEligible,
  assertHotelAvailabilityManifest,
  buildQuoteRelease,
  quoteArtifactSha256,
} from '../scripts/materialize-quote-release-v2.js';
import {
  parseReviewedManifestEnvelope,
  reviewedManifestSha256,
} from '../src/hms/release-manifest-binding.js';
import {
  buildLiveDepositLedgerManifest,
  buildLiveFolioReadManifest,
} from '../src/hms/live-read-manifest.js';
import { FOLIO_READ_IMPL_V1, createReadToolHandler } from '../src/hms/read-handler-index.js';
import { fingerprintReadToolRegistry } from '../src/hms/read-tools.js';
import { createHash, randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const ORIGIN = 'https://appsrv-1.legacyhotels.co.za';
const HEX = 'a'.repeat(64);

const HOTEL_AVAILABILITY_MANIFEST = JSON.stringify({
  schemaVersion: 1,
  surface: 'hotel_availability',
  functionName: 'OSMPAV',
  openPath: '/web/base/OSMPAV',
  openMethod: 'POST',
  openBody: { FUNCTION_CLASS: 'WEBL' },
  searchPath: '/web/base/OSMPAV.search',
  method: 'POST',
  contentType: 'application/x-www-form-urlencoded',
  noWrite: true,
  fixedBody: {},
  fields: {
    property: 'property',
    arrival: 'arrival',
    departure: 'departure',
    nights: 'nights',
    currency: 'currency',
    adults: 'adults',
    children: 'children',
    childAges: 'childAges',
    roomGroups: 'rooms',
  },
  roomEncoding: 'json',
  response: {
    rowsPath: 'result.rows',
    datePath: 'date',
    roomTypePath: 'roomType',
    ratePlanPath: 'ratePlan',
    availableCountPath: 'available',
    amountPath: 'amount',
    currencyPath: 'currency',
    restrictionsPath: 'restrictions',
  },
  discoveryEvidenceSha256: HEX,
  discoveredAt: '2026-09-16T00:00:00.000Z',
});

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function envelopePath(name: string): string {
  return join(process.cwd(), 'src/hms/request-manifests', name);
}

function releaseFor(manifestSha256: string) {
  return hmsPortfolioToolReleaseV2Schema.parse({
    schemaVersion: 2,
    releaseId: randomUUID(),
    toolsetVersion: '3.0.0',
    toolsetFingerprint: fingerprintReadToolRegistry(),
    sourceRevision: 'test-revision',
    phaseAPlanSha256: HEX,
    phaseBPlanSha256: HEX,
    gateSha256: HEX,
    runtimeAbiVersion: HMS_RUNTIME_ABI_VERSION,
    runtimeFingerprintSha256: HEX,
    requesterPolicySha256: HEX,
    privateDigestKeyVersion: 'v1',
    liveProofSha256: HEX,
    receiptSha256: HEX,
    qualification: 'live_verified',
    shadowSha256: null,
    evidenceKind: 'hms',
    toolId: 'hms_read_folio',
    toolVersion: '1.0.0',
    implementationSha256: FOLIO_READ_IMPL_V1,
    predecessorReleaseId: null,
    rollbackAction: 'disable',
    requestBranches: [
      {
        id: 'folio_summary',
        discoveryOperationId: 'folio_summary',
        manifestSha256,
        discoverySha256: HEX,
        parserSchemaSha256: HEX,
      },
    ],
    credentialVersionHmacSha256: HEX,
    roleProofSha256: HEX,
  });
}

function authorization(
  release: ReturnType<typeof releaseFor>,
  manifest: HmsSessionAuthorization['manifest'],
): HmsSessionAuthorization {
  return {
    operationId: randomUUID(),
    toolId: 'hms_read_folio',
    discoveryOperationId: 'folio_summary',
    releaseId: release.releaseId,
    requestBranchId: 'folio_summary',
    manifest,
    manifestSha256: release.requestBranches[0]!.manifestSha256,
    roleProofPath: '/private/proof',
    roleProofSha256: HEX,
    credentialVersionHmacSha256: HEX,
    runtimeFingerprintSha256: release.runtimeFingerprintSha256,
    privateDigestKeyVersion: release.privateDigestKeyVersion,
    sourceRevision: release.sourceRevision,
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
  };
}

function authorizationForTool(
  release: ReturnType<typeof buildQuoteRelease>,
  toolId: 'hms_quote_stay' | 'hms_read_folio',
  branchId: string,
  discoveryOperationId: 'quote_availability_search' | 'folio_summary' | 'deposit_ledger_summary',
  manifest: HmsSessionAuthorization['manifest'],
): HmsSessionAuthorization {
  const branch = release.requestBranches.find((candidate) => candidate.id === branchId);
  return {
    operationId: randomUUID(),
    toolId,
    discoveryOperationId,
    releaseId: release.releaseId,
    requestBranchId: branchId,
    manifest,
    manifestSha256: branch?.manifestSha256 ?? release.requestBranches[0]!.manifestSha256,
    roleProofPath: '/private/proof',
    roleProofSha256: release.roleProofSha256,
    credentialVersionHmacSha256: HEX,
    runtimeFingerprintSha256: release.runtimeFingerprintSha256,
    privateDigestKeyVersion: release.privateDigestKeyVersion,
    sourceRevision: release.sourceRevision,
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
  };
}

describe('reviewed release manifest binding', () => {
  it('hashes the exact nested runtime payload, not the envelope bytes', () => {
    const raw = readFileSync(envelopePath('hms_read_folio.folio.1.0.0.json'), 'utf8');
    const parsed = JSON.parse(raw) as { manifest: unknown };
    const manifest = parseReviewedManifestEnvelope(raw, {
      toolId: 'hms_read_folio',
      toolVersion: '1.0.0',
      discoveryOperationId: 'folio_summary',
    });

    expect(
      reviewedManifestSha256(raw, {
        toolId: 'hms_read_folio',
        toolVersion: '1.0.0',
        discoveryOperationId: 'folio_summary',
      }),
    ).toBe(sha256(JSON.stringify(parsed.manifest)));
    expect(
      reviewedManifestSha256(raw, {
        toolId: 'hms_read_folio',
        toolVersion: '1.0.0',
        discoveryOperationId: 'folio_summary',
      }),
    ).toBe(sha256(JSON.stringify(manifest)));
    expect(
      reviewedManifestSha256(raw, {
        toolId: 'hms_read_folio',
        toolVersion: '1.0.0',
        discoveryOperationId: 'folio_summary',
      }),
    ).not.toBe(sha256(raw));
  });

  it('rejects altered envelope metadata and payload before a release can bind it', () => {
    const raw = readFileSync(envelopePath('hms_read_folio.folio.1.0.0.json'), 'utf8');
    const envelope = JSON.parse(raw) as Record<string, unknown>;
    const manifest = envelope.manifest as { rules: Array<Record<string, unknown>> };
    manifest.rules[0] = { ...manifest.rules[0], path: '/altered' };
    const altered = JSON.stringify(envelope);

    expect(() =>
      parseReviewedManifestEnvelope(altered, {
        toolId: 'hms_read_folio',
        toolVersion: '1.0.0',
        discoveryOperationId: 'folio_summary',
      }),
    ).not.toThrow();
    expect(
      reviewedManifestSha256(altered, {
        toolId: 'hms_read_folio',
        toolVersion: '1.0.0',
        discoveryOperationId: 'folio_summary',
      }),
    ).not.toBe(
      reviewedManifestSha256(raw, {
        toolId: 'hms_read_folio',
        toolVersion: '1.0.0',
        discoveryOperationId: 'folio_summary',
      }),
    );
  });

  it('matches the runtime folio builders for both reviewed OSRESS/OSLEDG payloads', () => {
    const folioRaw = readFileSync(envelopePath('hms_read_folio.folio.1.0.0.json'), 'utf8');
    const depositRaw = readFileSync(
      envelopePath('hms_read_folio.deposit-ledger.1.0.0.json'),
      'utf8',
    );
    expect(
      reviewedManifestSha256(folioRaw, {
        toolId: 'hms_read_folio',
        toolVersion: '1.0.0',
        discoveryOperationId: 'folio_summary',
      }),
    ).toBe(sha256(JSON.stringify(buildLiveFolioReadManifest(ORIGIN))));
    expect(
      reviewedManifestSha256(depositRaw, {
        toolId: 'hms_read_folio',
        toolVersion: '1.0.0',
        discoveryOperationId: 'deposit_ledger_summary',
      }),
    ).toBe(sha256(JSON.stringify(buildLiveDepositLedgerManifest(ORIGIN))));
  });

  it('recomputes the authorization manifest at the handler boundary', () => {
    const manifest = buildLiveFolioReadManifest(ORIGIN);
    const digest = sha256(JSON.stringify(manifest));
    const release = releaseFor(digest);
    const auth = authorization(release, manifest);
    expect(createReadToolHandler(release, auth).toolId).toBe('hms_read_folio');

    const altered = {
      ...manifest,
      rules: manifest.rules.map((rule, index) =>
        index === 0 ? { ...rule, path: '/altered' } : rule,
      ),
    };
    expect(() => createReadToolHandler(release, { ...auth, manifest: altered })).toThrow(
      /manifest.*digest|manifest.*binding/i,
    );
  });

  it('keeps superseded OSRRAV out of quote materialization', async () => {
    const registry = emptyActiveRegistryV2({
      toolsetVersion: '3.0.0',
      toolsetFingerprint: fingerprintReadToolRegistry(),
    });
    const findRelease = releaseFor(HEX);
    const quoteRaw = readFileSync(envelopePath('hms_quote_stay.availability.2.0.0.json'), 'utf8');
    expect(() =>
      buildQuoteRelease({
        registry,
        findRelease,
        sourceRevision: 'local-materializer-test',
        runtimeFingerprintSha256: HEX,
        manifestRaw: quoteRaw,
        liveProofSha256: HEX,
        receiptSha256: HEX,
        releaseId: randomUUID(),
      }),
    ).toThrow('BLOCKED_QUOTE_MANIFEST_NOT_HOTEL_AVAILABILITY');

    const folioRaw = readFileSync(envelopePath('hms_read_folio.folio.1.0.0.json'), 'utf8');
    const depositRaw = readFileSync(
      envelopePath('hms_read_folio.deposit-ledger.1.0.0.json'),
      'utf8',
    );
    const financeRelease = buildFinanceRelease({
      registry,
      findRelease,
      sourceRevision: 'local-materializer-test',
      runtimeFingerprintSha256: HEX,
      folioManifestRaw: folioRaw,
      depositManifestRaw: depositRaw,
      liveProofSha256: HEX,
      receiptSha256: HEX,
      releaseId: randomUUID(),
    });

    for (const branch of [
      {
        raw: folioRaw,
        branchId: 'folio_summary' as const,
      },
      {
        raw: depositRaw,
        branchId: 'deposit_ledger_summary' as const,
      },
    ]) {
      const envelope = JSON.parse(branch.raw) as {
        manifest: HmsSessionAuthorization['manifest'];
      };
      const releaseBranch = financeRelease.requestBranches.find(
        (candidate) => candidate.id === branch.branchId,
      );
      expect(releaseBranch?.manifestSha256).toBe(
        financeReleaseManifestSha256(branch.raw, branch.branchId),
      );
      expect(
        createReadToolHandler(
          financeRelease,
          authorizationForTool(
            financeRelease,
            'hms_read_folio',
            branch.branchId,
            branch.branchId,
            envelope.manifest,
          ),
        ).toolId,
      ).toBe('hms_read_folio');
      const alteredManifest = {
        ...envelope.manifest,
        rules: envelope.manifest.rules.map((rule, index) =>
          index === 0 ? { ...rule, path: `/altered-${branch.branchId}` } : rule,
        ),
      };
      expect(() =>
        createReadToolHandler(
          financeRelease,
          authorizationForTool(
            financeRelease,
            'hms_read_folio',
            branch.branchId,
            branch.branchId,
            alteredManifest,
          ),
        ),
      ).toThrow(/manifest.*digest|manifest.*binding/i);
    }

    expect(() => assertQuotePromotionEligible()).toThrow(
      'BLOCKED_LIVE_PROOF_NOT_PROMOTION_ELIGIBLE',
    );
    expect(() =>
      assertHotelAvailabilityManifest(HOTEL_AVAILABILITY_MANIFEST),
    ).not.toThrow();
    expect(() =>
      assertHotelAvailabilityManifest(
        JSON.stringify({
          surface: 'room_type_rate_availability',
          functionName: 'OSRRAV',
          searchPath: '/room-type-rate-availability',
        }),
      ),
    ).toThrow('BLOCKED_QUOTE_MANIFEST_NOT_HOTEL_AVAILABILITY');
    expect(() => assertHotelAvailabilityManifest('{not-json')).toThrow(
      'BLOCKED_QUOTE_MANIFEST_INVALID_JSON',
    );
    expect(() => assertFinancePromotionEligible()).toThrow(
      'BLOCKED_LIVE_PROOF_NOT_PROMOTION_ELIGIBLE',
    );
    await expect(quoteArtifactSha256(undefined, 'HMS_QUOTE_LIVE_PROOF')).rejects.toThrow(
      'HMS_QUOTE_LIVE_PROOF_REQUIRED',
    );
    await expect(financeArtifactSha256('', 'HMS_FOLIO_FINALIZED_RECEIPT')).rejects.toThrow(
      'HMS_FOLIO_FINALIZED_RECEIPT_REQUIRED',
    );
  });
});

/**
 * Phase B action-specific preflight — named blockers / ready codes, no AWS/HMS.
 */
import {
  mkdtempSync,
  chmodSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { READ_TOOLS } from '../src/hms/read-tools.js';
import {
  formatPhaseBPreflightOkLine,
  formatPhaseBPreflightWaitLine,
  phaseBPreflightJsonRecord,
  runPhaseBReadPreflight,
} from '../src/ops/phase-b-read-preflight.js';

const sha = (n: number | string) => String(n).repeat(64).slice(0, 64);

function validRoleProofV2(
  toolId: 'hms_find_reservation' | 'hms_quote_stay' | 'hms_read_folio' = 'hms_find_reservation',
  now = new Date(),
) {
  const tool = READ_TOOLS[toolId];
  const issuedAt = new Date(now.getTime() - 60_000).toISOString();
  const expiresAt = new Date(now.getTime() + 86_400_000).toISOString();
  return {
    schemaVersion: 2 as const,
    attestationKind: 'operator_observed_runtime' as const,
    toolId,
    discoveryOperationId: tool.discoveryOperationIds[0]!,
    operationId: randomUUID(),
    observerSourceRevision: 'abc1234',
    evidenceArtifactId: randomUUID(),
    privateDigestKeyVersion: 'v1',
    actorHmacSha256: sha(1),
    credentialVersionHmacSha256: sha(2),
    runtimeFingerprintSha256: sha(3),
    roleFingerprintSha256: sha(4),
    propertyCode: 'HRCEN' as const,
    currency: 'ZAR' as const,
    credentialMode: 'view_only' as const,
    allowedSurfaces: [
      ...new Set(tool.requestBranches.flatMap((b) => b.requiredRoleSurfaces)),
    ],
    deniedActions: [...tool.deniedActions],
    issuedAt,
    expiresAt,
    evidenceSha256: sha(5),
  };
}

function validReviewedManifest() {
  return {
    rules: [
      {
        id: 'guest-stay-search',
        origin: 'https://hms.example.invalid',
        method: 'POST' as const,
        path: '/web/base/OSRESS.search',
        resourceTypes: ['xhr'],
        fixedQuery: {},
        variableQuery: {},
        fixedBody: {},
        variableBody: {},
        maxBodyBytes: 4096,
        redirectPolicy: 'same-reviewed-chain' as const,
      },
    ],
  };
}

describe('phase-b-read-preflight', () => {
  const roots: string[] = [];

  afterEach(() => {
    for (const root of roots.splice(0)) {
      rmSync(root, { recursive: true, force: true });
    }
  });

  function tempRoot(): string {
    const root = mkdtempSync(join(tmpdir(), 'phase-b-preflight-'));
    roots.push(root);
    return root;
  }

  function writeJson(path: string, value: unknown): string {
    writeFileSync(path, `${JSON.stringify(value)}\n`, { mode: 0o444 });
    try {
      chmodSync(path, 0o444);
    } catch {
      // Windows may ignore mode bits; preflight still rejects writable when detectable.
    }
    return path;
  }

  it('rejects unknown tool ids', () => {
    const result = runPhaseBReadPreflight({
      action: 'read-discovery',
      toolId: 'hms_not_a_tool',
    });
    expect(result).toMatchObject({
      ok: false,
      code: 'BLOCKED_UNKNOWN_TOOL',
      exitCode: 3,
    });
    expect(formatPhaseBPreflightWaitLine(result.code as 'BLOCKED_UNKNOWN_TOOL')).toBe(
      'HMS_WAIT code=BLOCKED_UNKNOWN_TOOL',
    );
  });

  it('rejects mail_read_artifact for discovery and proof', () => {
    expect(
      runPhaseBReadPreflight({
        action: 'read-discovery',
        toolId: 'mail_read_artifact',
      }).code,
    ).toBe('BLOCKED_MAIL_ARTIFACT_DISCOVERY');
    expect(
      runPhaseBReadPreflight({
        action: 'read-proof',
        toolId: 'mail_read_artifact',
      }).code,
    ).toBe('BLOCKED_MAIL_ARTIFACT_PROOF');
  });

  it('discovery is non-circular: sealed fixture + bootstrap → DISCOVERY_READY without role-proof/manifest', () => {
    const result = runPhaseBReadPreflight({
      action: 'read-discovery',
      toolId: 'hms_quote_stay',
      roleProofV2Path: null,
      reviewedRequestManifestPath: null,
    });
    expect(result).toMatchObject({
      ok: true,
      code: 'DISCOVERY_READY',
      exitCode: 0,
      toolId: 'hms_quote_stay',
      capabilityState: 'fixture_verified',
    });
    expect(formatPhaseBPreflightOkLine('DISCOVERY_READY')).toBe(
      'HMS_OK code=DISCOVERY_READY',
    );
    const json = phaseBPreflightJsonRecord(result);
    expect(json).toMatchObject({
      schemaVersion: 1,
      outcome: 'ok',
      stage: 'preflight',
      code: 'DISCOVERY_READY',
      exitCode: 0,
      retryable: false,
    });
  });

  it('discovery ready for demoted find (fixture_verified, no prior discovery digest)', () => {
    const result = runPhaseBReadPreflight({
      action: 'read-discovery',
      toolId: 'hms_find_reservation',
    });
    expect(result).toMatchObject({
      ok: true,
      code: 'DISCOVERY_READY',
      capabilityState: 'fixture_verified',
      exitCode: 0,
    });
  });

  it('proof requires role-proof-v2 (updated schema)', () => {
    expect(
      runPhaseBReadPreflight({
        action: 'read-proof',
        toolId: 'hms_quote_stay',
        roleProofV2Path: null,
      }).code,
    ).toBe('BLOCKED_NO_ROLE_PROOF_V2');

    const root = tempRoot();
    const staleV1Shape = writeJson(join(root, 'stale.json'), {
      schemaVersion: 2,
      actorDigest: sha(1),
      propertyCode: 'HRCEN',
      currency: 'ZAR',
      credentialMode: 'view_only',
      allowedSurfaces: ['Guest Stay'],
      deniedActions: ['save'],
      issuedAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + 86_400_000).toISOString(),
      evidenceSha256: sha(2),
    });
    expect(
      runPhaseBReadPreflight({
        action: 'read-proof',
        toolId: 'hms_quote_stay',
        roleProofV2Path: staleV1Shape,
      }).code,
    ).toBe('BLOCKED_NO_ROLE_PROOF_V2');
  });

  it('rejects symlink role-proof paths for proof', () => {
    const root = tempRoot();
    const real = writeJson(
      join(root, 'real.json'),
      validRoleProofV2('hms_find_reservation'),
    );
    const link = join(root, 'link.json');
    try {
      symlinkSync(real, link);
    } catch {
      return;
    }
    expect(
      runPhaseBReadPreflight({
        action: 'read-proof',
        toolId: 'hms_find_reservation',
        roleProofV2Path: link,
        reviewedRequestManifestPath: writeJson(
          join(root, 'manifest.json'),
          validReviewedManifest(),
        ),
        discoveryEvidencePresent: true,
        driverAndControlsReady: true,
      }).code,
    ).toBe('BLOCKED_NO_ROLE_PROOF_V2');
  });

  it('returns BLOCKED_ROLE_PROOF_V2_INSECURE for writable role-proof files', () => {
    const root = tempRoot();
    const path = join(root, 'writable-role.json');
    writeFileSync(path, `${JSON.stringify(validRoleProofV2('hms_quote_stay'))}\n`, {
      mode: 0o600,
    });
    try {
      chmodSync(path, 0o600);
    } catch {
      // ignore
    }
    const result = runPhaseBReadPreflight({
      action: 'read-proof',
      toolId: 'hms_quote_stay',
      roleProofV2Path: path,
      reviewedRequestManifestPath: null,
    });
    expect(['BLOCKED_ROLE_PROOF_V2_INSECURE', 'BLOCKED_NO_ROLE_PROOF_V2']).toContain(
      result.code,
    );
  });

  it('proof requires reviewed manifest after valid role-proof-v2', () => {
    const root = tempRoot();
    const role = writeJson(
      join(root, 'role-v2.json'),
      validRoleProofV2('hms_quote_stay'),
    );
    const result = runPhaseBReadPreflight({
      action: 'read-proof',
      toolId: 'hms_quote_stay',
      roleProofV2Path: role,
      reviewedRequestManifestPath: null,
    });
    expect(result).toMatchObject({
      ok: false,
      code: 'BLOCKED_NO_REVIEWED_REQUEST_MANIFEST',
      exitCode: 3,
    });
  });

  it('proof requires discovery evidence + driver/controls; never PHASE_B_BLOCKED', () => {
    const root = tempRoot();
    const role = writeJson(
      join(root, 'role-v2.json'),
      validRoleProofV2('hms_find_reservation'),
    );
    const manifest = writeJson(
      join(root, 'manifest.json'),
      validReviewedManifest(),
    );
    expect(
      runPhaseBReadPreflight({
        action: 'read-proof',
        toolId: 'hms_find_reservation',
        roleProofV2Path: role,
        reviewedRequestManifestPath: manifest,
      }).code,
    ).toBe('BLOCKED_NO_DISCOVERY_EVIDENCE');

    expect(
      runPhaseBReadPreflight({
        action: 'read-proof',
        toolId: 'hms_find_reservation',
        roleProofV2Path: role,
        reviewedRequestManifestPath: manifest,
        discoveryEvidencePresent: true,
        driverAndControlsReady: false,
      }).code,
    ).toBe('BLOCKED_NO_DRIVER_OR_CONTROLS');

    const ready = runPhaseBReadPreflight({
      action: 'read-proof',
      toolId: 'hms_find_reservation',
      roleProofV2Path: role,
      reviewedRequestManifestPath: manifest,
      discoveryEvidencePresent: true,
      driverAndControlsReady: true,
    });
    expect(ready).toMatchObject({
      ok: true,
      code: 'PROOF_READY',
      exitCode: 0,
      capabilityState: 'fixture_verified',
    });
    expect(ready.code).not.toBe('PHASE_B_BLOCKED');
  });

  it('promote needs immutable release + loadable handler only', () => {
    expect(
      runPhaseBReadPreflight({
        action: 'read-promote',
        toolId: 'hms_event_read',
        roleProofV2Path: null,
      }).code,
    ).toBe('BLOCKED_NO_IMMUTABLE_RELEASE');

    expect(
      runPhaseBReadPreflight({
        action: 'read-promote',
        toolId: 'hms_event_read',
        immutableReleaseReady: true,
        loadableHandlerReady: false,
      }).code,
    ).toBe('BLOCKED_NO_LOADABLE_HANDLER');

    expect(
      runPhaseBReadPreflight({
        action: 'read-promote',
        toolId: 'hms_event_read',
        immutableReleaseReady: true,
        loadableHandlerReady: true,
      }),
    ).toMatchObject({
      ok: true,
      code: 'PROMOTE_READY',
      exitCode: 0,
    });
  });

  it('rollback needs only active registry (ignores missing live evidence)', () => {
    expect(
      runPhaseBReadPreflight({
        action: 'read-rollback',
        toolId: 'hms_group_block_read',
        roleProofV2Path: null,
        reviewedRequestManifestPath: null,
      }).code,
    ).toBe('BLOCKED_NO_ACTIVE_REGISTRY');

    expect(
      runPhaseBReadPreflight({
        action: 'read-rollback',
        toolId: 'hms_group_block_read',
        activeRegistryReady: true,
        roleProofV2Path: null,
        reviewedRequestManifestPath: null,
      }),
    ).toMatchObject({
      ok: true,
      code: 'ROLLBACK_READY',
      exitCode: 0,
    });
  });
});

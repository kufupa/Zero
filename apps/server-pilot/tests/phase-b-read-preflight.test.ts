/**
 * Phase B read preflight — named blockers, no AWS/HMS.
 */
import {
  mkdirSync,
  mkdtempSync,
  chmodSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  formatPhaseBPreflightWaitLine,
  phaseBPreflightJsonRecord,
  runPhaseBReadPreflight,
} from '../src/ops/phase-b-read-preflight.js';

const sha = (n: number) => n.toString().repeat(64).slice(0, 64);

function validRoleProofV2(now = new Date()) {
  const issuedAt = new Date(now.getTime() - 60_000).toISOString();
  const expiresAt = new Date(now.getTime() + 86_400_000).toISOString();
  return {
    schemaVersion: 2 as const,
    actorDigest: sha(1),
    propertyCode: 'HRCEN',
    currency: 'ZAR',
    credentialMode: 'view_only' as const,
    allowedSurfaces: ['Guest Stay'],
    deniedActions: ['save', 'submit'],
    issuedAt,
    expiresAt,
    evidenceSha256: sha(2),
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
      roleProofV2Path: '/nope',
      reviewedRequestManifestPath: '/nope',
    });
    expect(result).toMatchObject({
      ok: false,
      code: 'BLOCKED_UNKNOWN_TOOL',
      exitCode: 3,
    });
    expect(formatPhaseBPreflightWaitLine(result.code)).toBe(
      'HMS_WAIT code=BLOCKED_UNKNOWN_TOOL',
    );
  });

  it('rejects mail_read_artifact for read-discovery', () => {
    const result = runPhaseBReadPreflight({
      action: 'read-discovery',
      toolId: 'mail_read_artifact',
    });
    expect(result).toMatchObject({
      ok: false,
      code: 'BLOCKED_MAIL_ARTIFACT_DISCOVERY',
      exitCode: 3,
    });
  });

  it('returns BLOCKED_NO_ROLE_PROOF_V2 when path absent (current reality)', () => {
    const result = runPhaseBReadPreflight({
      action: 'read-discovery',
      toolId: 'hms_quote_stay',
      roleProofV2Path: null,
      reviewedRequestManifestPath: null,
    });
    expect(result).toMatchObject({
      ok: false,
      code: 'BLOCKED_NO_ROLE_PROOF_V2',
      exitCode: 3,
      toolId: 'hms_quote_stay',
    });
  });

  it('returns BLOCKED_NO_ROLE_PROOF_V2 for missing file path', () => {
    const root = tempRoot();
    const result = runPhaseBReadPreflight({
      action: 'read-proof',
      toolId: 'hms_find_reservation',
      roleProofV2Path: join(root, 'missing-role-proof-v2.json'),
      reviewedRequestManifestPath: join(root, 'missing-manifest.json'),
    });
    expect(result.code).toBe('BLOCKED_NO_ROLE_PROOF_V2');
  });

  it('returns BLOCKED_NO_ROLE_PROOF_V2 for invalid or expired proof', () => {
    const root = tempRoot();
    const bad = writeJson(join(root, 'bad.json'), { schemaVersion: 1 });
    expect(
      runPhaseBReadPreflight({
        action: 'read-discovery',
        toolId: 'hms_read_folio',
        roleProofV2Path: bad,
      }).code,
    ).toBe('BLOCKED_NO_ROLE_PROOF_V2');

    const expired = writeJson(join(root, 'expired.json'), {
      ...validRoleProofV2(new Date('2020-01-01T00:00:00.000Z')),
      issuedAt: '2019-12-01T00:00:00.000Z',
      expiresAt: '2019-12-31T00:00:00.000Z',
    });
    expect(
      runPhaseBReadPreflight({
        action: 'read-discovery',
        toolId: 'hms_read_folio',
        roleProofV2Path: expired,
        now: new Date('2026-08-06T00:00:00.000Z'),
      }).code,
    ).toBe('BLOCKED_NO_ROLE_PROOF_V2');
  });

  it('rejects symlink role-proof paths', () => {
    const root = tempRoot();
    const real = writeJson(join(root, 'real.json'), validRoleProofV2());
    const link = join(root, 'link.json');
    try {
      symlinkSync(real, link);
    } catch {
      // Windows may require elevation for symlinks — skip soft.
      return;
    }
    expect(
      runPhaseBReadPreflight({
        action: 'read-discovery',
        toolId: 'hms_find_reservation',
        roleProofV2Path: link,
        reviewedRequestManifestPath: writeJson(
          join(root, 'manifest.json'),
          validReviewedManifest(),
        ),
      }).code,
    ).toBe('BLOCKED_NO_ROLE_PROOF_V2');
  });

  it('returns BLOCKED_ROLE_PROOF_V2_INSECURE for writable role-proof files', () => {
    const root = tempRoot();
    const path = join(root, 'writable-role.json');
    writeFileSync(path, `${JSON.stringify(validRoleProofV2())}\n`, {
      mode: 0o600,
    });
    try {
      chmodSync(path, 0o600);
    } catch {
      // ignore
    }
    const result = runPhaseBReadPreflight({
      action: 'read-discovery',
      toolId: 'hms_quote_stay',
      roleProofV2Path: path,
      reviewedRequestManifestPath: null,
    });
    // Windows may not retain unix write bits — accept insecure or missing-style fail-closed.
    expect(['BLOCKED_ROLE_PROOF_V2_INSECURE', 'BLOCKED_NO_ROLE_PROOF_V2']).toContain(
      result.code,
    );
  });

  it('returns BLOCKED_NO_REVIEWED_REQUEST_MANIFEST after valid role-proof-v2', () => {
    const root = tempRoot();
    const role = writeJson(join(root, 'role-v2.json'), validRoleProofV2());
    const result = runPhaseBReadPreflight({
      action: 'read-discovery',
      toolId: 'hms_company_account_read',
      roleProofV2Path: role,
      reviewedRequestManifestPath: null,
    });
    expect(result).toMatchObject({
      ok: false,
      code: 'BLOCKED_NO_REVIEWED_REQUEST_MANIFEST',
      exitCode: 3,
    });
  });

  it('returns BLOCKED_TOOL_FIXTURE_ONLY for fixture_verified tools with evidence', () => {
    const root = tempRoot();
    const role = writeJson(join(root, 'role-v2.json'), validRoleProofV2());
    const manifest = writeJson(
      join(root, 'manifest.json'),
      validReviewedManifest(),
    );
    const result = runPhaseBReadPreflight({
      action: 'read-discovery',
      toolId: 'hms_quote_stay',
      roleProofV2Path: role,
      reviewedRequestManifestPath: manifest,
    });
    expect(result).toMatchObject({
      ok: false,
      code: 'BLOCKED_TOOL_FIXTURE_ONLY',
      exitCode: 3,
      toolId: 'hms_quote_stay',
    });
  });

  it('returns PHASE_B_BLOCKED only after evidence passes for live_verified tool', () => {
    const root = tempRoot();
    const role = writeJson(join(root, 'role-v2.json'), validRoleProofV2());
    const manifest = writeJson(
      join(root, 'manifest.json'),
      validReviewedManifest(),
    );
    const result = runPhaseBReadPreflight({
      action: 'read-discovery',
      toolId: 'hms_find_reservation',
      roleProofV2Path: role,
      reviewedRequestManifestPath: manifest,
    });
    expect(result).toMatchObject({
      ok: true,
      code: 'PHASE_B_BLOCKED',
      exitCode: 3,
      toolId: 'hms_find_reservation',
      capabilityState: 'live_verified',
    });
    const json = phaseBPreflightJsonRecord(result);
    expect(json).toMatchObject({
      schemaVersion: 1,
      outcome: 'wait',
      stage: 'preflight',
      code: 'PHASE_B_BLOCKED',
      exitCode: 3,
      toolId: 'hms_find_reservation',
      retryable: false,
    });
  });

  it('covers promote and rollback with same evidence order', () => {
    const result = runPhaseBReadPreflight({
      action: 'read-promote',
      toolId: 'hms_event_read',
      roleProofV2Path: '',
    });
    expect(result.code).toBe('BLOCKED_NO_ROLE_PROOF_V2');

    const root = tempRoot();
    mkdirSync(root, { recursive: true });
    const role = writeJson(join(root, 'role-v2.json'), validRoleProofV2());
    expect(
      runPhaseBReadPreflight({
        action: 'read-rollback',
        toolId: 'hms_group_block_read',
        roleProofV2Path: role,
        reviewedRequestManifestPath: join(root, 'absent-manifest.json'),
      }).code,
    ).toBe('BLOCKED_NO_REVIEWED_REQUEST_MANIFEST');
  });
});

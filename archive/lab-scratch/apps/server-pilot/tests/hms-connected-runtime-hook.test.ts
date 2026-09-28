import {
  connectedProofBindingSidecarSchema,
  loadConnectedRoleProof,
  validateConnectedSessionAuthorization,
} from '../src/hms/connected-proof-binding.js';
import { createFetchBrowserFactory, createHmsRuntime, type HmsSecret } from '../../../../../apps/server-pilot/src/hms/runtime.js';
import { requestPolicyManifestSchema, requestRuleSchema } from '../../../../../apps/server-pilot/src/hms/contracts.js';
import { FIXTURE_IDS, startHmsFixtureServer } from '../../../../../apps/server-pilot/tests/helpers/hms-fixture-server.js';
import { buildLiveGuestStayReadManifest } from '../../../../../apps/server-pilot/src/hms/live-read-manifest.js';
import type { HmsSessionAuthorization } from '../../../../../apps/server-pilot/src/hms/release-kernel.js';
import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const PROOF_DENIED_ACTIONS = [
  'new_record',
  'save',
  'delete',
  'duplicate',
  'check_in',
  'check_out',
  'document_generate',
  'document_send',
] as const;

function proofBytes(proof: unknown): Buffer {
  return Buffer.from(`${JSON.stringify(proof)}\n`);
}

async function writeProtectedProof(path: string, bytes: Buffer): Promise<void> {
  await chmod(path, 0o644).catch(() => undefined);
  await writeFile(path, bytes, { mode: 0o444 });
  await chmod(path, 0o444);
}

function singleContextManifest(origin: string) {
  return requestPolicyManifestSchema.parse({
    rules: [
      requestRuleSchema.parse({
        id: 'login-page',
        origin,
        method: 'GET',
        path: '/login',
        resourceTypes: ['document'],
        redirectPolicy: 'same-reviewed-chain',
      }),
      requestRuleSchema.parse({
        id: 'login-session',
        origin,
        method: 'POST',
        path: '/session',
        resourceTypes: ['document'],
        contentType: 'application/x-www-form-urlencoded',
        variableBody: {
          username: { pattern: '.{1,64}', maxLength: 64 },
          password: { pattern: '.{1,128}', maxLength: 128 },
        },
        redirectPolicy: 'same-reviewed-chain',
      }),
      requestRuleSchema.parse({
        id: 'property-page',
        origin,
        method: 'GET',
        path: '/property',
        resourceTypes: ['document'],
        redirectPolicy: 'same-reviewed-chain',
      }),
    ],
  });
}

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe('connected proof runtime hook', () => {
  it('revalidates the supplied sidecar authorization before creating a context', async () => {
    const server = await startHmsFixtureServer();
    const secret: HmsSecret = {
      loginUrl: `${server.origin}/login`,
      username: 'fixture-user',
      password: 'fixture-password',
      expectedTenant: FIXTURE_IDS.tenant,
      expectedPropertyCode: FIXTURE_IDS.propertyCode,
      expectedPropertyName: FIXTURE_IDS.propertyName,
      mailboxTransportId: FIXTURE_IDS.transportId,
      credentialMode: 'view_only',
    };
    const manifest = requestPolicyManifestSchema.parse({
      rules: [
        requestRuleSchema.parse({
          id: 'login-page',
          origin: server.origin,
          method: 'GET',
          path: '/login',
          resourceTypes: ['document'],
          redirectPolicy: 'same-reviewed-chain',
        }),
      ],
    });
    let checks = 0;
    const runtime = createHmsRuntime({
      manifest,
      secretArn: 'arn:aws:secretsmanager:eu-west-1:000000000000:secret:fixture-hook',
      loadSecret: async () => secret,
      browserFactory: createFetchBrowserFactory(),
      runStartupCanary: false,
      requireSessionAuthorization: true,
      validateSessionAuthorization: async () => {
        checks += 1;
        const error = new Error('proof digest mismatch');
        Object.assign(error, { code: 'CONNECTED_PROOF_HASH_MISMATCH' });
        throw error;
      },
    });
    try {
      await runtime.start(AbortSignal.timeout(5_000));
      await expect(
        runtime.openReadSession({
          transportId: secret.mailboxTransportId,
          signal: AbortSignal.timeout(5_000),
          sessionAuthorization: {
            operationId: 'connected-op',
            toolId: 'hms_find_reservation',
            discoveryOperationId: 'guest_stay_search',
            releaseId: 'connected-binding-test',
            requestBranchId: 'guest_stay_search',
            manifest,
            manifestSha256: 'a'.repeat(64),
            roleProofPath: '/private/role-proof.json',
            roleProofSha256: 'b'.repeat(64),
            credentialVersionHmacSha256: 'c'.repeat(64),
            runtimeFingerprintSha256: 'd'.repeat(64),
            privateDigestKeyVersion: 'test-key',
            sourceRevision: 'test-source',
            expiresAt: new Date(Date.now() + 60_000).toISOString(),
          },
        }),
      ).rejects.toMatchObject({ code: 'CONNECTED_PROOF_HASH_MISMATCH' });
      expect(checks).toBe(1);
      expect(runtime.stats().contextsCreated).toBe(0);
    } finally {
      await runtime.close().catch(() => undefined);
      await server.close();
    }
  });

  it('revalidates connected authorization after property verification in single-context login', async () => {
    vi.stubEnv('HMS_SINGLE_CONTEXT_LOGIN', '1');
    const server = await startHmsFixtureServer();
    const secret: HmsSecret = {
      loginUrl: `${server.origin}/login`,
      username: 'fixture-user',
      password: 'fixture-password',
      expectedTenant: FIXTURE_IDS.tenant,
      expectedPropertyCode: FIXTURE_IDS.propertyCode,
      expectedPropertyName: FIXTURE_IDS.propertyName,
      mailboxTransportId: FIXTURE_IDS.transportId,
      credentialMode: 'view_only',
    };
    const manifest = singleContextManifest(server.origin);
    let checks = 0;
    const runtime = createHmsRuntime({
      manifest,
      secretArn: 'arn:aws:secretsmanager:eu-west-1:000000000000:secret:fixture-hook-single',
      loadSecret: async () => secret,
      browserFactory: createFetchBrowserFactory(),
      runStartupCanary: false,
      requireSessionAuthorization: true,
      validateSessionAuthorization: async () => {
        checks += 1;
        if (checks === 3) {
          const error = new Error('proof digest mismatch after authentication');
          Object.assign(error, { code: 'CONNECTED_PROOF_HASH_MISMATCH' });
          throw error;
        }
      },
    });
    try {
      await runtime.start(AbortSignal.timeout(5_000));
      const outcome = await runtime
        .openReadSession({
          transportId: secret.mailboxTransportId,
          signal: AbortSignal.timeout(10_000),
          sessionAuthorization: {
            operationId: 'connected-single-context-op',
            toolId: 'hms_find_reservation',
            discoveryOperationId: 'guest_stay_search',
            releaseId: 'connected-binding-test',
            requestBranchId: 'guest_stay_search',
            manifest,
            manifestSha256: 'a'.repeat(64),
            roleProofPath: '/private/role-proof.json',
            roleProofSha256: 'b'.repeat(64),
            credentialVersionHmacSha256: 'c'.repeat(64),
            runtimeFingerprintSha256: 'd'.repeat(64),
            privateDigestKeyVersion: 'test-key',
            sourceRevision: 'test-source',
            expiresAt: new Date(Date.now() + 60_000).toISOString(),
          },
        })
        .then(
          async (session) => {
            await session.close();
            return 'resolved' as const;
          },
          (error) => error,
        );
      expect(outcome).toMatchObject({ code: 'CONNECTED_PROOF_HASH_MISMATCH' });
      expect(checks).toBe(3);
      expect(server.requests.map((request) => request.path)).toContain('/property');
    } finally {
      await runtime.close().catch(() => undefined);
      await server.close();
    }
  });

  it('hands the validated proof snapshot to the fixture runtime loader across path replacement', async () => {
    vi.stubEnv('HMS_SINGLE_CONTEXT_LOGIN', '1');
    const server = await startHmsFixtureServer({ shape: 'live-infor' });
    const root = await mkdtemp(join(tmpdir(), 'hms-connected-runtime-proof-'));
    const proofPath = join(root, 'role-proof.json');
    const issuedAt = new Date(Date.now() - 60_000).toISOString();
    const expiresAt = new Date(Date.now() + 60_000).toISOString();
    const proof = {
      schemaVersion: 1,
      propertyCode: 'HRCEN',
      allowedSurfaces: ['Guest Stay'],
      deniedActions: PROOF_DENIED_ACTIONS,
      issuedAt,
      expiresAt,
      evidenceRef: 'proof-evidence:runtime-wiring-original',
      evidenceSha256: 'e'.repeat(64),
    } as const;
    const replacement = {
      ...proof,
      evidenceRef: 'proof-evidence:runtime-wiring-replacement',
    };
    const originalBytes = proofBytes(proof);
    const replacementBytes = proofBytes(replacement);
    const proofSha256 = createHash('sha256').update(originalBytes).digest('hex');
    const manifest = buildLiveGuestStayReadManifest(server.origin);
    const secret: HmsSecret = {
      loginUrl: `${server.origin}/web/base/logindisp?tenant=HMS_LEGACY`,
      username: 'fixture-user',
      password: 'fixture-password',
      expectedTenant: FIXTURE_IDS.tenant,
      expectedPropertyCode: FIXTURE_IDS.livePropertyCode,
      expectedPropertyName: FIXTURE_IDS.propertyName,
      mailboxTransportId: FIXTURE_IDS.transportId,
      credentialMode: 'view_only',
    };
    const binding = connectedProofBindingSidecarSchema.parse({
      schemaVersion: 'hms-connected-proof-binding/v1',
      mode: 'pre_promotion',
      bindingId: 'connected-runtime-wiring-test',
      propertyCode: 'HRCEN',
      bundleSourceFingerprintSha256: '9'.repeat(64),
      secretVersionId: 'fixture-runtime-wiring-secret',
      credentialVersionHmacSha256: 'c'.repeat(64),
      runtimeFingerprintSha256: 'd'.repeat(64),
      privateDigestKeyVersion: 'fixture-runtime-wiring-key',
      sourceRevision: 'fixture-runtime-wiring-source',
      find: { schemaVersion: 1, roleProofPath: proofPath, roleProofSha256: proofSha256 },
    });
    const authorization: HmsSessionAuthorization = {
      operationId: 'connected-runtime-wiring-op',
      toolId: 'hms_find_reservation',
      discoveryOperationId: 'guest_stay_search',
      releaseId: 'connected-runtime-wiring-test',
      requestBranchId: 'guest_stay_search',
      manifest,
      manifestSha256: 'a'.repeat(64),
      roleProofPath: proofPath,
      roleProofSha256: proofSha256,
      credentialVersionHmacSha256: 'c'.repeat(64),
      runtimeFingerprintSha256: 'd'.repeat(64),
      privateDigestKeyVersion: 'fixture-runtime-wiring-key',
      sourceRevision: 'fixture-runtime-wiring-source',
      expiresAt,
    };
    await writeFile(proofPath, originalBytes, { mode: 0o444 });
    await chmod(proofPath, 0o444);
    let validationCalls = 0;
    let loaderCalls = 0;
    let replacementPending = false;
    let replacedPathLoadEvidenceRef: string | undefined;
    const loadedEvidenceRefs: string[] = [];
    const runtime = createHmsRuntime({
      manifest,
      secretArn: 'arn:aws:secretsmanager:eu-west-1:000000000000:secret:fixture-runtime-wiring',
      loadSecret: async () => secret,
      browserFactory: createFetchBrowserFactory(),
      runStartupCanary: false,
      requireSessionAuthorization: true,
      roleProofPath: proofPath,
      loadRoleProof: async (path, now) => {
        loaderCalls += 1;
        try {
          const loaded = await loadConnectedRoleProof(binding, path, now);
          loadedEvidenceRefs.push(loaded.evidenceRef);
          if (replacementPending) replacedPathLoadEvidenceRef = loaded.evidenceRef;
          return loaded;
        } finally {
          if (replacementPending) {
            await writeProtectedProof(proofPath, originalBytes);
            replacementPending = false;
          }
        }
      },
      validateSessionAuthorization: async (auth) => {
        validationCalls += 1;
        await validateConnectedSessionAuthorization({
          binding,
          authorization: auth,
        });
        if (validationCalls === 1) {
          await writeProtectedProof(proofPath, replacementBytes);
          replacementPending = true;
        }
      },
    });
    try {
      await runtime.start(AbortSignal.timeout(5_000));
      const session = await runtime.openReadSession({
        transportId: secret.mailboxTransportId,
        signal: AbortSignal.timeout(10_000),
        sessionAuthorization: authorization,
      });
      await session.close();
      expect(validationCalls).toBe(3);
      expect(loaderCalls).toBeGreaterThanOrEqual(validationCalls);
      expect(loadedEvidenceRefs).toHaveLength(loaderCalls);
      expect(loadedEvidenceRefs).toEqual(
        Array.from({ length: loaderCalls }, () => proof.evidenceRef),
      );
      expect(replacedPathLoadEvidenceRef).toBe(proof.evidenceRef);
      expect(replacementPending).toBe(false);
      await expect(readFile(proofPath)).resolves.toEqual(originalBytes);
      expect(server.requests.map((request) => request.path)).toContain('/web/base/COMMON');
    } finally {
      await runtime.close().catch(() => undefined);
      await server.close();
      await rm(root, { recursive: true, force: true });
    }
  });
});

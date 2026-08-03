/**
 * Production HMS runtime composition — Playwright is a hard runtime dependency.
 * No fetch/mock browser factory fallback. Role-proof revalidated per context.
 */
import { readFile } from 'node:fs/promises';
import { chromium } from 'playwright';
import {
  GetSecretValueCommand,
  SecretsManagerClient,
} from '@aws-sdk/client-secrets-manager';
import { z } from 'zod';
import type { HmsWorkerRuntimeConfig } from '../env.js';
import { buildLiveGuestStayReadManifest } from './live-read-manifest.js';
import {
  createHmsRuntime,
  createPlaywrightBrowserFactory,
  hmsSecretSchema,
  HmsRuntimeError,
  type HmsRuntime,
  type HmsSecretLoader,
} from './runtime.js';

const DENIED_ACTIONS = [
  'new_record',
  'save',
  'delete',
  'duplicate',
  'check_in',
  'check_out',
  'document_generate',
  'document_send',
] as const;

export const hmsReadRoleProofV1Schema = z
  .object({
    schemaVersion: z.literal(1),
    propertyCode: z.literal('HRCEN'),
    allowedSurfaces: z.tuple([z.literal('Guest Stay')]),
    deniedActions: z.tuple([
      z.literal('new_record'),
      z.literal('save'),
      z.literal('delete'),
      z.literal('duplicate'),
      z.literal('check_in'),
      z.literal('check_out'),
      z.literal('document_generate'),
      z.literal('document_send'),
    ]),
    issuedAt: z.string().datetime(),
    expiresAt: z.string().datetime(),
    evidenceRef: z.string().min(1),
    evidenceSha256: z.string().regex(/^[a-f0-9]{64}$/i),
  })
  .strict();

export type HmsReadRoleProofV1 = z.infer<typeof hmsReadRoleProofV1Schema>;

const MAX_PROOF_TTL_MS = 30 * 24 * 60 * 60 * 1000;

export async function loadHmsReadRoleProof(
  path: string,
  now: Date = new Date(),
): Promise<HmsReadRoleProofV1> {
  let raw: string;
  try {
    raw = await readFile(path, 'utf8');
  } catch {
    throw new HmsRuntimeError(
      'ROLE_PROOF_MISSING',
      `role proof missing at ${path}`,
    );
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new HmsRuntimeError('ROLE_SCOPE_INVALID', 'role proof JSON invalid');
  }
  let proof: HmsReadRoleProofV1;
  try {
    proof = hmsReadRoleProofV1Schema.parse(parsed);
  } catch {
    throw new HmsRuntimeError('ROLE_SCOPE_INVALID', 'role proof schema invalid');
  }
  const issued = Date.parse(proof.issuedAt);
  const expires = Date.parse(proof.expiresAt);
  if (!Number.isFinite(issued) || !Number.isFinite(expires)) {
    throw new HmsRuntimeError('ROLE_SCOPE_INVALID', 'role proof dates invalid');
  }
  if (expires < now.getTime()) {
    throw new HmsRuntimeError('ROLE_PROOF_EXPIRED', 'role proof expired');
  }
  if (expires - issued > MAX_PROOF_TTL_MS) {
    throw new HmsRuntimeError('ROLE_SCOPE_INVALID', 'role proof TTL exceeds 30d');
  }
  if (proof.propertyCode !== 'HRCEN') {
    throw new HmsRuntimeError('ROLE_SCOPE_INVALID', 'role proof property mismatch');
  }
  for (const action of DENIED_ACTIONS) {
    if (!proof.deniedActions.includes(action)) {
      throw new HmsRuntimeError(
        'ROLE_SCOPE_INVALID',
        'role proof deniedActions incomplete',
      );
    }
  }
  if (!proof.allowedSurfaces.includes('Guest Stay')) {
    throw new HmsRuntimeError('ROLE_SCOPE_INVALID', 'role proof surface invalid');
  }
  return proof;
}

function createSecretsManagerLoader(region?: string): HmsSecretLoader {
  return async ({ secretArn, signal: _signal }) => {
    void _signal;
    const client = new SecretsManagerClient({
      region: region ?? process.env.AWS_REGION ?? 'af-south-1',
    });
    const res = await client.send(
      new GetSecretValueCommand({ SecretId: secretArn }),
    );
    if (!res.SecretString) {
      throw new HmsRuntimeError('secret_load_failed', 'secret empty');
    }
    return hmsSecretSchema.parse(JSON.parse(res.SecretString));
  };
}

/**
 * Production composition: Playwright Chromium required; role-proof path wired;
 * live Guest Stay manifest from secret login origin.
 */
export async function createProductionHmsRuntime(
  config: HmsWorkerRuntimeConfig,
  options?: {
    loadSecret?: HmsSecretLoader;
    region?: string;
  },
): Promise<HmsRuntime> {
  // Fail closed if Playwright Chromium cannot launch with configured binary.
  // createPlaywrightBrowserFactory launches again on first session — accept
  // one startup probe so missing binary fails before secret work continues.
  try {
    const probe = await chromium.launch({
      executablePath: config.chromiumExecutablePath,
      headless: true,
    });
    await probe.close();
  } catch (err) {
    throw new HmsRuntimeError(
      'chromium_failed',
      err instanceof Error ? err.message.slice(0, 120) : 'chromium unavailable',
    );
  }

  await loadHmsReadRoleProof(config.roleProofPath);

  const loadSecret =
    options?.loadSecret ?? createSecretsManagerLoader(options?.region);
  const rawSecret = await loadSecret({ secretArn: config.secretArn });
  const secret = hmsSecretSchema.parse(rawSecret);
  const origin = new URL(secret.loginUrl).origin;

  if (secret.expectedPropertyCode !== config.expectedPropertyCode) {
    throw new HmsRuntimeError(
      'PROPERTY_MISMATCH',
      'secret property does not match worker config',
    );
  }
  if (secret.expectedTenant !== config.expectedTenant) {
    throw new HmsRuntimeError(
      'PROPERTY_MISMATCH',
      'secret tenant does not match worker config',
    );
  }
  if (secret.mailboxTransportId !== config.expectedTransportId) {
    throw new HmsRuntimeError(
      'transport_mismatch',
      'secret transport does not match worker config',
    );
  }

  const browserFactory = createPlaywrightBrowserFactory();

  // Legacy /reservations canary is fixture-shaped and POLICY_BLOCK on live
  // OSRESS-only manifest. Readiness = LiveGuestStayDriver.runNotFoundCanary.
  return createHmsRuntime({
    manifest: buildLiveGuestStayReadManifest(origin),
    secretArn: config.secretArn,
    loadSecret: async () => secret,
    browserFactory,
    executablePath: config.chromiumExecutablePath,
    healthStatusPath: config.healthPath,
    circuitCooldownMs: config.circuitCooldownMs,
    defaultTimeoutMs: Math.min(15_000, config.runDeadlineMs),
    requireViewOnly: true,
    expectedOrigin: origin,
    roleProofPath: config.roleProofPath,
    loadRoleProof: loadHmsReadRoleProof,
    healthHeartbeatMs: 10_000,
    healthStaleAfterMs: 30_000,
    runStartupCanary: false,
  });
}

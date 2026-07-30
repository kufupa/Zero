/**
 * Abort-first HMS read discovery (builder-only).
 * Default: fixture mode. Live requires HMS_DISCOVERY_ALLOW_LIVE=1 (tests never set).
 * No write-form phase. Blocked unknown request → redacted signature + nonzero exit.
 */

import { unlink, writeFile } from 'node:fs/promises';
import { z } from 'zod';
import {
  requestPolicyManifestSchema,
  type RequestDecision,
  type RequestPolicyManifest,
} from '../src/hms/contracts.js';
import {
  createFetchBrowserFactory,
  createHmsRuntime,
  hmsSecretSchema,
  type HmsSecret,
  type HmsSecretLoader,
  type BrowserFactory,
} from '../src/hms/runtime.js';
import { evaluateObservedRequest } from '../src/hms/request-policy.js';

export const discoveryPhaseSchema = z.enum([
  'login',
  'reservation-search',
  'room-availability',
  'display-rates',
]);

export type DiscoveryPhase = z.infer<typeof discoveryPhaseSchema>;

export type RedactedDiscoveryObservation = {
  method: string;
  origin: string;
  path: string;
  resourceType: string;
  queryKeys: string[];
  bodyKeys: string[];
  bodyBytes: number;
  contentType?: string;
};

/** Structural fingerprint only — never raw query/body/credential values. */
export function sanitizeDiscoveryObservation(input: {
  method: string;
  url: string;
  resourceType?: string;
  contentType?: string;
  body?: string | null;
}): RedactedDiscoveryObservation {
  const url = new URL(input.url);
  const body = input.body ?? '';
  const contentType = input.contentType?.split(';', 1)[0]?.trim();
  let bodyKeys: string[] = [];
  if (
    body &&
    (contentType === 'application/x-www-form-urlencoded' || !contentType)
  ) {
    bodyKeys = [...new URLSearchParams(body).keys()].sort();
  } else if (body && contentType === 'application/json') {
    try {
      const parsed = JSON.parse(body) as Record<string, unknown>;
      bodyKeys = Object.keys(parsed).sort();
    } catch {
      bodyKeys = [];
    }
  }
  return {
    method: input.method.toUpperCase(),
    origin: url.origin,
    path: url.pathname,
    resourceType: input.resourceType ?? 'document',
    queryKeys: [...url.searchParams.keys()].sort(),
    bodyKeys,
    bodyBytes: Buffer.byteLength(body),
    contentType,
  };
}

export type DiscoveryResult = {
  phase: DiscoveryPhase;
  ok: true;
  structure: Record<string, unknown>;
  observations: RedactedDiscoveryObservation[];
};

export type DiscoveryBlockResult = {
  phase: DiscoveryPhase;
  ok: false;
  blocked: {
    code: string;
    redactedSignature: RequestDecision extends { action: 'block' }
      ? Extract<RequestDecision, { action: 'block' }>['redactedSignature']
      : never;
  };
};

export async function removeStaleDiscoveryOutput(path: string): Promise<void> {
  try {
    await unlink(path);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code !== 'ENOENT') throw err;
  }
}

export async function writeDiscoveryOutputAtomic(
  path: string,
  payload: unknown,
): Promise<void> {
  const tmp = `${path}.${process.pid}.tmp`;
  await writeFile(tmp, JSON.stringify(payload, null, 2), { mode: 0o600 });
  const { rename } = await import('node:fs/promises');
  await rename(tmp, path);
}

function assertFixtureOrAllowedLive(mode: 'fixture' | 'live'): void {
  if (mode === 'fixture') return;
  if (process.env.HMS_DISCOVERY_ALLOW_LIVE !== '1') {
    throw new Error(
      'live discovery refused: set HMS_DISCOVERY_ALLOW_LIVE=1 (orchestrator only)',
    );
  }
}

export type RunDiscoveryInput = {
  phase: DiscoveryPhase;
  manifest: RequestPolicyManifest;
  secret: HmsSecret;
  outputPath: string;
  mode?: 'fixture' | 'live';
  browserFactory?: BrowserFactory;
  loadSecret?: HmsSecretLoader;
  secretArn?: string;
  signal?: AbortSignal;
  /** When true, issue one unknown GET and persist redacted block (exit path). */
  probeUnknown?: boolean;
};

export async function runDiscovery(
  input: RunDiscoveryInput,
): Promise<DiscoveryResult | DiscoveryBlockResult> {
  const mode = input.mode ?? 'fixture';
  assertFixtureOrAllowedLive(mode);

  await removeStaleDiscoveryOutput(input.outputPath);

  const secretArn = input.secretArn ?? 'arn:aws:secretsmanager:local:000000000000:secret:fixture';
  const loadSecret: HmsSecretLoader =
    input.loadSecret ??
    (async () => {
      // Never call real SM from default fixture path
      return input.secret;
    });

  const browserFactory =
    input.browserFactory ?? createFetchBrowserFactory();
  const signal = input.signal ?? AbortSignal.timeout(60_000);

  const runtime = createHmsRuntime({
    manifest: input.manifest,
    secretArn,
    loadSecret,
    browserFactory,
    requireViewOnly: false, // discovery may use audited_write secret for observation
    expectedOrigin: new URL(input.secret.loginUrl).origin,
  });

  const observations: RedactedDiscoveryObservation[] = [];

  try {
    await runtime.start(signal);
    const session = await runtime.openReadSession({
      transportId: input.secret.mailboxTransportId,
      signal,
    });

    try {
      const origin = session.origin;
      observations.push(
        sanitizeDiscoveryObservation({
          method: 'GET',
          url: input.secret.loginUrl,
          resourceType: 'document',
        }),
      );

      if (input.phase === 'login') {
        const binding = await session.page.readPropertyBinding();
        const structure = {
          propertyTextMatched:
            binding.tenant === input.secret.expectedTenant &&
            binding.propertyCode === input.secret.expectedPropertyCode &&
            binding.propertyName === input.secret.expectedPropertyName,
          tenantPresent: Boolean(binding.tenant),
          propertyCodePresent: Boolean(binding.propertyCode),
        };
        const result: DiscoveryResult = {
          phase: input.phase,
          ok: true,
          structure,
          observations,
        };
        await writeDiscoveryOutputAtomic(input.outputPath, result);
        return result;
      }

      if (input.phase === 'reservation-search') {
        const url = `${origin}/reservations`;
        await session.page.goto(url);
        observations.push(
          sanitizeDiscoveryObservation({
            method: 'GET',
            url,
            resourceType: 'document',
          }),
        );
        const html = await session.page.content();
        const structure = {
          hasSearchForm: /id="reservation-search"/i.test(html),
          fieldNames: [...html.matchAll(/name="([^"]+)"/g)].map((m) => m[1]),
        };

        if (input.probeUnknown) {
          const unknown = `${origin}/unknown/discovery-probe`;
          try {
            await session.page.goto(unknown);
          } catch {
            /* expected block */
          }
          const decision = evaluateObservedRequest(input.manifest, {
            url: unknown,
            method: 'GET',
            resourceType: 'document',
          });
          const blockedDecision =
            session.violation()?.action === 'block'
              ? session.violation()
              : decision;
          if (blockedDecision && blockedDecision.action === 'block') {
            const blocked: DiscoveryBlockResult = {
              phase: input.phase,
              ok: false,
              blocked: {
                code: blockedDecision.code,
                redactedSignature: blockedDecision.redactedSignature,
              },
            };
            await writeDiscoveryOutputAtomic(input.outputPath, blocked);
            return blocked;
          }
        }

        const result: DiscoveryResult = {
          phase: input.phase,
          ok: true,
          structure,
          observations,
        };
        await writeDiscoveryOutputAtomic(input.outputPath, result);
        return result;
      }

      if (input.phase === 'room-availability') {
        const url = `${origin}/availability/rooms?view=inventory&startDate=2099-01-01`;
        await session.page.goto(url);
        observations.push(
          sanitizeDiscoveryObservation({
            method: 'GET',
            url,
            resourceType: 'document',
          }),
        );
        const html = await session.page.content();
        const result: DiscoveryResult = {
          phase: input.phase,
          ok: true,
          structure: {
            hasInventory: /data-testid="inventory"/i.test(html),
            fieldNames: [...html.matchAll(/name="([^"]+)"/g)].map((m) => m[1]),
          },
          observations,
        };
        await writeDiscoveryOutputAtomic(input.outputPath, result);
        return result;
      }

      // display-rates
      const url = `${origin}/availability/rates`;
      await session.page.goto(url);
      observations.push(
        sanitizeDiscoveryObservation({
          method: 'GET',
          url,
          resourceType: 'document',
        }),
      );
      const html = await session.page.content();
      const result: DiscoveryResult = {
        phase: input.phase,
        ok: true,
        structure: {
          hasRates: /data-testid="rates"/i.test(html),
          fieldNames: [...html.matchAll(/name="([^"]+)"/g)].map((m) => m[1]),
        },
        observations,
      };
      await writeDiscoveryOutputAtomic(input.outputPath, result);
      return result;
    } finally {
      await session.close();
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : 'discovery_failed';
    const safe = /password|secret|cookie|arn:aws/i.test(message)
      ? 'redacted_error'
      : message.slice(0, 160);
    const payload = {
      phase: input.phase,
      ok: false as const,
      error: safe,
    };
    await writeDiscoveryOutputAtomic(input.outputPath, payload);
    throw err;
  } finally {
    await runtime.close();
  }
}

async function main(): Promise<void> {
  const phase = discoveryPhaseSchema.parse(process.argv[2]);
  const mode =
    process.env.HMS_DISCOVERY_MODE === 'live' ? 'live' : 'fixture';
  assertFixtureOrAllowedLive(mode);

  const manifestPath = z.string().min(1).parse(
    process.env.HMS_DISCOVERY_MANIFEST_PATH,
  );
  const outputPath = z.string().min(1).parse(
    process.env.HMS_DISCOVERY_OUTPUT_PATH,
  );
  const secretArn = z.string().min(1).parse(process.env.HMS_READ_SECRET_ARN);

  // Live path loads via injectable loader only when orchestrator wires SM —
  // CLI refuses to construct SecretsManagerClient unless allow-live is set.
  if (mode === 'live') {
    throw new Error(
      'live CLI discovery is orchestrator-owned; use fixture mode in CI',
    );
  }

  const { readFile } = await import('node:fs/promises');
  const manifest = requestPolicyManifestSchema.parse(
    JSON.parse(await readFile(manifestPath, 'utf8')),
  );

  // Fixture secret from env skeleton — never log values
  const secret = hmsSecretSchema.parse({
    loginUrl: process.env.HMS_LOGIN_URL,
    username: process.env.HMS_USERNAME,
    password: process.env.HMS_PASSWORD,
    expectedTenant: process.env.HMS_EXPECTED_TENANT,
    expectedPropertyCode: process.env.HMS_EXPECTED_PROPERTY_CODE,
    expectedPropertyName: process.env.HMS_EXPECTED_PROPERTY_NAME,
    mailboxTransportId: process.env.HMS_MAILBOX_TRANSPORT_ID,
    credentialMode: process.env.HMS_CREDENTIAL_MODE ?? 'view_only',
  });

  const result = await runDiscovery({
    phase,
    manifest,
    secret,
    outputPath,
    mode: 'fixture',
    secretArn,
  });

  if (!result.ok) {
    process.exitCode = 2;
    return;
  }
  process.exitCode = 0;
}

const isMain =
  process.argv[1] &&
  (process.argv[1].endsWith('hms-discover-read.ts') ||
    process.argv[1].endsWith('hms-discover-read.js'));

if (isMain) {
  main().catch(() => {
    process.exitCode = 1;
  });
}

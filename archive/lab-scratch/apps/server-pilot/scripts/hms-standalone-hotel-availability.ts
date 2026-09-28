/**
 * Private, DB-free connected Hotel Availability runner.
 *
 * Usage is intentionally environment-driven so this script cannot accept a
 * caller URL, selector, record ID or gold answer.  It builds one exact policy
 * manifest from the tenant-discovered surface + connected request, starts one
 * authenticated runtime, performs one read, then closes it.
 */
import { readFile, writeFile, chmod } from 'node:fs/promises';
import { GetSecretValueCommand, SecretsManagerClient } from '@aws-sdk/client-secrets-manager';
import { z } from 'zod';
import { quoteRequestSchema } from '../../../../../apps/server-pilot/src/hms/quote-request-normalization.js';
import { hotelAvailabilitySurfaceManifestSchema, parseHotelAvailabilityResponse, buildHotelAvailabilityReadData } from '../src/hms/hotel-availability-contract.js';
import { buildHotelAvailabilityRequestManifest } from '../src/hms/hotel-availability-manifest.js';
import { classifyHotelAvailabilityResult } from '../src/hms/hotel-availability-contract.js';
import { createHotelAvailabilityFacade } from '../src/hms/hotel-availability-facade.js';
import { createHmsRuntime, createPlaywrightBrowserFactory, hmsSecretSchema } from '../../../../../apps/server-pilot/src/hms/runtime.js';

const inputSchema = z.object({
  inputSource: z.literal('connected_email_body'),
  goldFactsExcluded: z.literal(true),
  request: quoteRequestSchema,
}).strict();

async function readJson(path: string): Promise<unknown> {
  return JSON.parse(await readFile(path, 'utf8')) as unknown;
}

async function loadSecret(arn: string) {
  const client = new SecretsManagerClient({ region: process.env.AWS_REGION ?? 'af-south-1' });
  const result = await client.send(new GetSecretValueCommand({ SecretId: arn }));
  if (!result.SecretString) throw new Error('HMS secret has no SecretString');
  return hmsSecretSchema.parse(JSON.parse(result.SecretString));
}

async function main(): Promise<void> {
  if (process.env.HMS_HOTEL_AVAILABILITY_ALLOW_LIVE !== '1') {
    throw new Error('refused: set HMS_HOTEL_AVAILABILITY_ALLOW_LIVE=1');
  }
  const manifestPath = process.env.HMS_HOTEL_AVAILABILITY_MANIFEST_PATH;
  const inputPath = process.env.HMS_QUOTE_REQUEST_PATH;
  const secretArn = process.env.HMS_READ_SECRET_ARN;
  const outputPath = process.env.HMS_STANDALONE_OUTPUT_PATH ?? '/tmp/hms-hotel-availability-result.json';
  const executablePath = process.env.HMS_CHROMIUM_EXECUTABLE_PATH;
  if (!manifestPath || !inputPath || !secretArn || !executablePath) {
    throw new Error('manifest, connected request, secret ARN and Chromium path are required');
  }

  const surface = hotelAvailabilitySurfaceManifestSchema.parse(await readJson(manifestPath));
  const input = inputSchema.parse(await readJson(inputPath));
  const secret = await loadSecret(secretArn);
  if (secret.credentialMode !== 'view_only') throw new Error('standalone runner requires view_only credentials');
  if (secret.expectedPropertyCode !== input.request.propertyCode) throw new Error('request property does not match HMS secret');
  const origin = new URL(secret.loginUrl).origin;
  const policyManifest = buildHotelAvailabilityRequestManifest({ origin, request: input.request, surface });
  const runtime = createHmsRuntime({
    manifest: policyManifest,
    secretArn,
    loadSecret: async () => secret,
    browserFactory: createPlaywrightBrowserFactory(),
    executablePath,
    requireViewOnly: true,
    expectedOrigin: origin,
    runStartupCanary: false,
    requireAuditCapture: false,
    requireSessionAuthorization: false,
  });
  const signal = AbortSignal.timeout(Number(process.env.HMS_STANDALONE_TIMEOUT_MS ?? 90_000));
  let session: Awaited<ReturnType<typeof runtime.openReadSession>> | null = null;
  try {
    await runtime.start(signal);
    session = await runtime.openReadSession({ transportId: secret.mailboxTransportId, signal });
    const facade = createHotelAvailabilityFacade(session, surface);
    await facade.navigate();
    const responseText = await facade.search(input.request);
    const observedAt = new Date();
    const parsed = parseHotelAvailabilityResponse(responseText, input.request, surface, observedAt);
    const data = buildHotelAvailabilityReadData({ request: input.request, parsed });
    const unresolvedFields = [...new Set([
      ...parsed.unresolvedFields,
      ...(data.unresolvedInputs ?? []),
    ])];
    const result = {
      toolId: 'hms_quote_stay',
      surface: 'Hotel Availability',
      functionName: surface.functionName,
      status: classifyHotelAvailabilityResult({ parsed, data }),
      inputSource: input.inputSource,
      goldFactsExcluded: input.goldFactsExcluded,
      observedAt: observedAt.toISOString(),
      manifestSha256: surface.discoveryEvidenceSha256,
      data,
      unresolvedFields,
      runtimeHealth: runtime.health(),
    };
    await writeFile(outputPath, `${JSON.stringify(result, null, 2)}\n`, { mode: 0o600 });
    await chmod(outputPath, 0o600).catch(() => undefined);
    if (result.status !== 'ok') process.exitCode = 3;
  } finally {
    if (session) await session.close().catch(() => undefined);
    await runtime.close().catch(() => undefined);
  }
}

main().catch((error) => {
  const message = error instanceof Error ? error.message : 'standalone runner failed';
  process.stderr.write(`${message}\n`);
  process.exitCode = 1;
});

/**
 * Abort-first soft-capture for Room Type and Rate Availability (quote branch).
 * Records redacted structural signatures only — never body/query values.
 * Aborts CRS / save / delete / checkin / checkout / unknown mutation paths.
 * Orchestrator-only: requires HMS_DISCOVERY_ALLOW_LIVE=1.
 */
import { writeFile } from 'node:fs/promises';
import { chromium, type Request } from 'playwright';
import {
  GetSecretValueCommand,
  SecretsManagerClient,
} from '@aws-sdk/client-secrets-manager';
import { hmsSecretSchema } from '../src/hms/runtime.js';

type RedactedSig = {
  method: string;
  path: string;
  resourceType: string;
  queryKeys: string[];
  bodyKeys: string[];
  bodyBytes: number;
  contentType: string | null;
  decision: 'continue' | 'abort';
  abortReason?: string;
};

function redact(req: Request): Omit<RedactedSig, 'decision' | 'abortReason'> {
  const url = new URL(req.url());
  const headers = req.headers();
  const contentType = (headers['content-type'] ?? '').split(';', 1)[0]!.trim() || null;
  const raw = req.postData() ?? '';
  let bodyKeys: string[] = [];
  if (raw && (contentType === 'application/x-www-form-urlencoded' || !contentType)) {
    bodyKeys = [...new URLSearchParams(raw).keys()];
  } else if (raw && contentType === 'application/json') {
    try {
      bodyKeys = Object.keys(JSON.parse(raw) as Record<string, unknown>);
    } catch {
      bodyKeys = [];
    }
  }
  return {
    method: req.method().toUpperCase(),
    path: url.pathname,
    resourceType: req.resourceType(),
    queryKeys: [...url.searchParams.keys()],
    bodyKeys,
    bodyBytes: Buffer.byteLength(raw),
    contentType,
  };
}

function shouldAbort(path: string, method: string): string | null {
  if (/\/crs\/|checkavailability|check.?availability/i.test(path)) {
    return 'crs_check_availability';
  }
  if (/(save|delete|duplicate|checkin|checkout|amend|cancel|post|settle|refund|send|print|export|submit)/i.test(path)) {
    return 'mutation_path';
  }
  if (method !== 'GET' && method !== 'POST' && method !== 'HEAD' && method !== 'OPTIONS') {
    return 'unsafe_method';
  }
  return null;
}

async function main(): Promise<void> {
  if (process.env.HMS_DISCOVERY_ALLOW_LIVE !== '1') {
    throw new Error('refused: set HMS_DISCOVERY_ALLOW_LIVE=1');
  }
  const arn = process.env.HMS_READ_SECRET_ARN;
  if (!arn) throw new Error('HMS_READ_SECRET_ARN required');
  const outPath =
    process.env.HMS_QUOTE_CAPTURE_OUT ??
    '/tmp/hms-quote-availability-soft-capture.json';

  const client = new SecretsManagerClient({
    region: process.env.AWS_REGION ?? 'af-south-1',
  });
  const res = await client.send(new GetSecretValueCommand({ SecretId: arn }));
  if (!res.SecretString) throw new Error('secret empty');
  const secret = hmsSecretSchema.parse(JSON.parse(res.SecretString));
  if (secret.credentialMode !== 'view_only') {
    throw new Error('refuse: credentialMode must be view_only');
  }
  const origin = new URL(secret.loginUrl).origin;

  const signatures: RedactedSig[] = [];
  const structure: Record<string, unknown> = {
    menuLabelsSeen: [] as string[],
    toolbarIconPaths: [] as string[],
    functionNames: [] as string[],
    pageTitle: null as string | null,
    hasRoomRateAvailabilityText: false,
    hasCrsText: false,
  };

  const browser = await chromium.launch({
    headless: true,
    executablePath: process.env.HMS_CHROMIUM_EXECUTABLE_PATH || undefined,
  });
  const ctx = await browser.newContext({
    acceptDownloads: false,
    serviceWorkers: 'block',
    ignoreHTTPSErrors: true,
  });

  await ctx.route('**/*', async (route) => {
    const req = route.request();
    const url = req.url();
    if (!url.startsWith(origin)) {
      signatures.push({
        ...redact(req),
        decision: 'abort',
        abortReason: 'cross_origin',
      });
      await route.abort();
      return;
    }
    const path = new URL(url).pathname;
    const abortReason = shouldAbort(path, req.method());
    if (abortReason) {
      signatures.push({
        ...redact(req),
        decision: 'abort',
        abortReason,
      });
      await route.abort();
      return;
    }
    // Soft-allow chrome + login + availability-looking GETs; abort unknown POSTs
    // until preTransmissionEvidence exists for that exact signature.
    if (req.method() === 'POST') {
      const knownLogin =
        /\/session|\/login|j_security|Authenticate/i.test(path) ||
        /SYSTEM_FUNCTION_NAME|USER_FUNCTION_NAME/i.test(req.postData() ?? '');
      const knownAvail =
        /avail|rate|OSRAT|OSRAV|room.?rate|room.?type/i.test(path) ||
        /avail|rate|roomtype|rateplan/i.test(req.postData() ?? '');
      if (!knownLogin && !knownAvail) {
        signatures.push({
          ...redact(req),
          decision: 'abort',
          abortReason: 'unknown_post_pending_evidence',
        });
        await route.abort();
        return;
      }
      // Still record — do not transmit availability POST without evidence.
      if (knownAvail && !knownLogin) {
        signatures.push({
          ...redact(req),
          decision: 'abort',
          abortReason: 'availability_post_needs_preTransmissionEvidence',
        });
        await route.abort();
        return;
      }
    }
    signatures.push({ ...redact(req), decision: 'continue' });
    await route.continue();
  });

  const page = await ctx.newPage();
  try {
    await page.goto(secret.loginUrl, { waitUntil: 'domcontentloaded', timeout: 60_000 });
    try {
      await page.locator('input[name=userid]').fill(secret.username);
    } catch {
      await page
        .locator('input[name=username], input[name=j_username]')
        .first()
        .fill(secret.username);
    }
    await page.locator('input[name=password]').fill(secret.password);
    await Promise.all([
      page.waitForURL(/\/web\/base\/COMMON/i, { timeout: 60_000 }).catch(() => null),
      page.getByRole('button', { name: 'Sign in' }).click().catch(async () => {
        await page.locator('input[name=password]').press('Enter');
      }),
    ]);

    await page.waitForTimeout(3_000);
    structure.pageTitle = await page.title();
    const bodyText = await page.evaluate(() => document.body?.innerText?.slice(0, 8000) ?? '');
    structure.hasRoomRateAvailabilityText =
      /Room Type and Rate Availability|Room Rate Availability|Rate Availability/i.test(
        bodyText,
      );
    structure.hasCrsText = /CRS Check Availability|Check Availability/i.test(bodyText);
    const labels = bodyText
      .split('\n')
      .map((l) => l.trim())
      .filter((l) => l.length > 2 && l.length < 80)
      .slice(0, 200);
    structure.menuLabelsSeen = labels.filter((l) =>
      /Front Desk|Guest Stay|Availability|Rate|Room|CRS|Reserv/i.test(l),
    );

    // Collect toolbar icon paths from DOM (structure only).
    const icons = await page.evaluate(() =>
      [...document.querySelectorAll('img[src*="toolbar"], img[src*="availability"]')].map(
        (el) => (el as HTMLImageElement).getAttribute('src') ?? '',
      ),
    );
    structure.toolbarIconPaths = icons
      .map((s) => {
        try {
          return new URL(s, origin).pathname;
        } catch {
          return s;
        }
      })
      .filter(Boolean)
      .slice(0, 80);

    // Try exact menu navigation without posting search.
    for (const label of [
      'Front Desk',
      'Room Type and Rate Availability',
      'Room Rate Availability',
      'Availability',
    ]) {
      const visible = await page
        .locator(`text=${label}`)
        .first()
        .isVisible()
        .catch(() => false);
      if (visible) {
        await page.click(`text=${label}`, { timeout: 5_000 }).catch(() => undefined);
        await page.waitForTimeout(2_000);
      }
    }

    const afterNav = await page.evaluate(() => document.body?.innerText?.slice(0, 4000) ?? '');
    structure.hasRoomRateAvailabilityText =
      structure.hasRoomRateAvailabilityText ||
      /Room Type and Rate Availability|Room Rate Availability/i.test(afterNav);
    structure.functionNames = [
      ...new Set(
        [...afterNav.matchAll(/\b(OS[A-Z0-9]{3,8})\b/g)].map((m) => m[1]!),
      ),
    ].slice(0, 40);

    const payload = {
      schemaVersion: 1,
      surface: 'room_type_rate_availability',
      discoveryOperationId: 'quote_availability_search',
      capturedAt: new Date().toISOString(),
      originHost: new URL(origin).host,
      structure,
      signatures: signatures.slice(0, 400),
      aborted: signatures.filter((s) => s.decision === 'abort').slice(0, 100),
      continued: signatures.filter((s) => s.decision === 'continue').slice(0, 100),
      valuesCaptured: false,
    };
    await writeFile(outPath, `${JSON.stringify(payload, null, 2)}\n`, { mode: 0o600 });
    // stdout: counts only
    process.stdout.write(
      JSON.stringify({
        ok: true,
        outPath,
        signatureCount: signatures.length,
        abortCount: signatures.filter((s) => s.decision === 'abort').length,
        hasRoomRateAvailabilityText: structure.hasRoomRateAvailabilityText,
        hasCrsText: structure.hasCrsText,
        functionNameCount: (structure.functionNames as string[]).length,
        toolbarIconCount: (structure.toolbarIconPaths as string[]).length,
      }) + '\n',
    );
  } finally {
    await browser.close();
  }
}

main().catch((err) => {
  const msg = err instanceof Error ? err.message : 'capture_failed';
  const safe = /password|secret|cookie|arn:aws/i.test(msg)
    ? 'redacted_error'
    : msg.slice(0, 200);
  process.stderr.write(`HMS_QUOTE_CAPTURE_FAIL ${safe}\n`);
  process.exitCode = 1;
});

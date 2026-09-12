/**
 * Abort-first soft-capture for Sent Email (PSSNEL) and Tax Invoice surfaces.
 * Redacted structural signatures only — never body/query values, subjects,
 * addresses, or attachment filenames.
 * Sent Email deepen: soft-allow PSSNEL / PSSNEL.HDR OPEN (no .search), record
 * video, structure-inventory HDR (Wave A3 packaging path).
 * Orchestrator-only: requires HMS_DISCOVERY_ALLOW_LIVE=1.
 */
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { chromium, type Request } from 'playwright';
import {
  GetSecretValueCommand,
  SecretsManagerClient,
} from '@aws-sdk/client-secrets-manager';
import { extractPssnelHdrStructure } from '../src/hms/pssnel-hdr-structure.js';
import { hmsSecretSchema } from '../src/hms/runtime.js';

type SurfaceId = 'sent_email' | 'tax_invoice';

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
  const contentType =
    (headers['content-type'] ?? '').split(';', 1)[0]!.trim() || null;
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
  // Do not treat bare "email" substring as mutation — PSSNEL / Sent Email paths
  // must stay soft-open. Match delivery/mutation verbs only.
  if (
    /(save|delete|duplicate|checkin|checkout|amend|cancel|settle|refund|resend|print|export|generate|submit|finalize|void|\/send(?:\/|$))/i.test(
      path,
    )
  ) {
    return 'mutation_or_delivery_path';
  }
  if (method !== 'GET' && method !== 'POST' && method !== 'HEAD' && method !== 'OPTIONS') {
    return 'unsafe_method';
  }
  return null;
}

function isShellOrLoginPost(path: string, body: string): boolean {
  return (
    /\/session|\/login|j_security|Authenticate|BSSTRT|COMMON/i.test(path) ||
    /SYSTEM_FUNCTION_NAME|USER_FUNCTION_NAME/i.test(body)
  );
}

/** List/search envelopes — abort until preTransmissionEvidence exists. */
function isSurfaceSearchPost(path: string, body: string): boolean {
  if (/\.search$/i.test(path)) return true;
  if (/GRIDRESULT|ONLY_DATA_REQUIRED|pageaction=search/i.test(body)) return true;
  if (/PSSNEL|OSTXI|OSTAX|OSINV/i.test(path) && /\.search|grid|list/i.test(path)) {
    return true;
  }
  return false;
}

/** Soft-allow Sent Email surface OPEN only (no .search). Proven Wave A3. */
function isPssnelSurfaceOpen(path: string): boolean {
  return (
    /^\/web\/base\/PSSNEL\/?$/i.test(path) ||
    /^\/web\/base\/PSSNEL\.HDR\/?$/i.test(path)
  );
}

async function captureSurface(surface: SurfaceId): Promise<void> {
  if (process.env.HMS_DISCOVERY_ALLOW_LIVE !== '1') {
    throw new Error('refused: set HMS_DISCOVERY_ALLOW_LIVE=1');
  }
  const arn = process.env.HMS_READ_SECRET_ARN;
  if (!arn) throw new Error('HMS_READ_SECRET_ARN required');
  const outPath =
    process.env.HMS_COMMS_CAPTURE_OUT ??
    `/tmp/hms-${surface}-soft-capture.json`;

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
    surface,
    menuLabelsSeen: [] as string[],
    functionNames: [] as string[],
    pageTitle: null as string | null,
    hasTargetLabel: false,
    hasPrintAction: false,
    hasEmailAction: false,
    hasResendAction: false,
    hasAttachmentOpen: false,
  };

  const targetLabels =
    surface === 'sent_email'
      ? ['Front Desk', 'Sent Email', 'Email']
      : ['Front Desk', 'Tax Invoice', 'Invoice'];

  const { access } = await import('node:fs/promises');
  const { constants: fsConstants } = await import('node:fs');
  const videoDir =
    process.env.HMS_COMMS_CAPTURE_VIDEO_DIR?.trim() ||
    `${outPath.replace(/\.json$/i, '')}-video`;
  await mkdir(videoDir, { recursive: true, mode: 0o700 });

  let wantVideo = process.env.HMS_COMMS_CAPTURE_VIDEO !== '0';
  if (wantVideo) {
    const ffmpegCandidates = [
      process.env.PLAYWRIGHT_FFMPEG_PATH,
      '/home/ubuntu/.cache/ms-playwright/ffmpeg-1011/ffmpeg-linux',
      '/opt/nava/playwright-browsers/ffmpeg-1011/ffmpeg-linux',
      '/usr/bin/ffmpeg',
    ].filter((p): p is string => Boolean(p && p.trim()));
    let ffmpegOk = false;
    for (const p of ffmpegCandidates) {
      try {
        await access(p, fsConstants.X_OK);
        process.env.PLAYWRIGHT_FFMPEG_PATH = p;
        ffmpegOk = true;
        break;
      } catch {
        /* try next */
      }
    }
    if (!ffmpegOk) {
      wantVideo = false;
      process.stderr.write(
        'HMS_COMMS_CAPTURE_WARN code=FFMPEG_MISSING falling_back_no_video\n',
      );
    }
  }

  const browser = await chromium.launch({
    headless: true,
    executablePath: process.env.HMS_CHROMIUM_EXECUTABLE_PATH || undefined,
  });
  const ctx = await browser.newContext({
    acceptDownloads: false,
    serviceWorkers: 'block',
    ignoreHTTPSErrors: true,
    ...(wantVideo
      ? { recordVideo: { dir: videoDir, size: { width: 1280, height: 720 } } }
      : {}),
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
    if (req.method() === 'POST') {
      const body = req.postData() ?? '';
      const surfaceSearch = isSurfaceSearchPost(path, body);
      // Search/list posts always need independent preTransmissionEvidence.
      if (surfaceSearch) {
        signatures.push({
          ...redact(req),
          decision: 'abort',
          abortReason: `${surface}_search_needs_preTransmissionEvidence`,
        });
        await route.abort();
        return;
      }
      // Soft-allow proven PSSNEL open/HDR (structure inventory only).
      if (surface === 'sent_email' && isPssnelSurfaceOpen(path)) {
        signatures.push({ ...redact(req), decision: 'continue' });
        await route.continue();
        return;
      }
      // Chrome hydration: continue same-origin non-search POSTs that look like
      // shell/module open. Aborting these earlier produced 813B tenant stubs
      // instead of the proven ~28kB PSSNEL.HDR envelope.
      const shellOrLogin = isShellOrLoginPost(path, body);
      const moduleOpen =
        /^\/web\/base\/[A-Z0-9.]+$/i.test(path) && !/\.search/i.test(path);
      if (shellOrLogin || moduleOpen) {
        signatures.push({ ...redact(req), decision: 'continue' });
        await route.continue();
        return;
      }
      signatures.push({
        ...redact(req),
        decision: 'abort',
        abortReason: 'unknown_post_pending_evidence',
      });
      await route.abort();
      return;
    }
    signatures.push({ ...redact(req), decision: 'continue' });
    await route.continue();
  });

  const page = await ctx.newPage();
  try {
    await page.goto(secret.loginUrl, {
      waitUntil: 'domcontentloaded',
      timeout: 60_000,
    });
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

    // Expand Front Desk then open target — force click for ExtJS tree.
    for (const label of targetLabels) {
      const loc = page.getByText(label, { exact: true }).first();
      const visible = await loc.isVisible().catch(() => false);
      if (visible) {
        await loc.click({ force: true, timeout: 8_000 }).catch(() => undefined);
        await page.waitForTimeout(2_500);
      } else {
        // Fallback substring match for ExtJS menu paint.
        await page
          .locator(`text=${label}`)
          .first()
          .click({ force: true, timeout: 5_000 })
          .catch(() => undefined);
        await page.waitForTimeout(2_000);
      }
    }

    // Collect tree/menu node texts (structure labels only).
    const treeLabels = await page.evaluate(() => {
      const nodes = [
        ...document.querySelectorAll(
          '.x-tree-node-text, .x-menu-item-text, .x-btn-inner, a, span',
        ),
      ];
      return nodes
        .map((el) => (el.textContent ?? '').trim())
        .filter((t) => t.length > 2 && t.length < 64)
        .filter((t) =>
          /Front Desk|Sent Email|Tax Invoice|Email|Invoice|Guest Stay|Folio|Availability/i.test(
            t,
          ),
        )
        .slice(0, 80);
    });
    structure.menuLabelsSeen = [...new Set(treeLabels)];

    // Soft-probe PSSNEL OPEN + HDR structure inventory (no .search, no row values).
    if (surface === 'sent_email') {
      const openProbe = await page.evaluate(async () => {
        const body = new URLSearchParams({
          SYSTEM_FUNCTION_NAME: 'PSSNEL',
          USER_FUNCTION_NAME: 'PSSNEL',
          FUNCTION_CLASS: 'WEBL',
        });
        try {
          const res = await fetch(
            '/web/base/PSSNEL?FUNCTION_CLASS=WEBL&USER_FUNCTION_NAME=PSSNEL',
            {
              method: 'POST',
              credentials: 'same-origin',
              headers: { 'content-type': 'application/x-www-form-urlencoded' },
              body: body.toString(),
            },
          );
          const text = await res.text();
          return {
            ok: res.ok,
            status: res.status,
            bytes: text.length,
            hasPssnelToken: /PSSNEL/i.test(text),
            hasLoginFields:
              /name\s*=\s*["']userid["']/i.test(text) &&
              /name\s*=\s*["']password["']/i.test(text),
            hasErrorMarker:
              /not authorised|not authorized|access denied|permission|function not available|no authority/i.test(
                text,
              ),
          };
        } catch {
          return {
            ok: false,
            status: 0,
            bytes: 0,
            hasPssnelToken: false,
            hasLoginFields: false,
            hasErrorMarker: false,
            error: 'fetch_failed',
          };
        }
      });
      structure.pssnelOpenProbe = openProbe;

      const hdrText = await page.evaluate(async () => {
        const body = new URLSearchParams({
          SYSTEM_FUNCTION_NAME: 'PSSNEL',
          USER_FUNCTION_NAME: 'PSSNEL',
          CURRENT_TAB_NAME: 'HDR',
        });
        try {
          const res = await fetch('/web/base/PSSNEL.HDR', {
            method: 'POST',
            credentials: 'same-origin',
            headers: { 'content-type': 'application/x-www-form-urlencoded' },
            body: body.toString(),
          });
          const text = await res.text();
          return { ok: res.ok, status: res.status, text };
        } catch {
          return { ok: false, status: 0, text: '' };
        }
      });
      const hdrStructure = extractPssnelHdrStructure(hdrText.text);
      structure.pssnelHdrProbe = {
        ok: hdrText.ok,
        status: hdrText.status,
        ...hdrStructure,
        // Drop raw text — structure inventory only.
      };
    }

    const afterNav = await page.evaluate(
      () => document.body?.innerText?.slice(0, 6000) ?? '',
    );
    // Structure-only flags — never capture raw email/subject/filename text.
    structure.hasTargetLabel =
      surface === 'sent_email'
        ? /Sent Email/i.test(afterNav) ||
          Boolean(
            (structure.pssnelHdrProbe as { hasSentEmailToolbar?: boolean } | undefined)
              ?.hasSentEmailToolbar,
          )
        : /Tax Invoice/i.test(afterNav);
    structure.hasPrintAction = /\bPrint\b/i.test(afterNav);
    structure.hasEmailAction = /\bE-?mail\b/i.test(afterNav);
    structure.hasResendAction = /\bResend\b/i.test(afterNav);
    structure.hasAttachmentOpen = /\bOpen Attachment|View Attachment\b/i.test(
      afterNav,
    );

    const labels = afterNav
      .split('\n')
      .map((l) => l.trim())
      .filter((l) => l.length > 2 && l.length < 80)
      .slice(0, 200);
    const fromBody = labels.filter((l) =>
      /Front Desk|Sent Email|Tax Invoice|Email|Invoice|Guest Stay|Folio/i.test(l),
    );
    structure.menuLabelsSeen = [
      ...new Set([
        ...((structure.menuLabelsSeen as string[]) ?? []),
        ...fromBody,
      ]),
    ].slice(0, 80);
    structure.functionNames = [
      ...new Set(
        [...afterNav.matchAll(/\b(OS[A-Z0-9]{3,8}|PS[A-Z0-9]{3,8})\b/g)].map(
          (m) => m[1]!,
        ),
      ),
    ].slice(0, 40);
    if (
      surface === 'sent_email' &&
      !(structure.functionNames as string[]).includes('PSSNEL')
    ) {
      (structure.functionNames as string[]).push('PSSNEL');
    }

    const payload = {
      schemaVersion: 1,
      surface,
      discoveryOperationId:
        surface === 'sent_email' ? 'sent_email_list' : 'tax_invoice_list',
      capturedAt: new Date().toISOString(),
      originHost: new URL(origin).host,
      valuesCaptured: false,
      structure,
      signatures: signatures.slice(0, 400),
      abortSummary: signatures
        .filter((s) => s.decision === 'abort')
        .reduce<Record<string, number>>((acc, s) => {
          const key = s.abortReason ?? 'unknown';
          acc[key] = (acc[key] ?? 0) + 1;
          return acc;
        }, {}),
      continuedPostPaths: [
        ...new Set(
          signatures
            .filter((s) => s.decision === 'continue' && s.method === 'POST')
            .map((s) => s.path),
        ),
      ].slice(0, 40),
      abortedPostPaths: [
        ...new Set(
          signatures
            .filter((s) => s.decision === 'abort' && s.method === 'POST')
            .map((s) => `${s.path}:${s.abortReason ?? ''}`),
        ),
      ].slice(0, 80),
    };

    await writeFile(outPath, `${JSON.stringify(payload, null, 2)}\n`, {
      mode: 0o600,
    });

    const videoHandle = page.video();
    await page.close().catch(() => undefined);
    const videoPath = videoHandle ? await videoHandle.path().catch(() => null) : null;
    let videoSha256: string | null = null;
    if (videoPath) {
      const bytes = await readFile(videoPath);
      videoSha256 = createHash('sha256').update(bytes).digest('hex');
    }

    const hdrProbe = structure.pssnelHdrProbe as
      | { hdrBytes?: number; envelopeRecognized?: boolean; status?: number }
      | undefined;
    // stdout: digests/counts only — no PII
    process.stdout.write(
      `${JSON.stringify({
        ok: true,
        surface,
        outPath,
        videoDir,
        videoSha256,
        hasTargetLabel: structure.hasTargetLabel,
        functionNameCount: (structure.functionNames as string[]).length,
        pssnelHdrBytes: hdrProbe?.hdrBytes ?? 0,
        pssnelHdrEnvelope: Boolean(hdrProbe?.envelopeRecognized),
        pssnelHdrStatus: hdrProbe?.status ?? 0,
        abortSummary: payload.abortSummary,
        abortedPostPathCount: payload.abortedPostPaths.length,
      })}\n`,
    );
  } finally {
    await browser.close();
  }
}

async function main(): Promise<void> {
  const surfaceArg = (process.argv[2] || 'both').trim() as
    | SurfaceId
    | 'both';
  if (surfaceArg === 'both') {
    await captureSurface('sent_email');
    await captureSurface('tax_invoice');
    return;
  }
  if (surfaceArg !== 'sent_email' && surfaceArg !== 'tax_invoice') {
    throw new Error('usage: hms-communications-soft-capture.ts [sent_email|tax_invoice|both]');
  }
  await captureSurface(surfaceArg);
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});

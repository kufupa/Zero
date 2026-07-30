/**
 * Orchestrator-only abort-first live HMS login probe.
 * Loads secret from Secrets Manager, opens Chromium to login URL under
 * fail-closed request policy, never submits credentials.
 * Writes redacted JSON only.
 */
import { chromium, type Browser, type Page } from 'playwright';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import {
  GetSecretValueCommand,
  SecretsManagerClient,
} from '@aws-sdk/client-secrets-manager';
import { hmsSecretSchema, type HmsSecret } from '../src/hms/runtime.js';
import { evaluateObservedRequest } from '../src/hms/request-policy.js';
import {
  requestPolicyManifestSchema,
  type RequestPolicyManifest,
  type RequestDecision,
  type RedactedRequestSignature,
} from '../src/hms/contracts.js';

type ProbeEvent = {
  decision: 'allow' | 'block';
  code?: string;
  ruleId?: string;
  redactedSignature: RedactedRequestSignature;
};

async function loadSecret(arn: string): Promise<HmsSecret> {
  const client = new SecretsManagerClient({
    region: process.env.AWS_REGION ?? 'af-south-1',
  });
  const res = await client.send(
    new GetSecretValueCommand({ SecretId: arn }),
  );
  if (!res.SecretString) throw new Error('secret empty');
  return hmsSecretSchema.parse(JSON.parse(res.SecretString));
}

function getStaticRule(
  origin: string,
  id: string,
  path: string,
  resourceTypes: string[],
) {
  return {
    id,
    origin,
    method: 'GET' as const,
    path,
    resourceTypes,
    fixedQuery: {},
    variableQuery: {},
    fixedBody: {},
    variableBody: {},
    maxBodyBytes: 4096,
    redirectPolicy: 'same-reviewed-chain' as const,
  };
}

/**
 * Abort-first inventory (2026-07-30 EC2 probe): document GET + exact static
 * GETs observed as unknown_path on first pass. No POST/credential submit here.
 */
function minimalLoginManifest(origin: string): RequestPolicyManifest {
  return requestPolicyManifestSchema.parse({
    rules: [
      {
        id: 'live-login-get',
        origin,
        method: 'GET',
        path: '/web/base/logindisp',
        resourceTypes: ['document'],
        fixedQuery: {},
        variableQuery: {
          tenant: { pattern: 'HMS_LEGACY', maxLength: 32 },
        },
        fixedBody: {},
        variableBody: {},
        maxBodyBytes: 4096,
        redirectPolicy: 'same-reviewed-chain',
      },
      getStaticRule(origin, 'live-login-css', '/web/resources/inforhms/HMS-min.css', [
        'stylesheet',
      ]),
      getStaticRule(
        origin,
        'live-login-jquery',
        '/web/resources/shared/scripts/jquery-3.6.0.min.js',
        ['script'],
      ),
      getStaticRule(
        origin,
        'live-login-jquery-json',
        '/web/resources/shared/scripts/jquery.json-2.3.min.js',
        ['script'],
      ),
      getStaticRule(
        origin,
        'live-login-companyon',
        '/web/resources/shared/scripts/infor-companyon-client.js',
        ['script'],
      ),
      getStaticRule(origin, 'live-login-all-js', '/web/base/login-all.js', [
        'script',
      ]),
    ],
  });
}

function eventFromDecision(decision: RequestDecision): ProbeEvent {
  if (decision.action === 'allow') {
    return {
      decision: 'allow',
      ruleId: decision.ruleId,
      redactedSignature: {
        method: '',
        origin: '',
        path: '',
        resourceType: '',
        queryKeys: [],
        bodyKeys: [],
        bodyBytes: 0,
      },
    };
  }
  return {
    decision: 'block',
    code: decision.code,
    redactedSignature: decision.redactedSignature,
  };
}

async function main(): Promise<void> {
  if (process.env.HMS_DISCOVERY_ALLOW_LIVE !== '1') {
    throw new Error('refused: set HMS_DISCOVERY_ALLOW_LIVE=1');
  }
  const arn = process.env.HMS_READ_SECRET_ARN;
  if (!arn) throw new Error('HMS_READ_SECRET_ARN required');
  const outPath =
    process.env.HMS_DISCOVERY_OUTPUT_PATH ??
    '/tmp/hms-live-login-probe.json';

  const secret = await loadSecret(arn);
  const origin = new URL(secret.loginUrl).origin;
  const manifest = minimalLoginManifest(origin);

  const events: ProbeEvent[] = [];
  let browser: Browser | null = null;
  let page: Page | null = null;
  let firstBlock: ProbeEvent | null = null;

  try {
    browser = await chromium.launch({
      headless: true,
    });
    const context = await browser.newContext({
      acceptDownloads: false,
      serviceWorkers: 'block',
    });
    await context.route('**/*', async (route) => {
      const req = route.request();
      const decision = evaluateObservedRequest(manifest, {
        url: req.url(),
        method: req.method(),
        resourceType: req.resourceType(),
        headers: req.headers(),
        postData: req.postData(),
      });
      const ev = eventFromDecision(decision);
      if (decision.action === 'allow') {
        ev.redactedSignature = {
          method: req.method(),
          origin: new URL(req.url()).origin,
          path: new URL(req.url()).pathname,
          resourceType: req.resourceType(),
          contentType: req.headers()['content-type'],
          queryKeys: [...new URL(req.url()).searchParams.keys()].sort(),
          bodyKeys: [],
          bodyBytes: Buffer.byteLength(req.postData() ?? ''),
        };
        events.push(ev);
        await route.continue();
        return;
      }
      events.push(ev);
      if (!firstBlock) firstBlock = ev;
      await route.abort();
    });

    page = await context.newPage();
    const loginUrl = secret.loginUrl.includes('tenant=')
      ? secret.loginUrl
      : `${secret.loginUrl}${secret.loginUrl.includes('?') ? '&' : '?'}tenant=${encodeURIComponent(secret.expectedTenant)}`;

    let navError: string | null = null;
    try {
      await page.goto(loginUrl, {
        waitUntil: 'domcontentloaded',
        timeout: 45_000,
      });
    } catch (err) {
      const raw = err instanceof Error ? err.message : 'navigation_failed';
      navError = /password|secret|cookie/i.test(raw)
        ? 'redacted_error'
        : raw.slice(0, 160);
    }

    const title = page ? await page.title().catch(() => '') : '';
    const passwordCount = page
      ? await page.locator('input[type="password"]').count().catch(() => 0)
      : 0;
    const hasLoginFields = passwordCount > 0 || /login/i.test(title);

    if (process.env.HMS_LIVE_CANARY_SUBMIT === '1') {
      throw new Error('credential submit not enabled in this probe build');
    }

    // Connectivity canary: document GET allowed OR we captured a fail-closed
    // first block with redacted signature (abort-first inventory).
    const documentAllowed = events.some(
      (e) =>
        e.decision === 'allow' &&
        e.redactedSignature.path === '/web/base/logindisp',
    );
    const payload = {
      ok: documentAllowed || (firstBlock !== null && events.length > 0),
      phase: 'login-probe',
      origin,
      titlePresent: Boolean(title),
      hasLoginFields,
      documentAllowed,
      navError,
      allowCount: events.filter((e) => e.decision === 'allow').length,
      blockCount: events.filter((e) => e.decision === 'block').length,
      firstBlock,
      events: events.slice(0, 40),
      propertyExpectation: {
        tenant: secret.expectedTenant,
        propertyCode: secret.expectedPropertyCode,
      },
    };

    await mkdir(dirname(outPath), { recursive: true });
    await writeFile(outPath, JSON.stringify(payload, null, 2), {
      mode: 0o600,
    });
    console.log(
      JSON.stringify({
        wrote: outPath,
        ok: payload.ok,
        documentAllowed: payload.documentAllowed,
        allowCount: payload.allowCount,
        blockCount: payload.blockCount,
        hasLoginFields: payload.hasLoginFields,
        firstBlockCode: firstBlock?.code ?? null,
        firstBlockPath: firstBlock?.redactedSignature.path ?? null,
      }),
    );
    if (!payload.ok) process.exit(2);
  } finally {
    await page?.context().close().catch(() => {});
    await browser?.close().catch(() => {});
  }
}

function sanitizeProbeError(raw: string): string {
  // Strip secret-bearing tokens; keep IAM/AWS failure codes visible.
  let msg = raw
    .replace(/arn:aws:secretsmanager:[^\s]+/gi, 'arn:aws:secretsmanager:***')
    .replace(/\b[A-Za-z0-9+/_-]{24,}=*/g, '***');
  if (/\bpassword\b|\bcookie\b|SecretString/i.test(msg)) {
    return 'redacted_error';
  }
  return msg.slice(0, 240);
}

main().catch((err) => {
  const name = err instanceof Error ? err.name : 'Error';
  const msg = err instanceof Error ? err.message : String(err);
  console.error(`${name}: ${sanitizeProbeError(msg)}`);
  process.exit(1);
});

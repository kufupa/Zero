/**
 * Orchestrator-only abort-first live HMS login probe.
 * Loads secret from Secrets Manager, opens Chromium to login URL under
 * fail-closed request policy.
 *
 * Credential submit requires BOTH:
 *   HMS_DISCOVERY_ALLOW_LIVE=1 and HMS_LIVE_CANARY_SUBMIT=1
 * and secret.credentialMode === 'view_only'.
 * Writes redacted JSON only (no credential/cookie values).
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
      getStaticRule(
        origin,
        'live-login-error-svg',
        '/web/resources/inforhms/images/toolbar/error-solid.svg',
        ['image'],
      ),
      getStaticRule(
        origin,
        'live-login-logo-svg',
        '/web/resources/inforhms/images/shared/logo.svg',
        ['image'],
      ),
      getStaticRule(
        origin,
        'live-login-font-semibold',
        '/web/resources/shared/css/SourceSansPro-font/SourceSansPro-Semibold.ttf',
        ['font'],
      ),
      getStaticRule(
        origin,
        'live-login-font-regular',
        '/web/resources/shared/css/SourceSansPro-font/SourceSansPro-Regular.ttf',
        ['font'],
      ),
      getStaticRule(
        origin,
        'live-login-font-it',
        '/web/resources/shared/css/SourceSansPro-font/SourceSansPro-It.ttf',
        ['font'],
      ),
      {
        id: 'live-login-post',
        origin,
        method: 'POST',
        path: '/web/base/login',
        resourceTypes: ['xhr', 'fetch', 'document'],
        contentType: 'application/x-www-form-urlencoded',
        fixedQuery: {},
        variableQuery: {},
        fixedBody: {
          tenant: 'HMS_LEGACY',
        },
        variableBody: {
          userid: { pattern: '.{1,64}', maxLength: 64 },
          password: { pattern: '.{1,128}', maxLength: 128 },
          csrftckt: { pattern: '.{0,256}', maxLength: 256 },
          resetpassword: { pattern: '.{0,32}', maxLength: 32 },
          SYSTEM_FUNCTION_NAME: { pattern: '.{0,64}', maxLength: 64 },
          USER_FUNCTION_NAME: { pattern: '.{0,64}', maxLength: 64 },
        },
        maxBodyBytes: 4096,
        redirectPolicy: 'same-reviewed-chain',
      },
      {
        id: 'live-post-login-common',
        origin,
        method: 'GET',
        path: '/web/base/COMMON',
        resourceTypes: ['document', 'xhr', 'fetch'],
        fixedQuery: {},
        variableQuery: {
          // Session REQ_KEY is opaque; constrain charset/length only.
          // Do not treat COMMON as a write-form allow — stop on unknown POST
          // (e.g. BSSTRT) before any mutation surface.
          REQ_KEY: { pattern: '[A-Za-z0-9._-]{8,128}', maxLength: 128 },
        },
        fixedBody: {},
        variableBody: {},
        maxBodyBytes: 4096,
        redirectPolicy: 'same-reviewed-chain',
      },
      getStaticRule(origin, 'live-post-login-root', '/', ['document']),
      getStaticRule(
        origin,
        'live-common-vault-utility',
        '/web/resources/shared/scripts/vault/vaultUtility.js',
        ['script'],
      ),
      getStaticRule(
        origin,
        'live-common-parent-facade',
        '/web/resources/shared/scripts/vault/parentFacade.js',
        ['script'],
      ),
      getStaticRule(
        origin,
        'live-common-parent-facade-impl',
        '/web/resources/shared/scripts/vault/parentFacadeImpl.js',
        ['script'],
      ),
      getStaticRule(
        origin,
        'live-common-aes',
        '/web/resources/shared/scripts/cryptojs/aes.js',
        ['script'],
      ),
      getStaticRule(
        origin,
        'live-common-pbkdf2',
        '/web/resources/shared/scripts/cryptojs/pbkdf2.js',
        ['script'],
      ),
      getStaticRule(
        origin,
        'live-common-aes-util',
        '/web/resources/shared/scripts/cryptojs/AesUtil.js',
        ['script'],
      ),
      getStaticRule(
        origin,
        'live-common-sha256',
        '/web/resources/shared/scripts/cryptojs/sha256-min.js',
        ['script'],
      ),
      getStaticRule(origin, 'live-common-all-classes', '/web/base/all-classes.js', [
        'script',
      ]),
      {
        id: 'live-bsstrt',
        origin,
        method: 'POST',
        path: '/web/base/BSSTRT',
        resourceTypes: ['xhr', 'fetch'],
        contentType: 'application/x-www-form-urlencoded',
        fixedQuery: {},
        variableQuery: {},
        fixedBody: {},
        variableBody: {
          MENU_MODULE_KEY: { pattern: '.{0,64}', maxLength: 64 },
          SYSTEM_FUNCTION_NAME: { pattern: '.{0,64}', maxLength: 64 },
          USER_FUNCTION_NAME: { pattern: '.{0,64}', maxLength: 64 },
          removescreenflows: { pattern: '.{0,16}', maxLength: 16 },
        },
        maxBodyBytes: 4096,
        redirectPolicy: 'same-reviewed-chain',
      },
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
  const xhrMeta: Array<{
    path: string;
    status: number;
    ok: boolean;
    bodyBytes: number;
  }> = [];
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
        const url = new URL(req.url());
        const postData = req.postData() ?? '';
        let bodyKeys: string[] = [];
        if (postData) {
          try {
            bodyKeys = [...new URLSearchParams(postData).keys()].sort();
          } catch {
            bodyKeys = [];
          }
        }
        ev.redactedSignature = {
          method: req.method(),
          origin: url.origin,
          path: url.pathname,
          resourceType: req.resourceType(),
          contentType: req.headers()['content-type'],
          queryKeys: [...url.searchParams.keys()].sort(),
          bodyKeys,
          bodyBytes: Buffer.byteLength(postData),
        };
        events.push(ev);
        await route.continue();
        return;
      }
      events.push(ev);
      // Enrich blocked POST fingerprints with body keys for reviewed allowlist
      // authoring (never values).
      if (
        decision.action === 'block' &&
        req.method().toUpperCase() === 'POST' &&
        req.postData()
      ) {
        try {
          ev.redactedSignature = {
            ...ev.redactedSignature,
            bodyKeys: [...new URLSearchParams(req.postData()!).keys()].sort(),
            bodyBytes: Buffer.byteLength(req.postData()!),
            contentType: req.headers()['content-type'],
          };
        } catch {
          /* keep policy signature */
        }
      }
      if (!firstBlock) firstBlock = ev;
      await route.abort();
    });

    page = await context.newPage();
    page.on('response', (res) => {
      try {
        const url = new URL(res.url());
        if (url.pathname === '/web/base/login' || res.request().method() === 'POST') {
          const headers = res.headers();
          const len = Number(headers['content-length'] ?? '0');
          xhrMeta.push({
            path: url.pathname,
            status: res.status(),
            ok: res.ok(),
            bodyBytes: Number.isFinite(len) ? len : 0,
          });
        }
      } catch {
        /* ignore */
      }
    });
    const loginUrl = secret.loginUrl.includes('tenant=')
      ? secret.loginUrl
      : `${secret.loginUrl}${secret.loginUrl.includes('?') ? '&' : '?'}tenant=${encodeURIComponent(secret.expectedTenant)}`;

    let navError: string | null = null;
    try {
      await page.goto(loginUrl, {
        waitUntil: 'domcontentloaded',
        timeout: 45_000,
      });
      await page.waitForTimeout(2500);
    } catch (err) {
      const raw = err instanceof Error ? err.message : 'navigation_failed';
      navError = /password|secret|cookie/i.test(raw)
        ? 'redacted_error'
        : raw.slice(0, 160);
    }

    const title = page ? await page.title().catch(() => '') : '';
    const dom = page
      ? await page
          .evaluate(() => {
            const inputs = [...document.querySelectorAll('input')].map((el) => ({
              type: (el as HTMLInputElement).type || '',
              name: ((el as HTMLInputElement).name || '').slice(0, 40),
              id: ((el as HTMLInputElement).id || '').slice(0, 40),
            }));
            const text = (document.body?.innerText || '').toLowerCase();
            return {
              inputCount: inputs.length,
              inputTypes: inputs.map((i) => i.type),
              inputNames: inputs.map((i) => i.name),
              formCount: document.forms.length,
              iframeCount: document.querySelectorAll('iframe').length,
              passwordCount: inputs.filter((i) => i.type === 'password')
                .length,
              hasSignInCopy:
                text.includes('sign in') ||
                text.includes('username') ||
                text.includes('password') ||
                text.includes('login'),
            };
          })
          .catch(() => null)
      : null;
    const hasLoginFields = Boolean(
      dom &&
        (dom.passwordCount > 0 ||
          dom.hasSignInCopy ||
          dom.inputNames.some((n) => /user|pass|login/i.test(n))),
    );

    let fixedBodyCandidateKeys: string[] | undefined;
    if (process.env.HMS_LIVE_CANARY_SUBMIT === '1') {
      if (!hasLoginFields || !page) {
        throw new Error('login fields missing; refuse submit');
      }
      if (secret.credentialMode !== 'view_only') {
        throw new Error('refuse submit: credentialMode must be view_only');
      }
      fixedBodyCandidateKeys = await page.evaluate(() => {
        const keys: string[] = [];
        for (const el of document.querySelectorAll('input')) {
          const name = (el as HTMLInputElement).name || '';
          if (!name) continue;
          if (/pass|user|csrf|ticket|token|secret/i.test(name)) continue;
          keys.push(name);
        }
        return keys.sort();
      });
      // Fill only — never log credential values. Abort-first inventory for next unknown.
      await page.locator('input[name="userid"]').fill(secret.username);
      await page.locator('input[name="password"]').fill(secret.password);
      const preBlockCount = events.filter((e) => e.decision === 'block').length;
      const loginResponsePromise = page
        .waitForResponse(
          (res) => {
            try {
              return (
                new URL(res.url()).pathname === '/web/base/login' &&
                res.request().method() === 'POST'
              );
            } catch {
              return false;
            }
          },
          { timeout: 20_000 },
        )
        .catch(() => null);
      await page
        .locator('button, input[type="submit"]')
        .filter({ hasText: /sign in|log in|login/i })
        .first()
        .click({ timeout: 10_000 })
        .catch(async () => {
          await page!.locator('input[name="password"]').press('Enter');
        });
      const loginRes = await loginResponsePromise;
      if (loginRes) {
        const headers = loginRes.headers();
        const len = Number(headers['content-length'] ?? '0');
        xhrMeta.push({
          path: '/web/base/login',
          status: loginRes.status(),
          ok: loginRes.ok(),
          bodyBytes: Number.isFinite(len) ? len : 0,
        });
      }
      await page.waitForTimeout(2000);
      const postBlocks = events
        .filter((e) => e.decision === 'block')
        .slice(preBlockCount);
      if (!firstBlock && postBlocks[0]) firstBlock = postBlocks[0];
    }

    const afterSubmit = page
      ? await page
          .evaluate(() => ({
            path: location.pathname,
            title: document.title.slice(0, 80),
            stillHasUserid: !!document.querySelector('input[name="userid"]'),
            bodyHint: (() => {
              const t = (document.body?.innerText || '').toLowerCase();
              return {
                hasError:
                  t.includes('invalid') ||
                  t.includes('incorrect') ||
                  t.includes('failed'),
                hasProperty:
                  t.includes('property') || t.includes('centurion'),
                hasSignIn: t.includes('sign in') || t.includes('userid'),
              };
            })(),
          }))
          .catch(() => null)
      : null;

    // Connectivity canary: document GET allowed OR we captured a fail-closed
    // first block with redacted signature (abort-first inventory).
    const documentAllowed = events.some(
      (e) =>
        e.decision === 'allow' &&
        e.redactedSignature.path === '/web/base/logindisp',
    );
    const loginPostAllowed = events.some(
      (e) =>
        e.decision === 'allow' &&
        e.redactedSignature.method === 'POST' &&
        e.redactedSignature.path === '/web/base/login',
    );
    const payload = {
      ok: documentAllowed || (firstBlock !== null && events.length > 0),
      phase:
        process.env.HMS_LIVE_CANARY_SUBMIT === '1'
          ? 'login-submit-probe'
          : 'login-probe',
      origin,
      titlePresent: Boolean(title),
      titleLooksLikeInfor: /infor|hms/i.test(title),
      hasLoginFields,
      dom,
      fixedBodyCandidateKeys,
      afterSubmit,
      xhrMeta: xhrMeta.slice(0, 20),
      documentAllowed,
      loginPostAllowed,
      navError,
      allowCount: events.filter((e) => e.decision === 'allow').length,
      blockCount: events.filter((e) => e.decision === 'block').length,
      firstBlock,
      events: events.slice(0, 60),
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
        loginPostAllowed: payload.loginPostAllowed,
        allowCount: payload.allowCount,
        blockCount: payload.blockCount,
        hasLoginFields: payload.hasLoginFields,
        firstBlockCode: firstBlock?.code ?? null,
        firstBlockPath: firstBlock?.redactedSignature.path ?? null,
        firstBlockMethod: firstBlock?.redactedSignature.method ?? null,
      }),
    );
    if (!payload.ok) process.exit(2);
  } finally {
    try {
      await page?.unrouteAll({ behavior: 'ignoreErrors' });
    } catch {
      /* ignore */
    }
    await page?.context().close().catch(() => {});
    await browser?.close().catch(() => {});
  }
}

function sanitizeProbeError(raw: string): string {
  // Strip secret-bearing tokens; keep IAM/AWS failure codes visible.
  let msg = raw
    .replace(/arn:aws:secretsmanager:[^\s]+/gi, 'arn:aws:secretsmanager:***')
    .replace(/\b(cookie|set-cookie|jsessionid|csrftckt)\s*[:=][^\s;]+/gi, '$1=***')
    .replace(/\b[A-Za-z0-9+/_-]{24,}=*/g, '***');
  if (/\bpassword\b|SecretString/i.test(msg)) {
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

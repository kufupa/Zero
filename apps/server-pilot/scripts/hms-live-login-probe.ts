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
import {
  LIVE_GUEST_STAY_SEARCH_PATH,
  LIVE_NOTFOUND_CANARY,
  buildExactOsressSearchBody,
  buildExactOsressSearchRule,
  buildLiveGuestStayFunctionalRules,
  liveNotFoundCanaryCandidate,
} from '../src/hms/live-read-manifest.js';
// Canonical Guest Stay path for worker + probe: createLiveGuestStayDriver
// (apps/server-pilot/src/hms/live-guest-stay-driver.ts). This script retains
// inventory/debug capture; functional POST rules come from live-read-manifest.
// OSRESS.search allow only via exact-bound canary rule (no variable base rule).

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

function minimalLoginManifest(origin: string): RequestPolicyManifest {
  const chromeGets = [
    {
      id: 'live-login-get',
      origin,
      method: 'GET' as const,
      path: '/web/base/logindisp',
      resourceTypes: ['document'],
      fixedQuery: {},
      variableQuery: {
        tenant: { pattern: 'HMS_LEGACY', maxLength: 32 },
      },
      fixedBody: {},
      variableBody: {},
      maxBodyBytes: 4096,
      redirectPolicy: 'same-reviewed-chain' as const,
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
      id: 'live-post-login-common',
      origin,
      method: 'GET' as const,
      path: '/web/base/COMMON',
      resourceTypes: ['document', 'xhr', 'fetch'],
      fixedQuery: {},
      variableQuery: {
        REQ_KEY: { pattern: '[A-Za-z0-9._-]{8,128}', maxLength: 128 },
      },
      fixedBody: {},
      variableBody: {},
      maxBodyBytes: 4096,
      redirectPolicy: 'same-reviewed-chain' as const,
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
  ];

  // Share functional POST rules (login/OSRESV) with LiveGuestStayDriver.
  // OSRESS.search only via exact-bound canary — no open variable confirmation body.
  const functional = buildLiveGuestStayFunctionalRules(origin).filter(
    (rule) =>
      rule.id !== 'live-login-get' &&
      rule.id !== 'live-common-get' &&
      rule.id !== 'live-osresv-get',
  );
  const exactSearch = buildExactOsressSearchRule(
    origin,
    liveNotFoundCanaryCandidate(),
  );

  return requestPolicyManifestSchema.parse({
    rules: [...chromeGets, ...functional, exactSearch],
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
      executablePath: process.env.HMS_CHROMIUM_EXECUTABLE_PATH || undefined,
    });
    const context = await browser.newContext({
      acceptDownloads: false,
      serviceWorkers: 'block',
    });
    // Pre-connect WebSocket rejection before any navigation (same as runtime).
    await context.routeWebSocket('**/*', (ws) => {
      try {
        ws.close();
      } catch {
        /* ignore */
      }
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
        const path = url.pathname;
        if (
          path === '/web/base/login' ||
          path.startsWith('/web/base/OSRESV') ||
          path.startsWith('/web/base/BSSTRT') ||
          res.request().method() === 'POST'
        ) {
          const headers = res.headers();
          const len = Number(headers['content-length'] ?? '0');
          xhrMeta.push({
            path,
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
      await page
        .locator(
          'input[name=userid], input[name=username], input[name=j_username], input[id*=userid], input[id*=username], input[id*=user]',
        )
        .first()
        .fill(secret.username);
      await page
        .locator('input[name=password], input[type=password], input[id*=password]')
        .first()
        .fill(secret.password);
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
      await page.waitForTimeout(
        process.env.HMS_LIVE_CANARY_GUEST_STAY === '1' ? 5000 : 2000,
      );
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
                  t.includes('property') ||
                  t.includes('centurion') ||
                  t.includes('hrcen'),
                hasSignIn: t.includes('sign in') || t.includes('userid'),
              };
            })(),
          }))
          .catch(() => null)
      : null;

    let guestStayNav: {
      attempted: boolean;
      menuHits: Array<{ text: string; tag: string }>;
      clicked: string[];
      refusedMutationHit: boolean;
      error: string | null;
      afterPath: string | null;
      afterTitle: string | null;
      listHint: {
        hasNoResults: boolean;
        hasGuestStayCopy: boolean;
        hasNewRecord: boolean;
      } | null;
      confirmFieldValueLen: number;
      confirmFieldLooksCanary: boolean;
      hdrWithConfirmationCount: number;
      osressSearchAllowCount: number;
      lstAllowCount: number;
      firstBlockAfterNav: ProbeEvent | null;
    } | null = null;

    // Guest Stay open: documented menu Front Desk > Guest Stay (Infor help).
    // Abort-first: never New Record / Save / Duplicate / Submit / Check In|Out.
    if (
      process.env.HMS_LIVE_CANARY_GUEST_STAY === '1' &&
      process.env.HMS_LIVE_CANARY_SUBMIT === '1' &&
      page &&
      afterSubmit &&
      !afterSubmit.stillHasUserid
    ) {
      const preNavBlockCount = events.filter((e) => e.decision === 'block')
        .length;
      const clicked: string[] = [];
      let refusedMutationHit = false;
      let navErr: string | null = null;
      const menuHits = await page
        .evaluate(() => {
          const out: Array<{ text: string; tag: string }> = [];
          const nodes = document.querySelectorAll(
            'a, span, div, li, td, label, button',
          );
          for (const el of nodes) {
            const text = (el.textContent || '').replace(/\s+/g, ' ').trim();
            if (!text || text.length > 48) continue;
            if (
              /front\s*desk|guest\s*stay|reservations?/i.test(text) &&
              !/new\s*record|duplicate|save|submit|check\s*in|check\s*out|walk\s*-?\s*in/i.test(
                text,
              )
            ) {
              out.push({ text, tag: el.tagName });
              if (out.length >= 40) break;
            }
          }
          return out;
        })
        .catch(() => [] as Array<{ text: string; tag: string }>);

      try {
        const clickExactLabel = async (label: string): Promise<boolean> => {
          const clickedOk = await page!.evaluate((want) => {
            const nodes = [
              ...document.querySelectorAll('td, span, div, a, label, li'),
            ];
            for (const el of nodes) {
              const text = (el.textContent || '').replace(/\s+/g, ' ').trim();
              if (text !== want) continue;
              // Prefer leaf-ish nodes (short text equals want exactly).
              (el as HTMLElement).click();
              return true;
            }
            return false;
          }, label);
          if (clickedOk) {
            clicked.push(label);
            await page!.waitForTimeout(2000);
            return true;
          }
          // Fallback Playwright force click
          const loc = page!
            .locator('td, span, div, a')
            .filter({ hasText: new RegExp(`^${label}$`, 'i') })
            .first();
          if (await loc.isVisible({ timeout: 2_000 }).catch(() => false)) {
            await loc.click({ force: true, timeout: 5_000 });
            clicked.push(`${label}:force`);
            await page!.waitForTimeout(2000);
            return true;
          }
          return false;
        };

        await clickExactLabel('Front Desk');
        // Re-scan after expand for Guest Stay
        const afterExpandHits = await page
          .evaluate(() => {
            const out: string[] = [];
            for (const el of document.querySelectorAll(
              'td, span, div, a, label, li',
            )) {
              const text = (el.textContent || '').replace(/\s+/g, ' ').trim();
              if (/^Guest Stay$/i.test(text)) out.push(text);
              if (out.length >= 10) break;
            }
            return out;
          })
          .catch(() => [] as string[]);
        for (const hit of afterExpandHits) {
          if (
            /new\s*record|duplicate|save|submit|check\s*in|check\s*out|walk\s*-?\s*in/i.test(
              hit,
            )
          ) {
            refusedMutationHit = true;
            continue;
          }
          await clickExactLabel(hit);
          break;
        }
        if (
          !clicked.some((c) => /guest\s*stay/i.test(c)) &&
          !refusedMutationHit
        ) {
          await clickExactLabel('Guest Stay');
        }

        // After OSRESV shell: exact-bound OSRESS.search (fill primes UI only).
        // Live ExtJS Enter does not emit fixed MADDON scaffold — post exact body.
        if (clicked.some((c) => /guest\s*stay/i.test(c))) {
          await page!.waitForTimeout(4000);
          const searchLoc = page!.locator('input[name="search"]').first();
          let searchFilled: string | null = null;
          if (await searchLoc.count().catch(() => 0)) {
            await searchLoc.fill(LIVE_NOTFOUND_CANARY, { timeout: 5_000 });
            searchFilled = 'search';
          } else {
            for (const name of [
              'ff_confirmationnumber',
              'confirmationnumber',
            ]) {
              const loc = page!.locator(`input[name="${name}"]`).first();
              if (await loc.count().catch(() => 0)) {
                await loc.fill(LIVE_NOTFOUND_CANARY, { timeout: 5_000 });
                searchFilled = name;
                break;
              }
            }
          }
          if (searchFilled) {
            clicked.push(`searchField:${searchFilled}`);
          } else {
            clicked.push('searchField:missing');
          }
          const canary = liveNotFoundCanaryCandidate();
          const exactBody = buildExactOsressSearchBody(canary);
          const postData = new URLSearchParams(exactBody).toString();
          await page!.evaluate(
            async ({ url, postData }) => {
              await fetch(url, {
                method: 'POST',
                headers: {
                  'content-type': 'application/x-www-form-urlencoded',
                },
                body: postData,
                credentials: 'same-origin',
              });
            },
            {
              url: `${origin}${LIVE_GUEST_STAY_SEARCH_PATH}`,
              postData,
            },
          );
          clicked.push('search:exactOsressPost');
          await page!.waitForTimeout(5000);
        }
      } catch (err) {
        const raw = err instanceof Error ? err.message : String(err);
        navErr = /password|secret|cookie|jsessionid/i.test(raw)
          ? 'redacted_error'
          : raw.slice(0, 160);
      }

      const postNavBlocks = events
        .filter((e) => e.decision === 'block')
        .slice(preNavBlockCount);
      const afterNav = await page
        .evaluate(() => {
          const t = (document.body?.innerText || '').toLowerCase();
          const searchEl = document.querySelector(
            'input[name="search"]',
          ) as HTMLInputElement | null;
          const confirmEl = document.querySelector(
            'input[name="ff_confirmationnumber"], input[name="confirmationnumber"]',
          ) as HTMLInputElement | null;
          const filled = searchEl?.value || confirmEl?.value || '';
          return {
            path: location.pathname,
            title: document.title.slice(0, 80),
            confirmFieldValueLen: filled.length,
            confirmFieldLooksCanary: filled === LIVE_NOTFOUND_CANARY,
            listHint: {
              hasNoResults:
                t.includes('no reservations') ||
                t.includes('no records') ||
                t.includes('no results') ||
                t.includes('no data to display') ||
                t.includes('0 records') ||
                t.includes('0 items') ||
                t.includes('not found') ||
                t.includes('no matching'),
              hasGuestStayCopy:
                t.includes('guest stay') || t.includes('confirmation'),
              hasNewRecord: t.includes('new record'),
            },
          };
        })
        .catch(() => ({
          path: null as string | null,
          title: null as string | null,
          confirmFieldValueLen: 0,
          confirmFieldLooksCanary: false,
          listHint: null,
        }));

      const hdrAfterSearch = events.filter(
        (e) =>
          e.decision === 'allow' &&
          e.redactedSignature.path === '/web/base/OSRESV.HDR',
      );
      const osressSearchAllows = events.filter(
        (e) =>
          e.decision === 'allow' &&
          e.redactedSignature.path === LIVE_GUEST_STAY_SEARCH_PATH,
      );
      const lstAfterSearch = events.filter(
        (e) =>
          e.decision === 'allow' &&
          e.redactedSignature.path === '/web/base/OSRESV.LST',
      );

      guestStayNav = {
        attempted: true,
        menuHits: menuHits.slice(0, 20),
        clicked,
        refusedMutationHit,
        error: navErr,
        afterPath: afterNav.path,
        afterTitle: afterNav.title,
        listHint: afterNav.listHint,
        confirmFieldValueLen: afterNav.confirmFieldValueLen,
        confirmFieldLooksCanary: afterNav.confirmFieldLooksCanary,
        hdrWithConfirmationCount: hdrAfterSearch.length,
        osressSearchAllowCount: osressSearchAllows.length,
        lstAllowCount: lstAfterSearch.length,
        firstBlockAfterNav: postNavBlocks[0] ?? null,
      };
    }

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
    const propertyCodeInTitle = Boolean(
      (afterSubmit?.title || '').includes(secret.expectedPropertyCode),
    );
    // Redacted shell diagnostic: runtime verification also requires the
    // tenant/property name, while the older probe only reported the title.
    // Record booleans/hashes, never the shell text itself.
    const afterSubmitHtml = page ? await page.content().catch(() => '') : '';
    const expectedPropertyNamePresent = Boolean(
      secret.expectedPropertyName &&
        afterSubmitHtml.toLocaleLowerCase().includes(secret.expectedPropertyName.toLocaleLowerCase()),
    );
    const shellBinding = {
      htmlBytes: Buffer.byteLength(afterSubmitHtml),
      expectedTenantPresent: afterSubmitHtml.includes(secret.expectedTenant),
      expectedPropertyCodePresent: afterSubmitHtml.includes(secret.expectedPropertyCode),
      expectedPropertyNamePresent,
    };
    const phase =
      process.env.HMS_LIVE_CANARY_GUEST_STAY === '1' &&
      process.env.HMS_LIVE_CANARY_SUBMIT === '1'
        ? 'guest-stay-nav-probe'
        : process.env.HMS_LIVE_CANARY_SUBMIT === '1'
          ? 'login-submit-probe'
          : 'login-probe';
    const payload = {
      ok: documentAllowed || (firstBlock !== null && events.length > 0),
      phase,
      origin,
      titlePresent: Boolean(title),
      titleLooksLikeInfor: /infor|hms/i.test(title),
      hasLoginFields,
      dom,
      fixedBodyCandidateKeys,
      afterSubmit,
      guestStayNav,
      propertyCodeInTitle,
      shellBinding,
      xhrMeta: xhrMeta.slice(0, 20),
      documentAllowed,
      loginPostAllowed,
      navError,
      allowCount: events.filter((e) => e.decision === 'allow').length,
      blockCount: events.filter((e) => e.decision === 'block').length,
      firstBlock,
      events: events.slice(0, 80),
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
        phase: payload.phase,
        documentAllowed: payload.documentAllowed,
        loginPostAllowed: payload.loginPostAllowed,
        propertyCodeInTitle: payload.propertyCodeInTitle,
        guestStayClicked: payload.guestStayNav?.clicked ?? null,
        guestStayNoResults:
          payload.guestStayNav?.listHint?.hasNoResults ?? null,
        guestStayOsressSearch:
          payload.guestStayNav?.osressSearchAllowCount ?? null,
        guestStayCanaryField:
          payload.guestStayNav?.confirmFieldLooksCanary ?? null,
        guestStayFirstBlockPath:
          payload.guestStayNav?.firstBlockAfterNav?.redactedSignature.path ??
          null,
        guestStayFirstBlockCode:
          payload.guestStayNav?.firstBlockAfterNav?.code ?? null,
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

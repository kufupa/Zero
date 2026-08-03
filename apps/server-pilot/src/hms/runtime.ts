/**
 * HMS browser runtime — singleton Chromium, one-session semaphore, fail-closed
 * request policy, abort-first contexts, startup canary + circuit breaker.
 *
 * No production credentials. Secret loader injectable. BrowserFactory injectable
 * so fixture/unit tests run without live Chromium.
 */

import { randomUUID } from 'node:crypto';
import { chmod, mkdir, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { z } from 'zod';
import type { RequestDecision, RequestPolicyManifest } from './contracts.js';
import {
  contextCreationOptions,
  createBrowserEventGuards,
  enforceRequestPolicy,
  type PolicyRoute,
} from './request-policy.js';

export const hmsSecretSchema = z
  .object({
    loginUrl: z.string().url(),
    username: z.string().min(1),
    password: z.string().min(1),
    expectedTenant: z.string().min(1),
    expectedPropertyCode: z.string().min(1),
    expectedPropertyName: z.string().min(1),
    mailboxTransportId: z.string().min(1),
    credentialMode: z.enum(['audited_write', 'view_only']),
  })
  .strict();

export type HmsSecret = z.infer<typeof hmsSecretSchema>;

export type HmsHealthState =
  | 'stopped'
  | 'starting'
  | 'ready'
  | 'degraded'
  | 'circuit_open';

export type HmsHealth = {
  state: HmsHealthState;
  browserLaunches: number;
  contextsCreated: number;
  contextsClosed: number;
  activeSessions: number;
  lastErrorCode?: string;
  circuitOpenedAt?: string;
  checkedAt: string;
  staleAfterMs: number;
};

export type HmsReadSession = {
  id: string;
  origin: string;
  /** Last blocked policy decision (redacted), if any. */
  violation(): RequestDecision | null;
  /** True after policy block, abort, popup/download/ws, or close. */
  terminal(): boolean;
  /** Page surface for adapters / discovery (injectable browser). */
  page: HmsPage;
  close(): Promise<void>;
};

export type HmsPage = {
  goto(
    url: string,
    options?: { waitUntil?: string; timeout?: number },
  ): Promise<void>;
  content(): Promise<string>;
  close(): Promise<void>;
  setDefaultTimeout(ms: number): void;
  setDefaultNavigationTimeout(ms: number): void;
  /** Extract exact tenant/property header IDs from DOM (fail closed). */
  readPropertyBinding(): Promise<{
    tenant: string | null;
    propertyCode: string | null;
    propertyName: string | null;
  }>;
  fillLogin(username: string, password: string): Promise<void>;
  submitLogin(): Promise<void>;
  /**
   * POST url-encoded form through context route policy (canary / adapters).
   * Returns response body text. Live Playwright must not replace the SPA via
   * setContent — that destroys ExtJS and can trigger login form navigations.
   */
  postForm(url: string, fields: Record<string, string>): Promise<string>;
  click(selector: string): Promise<void>;
  /** Constrained fill — selector must be a reviewed static string. */
  fill(selector: string, value: string): Promise<void>;
  press(selector: string, key: string): Promise<void>;
  url(): string;
  title(): Promise<string>;
  /** Wait for path-correlated response after an action (optional on stubs). */
  waitForCorrelatedResponse?(pathSubstring: string): Promise<void>;
  /** Stable DOM read only — no free-form script from model code. */
  evaluateStableDom<T>(fn: () => T | Promise<T>): Promise<T>;
  /** @deprecated Prefer evaluateStableDom — kept for fixture adapters. */
  evaluate<T>(fn: () => T | Promise<T>): Promise<T>;
};

export type HmsDownloadEvent = { cancel(): Promise<void> };

export type HmsWebSocketRoute = {
  close(): void;
};

export type HmsBrowserContext = {
  route(
    url: string,
    handler: (route: PolicyRoute) => Promise<void> | void,
  ): Promise<void>;
  /** Must be installed before first navigation. */
  routeWebSocket(
    url: string,
    handler: (ws: HmsWebSocketRoute) => void,
  ): Promise<void>;
  newPage(): Promise<HmsPage>;
  close(): Promise<void>;
  pages(): HmsPage[];
  on(event: 'page', handler: (page: HmsPage) => void): void;
  on(event: 'download', handler: (download: HmsDownloadEvent) => void): void;
  on(event: 'websocket', handler: () => void): void;
};

export type HmsBrowser = {
  newContext(options: {
    acceptDownloads: false;
    serviceWorkers: 'block';
  }): Promise<HmsBrowserContext>;
  close(): Promise<void>;
};

export type BrowserFactory = (input: {
  executablePath?: string;
  signal?: AbortSignal;
}) => Promise<HmsBrowser>;

/** Process-wide Secrets Manager client stand-in — injectable; tests never pass real ARNs to AWS. */
export type HmsSecretLoader = (input: {
  secretArn: string;
  signal?: AbortSignal;
}) => Promise<unknown>;

export type HmsRuntime = {
  start(signal: AbortSignal): Promise<void>;
  openReadSession(input: {
    transportId: string;
    signal: AbortSignal;
    /** Per-session exact OSRESS.search candidate binding. */
    exactSearchCandidate?: import('./live-read-manifest.js').ExactReservationCandidate;
    /** Allow open before start() when LiveGuestStayDriver owns canary. */
    allowUnstarted?: boolean;
  }): Promise<HmsReadSession>;
  health(): HmsHealth;
  close(): Promise<void>;
  stats(): {
    browserLaunches: number;
    contextsCreated: number;
    contextsClosed: number;
  };
};

export type HmsRoleProofLoader = (
  path: string,
  now?: Date,
) => Promise<{
  schemaVersion: 1;
  propertyCode: 'HRCEN';
  allowedSurfaces: readonly string[];
  deniedActions: readonly string[];
  issuedAt: string;
  expiresAt: string;
  evidenceRef: string;
  evidenceSha256: string;
}>;

export type HmsRuntimeOptions = {
  manifest: RequestPolicyManifest;
  /** Exact Secrets Manager ARN in production; tests use fake ARNs + injectable loader. */
  secretArn: string;
  loadSecret: HmsSecretLoader;
  browserFactory: BrowserFactory;
  executablePath?: string;
  healthStatusPath?: string;
  /** Circuit recovery cooldown (ms). Default 30s. */
  circuitCooldownMs?: number;
  /** Per-navigation/locator budget (ms). Default 15s. */
  defaultTimeoutMs?: number;
  /** Require view_only for start canary (shadow/enabled). Default true. */
  requireViewOnly?: boolean;
  /** Manifest origin must match secret.loginUrl origin. */
  expectedOrigin?: string;
  /** Role-proof path — revalidated before every context creation when set. */
  roleProofPath?: string;
  loadRoleProof?: HmsRoleProofLoader;
  /** Health heartbeat interval (ms). Default 10s when healthStatusPath set. */
  healthHeartbeatMs?: number;
  /** Stale threshold written into health JSON. Default 30s. */
  healthStaleAfterMs?: number;
  /** Skip fixture reservation canary (live driver owns Guest Stay canary). */
  runStartupCanary?: boolean;
};

export const HEALTH_HEARTBEAT_MS = 10_000;
export const HEALTH_STALE_AFTER_MS = 30_000;

export class HmsRuntimeError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = 'HmsRuntimeError';
    this.code = code;
  }
}

function redactError(err: unknown): string {
  if (err instanceof HmsRuntimeError) return err.code;
  if (err instanceof Error) {
    const msg = err.message;
    // Never echo secrets / ARNs / cookies
    if (/password|secret|arn:aws|cookie|authorization/i.test(msg)) {
      return 'redacted_error';
    }
    return msg.slice(0, 120);
  }
  return 'unknown_error';
}

function assertNotAborted(signal: AbortSignal): void {
  if (signal.aborted) {
    throw new HmsRuntimeError('aborted', 'HMS operation aborted');
  }
}

function remainingBudgetMs(signal: AbortSignal, fallback: number): number {
  const deadline = (signal as AbortSignal & { deadlineMs?: number }).deadlineMs;
  if (typeof deadline === 'number') {
    return Math.max(1, deadline - Date.now());
  }
  return fallback;
}

export function withDeadline(
  signal: AbortSignal,
  timeoutMs: number,
): AbortSignal {
  const ctrl = new AbortController();
  const onAbort = () => ctrl.abort(signal.reason);
  signal.addEventListener('abort', onAbort, { once: true });
  const timer = setTimeout(() => ctrl.abort(new Error('timeout')), timeoutMs);
  (ctrl.signal as AbortSignal & { deadlineMs?: number }).deadlineMs =
    Date.now() + timeoutMs;
  ctrl.signal.addEventListener(
    'abort',
    () => {
      clearTimeout(timer);
      signal.removeEventListener('abort', onAbort);
    },
    { once: true },
  );
  return ctrl.signal;
}

function extractAttr(html: string, attr: string): string | null {
  const re = new RegExp(`${attr}="([^"]*)"`, 'i');
  const m = re.exec(html);
  return m?.[1] ?? null;
}

/** First `"key": "value"` (or `"key":"value"`) occurrence in HTML/JSON blobs. */
function extractJsonQuotedField(html: string, key: string): string | null {
  const re = new RegExp(`"${key}"\\s*:\\s*"([^"]*)"`, 'i');
  const m = re.exec(html);
  return m?.[1] ?? null;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Fixture pages use data-* attrs. Live Infor COMMON shell embeds
 * `"tenantid"` / `"property"` in config JSON and titles `Infor HMS - HRCEN`.
 * Property display name often appears only in banner text (no data attr).
 */
export function extractPropertyBindingFromDom(input: {
  html: string;
  title: string;
  pageUrl?: string;
}): {
  tenant: string | null;
  propertyCode: string | null;
  propertyName: string | null;
} {
  const { html, title, pageUrl } = input;
  let urlTenant: string | null = null;
  if (pageUrl) {
    try {
      urlTenant = new URL(pageUrl).searchParams.get('tenant');
    } catch {
      urlTenant = null;
    }
  }

  const titleProperty = /Infor HMS\s*-\s*([A-Z0-9]+)/i.exec(title)?.[1] ?? null;
  const propertyFromJson = extractJsonQuotedField(html, 'property');
  const userOrg = extractJsonQuotedField(html, 'userorg');

  return {
    tenant:
      extractAttr(html, 'data-tenant') ??
      extractJsonQuotedField(html, 'tenantid') ??
      urlTenant,
    propertyCode:
      extractAttr(html, 'data-property-code') ??
      titleProperty ??
      (/HRCEN/i.test(title) ? 'HRCEN' : null) ??
      (propertyFromJson && /^[A-Z0-9]{2,16}$/i.test(propertyFromJson)
        ? propertyFromJson
        : null) ??
      (userOrg && /^[A-Z0-9]{2,16}$/i.test(userOrg) ? userOrg : null),
    propertyName: extractAttr(html, 'data-property-name'),
  };
}

/** Live property name may omit data attr; require exact code+tenant+title+banner. */
export function livePropertyNameSatisfied(input: {
  html: string;
  title: string;
  expectedPropertyCode: string;
  expectedPropertyName: string;
  bindingPropertyName: string | null;
}): boolean {
  if (input.bindingPropertyName === input.expectedPropertyName) return true;
  if (input.bindingPropertyName != null) return false;
  const titleOk = new RegExp(
    `Infor HMS\\s*-\\s*${escapeRegExp(input.expectedPropertyCode)}`,
    'i',
  ).test(input.title);
  return titleOk && input.html.includes(input.expectedPropertyName);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isNavigationRaceError(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  return /navigat|Execution context was destroyed|changing the content|Target closed/i.test(
    msg,
  );
}

/**
 * Live login is async (COMMON shell + config JSON). Fixture returns attrs
 * immediately. Poll until tenant+propertyCode extractable or budget exhausted.
 */
export async function waitForAuthenticatedShell(
  page: HmsPage,
  secret: Pick<
    HmsSecret,
    'expectedTenant' | 'expectedPropertyCode' | 'expectedPropertyName'
  >,
  timeoutMs: number,
): Promise<void> {
  const deadline = Date.now() + Math.max(500, timeoutMs);
  while (Date.now() < deadline) {
    try {
      const html = await page.content();
      const title = await page.title();
      const binding = extractPropertyBindingFromDom({
        html,
        title,
        pageUrl: page.url(),
      });
      if (
        binding.tenant === secret.expectedTenant &&
        binding.propertyCode === secret.expectedPropertyCode &&
        livePropertyNameSatisfied({
          html,
          title,
          expectedPropertyCode: secret.expectedPropertyCode,
          expectedPropertyName: secret.expectedPropertyName,
          bindingPropertyName: binding.propertyName,
        })
      ) {
        return;
      }
      // Fixture: data-* attrs present (name included).
      if (
        extractAttr(html, 'data-tenant') &&
        extractAttr(html, 'data-property-code') &&
        extractAttr(html, 'data-property-name')
      ) {
        return;
      }
    } catch (err) {
      if (!isNavigationRaceError(err)) throw err;
    }
    await sleep(250);
  }
  throw new HmsRuntimeError('AUTH_FAILED', 'post-login shell not ready');
}

/**
 * Fetch-backed page for fixture tests (no Chromium). Applies context route
 * handlers before network I/O so policy can abort unknown/mutation requests.
 */
export function createFetchBrowserFactory(
  routeHandlers: Array<(route: PolicyRoute) => Promise<void>> = [],
): BrowserFactory {
  return async () => {
    let closed = false;
    const contexts: FetchContext[] = [];

    class FetchPage implements HmsPage {
      #html = '';
      #defaultTimeout = 10_000;
      #navTimeout = 15_000;
      #closed = false;
      #url = '';
      constructor(private readonly ctx: FetchContext) {}

      setDefaultTimeout(ms: number) {
        this.#defaultTimeout = ms;
      }
      setDefaultNavigationTimeout(ms: number) {
        this.#navTimeout = ms;
      }

      url() {
        return this.#url || this.ctx.lastOrigin || '';
      }

      async title() {
        const m = /<title>([^<]*)<\/title>/i.exec(this.#html);
        return m?.[1] ?? '';
      }

      async goto(url: string, options?: { timeout?: number }) {
        this.#assertOpen();
        const decision = await this.ctx.dispatchRoute({
          url,
          method: 'GET',
          resourceType: 'document',
          headers: {},
          postData: null,
        });
        if (decision?.action === 'block') {
          throw new HmsRuntimeError(
            decision.code,
            `navigation blocked: ${decision.code}`,
          );
        }
        const timeout = options?.timeout ?? this.#navTimeout;
        const ctrl = new AbortController();
        const timer = setTimeout(() => ctrl.abort(), timeout);
        try {
          const res = await fetch(url, {
            redirect: 'manual',
            signal: ctrl.signal,
          });
          if (res.status >= 300 && res.status < 400) {
            const loc = res.headers.get('location');
            if (loc) {
              const next = new URL(loc, url).toString();
              await this.goto(next, options);
              return;
            }
          }
          this.#html = await res.text();
          this.#url = url;
        } finally {
          clearTimeout(timer);
        }
      }

      async content() {
        this.#assertOpen();
        return this.#html;
      }

      async readPropertyBinding() {
        return extractPropertyBindingFromDom({
          html: this.#html,
          title: await this.title(),
          pageUrl: this.#url,
        });
      }

      async fillLogin(username: string, password: string) {
        this.#assertOpen();
        const hasUserid = /name="userid"/i.test(this.#html);
        const hasUsername = /name="username"/i.test(this.#html);
        if (!hasUserid && !hasUsername) {
          throw new HmsRuntimeError('malformed_dom', 'login form missing');
        }
        // Store for submit — no credentials in logs
        this.ctx.pendingLogin = { username, password };
      }

      async submitLogin() {
        this.#assertOpen();
        const creds = this.ctx.pendingLogin;
        if (!creds) throw new HmsRuntimeError('login_state', 'fill login first');
        const actionMatch = /action="([^"]+)"/i.exec(this.#html);
        const action = actionMatch?.[1] ?? '/session';
        const base = this.ctx.lastOrigin ?? 'http://127.0.0.1';
        const url = new URL(action, base).toString();
        const hasUserid = /name="userid"/i.test(this.#html);
        if (hasUserid) {
          await this.postForm(url, {
            userid: creds.username,
            password: creds.password,
            tenant: 'HMS_LEGACY',
            csrftckt: 'fixture',
            resetpassword: '',
            SYSTEM_FUNCTION_NAME: '',
            USER_FUNCTION_NAME: '',
          });
        } else {
          await this.postForm(url, {
            username: creds.username,
            password: creds.password,
          });
        }
      }

      async postForm(url: string, fields: Record<string, string>) {
        this.#assertOpen();
        const postData = new URLSearchParams(fields).toString();
        const path = new URL(url).pathname;
        const resourceType = path.includes('/web/') ? 'xhr' : 'document';
        const decision = await this.ctx.dispatchRoute({
          url,
          method: 'POST',
          resourceType,
          headers: {
            'content-type': 'application/x-www-form-urlencoded',
          },
          postData,
        });
        if (decision?.action === 'block') {
          throw new HmsRuntimeError(
            decision.code,
            `post blocked: ${decision.code}`,
          );
        }
        const res = await fetch(url, {
          method: 'POST',
          headers: { 'content-type': 'application/x-www-form-urlencoded' },
          body: postData,
          redirect: 'manual',
        });
        const loc = res.headers.get('location');
        if (loc) {
          await this.goto(new URL(loc, url).toString());
          return this.#html;
        }
        this.#html = await res.text();
        this.#url = url;
        return this.#html;
      }

      async click(selector: string) {
        this.#assertOpen();
        void selector;
        void this.#defaultTimeout;
      }

      async fill(selector: string, value: string) {
        this.#assertOpen();
        // Reflect filled value into fixture HTML for canary field checks
        const nameMatch = /name=["']([^"']+)["']/.exec(selector);
        if (nameMatch) {
          const name = nameMatch[1]!;
          const re = new RegExp(
            `(<input[^>]*name="${name}"[^>]*)(/?>)`,
            'i',
          );
          if (re.test(this.#html)) {
            this.#html = this.#html.replace(re, `$1 value="${value}"$2`);
          } else {
            this.#html += `<input name="${name}" value="${value}" />`;
          }
          this.ctx.pendingSearchValue = value;
        }
      }

      async press(selector: string, key: string) {
        this.#assertOpen();
        if (key !== 'Enter') return;
        const value = this.ctx.pendingSearchValue;
        if (!value) return;
        const origin = this.ctx.lastOrigin ?? 'http://127.0.0.1';
        const { buildExactOsressSearchBody } = await import(
          './live-read-manifest.js'
        );
        await this.postForm(
          `${origin}/web/base/OSRESS.search`,
          buildExactOsressSearchBody({
            id: 'fixture',
            kind: 'confirmation',
            value,
          }),
        );
        void selector;
      }

      async waitForCorrelatedResponse(_pathSubstring: string) {
        this.#assertOpen();
      }

      async evaluateStableDom<T>(fn: () => T | Promise<T>): Promise<T> {
        return this.evaluate(fn);
      }

      async evaluate<T>(fn: () => T | Promise<T>): Promise<T> {
        this.#assertOpen();
        return fn();
      }

      async close() {
        this.#closed = true;
      }

      #assertOpen() {
        if (this.#closed || this.ctx.closed || closed) {
          throw new HmsRuntimeError('context_closed', 'page/context closed');
        }
      }
    }

    class FetchContext implements HmsBrowserContext {
      closed = false;
      pendingLogin: { username: string; password: string } | null = null;
      pendingSearchValue: string | null = null;
      lastOrigin: string | null = null;
      #pages: FetchPage[] = [];
      #handlers: Array<(route: PolicyRoute) => Promise<void>> = [
        ...routeHandlers,
      ];
      #pageListeners: Array<(page: HmsPage) => void> = [];
      #downloadListeners: Array<(download: HmsDownloadEvent) => void> = [];
      #websocketListeners: Array<() => void> = [];
      #wsRouteInstalled = false;
      lastViolation: RequestDecision | null = null;

      async route(
        _url: string,
        handler: (route: PolicyRoute) => Promise<void> | void,
      ) {
        this.#handlers.push(async (route) => {
          await handler(route);
        });
      }

      async routeWebSocket(
        _url: string,
        handler: (ws: HmsWebSocketRoute) => void,
      ) {
        this.#wsRouteInstalled = true;
        this.#websocketListeners.push(() => {
          handler({ close() {} });
        });
      }

      get wsRouteInstalled() {
        return this.#wsRouteInstalled;
      }

      async dispatchRoute(input: {
        url: string;
        method: string;
        resourceType: string;
        headers: Record<string, string>;
        postData: string | null;
        redirectedFrom?: string | null;
      }): Promise<RequestDecision | null> {
        this.lastOrigin = new URL(input.url).origin;
        let continued = false;
        let aborted = false;
        let captured: RequestDecision | null = null;

        const route: PolicyRoute & {
          __decision?: RequestDecision;
        } = {
          request() {
            return {
              url: () => input.url,
              method: () => input.method,
              resourceType: () => input.resourceType,
              headers: () => input.headers,
              postData: () => input.postData,
              redirectedFrom: () =>
                input.redirectedFrom
                  ? { url: () => input.redirectedFrom as string }
                  : null,
              isNavigationRequest: () => input.resourceType === 'document',
            };
          },
          async continue() {
            continued = true;
          },
          async abort(_errorCode?: string) {
            aborted = true;
          },
        };

        for (const handler of this.#handlers) {
          await handler(route);
          if (route.__decision) captured = route.__decision;
        }

        if (aborted && !continued) {
          this.lastViolation = captured;
          return (
            captured ?? {
              action: 'block',
              code: 'blockedbyclient',
              redactedSignature: {
                method: input.method,
                origin: new URL(input.url).origin,
                path: new URL(input.url).pathname,
                resourceType: input.resourceType,
                queryKeys: [],
                bodyKeys: [],
                bodyBytes: Buffer.byteLength(input.postData ?? ''),
              },
            }
          );
        }
        return null;
      }

      async newPage() {
        const page = new FetchPage(this);
        this.#pages.push(page);
        for (const listener of this.#pageListeners) listener(page);
        return page;
      }

      pages() {
        return [...this.#pages];
      }

      on(
        event: 'page' | 'download' | 'websocket',
        handler:
          | ((page: HmsPage) => void)
          | ((download: HmsDownloadEvent) => void)
          | (() => void),
      ) {
        if (event === 'page') {
          this.#pageListeners.push(handler as (page: HmsPage) => void);
        } else if (event === 'download') {
          this.#downloadListeners.push(
            handler as (download: HmsDownloadEvent) => void,
          );
        } else if (event === 'websocket') {
          this.#websocketListeners.push(handler as () => void);
        }
      }

      /** Test helper: emit download/ws for guard coverage. */
      emitDownload(download: HmsDownloadEvent = { cancel: async () => {} }) {
        for (const listener of this.#downloadListeners) listener(download);
      }

      emitWebSocket() {
        for (const listener of this.#websocketListeners) listener();
      }

      async close() {
        this.closed = true;
        for (const page of this.#pages) await page.close();
        this.#pages = [];
      }
    }

    return {
      async newContext() {
        if (closed) throw new HmsRuntimeError('browser_closed', 'browser closed');
        const ctx = new FetchContext();
        contexts.push(ctx);
        return ctx;
      },
      async close() {
        closed = true;
        for (const ctx of contexts) await ctx.close();
        contexts.length = 0;
      },
    };
  };
}

async function writeHealthFile(
  path: string | undefined,
  health: HmsHealth,
): Promise<void> {
  if (!path) return;
  const payload = JSON.stringify({
    schemaVersion: 1,
    pid: process.pid,
    ...health,
  });
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.${process.pid}.tmp`;
  try {
    await writeFile(temporary, payload, { mode: 0o600 });
    await chmod(temporary, 0o600);
    await rename(temporary, path);
  } catch {
    // Windows may EPERM on rename while heartbeat overlaps close — direct write.
    await writeFile(path, payload, { mode: 0o600 });
  }
  try {
    await chmod(path, 0o600);
  } catch {
    /* windows may ignore */
  }
}

function manifestOrigin(manifest: RequestPolicyManifest): string {
  const origins = new Set(manifest.rules.map((r) => r.origin));
  if (origins.size !== 1) {
    throw new HmsRuntimeError(
      'manifest_origin',
      'manifest must have exactly one origin',
    );
  }
  return [...origins][0]!;
}

export function createHmsRuntime(options: HmsRuntimeOptions): HmsRuntime {
  const timeoutMs = options.defaultTimeoutMs ?? 15_000;
  const cooldownMs = options.circuitCooldownMs ?? 30_000;
  const requireViewOnly = options.requireViewOnly ?? true;
  const staleAfterMs = options.healthStaleAfterMs ?? HEALTH_STALE_AFTER_MS;
  const heartbeatMs = options.healthHeartbeatMs ?? HEALTH_HEARTBEAT_MS;
  const runStartupCanary = options.runStartupCanary ?? true;

  let browser: HmsBrowser | null = null;
  let cachedSecret: HmsSecret | null = null;
  let browserLaunches = 0;
  let contextsCreated = 0;
  let contextsClosed = 0;
  let activeSessions = 0;
  let sessionLock: Promise<void> = Promise.resolve();
  let state: HmsHealthState = 'stopped';
  let lastErrorCode: string | undefined;
  let circuitOpenedAt: number | undefined;
  let started = false;
  let heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  let transientRetries = 0;

  const health = (): HmsHealth => ({
    state,
    browserLaunches,
    contextsCreated,
    contextsClosed,
    activeSessions,
    lastErrorCode,
    circuitOpenedAt: circuitOpenedAt
      ? new Date(circuitOpenedAt).toISOString()
      : undefined,
    checkedAt: new Date().toISOString(),
    staleAfterMs,
  });

  function stopHeartbeat() {
    if (heartbeatTimer) {
      clearInterval(heartbeatTimer);
      heartbeatTimer = null;
    }
  }

  function startHeartbeat() {
    stopHeartbeat();
    if (!options.healthStatusPath) return;
    heartbeatTimer = setInterval(() => {
      void writeHealthFile(options.healthStatusPath, health());
    }, heartbeatMs);
    if (typeof heartbeatTimer === 'object' && 'unref' in heartbeatTimer) {
      heartbeatTimer.unref();
    }
  }

  async function revalidateRoleProof(): Promise<void> {
    if (!options.roleProofPath) return;
    const loader =
      options.loadRoleProof ??
      (async (path: string) => {
        const { loadHmsReadRoleProof } = await import('./production-runtime.js');
        return loadHmsReadRoleProof(path);
      });
    try {
      await loader(options.roleProofPath, new Date());
    } catch (err) {
      if (err instanceof HmsRuntimeError) throw err;
      throw new HmsRuntimeError(
        'ROLE_PROOF_MISSING',
        redactError(err),
      );
    }
  }

  async function getSecret(signal?: AbortSignal): Promise<HmsSecret> {
    if (cachedSecret) return cachedSecret;
    try {
      const raw = await options.loadSecret({
        secretArn: options.secretArn,
        signal,
      });
      const secret = hmsSecretSchema.parse(raw);
      const loginOrigin = new URL(secret.loginUrl).origin;
      const expected =
        options.expectedOrigin ?? manifestOrigin(options.manifest);
      if (loginOrigin !== expected) {
        throw new HmsRuntimeError(
          'login_origin_mismatch',
          'login URL origin does not match manifest origin',
        );
      }
      if (requireViewOnly && secret.credentialMode !== 'view_only') {
        throw new HmsRuntimeError(
          'credential_mode',
          'HMS runtime requires view_only credentials',
        );
      }
      cachedSecret = secret;
      return secret;
    } catch (err) {
      cachedSecret = null;
      if (err instanceof HmsRuntimeError) throw err;
      if (err instanceof z.ZodError) {
        throw new HmsRuntimeError('secret_invalid', 'HMS secret schema invalid');
      }
      throw new HmsRuntimeError('secret_load_failed', redactError(err));
    }
  }

  async function getBrowser(signal: AbortSignal): Promise<HmsBrowser> {
    assertNotAborted(signal);
    if (browser) return browser;
    try {
      browser = await options.browserFactory({
        executablePath: options.executablePath,
        signal,
      });
      browserLaunches += 1;
      return browser;
    } catch (err) {
      throw new HmsRuntimeError('chromium_failed', redactError(err));
    }
  }

  function assertCircuitClosed(): void {
    if (state !== 'circuit_open') return;
    if (
      circuitOpenedAt &&
      Date.now() - circuitOpenedAt >= cooldownMs
    ) {
      // recovery window — allow start/canary to re-probe
      state = 'degraded';
      lastErrorCode = undefined;
      return;
    }
    throw new HmsRuntimeError('circuit_open', 'HMS circuit open');
  }

  function openCircuit(code: string): void {
    state = 'circuit_open';
    lastErrorCode = code;
    circuitOpenedAt = Date.now();
  }

  async function verifyProperty(
    page: HmsPage,
    secret: HmsSecret,
  ): Promise<void> {
    const deadline = Date.now() + 5_000;
    let lastNavErr: unknown;
    while (Date.now() < deadline) {
      try {
        const binding = await page.readPropertyBinding();
        if (binding.tenant !== secret.expectedTenant) {
          throw new HmsRuntimeError('wrong_tenant', 'tenant ID mismatch');
        }
        if (binding.propertyCode !== secret.expectedPropertyCode) {
          throw new HmsRuntimeError('wrong_property', 'property code mismatch');
        }
        if (binding.propertyName === secret.expectedPropertyName) return;
        const html = await page.content();
        const title = await page.title();
        if (
          livePropertyNameSatisfied({
            html,
            title,
            expectedPropertyCode: secret.expectedPropertyCode,
            expectedPropertyName: secret.expectedPropertyName,
            bindingPropertyName: binding.propertyName,
          })
        ) {
          return;
        }
        throw new HmsRuntimeError('wrong_property', 'property name mismatch');
      } catch (err) {
        if (err instanceof HmsRuntimeError) throw err;
        if (!isNavigationRaceError(err)) throw err;
        lastNavErr = err;
        await sleep(250);
      }
    }
    throw new HmsRuntimeError(
      'session_failed',
      lastNavErr instanceof Error
        ? lastNavErr.message.slice(0, 120)
        : 'property verify interrupted by navigation',
    );
  }

  /**
   * Startup canary (orchestrator may later run live):
   * 1. Login
   * 2. Verify tenant/property exact IDs
   * 3. One reservation not-found read
   * 4. Room Availability or Display Rates only after manifest approval
   * 5. Close context
   * Runtime stays unavailable if any step fails.
   */
  async function runCanary(signal: AbortSignal): Promise<void> {
    const session = await openReadSessionInternal({
      transportId: (await getSecret(signal)).mailboxTransportId,
      signal,
      canary: true,
    });
    try {
      const secret = await getSecret(signal);
      const origin = new URL(secret.loginUrl).origin;
      // Step 3: reservation not-found read (real search path, not page shell only)
      await session.page.goto(`${origin}/reservations`, {
        timeout: remainingBudgetMs(signal, timeoutMs),
      });
      await session.page.postForm(`${origin}/web/reservation/search`, {
        action: 'search',
        tenant: secret.expectedTenant,
        property: secret.expectedPropertyCode,
        confirmationNumber: 'NOTFOUND-CANARY',
        surname: '',
      });
      const searchHtml = await session.page.content();
      if (!/data-testid="no-results"|No reservations found/i.test(searchHtml)) {
        throw new HmsRuntimeError(
          'canary_reservation',
          'canary expected reservation not-found result',
        );
      }
      // Step 4: harmless Room Availability if rule present
      const hasRooms = options.manifest.rules.some(
        (r) => r.path === '/availability/rooms',
      );
      if (hasRooms) {
        await session.page.goto(
          `${origin}/availability/rooms?view=inventory&startDate=2099-01-01`,
          { timeout: remainingBudgetMs(signal, timeoutMs) },
        );
      }
    } finally {
      await session.close();
    }
  }

  async function openReadSessionInternal(input: {
    transportId: string;
    signal: AbortSignal;
    canary?: boolean;
    exactSearchCandidate?: import('./live-read-manifest.js').ExactReservationCandidate;
    allowUnstarted?: boolean;
  }): Promise<HmsReadSession> {
    assertNotAborted(input.signal);
    if (!input.canary) assertCircuitClosed();
    if (!started && !input.canary && !input.allowUnstarted) {
      throw new HmsRuntimeError('not_started', 'HMS runtime not started');
    }

    await revalidateRoleProof();

    const secret = await getSecret(input.signal);
    if (input.transportId !== secret.mailboxTransportId) {
      throw new HmsRuntimeError(
        'transport_mismatch',
        'transportId does not match secret mailboxTransportId',
      );
    }

    let sessionManifest = options.manifest;
    if (input.exactSearchCandidate) {
      const { buildExactOsressSearchManifest } = await import(
        './live-read-manifest.js'
      );
      sessionManifest = buildExactOsressSearchManifest(
        new URL(secret.loginUrl).origin,
        input.exactSearchCandidate,
      );
    }

    const release = await acquireSessionLock();
    activeSessions += 1;

    let context: HmsBrowserContext | null = null;
    let lastViolation: RequestDecision | null = null;
    let terminal = false;
    let released = false;
    let closedCounted = false;
    const guards = createBrowserEventGuards(sessionManifest);

    const releaseOnce = () => {
      if (released) return;
      released = true;
      activeSessions = Math.max(0, activeSessions - 1);
      release();
    };

    const teardown = async () => {
      input.signal.removeEventListener('abort', closeOnAbort);
      try {
        if (context) {
          await context.close();
          if (!closedCounted) {
            closedCounted = true;
            contextsClosed += 1;
          }
        }
      } catch {
        /* ignore close errors */
      } finally {
        releaseOnce();
      }
    };

    const closeOnAbort = () => {
      terminal = true;
      void teardown();
    };
    input.signal.addEventListener('abort', closeOnAbort, { once: true });

    try {
      const b = await getBrowser(input.signal);
      context = await b.newContext(contextCreationOptions());
      contextsCreated += 1;

      // Pre-connect WebSocket rejection BEFORE any navigation.
      await context.routeWebSocket('**/*', (ws) => {
        guards.handleWebSocket();
        lastViolation = guards.lastBlock();
        terminal = true;
        ws.close();
        void teardown();
      });

      await context.route('**/*', async (route) => {
        const decision = await enforceRequestPolicy(route, sessionManifest, {
          onDecision: (d) => {
            if (d.action === 'block') lastViolation = d;
          },
        });
        (route as PolicyRoute & { __decision?: RequestDecision }).__decision =
          decision;
        if (decision.action === 'block') {
          lastViolation = decision;
          terminal = true;
          // Do not await: Playwright context.close waits for active route
          // handlers (PW 1.52+). Fire-and-forget matches abort/ws path.
          void teardown();
        }
      });

      let sawPrimaryPage = false;
      context.on('page', (page) => {
        if (!sawPrimaryPage) {
          sawPrimaryPage = true;
          return;
        }
        void (async () => {
          await guards.handlePopup(page);
          lastViolation = guards.lastBlock();
          terminal = true;
          void teardown();
        })();
      });
      context.on('download', (download) => {
        void (async () => {
          await guards.handleDownload(download);
          lastViolation = guards.lastBlock();
          terminal = true;
          void teardown();
        })();
      });
      context.on('websocket', () => {
        guards.handleWebSocket();
        lastViolation = guards.lastBlock();
        terminal = true;
        void teardown();
      });

      const page = await context.newPage();
      sawPrimaryPage = true;
      page.setDefaultTimeout(timeoutMs);
      page.setDefaultNavigationTimeout(timeoutMs);

      await page.goto(secret.loginUrl, {
        timeout: remainingBudgetMs(input.signal, timeoutMs),
      });
      await page.fillLogin(secret.username, secret.password);
      await page.submitLogin();
      await waitForAuthenticatedShell(
        page,
        secret,
        remainingBudgetMs(input.signal, timeoutMs),
      );
      await verifyProperty(page, secret);

      if (!started && input.allowUnstarted) {
        started = true;
        state = 'ready';
      }

      const sessionId = randomUUID();

      return {
        id: sessionId,
        origin: new URL(secret.loginUrl).origin,
        violation: () => lastViolation,
        terminal: () => terminal,
        page,
        close: async () => {
          terminal = true;
          await teardown();
        },
      };
    } catch (err) {
      terminal = true;
      await teardown();

      const code =
        err instanceof HmsRuntimeError ? err.code : redactError(err);
      if (code === 'wrong_tenant' || code === 'wrong_property') {
        openCircuit(code);
        await writeHealthFile(options.healthStatusPath, health());
      } else if (
        code === 'chromium_failed' ||
        code === 'TRANSIENT_NETWORK' ||
        /net::|ECONNRESET|ETIMEDOUT/i.test(String(code))
      ) {
        // One bounded retry for transient browser/network only.
        if (transientRetries < 1) {
          transientRetries += 1;
          cachedSecret = null;
          browser = null;
          throw new HmsRuntimeError('TRANSIENT_NETWORK', String(code));
        }
      } else if (
        /ROLE_PROOF|AUTH_FAILED|POLICY_BLOCK|SCHEMA_DRIFT|credential|wrong_/i.test(
          String(code),
        )
      ) {
        // Permanent — stay quiesced / degraded, no retry.
        state = state === 'circuit_open' ? state : 'degraded';
        lastErrorCode = code;
      }
      cachedSecret = null;
      throw err instanceof HmsRuntimeError
        ? err
        : new HmsRuntimeError('session_failed', String(code));
    }
  }

  function acquireSessionLock(): Promise<() => void> {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const prev = sessionLock;
    sessionLock = prev.then(() => gate);
    return prev.then(() => release);
  }

  return {
    async start(signal: AbortSignal) {
      assertNotAborted(signal);
      if (started && state === 'ready') return;
      assertCircuitClosed();
      state = 'starting';
      lastErrorCode = undefined;
      try {
        await revalidateRoleProof();
        await getSecret(signal);
        await getBrowser(signal);
        if (runStartupCanary) {
          await runCanary(signal);
        }
        started = true;
        state = 'ready';
        lastErrorCode = undefined;
        transientRetries = 0;
        await writeHealthFile(options.healthStatusPath, health());
        startHeartbeat();
      } catch (err) {
        started = false;
        stopHeartbeat();
        const code =
          err instanceof HmsRuntimeError ? err.code : redactError(err);
        if (code === 'wrong_tenant' || code === 'wrong_property') {
          openCircuit(code);
        } else if (code !== 'circuit_open') {
          state = 'degraded';
          lastErrorCode = code;
        }
        await writeHealthFile(options.healthStatusPath, health());
        throw err instanceof HmsRuntimeError
          ? err
          : new HmsRuntimeError('start_failed', String(code));
      }
    },

    openReadSession(input) {
      return openReadSessionInternal({
        ...input,
        canary: false,
        exactSearchCandidate: input.exactSearchCandidate,
        allowUnstarted: input.allowUnstarted,
      });
    },

    health,

    stats: () => ({ browserLaunches, contextsCreated, contextsClosed }),

    async close() {
      started = false;
      state = 'stopped';
      cachedSecret = null;
      stopHeartbeat();
      // Let in-flight heartbeat write settle before final write.
      await new Promise((r) => setTimeout(r, 0));
      try {
        await browser?.close();
      } finally {
        browser = null;
        activeSessions = 0;
        await writeHealthFile(options.healthStatusPath, health());
      }
    },
  };
}

/** Required Playwright factory — production composition must use this (or equivalent). */
export function createPlaywrightBrowserFactory(): BrowserFactory {
  return async ({ executablePath, signal }) => {
    assertNotAborted(signal ?? new AbortController().signal);
    const pw = await import('playwright');
    const browser = await pw.chromium.launch({
      executablePath,
      headless: true,
    });
    return {
      async newContext(opts) {
        const context = await browser.newContext(opts);
        return {
          async route(url, handler) {
            await context.route(url, async (route) => {
              const req = route.request();
              const redirected = req.redirectedFrom();
              const adapter: PolicyRoute = {
                request: () => ({
                  url: () => req.url(),
                  method: () => req.method(),
                  resourceType: () => req.resourceType(),
                  headers: () => req.headers(),
                  postData: () => req.postData(),
                  redirectedFrom: () =>
                    redirected ? { url: () => redirected.url() } : null,
                  isNavigationRequest: () => req.isNavigationRequest(),
                }),
                continue: () => route.continue(),
                abort: (code?: string) => route.abort(code),
              };
              await handler(adapter);
            });
          },
          async routeWebSocket(url, handler) {
            await context.routeWebSocket(url, (ws) => {
              handler({
                close() {
                  try {
                    ws.close();
                  } catch {
                    /* ignore */
                  }
                },
              });
            });
          },
          async newPage() {
            const page = await context.newPage();
            return wrapPlaywrightPage(page);
          },
          async close() {
            await context.close();
          },
          pages() {
            return context.pages().map(wrapPlaywrightPage);
          },
          on(
            event: 'page' | 'download' | 'websocket',
            handler:
              | ((page: HmsPage) => void)
              | ((download: HmsDownloadEvent) => void)
              | (() => void),
          ) {
            if (event === 'page') {
              context.on('page', (p) =>
                (handler as (page: HmsPage) => void)(wrapPlaywrightPage(p)),
              );
            } else if (event === 'download') {
              (
                context as unknown as {
                  on(
                    event: 'download',
                    listener: (download: { cancel(): Promise<void> }) => void,
                  ): void;
                }
              ).on('download', (d) =>
                (handler as (download: HmsDownloadEvent) => void)({
                  cancel: () => d.cancel(),
                }),
              );
            } else if (event === 'websocket') {
              context.on('page', (p) => {
                p.on('websocket', () => {
                  (handler as () => void)();
                });
              });
            }
          },
        };
      },
      async close() {
        await browser.close();
      },
    };
  };
}

/** Optional real Playwright factory — only when playwright is installed. */
export async function tryCreatePlaywrightBrowserFactory(): Promise<BrowserFactory | null> {
  try {
    await import('playwright');
    return createPlaywrightBrowserFactory();
  } catch {
    return null;
  }
}

function wrapPlaywrightPage(page: {
  goto(url: string, options?: { waitUntil?: 'domcontentloaded'; timeout?: number }): Promise<unknown>;
  content(): Promise<string>;
  close(): Promise<void>;
  setDefaultTimeout(ms: number): void;
  setDefaultNavigationTimeout(ms: number): void;
  setContent?(html: string): Promise<void>;
  url(): string;
  title(): Promise<string>;
  locator(selector: string): {
    fill(value: string): Promise<void>;
    click(options?: { force?: boolean; timeout?: number }): Promise<void>;
    press(key: string): Promise<void>;
    count(): Promise<number>;
    nth(index: number): {
      isVisible(): Promise<boolean>;
      scrollIntoViewIfNeeded(): Promise<void>;
      click(options?: { force?: boolean; timeout?: number }): Promise<void>;
    };
    first(): {
      click(options?: { force?: boolean; timeout?: number }): Promise<void>;
    };
  };
  getByLabel(text: string): { fill(value: string): Promise<void> };
  getByRole(
    role: string,
    opts: { name: string },
  ): { click(): Promise<void> };
  waitForResponse(
    predicate: (res: { url(): string }) => boolean,
    options?: { timeout?: number },
  ): Promise<unknown>;
  waitForURL(
    url: RegExp | string,
    options?: { timeout?: number },
  ): Promise<unknown>;
  waitForLoadState(
    state?: 'load' | 'domcontentloaded' | 'networkidle',
  ): Promise<void>;
  evaluate<T>(fn: () => T | Promise<T>): Promise<T>;
  evaluate<T, A>(fn: (arg: A) => T | Promise<T>, arg: A): Promise<T>;
}): HmsPage {
  return {
    async goto(url, options) {
      await page.goto(url, {
        waitUntil: 'domcontentloaded',
        timeout: options?.timeout,
      });
    },
    async content() {
      try {
        return await page.content();
      } catch (err) {
        if (!isNavigationRaceError(err)) throw err;
        await page.waitForLoadState('domcontentloaded').catch(() => undefined);
        await new Promise((r) => setTimeout(r, 200));
        return page.content();
      }
    },
    close: () => page.close(),
    setDefaultTimeout: (ms) => page.setDefaultTimeout(ms),
    setDefaultNavigationTimeout: (ms) => page.setDefaultNavigationTimeout(ms),
    url: () => page.url(),
    title: () => page.title(),
    async readPropertyBinding() {
      const html = await (async () => {
        try {
          return await page.content();
        } catch (err) {
          if (!isNavigationRaceError(err)) throw err;
          await page.waitForLoadState('domcontentloaded').catch(() => undefined);
          await new Promise((r) => setTimeout(r, 200));
          return page.content();
        }
      })();
      let title = '';
      try {
        title = await page.title();
      } catch (err) {
        if (!isNavigationRaceError(err)) throw err;
        await new Promise((r) => setTimeout(r, 200));
        title = await page.title();
      }
      return extractPropertyBindingFromDom({
        html,
        title,
        pageUrl: page.url(),
      });
    },
    async fillLogin(username, password) {
      const userid = page.locator('input[name="userid"]');
      const userLegacy = page.locator('input[name="username"]');
      try {
        await userid.fill(username);
      } catch {
        try {
          await page.getByLabel('Username').fill(username);
        } catch {
          await userLegacy.fill(username);
        }
      }
      try {
        await page.locator('input[name="password"]').fill(password);
      } catch {
        await page.getByLabel('Password').fill(password);
      }
    },
    async submitLogin() {
      const waitCommon = () =>
        page
          .waitForURL(/\/web\/base\/COMMON/i, { timeout: 20_000 })
          .catch(() => undefined);
      try {
        await Promise.all([
          waitCommon(),
          page.getByRole('button', { name: 'Sign in' }).click(),
        ]);
      } catch {
        await Promise.all([
          waitCommon(),
          page.locator('input[name="password"]').press('Enter'),
        ]);
      }
      await page.waitForLoadState('domcontentloaded').catch(() => undefined);
      await new Promise((r) => setTimeout(r, 500));
    },
    async postForm(url, fields) {
      const postData = new URLSearchParams(fields).toString();
      // Never page.setContent — live HMS is an ExtJS SPA; replacing the document
      // tears down COMMON and has been observed to fire POST /web/base/logindisp.
      return page.evaluate(
        async ({ url, postData }) => {
          const res = await fetch(url, {
            method: 'POST',
            headers: { 'content-type': 'application/x-www-form-urlencoded' },
            body: postData,
            credentials: 'same-origin',
          });
          return await res.text();
        },
        { url, postData },
      );
    },
    async click(selector) {
      const loc = page.locator(selector);
      const count = await loc.count().catch(() => 0);
      for (let i = 0; i < count; i += 1) {
        const el = loc.nth(i);
        const visible = await el.isVisible().catch(() => false);
        if (!visible) continue;
        await el.scrollIntoViewIfNeeded().catch(() => undefined);
        await el.click({ force: true, timeout: 5_000 });
        return;
      }
      // Live tree labels often have 0x0 rects until expanded; still dispatch click.
      const textMatch = /^text=(.+)$/i.exec(selector);
      if (textMatch) {
        const label = textMatch[1]!;
        const clicked = await page.evaluate((wanted: string) => {
          const root = (
            globalThis as unknown as {
              document?: {
                querySelectorAll(sel: string): ArrayLike<{
                  textContent: string | null;
                  click(): void;
                }>;
              };
            }
          ).document;
          if (!root) return false;
          const nodes = Array.from(
            root.querySelectorAll('a, span, td, div, li, label, em'),
          );
          const exact = nodes.filter(
            (n) => (n.textContent || '').trim() === wanted,
          );
          // Prefer shortest textContent (= leaf label, not parent row).
          exact.sort(
            (a, b) =>
              (a.textContent || '').length - (b.textContent || '').length,
          );
          const match = exact[0];
          if (!match) return false;
          match.click();
          return true;
        }, label);
        if (clicked) return;
      }
      await page.locator(selector).first().click({ force: true, timeout: 5_000 });
    },
    async fill(selector, value) {
      await page.locator(selector).fill(value);
    },
    async press(selector, key) {
      await page.locator(selector).press(key);
    },
    async waitForCorrelatedResponse(pathSubstring) {
      await page.waitForResponse(
        (res) => res.url().includes(pathSubstring),
        { timeout: 15_000 },
      );
    },
    evaluateStableDom: (fn) => page.evaluate(fn),
    evaluate: (fn) => page.evaluate(fn),
  };
}

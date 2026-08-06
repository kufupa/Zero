/**
 * HMS browser runtime — singleton Chromium, one-session semaphore, fail-closed
 * request policy, abort-first contexts, startup canary + circuit breaker.
 *
 * No production credentials. Secret loader injectable. BrowserFactory injectable
 * so fixture/unit tests run without live Chromium.
 */

import { randomUUID } from 'node:crypto';
import { chmod, mkdir, rename, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { z } from 'zod';
import type { RequestDecision, RequestPolicyManifest } from './contracts.js';
import {
  contextCreationOptions,
  createBrowserEventGuards,
  enforceRequestPolicy,
  type PolicyRoute,
} from './request-policy.js';
import {
  HmsBrowserArtifactError,
  HMS_BROWSER_CAPACITY_WATCHDOG_MS,
  HMS_BROWSER_ARTIFACT_MAX_CAPTURE_BYTES,
  HMS_BROWSER_ARTIFACT_MIN_LIVE_FREE_BYTES,
  HMS_BROWSER_CAPTURE_FINALIZE_TIMEOUT_MS,
  HMS_BROWSER_LIVE_PROOF_FINALIZE_TIMEOUT_MS,
  type HmsBrowserAuditSpec,
  type HmsBrowserCaptureHandle,
} from './browser-artifacts.js';
import type {
  HmsEvidenceHmacConfig,
  HmsSecretVersionMetadata,
} from './evidence-runtime.js';
import { revalidateEvidenceBindings } from './evidence-runtime.js';

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
  /** Last finalized browser audit receipt for this session (digests only). */
  lastReceipt(): import('./browser-artifacts.js').HmsBrowserArtifactReceiptV1 | null;
  close(options?: {
    outcome?: import('./browser-artifacts.js').HmsBrowserArtifactReceiptBaseV1['operationOutcome'];
    terminalCode?: import('./browser-artifacts.js').HmsBrowserArtifactReceiptBaseV1['terminalCode'];
    complete?: boolean;
  }): Promise<void>;
};

export type HmsPageVideo = {
  /** Absolute path once context has closed (Playwright Video API). */
  path(): Promise<string>;
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
  /** Present when context was created with recordVideo (live_proof). */
  video?(): HmsPageVideo | null;
};

export type HmsDownloadEvent = { cancel(): Promise<void> };

export type HmsWebSocketRoute = {
  close(): void;
};

export type HmsTracing = {
  start(options: {
    screenshots: boolean;
    snapshots: boolean;
    sources: boolean;
    title?: string;
  }): Promise<void>;
  stop(options?: { path?: string }): Promise<void>;
};

export type HmsNewContextOptions = {
  acceptDownloads: false;
  serviceWorkers: 'block';
  ignoreHTTPSErrors?: true;
  /** Only live_proof may set this — normal must omit. */
  recordVideo?: {
    dir: string;
    size: { width: number; height: number };
  };
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
  tracing: HmsTracing;
};

export type HmsBrowser = {
  newContext(options: HmsNewContextOptions): Promise<HmsBrowserContext>;
  close(): Promise<void>;
};

export type BrowserFactory = (input: {
  executablePath?: string;
  signal?: AbortSignal;
  /** Protected Playwright tracesDir under artifact root. */
  tracesDir?: string;
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
    /** Required when runtime.requireAuditCapture / production store wired. */
    auditSpec?: import('./browser-artifacts.js').HmsBrowserAuditSpec;
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
  /** Private capture spool — when set, every session must supply auditSpec. */
  artifactStore?: import('./browser-artifacts.js').HmsBrowserArtifactStore;
  /** Fail closed if openReadSession omits auditSpec while store is present. */
  requireAuditCapture?: boolean;
  /** Expired artifact purge cadence. Default 1 hour. */
  artifactPurgeIntervalMs?: number;
  sourceRevision?: string;
  playwrightRevision?: string;
  chromiumRevision?: string;
  /**
   * When set, revalidate AWSCURRENT + evidence-key version + runtime fingerprint
   * before every context/claim. Inject fakes in tests — no live AWS.
   */
  evidenceBindings?: {
    evidence: HmsEvidenceHmacConfig;
    secretVersion: HmsSecretVersionMetadata;
    expectedCredentialVersionHmacSha256?: string;
    expectedRuntimeFingerprintSha256?: string;
  };
};

export const HEALTH_HEARTBEAT_MS = 10_000;
export const HEALTH_STALE_AFTER_MS = 30_000;
export const ARTIFACT_PURGE_INTERVAL_MS = 60 * 60 * 1000;

/** Max queued waiters for the one-session semaphore (holder not counted). */
export const HMS_SESSION_WAITER_CAP = 2;
export const HMS_SESSION_WAITER_CAP_CODE = 'HMS_SESSION_WAITER_CAP';
export const CAPACITY_REJECTED = 'CAPACITY_REJECTED';

export class HmsRuntimeError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = 'HmsRuntimeError';
    this.code = code;
  }
}

export type BoundedSessionLock = {
  acquire(signal: AbortSignal): Promise<() => void>;
  waitingCount(): number;
  /** Resolves after active holder and all queued waiters finish. */
  drain(): Promise<void>;
};

/**
 * One-session promise chain with a hard waiter cap.
 * Excess waiters reject immediately — no unbounded queue.
 */
export function createBoundedSessionLock(options?: {
  waiterCap?: number;
  /** Max time a waiter may sit on the queue before reject (plan QUEUE_WAIT_MS). */
  maxWaitMs?: number;
  isClosing?: () => boolean;
}): BoundedSessionLock {
  const waiterCap = options?.waiterCap ?? HMS_SESSION_WAITER_CAP;
  const maxWaitMs = options?.maxWaitMs;
  let sessionLock: Promise<void> = Promise.resolve();
  let waiters = 0;

  return {
    waitingCount: () => waiters,
    drain: () => sessionLock,
    acquire(signal: AbortSignal): Promise<() => void> {
      if (options?.isClosing?.()) {
        return Promise.reject(
          new HmsRuntimeError('not_started', 'HMS runtime is closing'),
        );
      }
      if (waiters >= waiterCap) {
        return Promise.reject(
          new HmsRuntimeError(HMS_SESSION_WAITER_CAP_CODE, CAPACITY_REJECTED),
        );
      }
      waiters += 1;
      let release!: () => void;
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      const prev = sessionLock;
      sessionLock = prev.then(() => gate);
      return new Promise<() => void>((resolveLock, rejectLock) => {
        let settled = false;
        let waitTimer: ReturnType<typeof setTimeout> | undefined;
        const finishWaiter = () => {
          if (waiters > 0) waiters -= 1;
        };
        const clearWaitTimer = () => {
          if (waitTimer !== undefined) {
            clearTimeout(waitTimer);
            waitTimer = undefined;
          }
        };
        const rejectQueued = (error: HmsRuntimeError) => {
          if (settled) return;
          settled = true;
          clearWaitTimer();
          finishWaiter();
          signal.removeEventListener('abort', onAbort);
          release();
          rejectLock(error);
        };
        const onAbort = () =>
          rejectQueued(new HmsRuntimeError('aborted', 'operation aborted'));
        signal.addEventListener('abort', onAbort, { once: true });
        if (signal.aborted) {
          onAbort();
          return;
        }
        if (typeof maxWaitMs === 'number' && maxWaitMs > 0) {
          waitTimer = setTimeout(() => {
            rejectQueued(
              new HmsRuntimeError(
                HMS_SESSION_WAITER_CAP_CODE,
                CAPACITY_REJECTED,
              ),
            );
          }, maxWaitMs);
        }
        void prev.then(
          () => {
            if (settled) return;
            if (options?.isClosing?.()) {
              rejectQueued(
                new HmsRuntimeError('not_started', 'HMS runtime is closing'),
              );
              return;
            }
            if (signal.aborted) {
              onAbort();
              return;
            }
            settled = true;
            clearWaitTimer();
            finishWaiter();
            signal.removeEventListener('abort', onAbort);
            resolveLock(release);
          },
          () =>
            rejectQueued(
              new HmsRuntimeError('session_failed', 'session lock failed'),
            ),
        );
      });
    },
  };
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
      #videoDir: string | null = null;
      #primaryVideoPath: string | null = null;

      tracing: HmsTracing = {
        start: async () => undefined,
        stop: async (opts) => {
          if (opts?.path) {
            await writeFile(opts.path, Buffer.from('PK\x03\x04fetch-trace'));
          }
        },
      };

      constructor(opts?: HmsNewContextOptions) {
        this.#videoDir = opts?.recordVideo?.dir ?? null;
      }

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
        if (this.#videoDir && !this.#primaryVideoPath) {
          this.#primaryVideoPath = join(this.#videoDir, 'page.webm');
          (page as HmsPage).video = () => ({
            path: async () => {
              if (!this.#primaryVideoPath) {
                throw new HmsRuntimeError('VIDEO_FINALIZE_FAILED', 'no video');
              }
              return this.#primaryVideoPath;
            },
          });
        }
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
        if (this.#primaryVideoPath) {
          await writeFile(
            this.#primaryVideoPath,
            Buffer.from('fetch-webm-fixture'),
          );
        }
      }
    }

    return {
      async newContext(opts: HmsNewContextOptions) {
        if (closed) throw new HmsRuntimeError('browser_closed', 'browser closed');
        const ctx = new FetchContext(opts);
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

function createHmsRuntimeInternal(
  options: HmsRuntimeOptions,
  allowLiveProof: boolean,
): HmsRuntime {
  const timeoutMs = options.defaultTimeoutMs ?? 15_000;
  const cooldownMs = options.circuitCooldownMs ?? 30_000;
  const requireViewOnly = options.requireViewOnly ?? true;
  const staleAfterMs = options.healthStaleAfterMs ?? HEALTH_STALE_AFTER_MS;
  const heartbeatMs = options.healthHeartbeatMs ?? HEALTH_HEARTBEAT_MS;
  const artifactPurgeMs =
    options.artifactPurgeIntervalMs ?? ARTIFACT_PURGE_INTERVAL_MS;
  const runStartupCanary = options.runStartupCanary ?? true;
  let healthWriteQueue: Promise<void> = Promise.resolve();
  const persistHealth = (): Promise<void> => {
    const write = healthWriteQueue.then(() =>
      writeHealthFile(options.healthStatusPath, health()),
    );
    healthWriteQueue = write.catch(() => undefined);
    return write;
  };

  let browser: HmsBrowser | null = null;
  let cachedSecret: HmsSecret | null = null;
  let browserLaunches = 0;
  let contextsCreated = 0;
  let contextsClosed = 0;
  let activeSessions = 0;
  const sessionSemaphore = createBoundedSessionLock({
    waiterCap: HMS_SESSION_WAITER_CAP,
    maxWaitMs: 30_000,
    isClosing: () => closing,
  });
  let state: HmsHealthState = 'stopped';
  let lastErrorCode: string | undefined;
  let circuitOpenedAt: number | undefined;
  let started = false;
  let closing = false;
  let heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  let artifactPurgeTimer: ReturnType<typeof setInterval> | null = null;
  let artifactPurgeQueue: Promise<void> = Promise.resolve();
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
      void persistHealth();
    }, heartbeatMs);
    if (typeof heartbeatTimer === 'object' && 'unref' in heartbeatTimer) {
      heartbeatTimer.unref();
    }
  }

  async function purgeArtifacts(): Promise<void> {
    if (!options.artifactStore) return;
    const purge = artifactPurgeQueue.then(async () => {
      await options.artifactStore!.purgeExpired();
    });
    artifactPurgeQueue = purge.catch(() => undefined);
    try {
      await purge;
    } catch {
      state = 'degraded';
      lastErrorCode = 'AUDIT_CAPTURE';
      await persistHealth().catch(() => undefined);
      throw new HmsRuntimeError(
        'AUDIT_CAPTURE',
        'artifact retention purge failed',
      );
    }
  }

  function stopArtifactPurge() {
    if (artifactPurgeTimer) {
      clearInterval(artifactPurgeTimer);
      artifactPurgeTimer = null;
    }
  }

  function startArtifactPurge() {
    stopArtifactPurge();
    if (!options.artifactStore) return;
    artifactPurgeTimer = setInterval(() => {
      void purgeArtifacts().catch(() => undefined);
    }, artifactPurgeMs);
    if (
      typeof artifactPurgeTimer === 'object' &&
      'unref' in artifactPurgeTimer
    ) {
      artifactPurgeTimer.unref();
    }
  }

  async function poisonAfterFinalizeTimeout(): Promise<void> {
    closing = true;
    started = false;
    state = 'degraded';
    lastErrorCode = 'AUDIT_CAPTURE';
    cachedSecret = null;
    stopHeartbeat();
    stopArtifactPurge();
    const failedBrowser = browser;
    browser = null;
    if (failedBrowser) {
      let closeTimer: ReturnType<typeof setTimeout> | undefined;
      try {
        await Promise.race([
          failedBrowser.close(),
          new Promise<void>((resolveClose) => {
            closeTimer = setTimeout(resolveClose, 5_000);
          }),
        ]);
      } catch {
        // Runtime remains poisoned; process-level supervisor owns hard recovery.
      } finally {
        if (closeTimer) clearTimeout(closeTimer);
      }
    }
    await persistHealth().catch(() => undefined);
  }

  async function revalidateRoleProof(): Promise<void> {
    if (!options.roleProofPath) return;
    const loader =
      options.loadRoleProof ??
      (async (path: string, now?: Date) => {
        const { loadHmsReadRoleProof, loadHmsReadRoleProofV2 } = await import(
          './release-kernel.js'
        );
        const { READ_TOOLS } = await import('./read-tools.js');
        if (/\.v2\.json$/i.test(path)) {
          const toolId = path.match(/([a-z0-9_]+)\.v2\.json$/i)?.[1];
          if (!toolId || !(toolId in READ_TOOLS) || toolId === 'mail_read_artifact') {
            throw new HmsRuntimeError(
              'ROLE_SCOPE_INVALID',
              'role proof v2 requires HmsReadToolId',
            );
          }
          const proof = await loadHmsReadRoleProofV2(
            path,
            READ_TOOLS[toolId as keyof typeof READ_TOOLS],
            now,
          );
          return {
            schemaVersion: 1 as const,
            propertyCode: 'HRCEN' as const,
            allowedSurfaces: ['Guest Stay'] as const,
            deniedActions: [
              'new_record',
              'save',
              'delete',
              'duplicate',
              'check_in',
              'check_out',
              'document_generate',
              'document_send',
            ] as const,
            issuedAt: proof.issuedAt,
            expiresAt: proof.expiresAt,
            evidenceRef: `role-proof-v2:${proof.toolId}`,
            evidenceSha256: proof.evidenceSha256,
          };
        }
        return loadHmsReadRoleProof(path, now);
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

  function revalidateEvidenceIfConfigured(): void {
    const bindings = options.evidenceBindings;
    if (!bindings) return;
    revalidateEvidenceBindings({
      secretVersion: bindings.secretVersion,
      evidence: bindings.evidence,
      expectedCredentialVersionHmacSha256:
        bindings.expectedCredentialVersionHmacSha256,
      expectedRuntimeFingerprintSha256:
        bindings.expectedRuntimeFingerprintSha256,
      runtimeFingerprint:
        options.sourceRevision &&
        options.playwrightRevision &&
        options.chromiumRevision
          ? {
              sourceRevision: options.sourceRevision,
              playwrightRevision: options.playwrightRevision,
              chromiumRevision: options.chromiumRevision,
            }
          : undefined,
      hmsSecretArn: options.secretArn,
    });
  }

  async function getSecret(signal?: AbortSignal): Promise<HmsSecret> {
    if (cachedSecret) return cachedSecret;
    try {
      const raw = await options.loadSecret({
        secretArn: options.secretArn,
        signal,
      });
      // Accept plain secret or { secret, versionId, versionStages } from production.
      const payload =
        raw &&
        typeof raw === 'object' &&
        !Array.isArray(raw) &&
        'secret' in (raw as object)
          ? (raw as { secret: unknown }).secret
          : raw;
      const secret = hmsSecretSchema.parse(payload);
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
        tracesDir: options.artifactStore?.intermediateDir,
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

  let activeTeardown: Promise<void> = Promise.resolve();
  let activeTeardownError: unknown;

  async function openReadSessionInternal(input: {
    transportId: string;
    signal: AbortSignal;
    canary?: boolean;
    exactSearchCandidate?: import('./live-read-manifest.js').ExactReservationCandidate;
    allowUnstarted?: boolean;
    auditSpec?: HmsBrowserAuditSpec;
  }): Promise<HmsReadSession> {
    assertNotAborted(input.signal);
    if (closing) {
      throw new HmsRuntimeError('not_started', 'HMS runtime is closing');
    }
    if (!input.canary) assertCircuitClosed();
    if (!started && !input.canary && !input.allowUnstarted) {
      throw new HmsRuntimeError('not_started', 'HMS runtime not started');
    }

    const store = options.artifactStore;
    const requireCapture = options.requireAuditCapture ?? Boolean(store);
    if (requireCapture && !store) {
      throw new HmsRuntimeError(
        'AUDIT_CAPTURE',
        'artifact store required for audited HMS session',
      );
    }
    if (requireCapture && !input.auditSpec && !input.canary) {
      throw new HmsRuntimeError(
        'AUDIT_CAPTURE',
        'auditSpec required for audited HMS session',
      );
    }
    if (input.auditSpec?.executionClass === 'live_proof' && !allowLiveProof) {
      throw new HmsRuntimeError(
        'AUDIT_CAPTURE',
        'live_proof requires proof-only runtime composition',
      );
    }

    await revalidateRoleProof();
    revalidateEvidenceIfConfigured();

    const secret = await getSecret(input.signal);
    if (input.transportId !== secret.mailboxTransportId) {
      throw new HmsRuntimeError(
        'transport_mismatch',
        'transportId does not match secret mailboxTransportId',
      );
    }
    if (requireViewOnly && secret.credentialMode !== 'view_only') {
      throw new HmsRuntimeError(
        'credential_mode',
        'view_only required for read sessions',
      );
    }
    if (options.expectedOrigin) {
      const loginOrigin = new URL(secret.loginUrl).origin;
      if (loginOrigin !== options.expectedOrigin) {
        throw new HmsRuntimeError(
          'origin_mismatch',
          'secret login origin mismatch',
        );
      }
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

    let capture: HmsBrowserCaptureHandle | null = null;
    let lastReceipt: import('./browser-artifacts.js').HmsBrowserArtifactReceiptV1 | null =
      null;

    const release = await acquireSessionLock(input.signal);
    activeSessions += 1;

    let context: HmsBrowserContext | null = null;
    let primaryPage: HmsPage | null = null;
    let lastViolation: RequestDecision | null = null;
    let terminal = false;
    let released = false;
    let closedCounted = false;
    let finalizeOnce: Promise<void> | null = null;
    let traceStarted = false;
    const ruleCounts = new Map<string, number>();
    let blockedRequests = 0;
    let mutationRequests = 0;
    let popupCount = 0;
    let downloadCount = 0;
    let webSocketCount = 0;
    let watchdog: ReturnType<typeof setInterval> | null = null;
    let watchdogBusy = false;
    const guards = createBrowserEventGuards(sessionManifest);

    const releaseOnce = () => {
      if (released) return;
      released = true;
      activeSessions = Math.max(0, activeSessions - 1);
      release();
    };

    const stopWatchdog = () => {
      if (watchdog) {
        clearInterval(watchdog);
        watchdog = null;
      }
    };

    const finalizeCapture = async (args: {
      outcome: import('./browser-artifacts.js').HmsBrowserArtifactReceiptBaseV1['operationOutcome'];
      terminalCode: import('./browser-artifacts.js').HmsBrowserArtifactReceiptBaseV1['terminalCode'];
      terminalStage: import('./browser-artifacts.js').HmsBrowserArtifactReceiptBaseV1['terminalStage'];
      complete: boolean;
    }) => {
      if (!capture) return;
      stopWatchdog();
      const budgetMs =
        input.auditSpec?.executionClass === 'live_proof'
          ? HMS_BROWSER_LIVE_PROOF_FINALIZE_TIMEOUT_MS
          : HMS_BROWSER_CAPTURE_FINALIZE_TIMEOUT_MS;
      const finalizeDeadline = Date.now() + budgetMs;
      let finalizeTimedOut = false;
      const withinFinalizeBudget = async <T>(
        operation: () => Promise<T>,
      ): Promise<T> => {
        const remaining = finalizeDeadline - Date.now();
        if (remaining <= 0) {
          finalizeTimedOut = true;
          await poisonAfterFinalizeTimeout();
          throw new HmsRuntimeError('AUDIT_CAPTURE', 'TRACE_FINALIZE_FAILED');
        }
        const pending = operation();
        let timer: ReturnType<typeof setTimeout> | undefined;
        let timedOut = false;
        try {
          return await Promise.race([
            pending,
            new Promise<never>((_, reject) => {
              timer = setTimeout(
                () => {
                  timedOut = true;
                  reject(
                    new HmsRuntimeError(
                      'AUDIT_CAPTURE',
                      'TRACE_FINALIZE_FAILED',
                    ),
                  );
                },
                remaining,
              );
            }),
          ]);
        } catch (error) {
          if (timedOut) {
            finalizeTimedOut = true;
            await poisonAfterFinalizeTimeout();
          }
          throw error;
        } finally {
          if (timer) clearTimeout(timer);
        }
      };
      try {
        if (context && traceStarted) {
          await withinFinalizeBudget(() =>
            context!.tracing.stop({
              path: join(capture!.stagingDir, 'trace.zip'),
            }),
          );
          capture.markMilestone('traceStoppedAt');
        }
      } catch {
        args.complete = false;
        args.terminalCode =
          args.terminalCode === 'OK' ? 'TRACE_FINALIZE_FAILED' : args.terminalCode;
        args.terminalStage = 'trace_stop';
      }

      let closeErr: unknown;
      try {
        if (context) {
          const videoHandle =
            input.auditSpec?.executionClass === 'live_proof' && primaryPage?.video
              ? primaryPage.video()
              : null;
          await withinFinalizeBudget(() => context!.close());
          capture.markMilestone('contextClosedAt');
          if (!closedCounted) {
            closedCounted = true;
            contextsClosed += 1;
          }
          if (videoHandle && capture.videoDir) {
            try {
              const rawPath = await withinFinalizeBudget(() =>
                videoHandle.path(),
              );
              await withinFinalizeBudget(
                () => rename(rawPath, join(capture!.stagingDir, 'video.webm')),
              );
            } catch {
              args.complete = false;
              args.terminalCode = 'VIDEO_FINALIZE_FAILED';
              args.terminalStage = 'video_finalize';
            }
          }
        }
      } catch (err) {
        closeErr = err;
        args.complete = false;
        args.terminalCode = 'CONTEXT_CLOSE_FAILED';
        args.terminalStage = 'context_close';
      } finally {
        context = null;
      }

      try {
        const receipt = await withinFinalizeBudget(() =>
          capture!.finalize({
            outcome: args.outcome,
            terminalCode: args.terminalCode,
            terminalStage: args.terminalStage,
            sourceRevision: options.sourceRevision ?? 'unknown',
            playwrightRevision: options.playwrightRevision ?? '1.52.0',
            chromiumRevision: options.chromiumRevision ?? 'unknown',
            requestRules: [...ruleCounts.entries()].map(([ruleId, count]) => ({
              ruleId,
              count,
            })),
            blockedRequests,
            mutationRequests,
            popupCount,
            downloadCount,
            webSocketCount,
            complete: args.complete,
          }),
        );
        lastReceipt = receipt;
        if (receipt.artifactState !== 'complete') {
          state = 'degraded';
          lastErrorCode = 'AUDIT_CAPTURE';
          throw new HmsRuntimeError('AUDIT_CAPTURE', args.terminalCode);
        }
      } catch (err) {
        if (!finalizeTimedOut) {
          await capture.abandon().catch(() => undefined);
        }
        state = 'degraded';
        lastErrorCode = 'AUDIT_CAPTURE';
        if (closeErr) {
          throw new AggregateError(
            [err, closeErr],
            'HMS capture finalize failed',
          );
        }
        throw err instanceof HmsRuntimeError
          ? err
          : new HmsRuntimeError('AUDIT_CAPTURE', 'TRACE_FINALIZE_FAILED');
      }
      if (closeErr) {
        throw closeErr instanceof Error
          ? closeErr
          : new HmsRuntimeError('AUDIT_CAPTURE', 'CONTEXT_CLOSE_FAILED');
      }
    };

    const teardown = async (captureArgs?: {
      outcome: import('./browser-artifacts.js').HmsBrowserArtifactReceiptBaseV1['operationOutcome'];
      terminalCode: import('./browser-artifacts.js').HmsBrowserArtifactReceiptBaseV1['terminalCode'];
      terminalStage: import('./browser-artifacts.js').HmsBrowserArtifactReceiptBaseV1['terminalStage'];
      complete: boolean;
    }) => {
      if (finalizeOnce) return finalizeOnce;
      finalizeOnce = (async () => {
        input.signal.removeEventListener('abort', closeOnAbort);
        try {
          if (capture) {
            await finalizeCapture(
              captureArgs ?? {
                outcome: 'aborted',
                terminalCode: 'ABORTED',
                terminalStage: 'context_close',
                complete: false,
              },
            );
          } else if (context) {
            try {
              await context.close();
              if (!closedCounted) {
                closedCounted = true;
                contextsClosed += 1;
              }
            } catch {
              /* ignore close errors when uncaptured */
            }
          }
        } finally {
          releaseOnce();
        }
      })();
      const pendingFinalize = finalizeOnce;
      activeTeardown = activeTeardown.then(async () => {
        try {
          await pendingFinalize;
        } catch (error) {
          activeTeardownError ??= error;
        }
      });
      return finalizeOnce;
    };

    const closeOnAbort = () => {
      terminal = true;
      void teardown({
        outcome: 'aborted',
        terminalCode: 'ABORTED',
        terminalStage: 'tool',
        complete: Boolean(capture && traceStarted),
      }).catch(() => undefined);
    };
    input.signal.addEventListener('abort', closeOnAbort, { once: true });

    try {
      assertNotAborted(input.signal);
      if (closing) {
        throw new HmsRuntimeError('not_started', 'HMS runtime is closing');
      }
      if (!input.canary) assertCircuitClosed();
      await revalidateRoleProof();
      revalidateEvidenceIfConfigured();
      const currentSecret = await getSecret(input.signal);
      if (input.transportId !== currentSecret.mailboxTransportId) {
        throw new HmsRuntimeError(
          'transport_mismatch',
          'transportId does not match secret mailboxTransportId',
        );
      }
      if (requireViewOnly && currentSecret.credentialMode !== 'view_only') {
        throw new HmsRuntimeError(
          'credential_mode',
          'view_only required for read sessions',
        );
      }
      if (
        options.expectedOrigin &&
        new URL(currentSecret.loginUrl).origin !== options.expectedOrigin
      ) {
        throw new HmsRuntimeError(
          'origin_mismatch',
          'secret login origin mismatch',
        );
      }
      if (store && input.auditSpec) {
        try {
          capture = await store.beginCapture(input.auditSpec);
        } catch (err) {
          state = 'degraded';
          lastErrorCode = 'AUDIT_CAPTURE';
          if (err instanceof HmsBrowserArtifactError) {
            throw new HmsRuntimeError('AUDIT_CAPTURE', err.code);
          }
          throw new HmsRuntimeError(
            'AUDIT_CAPTURE',
            'TRACE_STORAGE_UNAVAILABLE',
          );
        }
      }
      const b = await getBrowser(input.signal);
      const ctxOpts: HmsNewContextOptions = {
        ...contextCreationOptions(),
        ...(capture?.videoDir
          ? {
              recordVideo: {
                dir: capture.videoDir,
                size: { width: 1280, height: 720 },
              },
            }
          : {}),
      };
      context = await b.newContext(ctxOpts);
      contextsCreated += 1;

      if (capture) {
        try {
          await context.tracing.start({
            screenshots: true,
            snapshots: true,
            sources: false,
            title: `${input.auditSpec!.toolId}:${input.auditSpec!.operationId}`,
          });
          traceStarted = true;
          capture.markMilestone('traceStartedAt');
        } catch {
          await capture.abandon().catch(() => undefined);
          throw new HmsRuntimeError('AUDIT_CAPTURE', 'TRACE_START_FAILED');
        }

        watchdog = setInterval(() => {
          if (watchdogBusy || terminal) return;
          watchdogBusy = true;
          void (async () => {
            try {
              const [bytes, freeBytes] = await Promise.all([
                capture!.observeStagedBytes(),
                capture!.observeFreeBytes(),
              ]);
              if (
                bytes >= HMS_BROWSER_ARTIFACT_MAX_CAPTURE_BYTES ||
                freeBytes <= HMS_BROWSER_ARTIFACT_MIN_LIVE_FREE_BYTES
              ) {
                terminal = true;
                void teardown({
                  outcome: 'failed',
                  terminalCode: 'CAPTURE_CAPACITY_EXCEEDED',
                  terminalStage: 'tool',
                  complete: false,
                }).catch(() => undefined);
              }
            } catch {
              terminal = true;
              void teardown({
                outcome: 'failed',
                terminalCode: 'CAPTURE_CAPACITY_EXCEEDED',
                terminalStage: 'tool',
                complete: false,
              }).catch(() => undefined);
            } finally {
              watchdogBusy = false;
            }
          })();
        }, HMS_BROWSER_CAPACITY_WATCHDOG_MS);
        watchdog.unref?.();
      }

      // Pre-connect WebSocket rejection BEFORE any navigation.
      await context.routeWebSocket('**/*', (ws) => {
        guards.handleWebSocket();
        webSocketCount += 1;
        lastViolation = guards.lastBlock();
        state = 'degraded';
        lastErrorCode = lastViolation?.action === 'block'
          ? lastViolation.code
          : 'websocket_blocked';
        terminal = true;
        ws.close();
        void teardown({
          outcome: 'policy_blocked',
          terminalCode: 'POLICY_BLOCK',
          terminalStage: 'tool',
          complete: Boolean(capture && traceStarted),
        }).catch(() => undefined);
      });

      await context.route('**/*', async (route) => {
        const decision = await enforceRequestPolicy(route, sessionManifest, {
          onDecision: (d) => {
            if (d.action === 'allow' && d.ruleId) {
              ruleCounts.set(d.ruleId, (ruleCounts.get(d.ruleId) ?? 0) + 1);
            }
            if (d.action === 'block') {
              blockedRequests += 1;
              if (d.code === 'mutation_action' || d.code === 'submit_button') {
                mutationRequests += 1;
              }
              lastViolation = d;
            }
          },
        });
        (route as PolicyRoute & { __decision?: RequestDecision }).__decision =
          decision;
        if (decision.action === 'block') {
          lastViolation = decision;
          state = 'degraded';
          lastErrorCode = decision.code;
          terminal = true;
          void teardown({
            outcome: 'policy_blocked',
            terminalCode: 'POLICY_BLOCK',
            terminalStage: 'tool',
            complete: Boolean(capture && traceStarted),
          }).catch(() => undefined);
        }
      });

      let sawPrimaryPage = false;
      context.on('page', (page) => {
        if (!sawPrimaryPage) {
          sawPrimaryPage = true;
          return;
        }
        popupCount += 1;
        void guards.handlePopup(page).catch(() => undefined);
        lastViolation = guards.lastBlock();
        state = 'degraded';
        lastErrorCode = 'popup_blocked';
        terminal = true;
        void teardown({
          outcome: 'policy_blocked',
          terminalCode: 'POLICY_BLOCK',
          terminalStage: 'tool',
          complete: Boolean(capture && traceStarted),
        }).catch(() => undefined);
      });
      context.on('download', (download) => {
        downloadCount += 1;
        void guards.handleDownload(download).catch(() => undefined);
        lastViolation = guards.lastBlock();
        state = 'degraded';
        lastErrorCode = 'download_blocked';
        terminal = true;
        void teardown({
          outcome: 'policy_blocked',
          terminalCode: 'POLICY_BLOCK',
          terminalStage: 'tool',
          complete: Boolean(capture && traceStarted),
        }).catch(() => undefined);
      });
      context.on('websocket', () => {
        guards.handleWebSocket();
        webSocketCount += 1;
        lastViolation = guards.lastBlock();
        state = 'degraded';
        lastErrorCode = 'websocket_blocked';
        terminal = true;
        void teardown({
          outcome: 'policy_blocked',
          terminalCode: 'POLICY_BLOCK',
          terminalStage: 'tool',
          complete: Boolean(capture && traceStarted),
        }).catch(() => undefined);
      });

      if (capture) capture.markMilestone('loginStartedAt');
      const page = await context.newPage();
      primaryPage = page;
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
      if (capture) capture.markMilestone('toolStartedAt');

      return {
        id: sessionId,
        origin: new URL(secret.loginUrl).origin,
        violation: () => lastViolation,
        terminal: () => terminal,
        page,
        lastReceipt: () => lastReceipt,
        close: async (closeOpts) => {
          terminal = true;
          if (capture) capture.markMilestone('toolFinishedAt');
          const blocked =
            lastViolation?.action === 'block' ||
            blockedRequests > 0 ||
            mutationRequests > 0 ||
            popupCount > 0 ||
            downloadCount > 0 ||
            webSocketCount > 0;
          await teardown({
            outcome:
              closeOpts?.outcome ??
              (blocked ? 'policy_blocked' : 'succeeded'),
            terminalCode:
              closeOpts?.terminalCode ??
              (blocked ? 'POLICY_BLOCK' : 'OK'),
            terminalStage: 'receipt_finalize',
            complete:
              closeOpts?.complete ??
              (Boolean(capture && traceStarted) && !blocked),
          });
        },
      };
    } catch (err) {
      terminal = true;
      const captureCode =
        err instanceof HmsRuntimeError && err.code === 'AUDIT_CAPTURE'
          ? err.message
          : undefined;
      let teardownError: unknown;
      try {
        await teardown({
          outcome:
            err instanceof HmsRuntimeError && err.code === 'aborted'
              ? 'aborted'
              : 'failed',
          terminalCode:
            captureCode === 'TRACE_START_FAILED'
              ? 'TRACE_START_FAILED'
              : captureCode === 'CAPTURE_CAPACITY_EXCEEDED'
                ? 'CAPTURE_CAPACITY_EXCEEDED'
                : 'TOOL_ERROR',
          terminalStage: 'login',
          complete: false,
        });
      } catch (error) {
        teardownError = error;
      }

      const code =
        err instanceof HmsRuntimeError ? err.code : redactError(err);
      if (code === 'wrong_tenant' || code === 'wrong_property') {
        openCircuit(code);
        await persistHealth();
      } else if (
        code === 'chromium_failed' ||
        code === 'TRANSIENT_NETWORK' ||
        /net::|ECONNRESET|ETIMEDOUT/i.test(String(code))
      ) {
        if (transientRetries < 1 && !teardownError) {
          transientRetries += 1;
          cachedSecret = null;
          const failedBrowser = browser;
          browser = null;
          if (failedBrowser) {
            try {
              await failedBrowser.close();
            } catch {
              state = 'degraded';
              lastErrorCode = 'AUDIT_CAPTURE';
              throw new HmsRuntimeError(
                'AUDIT_CAPTURE',
                'CONTEXT_CLOSE_FAILED',
              );
            }
          }
          throw new HmsRuntimeError('TRANSIENT_NETWORK', String(code));
        }
      } else if (
        /ROLE_PROOF|AUTH_FAILED|POLICY_BLOCK|SCHEMA_DRIFT|credential|wrong_|AUDIT_CAPTURE/i.test(
          String(code),
        )
      ) {
        state = state === 'circuit_open' ? state : 'degraded';
        lastErrorCode = code;
      }
      cachedSecret = null;
      if (teardownError) {
        state = state === 'circuit_open' ? state : 'degraded';
        lastErrorCode = 'AUDIT_CAPTURE';
        throw new AggregateError(
          [err, teardownError],
          'HMS session setup and audit finalization failed',
        );
      }
      throw err instanceof HmsRuntimeError
        ? err
        : new HmsRuntimeError('session_failed', String(code));
    }
  }


  function acquireSessionLock(signal: AbortSignal): Promise<() => void> {
    return sessionSemaphore.acquire(signal);
  }

  return {
    async start(signal: AbortSignal) {
      assertNotAborted(signal);
      if (closing) {
        throw new HmsRuntimeError('not_started', 'HMS runtime is closing');
      }
      if (started && state === 'ready') return;
      assertCircuitClosed();
      state = 'starting';
      lastErrorCode = undefined;
      try {
        await purgeArtifacts();
        await revalidateRoleProof();
        revalidateEvidenceIfConfigured();
        await getSecret(signal);
        await getBrowser(signal);
        if (runStartupCanary) {
          await runCanary(signal);
        }
        started = true;
        state = 'ready';
        lastErrorCode = undefined;
        transientRetries = 0;
        await persistHealth();
        startHeartbeat();
        startArtifactPurge();
      } catch (err) {
        started = false;
        stopHeartbeat();
        stopArtifactPurge();
        const code =
          err instanceof HmsRuntimeError ? err.code : redactError(err);
        if (code === 'wrong_tenant' || code === 'wrong_property') {
          openCircuit(code);
        } else if (code !== 'circuit_open') {
          state = 'degraded';
          lastErrorCode = code;
        }
        await persistHealth();
        throw err instanceof HmsRuntimeError
          ? err
          : new HmsRuntimeError('start_failed', String(code));
      }
    },

    async openReadSession(input) {
      await purgeArtifacts();
      return openReadSessionInternal({
        ...input,
        canary: false,
        exactSearchCandidate: input.exactSearchCandidate,
        allowUnstarted: input.allowUnstarted,
        auditSpec: input.auditSpec,
      });
    },

    health,

    stats: () => ({ browserLaunches, contextsCreated, contextsClosed }),

    async close() {
      closing = true;
      started = false;
      state = 'stopped';
      cachedSecret = null;
      stopHeartbeat();
      stopArtifactPurge();
      await artifactPurgeQueue;
      let teardownError: unknown;
      let teardownTimer: ReturnType<typeof setTimeout> | undefined;
      // Drain active and already-queued sessions, then their capture teardowns.
      try {
        await Promise.race([
          (async () => {
            const queuedSessions = sessionSemaphore.drain();
            await queuedSessions;
            await activeTeardown;
          })(),
          new Promise<never>((_, reject) => {
            teardownTimer = setTimeout(
              () =>
                reject(
                  new HmsRuntimeError(
                    'AUDIT_CAPTURE',
                    'TRACE_FINALIZE_FAILED',
                  ),
                ),
              HMS_BROWSER_LIVE_PROOF_FINALIZE_TIMEOUT_MS,
            );
          }),
        ]);
      } catch (error) {
        teardownError = error;
      } finally {
        if (teardownTimer) clearTimeout(teardownTimer);
      }
      if (!teardownError && activeTeardownError) {
        teardownError = activeTeardownError;
      }
      // Let in-flight heartbeat write settle before final write.
      await new Promise((r) => setTimeout(r, 0));
      let browserCloseError: unknown;
      let browserCloseTimer: ReturnType<typeof setTimeout> | undefined;
      try {
        if (browser) {
          await Promise.race([
            browser.close(),
            new Promise<never>((_, reject) => {
              browserCloseTimer = setTimeout(
                () =>
                  reject(
                    new HmsRuntimeError(
                      'AUDIT_CAPTURE',
                      'CONTEXT_CLOSE_FAILED',
                    ),
                  ),
                HMS_BROWSER_CAPTURE_FINALIZE_TIMEOUT_MS,
              );
            }),
          ]);
        }
      } catch (error) {
        browserCloseError = error;
      } finally {
        if (browserCloseTimer) clearTimeout(browserCloseTimer);
        browser = null;
        activeSessions = 0;
        await persistHealth();
      }
      if (teardownError && browserCloseError) {
        throw new AggregateError(
          [teardownError, browserCloseError],
          'HMS teardown and browser close failed',
        );
      }
      if (teardownError) throw teardownError;
      if (browserCloseError) throw browserCloseError;
    },
  };
}

export function createHmsRuntime(options: HmsRuntimeOptions): HmsRuntime {
  return createHmsRuntimeInternal(options, false);
}

/** Explicit proof-only composition. Never import from normal workers. */
export function createHmsLiveProofRuntime(
  options: HmsRuntimeOptions,
): HmsRuntime {
  return createHmsRuntimeInternal(options, true);
}

/** Required Playwright factory — production composition must use this (or equivalent). */
export function createPlaywrightBrowserFactory(): BrowserFactory {
  return async ({ executablePath, signal, tracesDir }) => {
    assertNotAborted(signal ?? new AbortController().signal);
    const pw = await import('playwright');
    const browser = await pw.chromium.launch({
      executablePath,
      headless: true,
      ...(tracesDir ? { tracesDir } : {}),
    });
    return {
      async newContext(opts) {
        const context = await browser.newContext(opts);
        return {
          tracing: {
            start: (o) => context.tracing.start(o),
            stop: (o) => context.tracing.stop(o),
          },
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
              const attach = (
                page: ReturnType<typeof context.pages>[number],
              ) => {
                page.on('download', (download) => {
                  (handler as (event: HmsDownloadEvent) => void)({
                    cancel: () => download.cancel(),
                  });
                });
              };
              for (const page of context.pages()) attach(page);
              context.on('page', attach);
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
  getByText(
    text: string,
    opts?: { exact?: boolean },
  ): {
    first(): {
      click(options?: { force?: boolean; timeout?: number }): Promise<void>;
    };
  };
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
  video?(): { path(): Promise<string> } | null;
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
      const textMatch = /^text=(.+)$/i.exec(selector);
      if (textMatch) {
        const label = textMatch[1]!;
        // ExtJS x-tree-node-text is often off-viewport; text-walker click first.
        const walked = await page.evaluate((wanted: string) => {
          const root = (
            globalThis as unknown as {
              document?: {
                createTreeWalker(
                  root: unknown,
                  whatToShow: number,
                ): {
                  nextNode(): {
                    textContent: string | null;
                    parentElement: { click(): void } | null;
                  } | null;
                };
                body: unknown;
              };
            }
          ).document;
          if (!root?.body) return false;
          const walker = root.createTreeWalker(root.body, 4 /* SHOW_TEXT */);
          let node = walker.nextNode();
          while (node) {
            if (
              (node.textContent || '').trim() === wanted &&
              node.parentElement
            ) {
              node.parentElement.click();
              return true;
            }
            node = walker.nextNode();
          }
          return false;
        }, label);
        if (walked) return;
        try {
          await page
            .getByText(label, { exact: true })
            .first()
            .click({ force: true, timeout: 5_000 });
          return;
        } catch {
          /* try xpath */
        }
        try {
          await page
            .locator(
              `xpath=//*[normalize-space(text())=${JSON.stringify(label)}]`,
            )
            .first()
            .click({ force: true, timeout: 5_000 });
          return;
        } catch {
          /* fall through */
        }
      }

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
    video: () => {
      const v = page.video?.();
      if (!v) return null;
      return { path: () => v.path() };
    },
  };
}

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
import { zipSync } from 'fflate';
import type { RequestDecision, RequestPolicyManifest } from './contracts.js';
import {
  contextCreationOptions,
  createBrowserEventGuards,
  enforceRequestPolicy,
  type PolicyRoute,
} from './request-policy.js';
import {
  buildNarrowRequestProjection,
  type NarrowRequestProjection,
} from './request-signature-projection.js';
import {
  HmsBrowserArtifactError,
  HMS_BROWSER_CAPACITY_WATCHDOG_MS,
  HMS_BROWSER_ARTIFACT_MAX_CAPTURE_BYTES,
  HMS_BROWSER_ARTIFACT_MIN_LIVE_FREE_BYTES,
  HMS_BROWSER_CAPTURE_FINALIZE_TIMEOUT_MS,
  HMS_BROWSER_LIVE_PROOF_FINALIZE_TIMEOUT_MS,
  collectHmsStorageStateSecretValues,
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

/**
 * Opt-in response bounds for the small number of reviewed browser form reads.
 * The bounded native path is deliberately separate from legacy postForm calls.
 */
export type HmsPostFormResponseBounds = Readonly<{
  maxBytes: number;
  timeoutMs: number;
}>;

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
  postForm(
    url: string,
    fields: Record<string, string>,
    responseBounds?: HmsPostFormResponseBounds,
  ): Promise<string>;
  /**
   * Optional JSON POST through the same context route policy. Implementations
   * must use the page's authenticated context; no API-request fallback/retry.
   */
  postJson?(url: string, body: Record<string, unknown>): Promise<string>;
  click(selector: string): Promise<void>;
  /** Constrained dblclick — selector must be a reviewed static string. */
  dblclick(selector: string): Promise<void>;
  /**
   * Dblclick first visible ExtJS grid row whose text contains `token`.
   * Used to open the matched Guest Stay result (not shell chrome grids).
   */
  dblclickRowContaining?(token: string): Promise<void>;
  /** Constrained fill — selector must be a reviewed static string. */
  fill(selector: string, value: string): Promise<void>;
  press(selector: string, key: string): Promise<void>;
  url(): string;
  title(): Promise<string>;
  /** Wait for path-correlated response after an action (optional on stubs). Returns body text when available. */
  waitForCorrelatedResponse?(pathSubstring: string): Promise<string>;
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
    name?: string;
    title?: string;
  }): Promise<void>;
  stop(options?: { path?: string }): Promise<void>;
};

/** Opaque Playwright-native context state; never serialized by runtime code. */
export type HmsStorageState = unknown;

export type HmsNewContextOptions = {
  acceptDownloads: false;
  serviceWorkers: 'block';
  ignoreHTTPSErrors?: true;
  /** Native Playwright storageState passed only to the second context. */
  storageState?: HmsStorageState;
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
  /** Native Playwright storageState export; live adapters must implement it. */
  storageState(): Promise<HmsStorageState>;
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
    /** Per-session OSRESS.search candidate binding (exact or surname+dates). */
    exactSearchCandidate?: import('./live-read-manifest.js').ReservationSearchCandidate;
    /** Allow open before start() when LiveGuestStayDriver owns canary. */
    allowUnstarted?: boolean;
    /** Required when runtime.requireAuditCapture / production store wired. */
    auditSpec?: import('./browser-artifacts.js').HmsBrowserAuditSpec;
    /**
     * Plan-scoped HMS session lease. When set, request firewall uses this
     * tool/branch manifest — never a process-wide Guest Stay union.
     */
    sessionAuthorization?: import('./release-kernel.js').HmsSessionAuthorization;
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
  /**
   * Narrow private proof-binding seam for connected runs. It is invoked for
   * each supplied session authorization before a proof context is created and
   * again after authentication. Undefined preserves fixture runtimes.
   */
  validateSessionAuthorization?: (
    authorization: import('./release-kernel.js').HmsSessionAuthorization,
  ) => Promise<void> | void;
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
  /**
   * Production live path: every non-canary openReadSession must carry a
   * per-tool HmsSessionAuthorization (never process-wide Guest Stay alone).
   */
  requireSessionAuthorization?: boolean;
  /**
   * Reuse a validated authenticated storage state between serialized read
   * sessions. The proof context remains fresh per call; only the login is
   * reused. Disabled by default for isolated fixture/proof tests.
   */
  reuseAuthenticatedStorageState?: boolean;
  /**
   * Development-only request projection invoked synchronously before policy
   * continuation/abort. It receives names, reviewed transport values and
   * digests only; callback failure never changes the policy decision.
   */
  onRequestProjection?: (projection: NarrowRequestProjection) => void;
};

export const HEALTH_HEARTBEAT_MS = 10_000;
export const HEALTH_STALE_AFTER_MS = 30_000;
export const ARTIFACT_PURGE_INTERVAL_MS = 60 * 60 * 1000;

/** Max queued waiters for the one-session semaphore (holder not counted). */
export const HMS_SESSION_WAITER_CAP = 2;
export const HMS_SESSION_WAITER_CAP_CODE = 'HMS_SESSION_WAITER_CAP';
export const CAPACITY_REJECTED = 'CAPACITY_REJECTED';

// Authentication contexts are never recorded, but their native close must
// still be bounded. A late native close remains attached to its original
// context so a timed-out cleanup cannot release the session lock or mutate a
// later context's accounting.
const HMS_AUTH_CONTEXT_CLOSE_TIMEOUT_MS = 1_000;

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

function assertDeadline(signal: AbortSignal): void {
  const deadline = (signal as AbortSignal & { deadlineMs?: number }).deadlineMs;
  if (typeof deadline === 'number' && deadline <= Date.now()) {
    throw new HmsRuntimeError('aborted', 'HMS operation deadline exceeded');
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

type LoginTimingPhase =
  | 'login_goto'
  | 'login_fill'
  | 'login_submit'
  | 'wait_authenticated_shell'
  | 'verify_property';
type LoginTimingBranch = 'userid' | 'label' | 'username' | 'button' | 'enter';

function emitLoginTiming(
  phase: LoginTimingPhase,
  startedAt: number,
  selectorBranch?: LoginTimingBranch,
): void {
  if (process.env.HMS_PROOF_DIAGNOSTICS !== '1') return;
  try {
    process.stderr.write(
      `${JSON.stringify({
        type: 'HMS_PROOF_DIAGNOSTIC',
        stage: 'login_timing',
        phase,
        durationMs: Math.max(0, Date.now() - startedAt),
        ...(selectorBranch ? { selectorBranch } : {}),
      })}\n`,
    );
  } catch {
    // Diagnostics must never change the login result or mask its error.
  }
}

async function gotoLoginWithTiming(
  page: HmsPage,
  url: string,
  timeout: number,
): Promise<void> {
  const startedAt = Date.now();
  try {
    await page.goto(url, { timeout });
  } finally {
    emitLoginTiming('login_goto', startedAt);
  }
}

function isNavigationRaceError(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  return /navigat|Execution context was destroyed|changing the content|Target closed/i.test(
    msg,
  );
}

/**
 * Proof-context entry after storage-state handoff.
 * Live Infor COMMON?REQ_KEY is one-shot: replaying it in a second context loads
 * a document that never hydrates tenant/property (AUTH_FAILED). Guest Stay
 * OSRESV is already on the reviewed find manifest and restores the shell from
 * cookies without consuming REQ_KEY.
 */
export function resolveProofLandingUrl(authLandingUrl: string): string {
  const url = new URL(authLandingUrl);
  if (/\/web\/base\/COMMON/i.test(url.pathname)) {
    return new URL('/web/base/OSRESV', url.origin).href;
  }
  return authLandingUrl;
}

/**
 * Detect a true unauthenticated login document after storage-state handoff.
 * Do not match bare "username"/"userid"/"password" substrings on authenticated
 * COMMON HTML — live Infor shell keeps those inputs in chrome/modals.
 */
export function looksLikeUnauthenticatedLoginPage(
  pageUrl: string,
  html: string,
): boolean {
  let pathname = '';
  try {
    pathname = new URL(pageUrl).pathname;
  } catch {
    pathname = '';
  }
  if (/\/web\/base\/COMMON/i.test(pathname) || /\/web\/base\/OSRESV/i.test(pathname)) {
    return false;
  }
  if (
    /\/web\/base\/logindisp$/i.test(pathname) ||
    /\/web\/base\/login\/?$/i.test(pathname) ||
    pathname === '/login'
  ) {
    return true;
  }
  // Unknown paths (fixtures): require a password-typed field, not name-only hits.
  return (
    /<input\b[^>]*type=["']password["'][^>]*>/i.test(html) &&
    /<input\b[^>]*(?:name|id|aria-label)=["'][^"']*(?:userid|username|password)["'][^>]*>/i.test(
      html,
    )
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
  const startedAt = Date.now();
  try {
    await waitForAuthenticatedShellCore(page, secret, timeoutMs);
  } finally {
    emitLoginTiming('wait_authenticated_shell', startedAt);
  }
}

async function waitForAuthenticatedShellCore(
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
        this.ctx.markAuthenticated();
      }

      async postForm(
        url: string,
        fields: Record<string, string>,
        responseBounds?: HmsPostFormResponseBounds,
      ) {
        this.#assertOpen();
        if (responseBounds) {
          throw new HmsRuntimeError(
            'SOURCE_UNAVAILABLE',
            'bounded form reads require native browser transport',
          );
        }
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

      async postJson(url: string, body: Record<string, unknown>) {
        this.#assertOpen();
        const postData = JSON.stringify(body);
        const decision = await this.ctx.dispatchRoute({
          url,
          method: 'POST',
          resourceType: 'xhr',
          headers: { 'content-type': 'application/json' },
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
          headers: { 'content-type': 'application/json' },
          body: postData,
          redirect: 'manual',
        });
        if (res.status < 200 || res.status >= 300 || res.type === 'opaqueredirect') {
          throw new HmsRuntimeError(
            'SOURCE_UNAVAILABLE',
            'JSON response status/type rejected',
          );
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

      async dblclick(selector: string) {
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
        return '';
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
      #storageState: HmsStorageState;
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
            await writeFile(
              opts.path,
              Buffer.from(
                zipSync(
                  {
                    'trace.trace': Buffer.from('{"type":"context-options"}\n'),
                    'trace.network': Buffer.from('{"type":"resource-snapshot"}\n'),
                  },
                  { level: 0, mtime: new Date('1980-01-01T00:00:00.000Z') },
                ),
              ),
            );
          }
        },
      };

      constructor(opts?: HmsNewContextOptions) {
        this.#videoDir = opts?.recordVideo?.dir ?? null;
        this.#storageState = opts?.storageState ?? {
          cookies: [],
          origins: [],
        };
      }

      markAuthenticated() {
        // Offline adapter only: this models the native storageState contract;
        // production state always comes from Playwright itself.
        this.#storageState = {
          cookies: [{ name: 'fixture-session', value: 'authenticated' }],
          origins: [],
        };
      }

      async storageState(): Promise<HmsStorageState> {
        return this.#storageState;
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
  let cachedAuthenticatedStorageState: HmsStorageState | null = null;
  let cachedAuthenticatedLandingUrl: string | null = null;
  const reuseAuthenticatedStorageState = options.reuseAuthenticatedStorageState === true;
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
    if (process.env.HMS_PROOF_SOFT_TRACE_FINALIZE === '1') {
      // Plan gate prefers video over trace ZIP. Keep runtime usable for the next
      // discovery candidate / live_proof session after sanitizer timeout.
      lastErrorCode = 'AUDIT_CAPTURE';
      if (process.env.HMS_PROOF_DIAGNOSTICS === '1') {
        process.stderr.write(
          `${JSON.stringify({
            type: 'HMS_PROOF_DIAGNOSTIC',
            stage: 'finalize_timeout',
            code: 'TRACE_FINALIZE_SOFT_NO_POISON',
          })}\n`,
        );
      }
      return;
    }
    closing = true;
    started = false;
    state = 'degraded';
    lastErrorCode = 'AUDIT_CAPTURE';
    cachedSecret = null;
    cachedAuthenticatedStorageState = null;
    cachedAuthenticatedLandingUrl = null;
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

  async function getBrowser(
    signal: AbortSignal,
    captureTracesDir?: string,
  ): Promise<HmsBrowser> {
    assertNotAborted(signal);
    if (browser) return browser;
    try {
      browser = await options.browserFactory({
        executablePath: options.executablePath,
        signal,
        tracesDir: captureTracesDir ?? options.artifactStore?.intermediateDir,
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

  async function verifyPropertyCore(
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

  async function verifyProperty(
    page: HmsPage,
    secret: HmsSecret,
  ): Promise<void> {
    const startedAt = Date.now();
    try {
      await verifyPropertyCore(page, secret);
    } finally {
      emitLoginTiming('verify_property', startedAt);
    }
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
  const drainActiveTeardown = async (): Promise<void> => {
    let observed: Promise<void> | null = null;
    while (observed !== activeTeardown) {
      observed = activeTeardown;
      await observed;
    }
  };

  async function openReadSessionInternal(input: {
    transportId: string;
    signal: AbortSignal;
    canary?: boolean;
    exactSearchCandidate?: import('./live-read-manifest.js').ReservationSearchCandidate;
    allowUnstarted?: boolean;
    auditSpec?: HmsBrowserAuditSpec;
    sessionAuthorization?: import('./release-kernel.js').HmsSessionAuthorization;
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

    const requireSessionAuth = options.requireSessionAuthorization === true;
    if (
      requireSessionAuth &&
      !input.canary &&
      !input.sessionAuthorization
    ) {
      throw new HmsRuntimeError(
        'ROLE_SCOPE_INVALID',
        'sessionAuthorization required for live read session',
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

    const revalidateSessionAuthorization = async (): Promise<void> => {
      const auth = input.sessionAuthorization;
      if (!auth) return;
      const expiresAt = Date.parse(auth.expiresAt);
      if (!Number.isFinite(expiresAt) || expiresAt <= Date.now()) {
        throw new HmsRuntimeError(
          'ROLE_PROOF_EXPIRED',
          'session authorization expired',
        );
      }
      if (options.validateSessionAuthorization) {
        try {
          await options.validateSessionAuthorization(auth);
        } catch (err) {
          if (err instanceof HmsRuntimeError) throw err;
          const code =
            err && typeof err === 'object' && 'code' in err && typeof err.code === 'string'
              ? err.code
              : 'ROLE_SCOPE_INVALID';
          throw new HmsRuntimeError(code, redactError(err));
        }
      }
      const loader = options.loadRoleProof;
      if (loader) {
        try {
          await loader(auth.roleProofPath, new Date());
        } catch (err) {
          if (err instanceof HmsRuntimeError) throw err;
          throw new HmsRuntimeError('ROLE_PROOF_MISSING', redactError(err));
        }
      }
    };

    let sessionManifest = options.manifest;
    if (input.sessionAuthorization) {
      const auth = input.sessionAuthorization;
      // Per-context lease: one tool/branch manifest — never process-wide union.
      sessionManifest = auth.manifest;
      await revalidateSessionAuthorization();
    } else if (input.exactSearchCandidate) {
      const { buildExactOsressSearchManifest } = await import(
        './live-read-manifest.js'
      );
      sessionManifest = buildExactOsressSearchManifest(
        new URL(secret.loginUrl).origin,
        input.exactSearchCandidate,
      );
    }
    if (process.env.HMS_PROOF_DIAGNOSTICS === '1') {
      const hdrIds = sessionManifest.rules
        .filter((rule) => rule.path === '/web/base/OSRESV.HDR')
        .map((rule) => rule.id);
      process.stderr.write(
        `${JSON.stringify({
          type: 'HMS_PROOF_DIAGNOSTIC',
          stage: 'session_manifest',
          code: hdrIds.includes('live-osresv-hdr-detail-open-chrome')
            ? 'SESSION_HAS_HDR_DETAIL_CHROME'
            : hdrIds.includes('live-osresv-hdr')
              ? 'SESSION_HAS_SHELL_HDR_ONLY'
              : 'SESSION_HDR_UNEXPECTED',
          hdrRuleIds: hdrIds,
          hasSessionAuthorization: Boolean(input.sessionAuthorization),
          hasExactSearchCandidate: Boolean(input.exactSearchCandidate),
        })}\n`,
      );
    }

    let capture: HmsBrowserCaptureHandle | null = null;
    let lastReceipt: import('./browser-artifacts.js').HmsBrowserArtifactReceiptV1 | null =
      null;

    const release = await acquireSessionLock(input.signal);
    activeSessions += 1;

    let authContext: HmsBrowserContext | null = null;
    let authCloseOnce: Promise<void> | null = null;
    let authContextGeneration = 0;
    let authContextCloseCounted = false;
    let authClosePending = false;
    let authContextCreationPending: Promise<HmsBrowserContext> | null = null;
    let context: HmsBrowserContext | null = null;
    let proofContextCreationPending: Promise<HmsBrowserContext> | null = null;
    let proofContextGeneration = 0;
    let proofCloseOnce: Promise<void> | null = null;
    let proofClosePending = false;
    let proofCreationCleanupTimedOut = false;
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

    let teardownStarted = false;
    let teardownFinished = false;
    const releaseIfSafe = () => {
      // A timed-out native close may still be running. Keep both the lock and
      // active-session accounting until teardown is complete and ownership is
      // proven closed, including when the native promise settles late.
      if (
        !teardownFinished ||
        authContext ||
        authClosePending ||
        authContextCreationPending ||
        proofContextCreationPending ||
        context ||
        proofClosePending
      ) {
        return;
      }
      releaseOnce();
    };

    const poisonAuthCleanup = () => {
      // No proof context may be created after auth cleanup is unprovable. The
      // existing closing gate is terminal for this runtime instance; it is not
      // a new rearm or registry authority.
      closing = true;
      started = false;
      state = state === 'circuit_open' ? state : 'degraded';
      lastErrorCode = 'AUDIT_CAPTURE';
    };

    const markAuthContextClosed = (
      owned: HmsBrowserContext,
      generation: number,
    ) => {
      // Identity + generation prevents a late completion from clearing or
      // counting a different context if ownership ever changes.
      if (authContext !== owned || authContextGeneration !== generation) return;
      authContext = null;
      authClosePending = false;
      if (!authContextCloseCounted) {
        authContextCloseCounted = true;
        contextsClosed += 1;
      }
      releaseIfSafe();
    };

    const closeAuthContext = (): Promise<void> => {
      if (authCloseOnce) return authCloseOnce;
      const owned = authContext;
      if (!owned) return Promise.resolve();
      const generation = authContextGeneration;
      authClosePending = true;

      let operation!: Promise<void>;
      operation = (async () => {
        const deadline = Date.now() + HMS_AUTH_CONTEXT_CLOSE_TIMEOUT_MS;
        for (let attempt = 0; attempt < 2; attempt += 1) {
          const remaining = deadline - Date.now();
          if (remaining <= 0) {
            authClosePending = false;
            poisonAuthCleanup();
            throw new HmsRuntimeError(
              'AUDIT_CAPTURE',
              'AUTH_CONTEXT_CLOSE_FAILED',
            );
          }

          // Promise.resolve().then also converts a synchronous native throw to
          // a handled rejection, allowing the safe retry path below.
          const pending = Promise.resolve().then(() => owned.close());
          let timer: ReturnType<typeof setTimeout> | undefined;
          let timedOut = false;
          const timeoutError = new HmsRuntimeError(
            'AUDIT_CAPTURE',
            'AUTH_CONTEXT_CLOSE_TIMEOUT',
          );
          try {
            await new Promise<void>((resolve, reject) => {
              timer = setTimeout(() => {
                timedOut = true;
                reject(timeoutError);
              }, remaining);
              pending.then(resolve, reject);
            });
            markAuthContextClosed(owned, generation);
            return;
          } catch (error) {
            if (timedOut) {
              // Keep the native promise observed so a late rejection cannot
              // become unhandled. A late success closes only this exact owner.
              void pending.then(
                () => {
                  if (
                    authContext === owned &&
                    authContextGeneration === generation
                  ) {
                    markAuthContextClosed(owned, generation);
                    if (authCloseOnce === operation) {
                      authCloseOnce = Promise.resolve();
                    }
                  }
                },
                () => {
                  if (
                    authContext === owned &&
                    authContextGeneration === generation
                  ) {
                    authClosePending = false;
                    poisonAuthCleanup();
                  }
                },
              );
              poisonAuthCleanup();
              throw error;
            }
            if (attempt === 0 && Date.now() < deadline) {
              // A settled rejection means no concurrent native close remains;
              // retry once to recover from a partial/idempotent close failure.
              continue;
            }
            authClosePending = false;
            poisonAuthCleanup();
            throw new HmsRuntimeError(
              'AUDIT_CAPTURE',
              'AUTH_CONTEXT_CLOSE_FAILED',
            );
          } finally {
            if (timer) clearTimeout(timer);
          }
        }
      })();
      authCloseOnce = operation;
      return operation;
    };

    const beginAuthContextCreation = (
      create: () => Promise<HmsBrowserContext>,
    ): Promise<HmsBrowserContext> => {
      const pending = Promise.resolve().then(create);
      authContextCreationPending = pending;
      void pending.then(
        (created) => {
          if (authContextCreationPending === pending) {
            authContextCreationPending = null;
          }
          authContext = created;
          authContextGeneration += 1;
          authContextCloseCounted = false;
          contextsCreated += 1;
          if (input.signal.aborted || terminal || closing) {
            void closeAuthContext().catch(() => undefined);
          } else {
            releaseIfSafe();
          }
        },
        () => {
          if (authContextCreationPending === pending) {
            authContextCreationPending = null;
          }
          releaseIfSafe();
        },
      );
      return pending;
    };

    const awaitAuthContextCreationCleanup = async (): Promise<void> => {
      const pending = authContextCreationPending;
      if (pending) {
        let timer: ReturnType<typeof setTimeout> | undefined;
        let timedOut = false;
        try {
          await Promise.race([
            pending,
            new Promise<void>((resolve) => {
              timer = setTimeout(() => {
                timedOut = true;
                resolve();
              }, HMS_AUTH_CONTEXT_CLOSE_TIMEOUT_MS);
            }),
          ]);
        } finally {
          if (timer) clearTimeout(timer);
        }
        if (timedOut) {
          poisonAuthCleanup();
          throw new HmsRuntimeError(
            'AUDIT_CAPTURE',
            'AUTH_CONTEXT_CREATE_TIMEOUT',
          );
        }
      }
      await closeAuthContext();
    };

    const awaitContextCreationForSetup = async <T>(
      pending: Promise<T>,
    ): Promise<T> => {
      if (input.signal.aborted) {
        throw new HmsRuntimeError('aborted', 'HMS operation aborted');
      }
      let onAbort!: () => void;
      const aborted = new Promise<never>((_, reject) => {
        onAbort = () =>
          reject(new HmsRuntimeError('aborted', 'HMS operation aborted'));
        input.signal.addEventListener('abort', onAbort, { once: true });
      });
      try {
        return await Promise.race([pending, aborted]);
      } finally {
        input.signal.removeEventListener('abort', onAbort);
      }
    };

    const markProofContextClosed = (
      owned: HmsBrowserContext,
      generation: number,
    ) => {
      if (context !== owned || proofContextGeneration !== generation) return;
      context = null;
      proofClosePending = false;
      if (!closedCounted) {
        closedCounted = true;
        contextsClosed += 1;
      }
      releaseIfSafe();
    };

    const closeProofContext = (deadlineAt?: number): Promise<void> => {
      if (proofCloseOnce) return proofCloseOnce;
      const owned = context;
      if (!owned) return Promise.resolve();
      const generation = proofContextGeneration;
      proofClosePending = true;

      let operation!: Promise<void>;
      operation = (async () => {
        const deadline =
          deadlineAt ?? Date.now() + HMS_AUTH_CONTEXT_CLOSE_TIMEOUT_MS;
        for (let attempt = 0; attempt < 2; attempt += 1) {
          const remaining = deadline - Date.now();
          if (remaining <= 0) {
            proofClosePending = false;
            poisonAuthCleanup();
            throw new HmsRuntimeError(
              'AUDIT_CAPTURE',
              'CONTEXT_CLOSE_FAILED',
            );
          }
          const pending = Promise.resolve().then(() => owned.close());
          let timer: ReturnType<typeof setTimeout> | undefined;
          let timedOut = false;
          const timeoutError = new HmsRuntimeError(
            'AUDIT_CAPTURE',
            'CONTEXT_CLOSE_FAILED',
          );
          try {
            await new Promise<void>((resolve, reject) => {
              timer = setTimeout(() => {
                timedOut = true;
                reject(timeoutError);
              }, remaining);
              pending.then(resolve, reject);
            });
            markProofContextClosed(owned, generation);
            return;
          } catch (error) {
            if (timedOut) {
              void pending.then(
                () => {
                  if (
                    context === owned &&
                    proofContextGeneration === generation
                  ) {
                    markProofContextClosed(owned, generation);
                    if (proofCloseOnce === operation) {
                      proofCloseOnce = Promise.resolve();
                    }
                  }
                },
                () => {
                  if (
                    context === owned &&
                    proofContextGeneration === generation
                  ) {
                    proofClosePending = false;
                    poisonAuthCleanup();
                  }
                },
              );
              poisonAuthCleanup();
              throw error;
            }
            if (attempt === 0 && Date.now() < deadline) continue;
            proofClosePending = false;
            poisonAuthCleanup();
            throw new HmsRuntimeError(
              'AUDIT_CAPTURE',
              'CONTEXT_CLOSE_FAILED',
            );
          } finally {
            if (timer) clearTimeout(timer);
          }
        }
      })();
      proofCloseOnce = operation;
      return operation;
    };

    const beginProofContextCreation = (
      create: () => Promise<HmsBrowserContext>,
    ): Promise<HmsBrowserContext> => {
      const pending = Promise.resolve().then(create);
      proofContextCreationPending = pending;
      void pending.then(
        (created) => {
          if (proofContextCreationPending === pending) {
            proofContextCreationPending = null;
          }
          context = created;
          proofContextGeneration += 1;
          closedCounted = false;
          contextsCreated += 1;
          if (input.signal.aborted || terminal || closing) {
            if (
              !teardownStarted ||
              teardownFinished ||
              proofCreationCleanupTimedOut
            ) {
              void closeProofContext().catch(() => undefined);
            }
          } else {
            releaseIfSafe();
          }
        },
        () => {
          if (proofContextCreationPending === pending) {
            proofContextCreationPending = null;
          }
          releaseIfSafe();
        },
      );
      return pending;
    };

    const awaitProofContextCreation = async (): Promise<void> => {
      const pending = proofContextCreationPending;
      if (!pending) return;
      let timer: ReturnType<typeof setTimeout> | undefined;
      let timedOut = false;
      try {
        await Promise.race([
          pending,
          new Promise<void>((resolve) => {
            timer = setTimeout(() => {
              timedOut = true;
              resolve();
            }, HMS_AUTH_CONTEXT_CLOSE_TIMEOUT_MS);
          }),
        ]);
      } finally {
        if (timer) clearTimeout(timer);
      }
      if (timedOut) {
        proofCreationCleanupTimedOut = true;
        poisonAuthCleanup();
        throw new HmsRuntimeError(
          'AUDIT_CAPTURE',
          'PROOF_CONTEXT_CREATE_TIMEOUT',
        );
      }
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
      const parentDeadline = (input.signal as AbortSignal & { deadlineMs?: number }).deadlineMs;
      const finalizeDeadline = Math.min(
        Date.now() + budgetMs,
        typeof parentDeadline === 'number' && Number.isFinite(parentDeadline)
          ? parentDeadline
          : Infinity,
      );
      const finalizeController = new AbortController();
      (finalizeController.signal as AbortSignal & { deadlineMs?: number }).deadlineMs =
        finalizeDeadline;
      const onParentAbort = () => finalizeController.abort(input.signal.reason);
      input.signal.addEventListener('abort', onParentAbort, { once: true });
      if (input.signal.aborted) onParentAbort();
      let finalizeTimedOut = false;
      const abortFinalization = (): void => {
        finalizeTimedOut = true;
        capture!.invalidate();
        finalizeController.abort(
          new HmsRuntimeError('AUDIT_CAPTURE', 'TRACE_FINALIZE_FAILED'),
        );
      };
      const finalizeTimer = setTimeout(
        abortFinalization,
        Math.max(0, finalizeDeadline - Date.now()),
      );
      type LateProducer = {
        kind: 'trace_stop' | 'video' | 'capture_finalize';
        pending: Promise<unknown>;
      };
      // Keep the mutable value behind an object property. TypeScript cannot
      // observe assignments made from the budget callback closure and can
      // otherwise narrow the captured variable to `never` below.
      const lateProducerRef: { current: LateProducer | null } = { current: null };
      let lateSettlement: Promise<void> | null = null;
      const withinFinalizeBudget = async <T>(
        operation: () => Promise<T>,
        kind: 'trace_stop' | 'video' | 'capture_finalize',
      ): Promise<T> => {
        const remaining = finalizeDeadline - Date.now();
        if (remaining <= 0) {
          abortFinalization();
          await poisonAfterFinalizeTimeout();
          throw new HmsRuntimeError('AUDIT_CAPTURE', 'TRACE_FINALIZE_FAILED');
        }
        const pending = Promise.resolve().then(operation);
        let timer: ReturnType<typeof setTimeout> | undefined;
        let timedOut = false;
        try {
          return await Promise.race([
            pending,
            new Promise<never>((_, reject) => {
              timer = setTimeout(
                () => {
                  timedOut = true;
                  abortFinalization();
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
          if (timedOut || finalizeTimedOut) {
            abortFinalization();
            lateProducerRef.current ??= { kind, pending };
            await poisonAfterFinalizeTimeout();
          }
          throw error;
        } finally {
          if (timer) clearTimeout(timer);
        }
      };
      const quarantineLateProducer = (): void => {
        const producer = lateProducerRef.current;
        if (!producer || lateSettlement) return;
        const recordLateFailure = async (error: unknown): Promise<void> => {
          const failure =
            error instanceof HmsRuntimeError
              ? error
              : new HmsRuntimeError('AUDIT_CAPTURE', 'TRACE_FINALIZE_FAILED');
          activeTeardownError ??= failure;
          state = 'degraded';
          lastErrorCode = 'AUDIT_CAPTURE';
          try {
            await capture!.abandon();
          } catch (cleanupError) {
            activeTeardownError ??= cleanupError;
          }
        };
        const settlement = producer.pending.then(
          async (result) => {
            try {
              if (producer.kind === 'capture_finalize') {
                const receipt =
                  result as import('./browser-artifacts.js').HmsBrowserArtifactReceiptV1;
                if (receipt.artifactState === 'complete') {
                  capture!.invalidate();
                  await recordLateFailure(
                    new HmsRuntimeError('AUDIT_CAPTURE', 'TRACE_FINALIZE_FAILED'),
                  );
                  return;
                }
                lastReceipt = receipt;
                return;
              }
              await closeProofContext().catch(() => undefined);
              const receipt = await capture!.finalize({
                signal: finalizeController.signal,
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
                complete: false,
              });
              if (receipt.artifactState === 'complete') {
                capture!.invalidate();
                await recordLateFailure(
                  new HmsRuntimeError('AUDIT_CAPTURE', 'TRACE_FINALIZE_FAILED'),
                );
              } else {
                lastReceipt = receipt;
              }
            } catch (error) {
              await recordLateFailure(error);
            }
          },
          async (error) => {
            await recordLateFailure(error);
          },
        );
        lateSettlement = settlement;
        // Keep teardown ownership attached until the native producer settles;
        // the caller still receives the bounded failure immediately. The
        // single cached settlement also prevents duplicate late finalizers
        // when both the producer-specific and outer catches run.
        activeTeardown = activeTeardown.then(async () => {
          await lateSettlement;
        });
        void lateSettlement;
      };
      try {
        let softAbandonAfterClose = false;
        if (
          process.env.HMS_PROOF_SOFT_TRACE_FINALIZE === '1' &&
          !traceStarted
        ) {
          if (input.auditSpec?.executionClass === 'live_proof') {
            // Soft video-only gate: never demand sanitized trace.zip. Force the
            // incomplete finalize path so video digests land on lastReceipt
            // instead of throwing away retainIncomplete's receipt.
            args.complete = false;
            if (args.terminalCode === 'OK') {
              args.terminalCode = 'TRACE_FINALIZE_FAILED';
              args.terminalStage = 'receipt_finalize';
            }
            if (process.env.HMS_PROOF_DIAGNOSTICS === '1') {
              process.stderr.write(
                `${JSON.stringify({
                  type: 'HMS_PROOF_DIAGNOSTIC',
                  stage: 'finalize_capture',
                  code: 'TRACE_SKIPPED_SOFT_INCOMPLETE',
                })}\n`,
              );
            }
          } else {
            // Discovery/normal: close context first, then abandon capture —
            // never leave sessions open (CAPACITY_REJECTED) or .incomplete-*.
            softAbandonAfterClose = true;
            args.complete = false;
          }
        }
        try {
          if (context && traceStarted) {
            await withinFinalizeBudget(() =>
              context!.tracing.stop({
                path: join(capture!.stagingDir, 'trace.zip'),
              }),
              'trace_stop',
            );
            capture.markMilestone('traceStoppedAt');
          }
        } catch {
          args.complete = false;
          args.terminalCode =
            args.terminalCode === 'OK' ? 'TRACE_FINALIZE_FAILED' : args.terminalCode;
          args.terminalStage = 'trace_stop';
          if (lateProducerRef.current?.kind === 'trace_stop') {
            quarantineLateProducer();
            throw new HmsRuntimeError('AUDIT_CAPTURE', 'TRACE_FINALIZE_FAILED');
          }
        }

        let closeErr: unknown;
        try {
          if (context) {
            const videoHandle =
              input.auditSpec?.executionClass === 'live_proof' && primaryPage?.video
                ? primaryPage.video()
                : null;
            await closeProofContext(finalizeDeadline);
            capture.markMilestone('contextClosedAt');
            if (videoHandle && capture.videoDir) {
              try {
                const rawPath = await withinFinalizeBudget(() =>
                  videoHandle.path(),
                  'video',
                );
                await withinFinalizeBudget(
                  () => rename(rawPath, join(capture!.stagingDir, 'video.webm')),
                  'video',
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
        }

        if (softAbandonAfterClose) {
          await capture.abandon();
          if (process.env.HMS_PROOF_DIAGNOSTICS === '1') {
            process.stderr.write(
              `${JSON.stringify({
                type: 'HMS_PROOF_DIAGNOSTIC',
                stage: 'finalize_capture',
                code: 'TRACE_SKIPPED_SOFT_ABANDON',
                terminalCode: args.terminalCode,
              })}\n`,
            );
          }
          if (closeErr) {
            throw closeErr instanceof Error
              ? closeErr
              : new HmsRuntimeError('AUDIT_CAPTURE', 'CONTEXT_CLOSE_FAILED');
          }
          return;
        }

        try {
          const receipt = await withinFinalizeBudget(() =>
            capture!.finalize({
              signal: finalizeController.signal,
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
            'capture_finalize',
          );
          lastReceipt = receipt;
          if (receipt.artifactState !== 'complete') {
            const softVideoOk =
              process.env.HMS_PROOF_SOFT_TRACE_FINALIZE === '1' &&
              input.auditSpec?.executionClass === 'live_proof' &&
              Boolean(receipt.video);
            if (softVideoOk) {
              if (process.env.HMS_PROOF_DIAGNOSTICS === '1') {
                process.stderr.write(
                  `${JSON.stringify({
                    type: 'HMS_PROOF_DIAGNOSTIC',
                    stage: 'finalize_capture',
                    code: 'SOFT_INCOMPLETE_VIDEO_KEPT',
                    artifactId: receipt.artifactId,
                    hasVideo: true,
                  })}\n`,
                );
              }
              // Keep `.incomplete-<id>` (video + receipt). Do not abandon.
              return;
            }
            state = 'degraded';
            lastErrorCode = 'AUDIT_CAPTURE';
            throw new HmsRuntimeError('AUDIT_CAPTURE', args.terminalCode);
          }
        } catch (err) {
          if (lateProducerRef.current) {
            quarantineLateProducer();
          } else {
            await capture.abandon();
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
      } finally {
        clearTimeout(finalizeTimer);
        input.signal.removeEventListener('abort', onParentAbort);
      }
    };

    const teardown = async (captureArgs?: {
      outcome: import('./browser-artifacts.js').HmsBrowserArtifactReceiptBaseV1['operationOutcome'];
      terminalCode: import('./browser-artifacts.js').HmsBrowserArtifactReceiptBaseV1['terminalCode'];
      terminalStage: import('./browser-artifacts.js').HmsBrowserArtifactReceiptBaseV1['terminalStage'];
      complete: boolean;
    }) => {
      if (finalizeOnce) return finalizeOnce;
      teardownStarted = true;
      finalizeOnce = (async () => {
        let authCloseError: unknown;
        try {
          await awaitAuthContextCreationCleanup();
        } catch (error) {
          authCloseError = error;
        }
        let proofCloseError: unknown;
        try {
          await awaitProofContextCreation();
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
              await closeProofContext();
            } catch (error) {
              proofCloseError = error;
            }
          }
          const cleanupErrors = [authCloseError, proofCloseError].filter(
            (error): error is unknown => Boolean(error),
          );
          if (cleanupErrors.length === 1) throw cleanupErrors[0];
          if (cleanupErrors.length > 1) {
            throw new AggregateError(
              cleanupErrors,
              'HMS context teardown failed',
            );
          }
        } catch (error) {
          if (authCloseError && error !== authCloseError) {
            throw new AggregateError(
              [authCloseError, error],
              'HMS authentication and capture teardown failed',
            );
          }
          throw error;
        } finally {
          input.signal.removeEventListener('abort', closeOnAbort);
          teardownFinished = true;
          releaseIfSafe();
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
      capture?.invalidate();
      void teardown({
        outcome: 'aborted',
        terminalCode: 'ABORTED',
        terminalStage: 'tool',
        complete: Boolean(capture && traceStarted),
      }).catch(() => undefined);
    };

    const installContextGuards = async (
      guardedContext: HmsBrowserContext,
    ): Promise<void> => {
      // Install every guard before the context can create its first page. The
      // same manifest, terminal state, counters, and teardown cover both
      // authentication and recorded proof contexts.
      await guardedContext.routeWebSocket('**/*', (ws) => {
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

      await guardedContext.route('**/*', async (route) => {
        try {
          const request = route.request();
          options.onRequestProjection?.(
            buildNarrowRequestProjection({
              kind: 'runtime-request-projection',
              url: request.url(),
              method: request.method(),
              resourceType: request.resourceType(),
              rawBody: request.postData(),
              headers: request.headers(),
            }),
          );
        } catch {
          // Diagnostics are advisory; never let projection failure bypass the
          // fail-closed request policy below.
        }
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
              if (process.env.HMS_PROOF_DIAGNOSTICS === '1') {
                const sig = d.redactedSignature;
                const chrome = sessionManifest.rules.find(
                  (rule) => rule.id === 'live-osresv-hdr-detail-open-chrome',
                );
                const allowed = new Set([
                  ...Object.keys(chrome?.fixedBody ?? {}),
                  ...Object.keys(chrome?.variableBody ?? {}),
                ]);
                const extraKeys = sig.bodyKeys.filter((key) => !allowed.has(key));
                process.stderr.write(
                  `${JSON.stringify({
                    type: 'HMS_PROOF_DIAGNOSTIC',
                    stage: 'request_policy',
                    code: d.code,
                    method: sig.method,
                    path: sig.path,
                    resourceType: sig.resourceType,
                    queryKeys: sig.queryKeys.slice(0, 12),
                    bodyKeys: sig.bodyKeys.slice(0, 64),
                    bodyKeyCount: sig.bodyKeys.length,
                    chromeVariableCount: Object.keys(chrome?.variableBody ?? {}).length,
                    chromeFixedCount: Object.keys(chrome?.fixedBody ?? {}).length,
                    extraKeysVsChrome: extraKeys.slice(0, 16),
                  })}\n`,
                );
              }
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
      guardedContext.on('page', (page) => {
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
      guardedContext.on('download', (download) => {
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
      guardedContext.on('websocket', () => {
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
          capture.addSecretValues([currentSecret.username, currentSecret.password]);
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
      if (capture) capture.markMilestone('loginStartedAt');

      // Authentication is deliberately unrecorded and untraced. It shares the
      // browser process, lock, manifest, guards, counters, and terminal state
      // with the proof context but never receives recordVideo.
      await revalidateRoleProof();
      revalidateEvidenceIfConfigured();
      await revalidateSessionAuthorization();
      assertNotAborted(input.signal);
      assertDeadline(input.signal);
      const b = await getBrowser(input.signal, capture?.nativeTracesDir);
      assertNotAborted(input.signal);
      assertDeadline(input.signal);
      if (terminal || closing) {
        throw new HmsRuntimeError('aborted', 'HMS operation aborted');
      }

      // Live Infor: Playwright storageState handoff into a second context does
      // not restore an authenticated shell (AUTH_FAILED after COMMON/OSRESV).
      // Opt-in single-context login keeps session on one context. live_proof
      // video may include the login form; preferred over no live proof.
      const useSingleContextLogin = process.env.HMS_SINGLE_CONTEXT_LOGIN === '1';
      if (useSingleContextLogin) {
        const proofOpts: HmsNewContextOptions = {
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
        const proof = await awaitContextCreationForSetup(
          beginProofContextCreation(async () => {
            assertNotAborted(input.signal);
            assertDeadline(input.signal);
            if (terminal || closing) {
              throw new HmsRuntimeError('aborted', 'HMS operation aborted');
            }
            return b.newContext(proofOpts);
          }),
        );
        if (input.signal.aborted || terminal || closing) {
          await closeProofContext();
          throw new HmsRuntimeError('aborted', 'HMS operation aborted');
        }
        await installContextGuards(proof);
        assertNotAborted(input.signal);
        assertDeadline(input.signal);
        const page = await proof.newPage();
        primaryPage = page;
        page.setDefaultTimeout(timeoutMs);
        page.setDefaultNavigationTimeout(timeoutMs);
        await gotoLoginWithTiming(
          page,
          secret.loginUrl,
          remainingBudgetMs(input.signal, timeoutMs),
        );
        await page.fillLogin(secret.username, secret.password);
        await page.submitLogin();
        await waitForAuthenticatedShell(
          page,
          secret,
          remainingBudgetMs(input.signal, timeoutMs),
        );
        await verifyProperty(page, secret);
        await revalidateSessionAuthorization();

        if (capture) {
          const skipTrace = process.env.HMS_PROOF_SOFT_TRACE_FINALIZE === '1';
          if (!skipTrace) {
            try {
              await proof.tracing.start({
                screenshots: true,
                snapshots: true,
                sources: false,
                name: capture.nativeTraceName,
                title: `${input.auditSpec!.toolId}:${input.auditSpec!.operationId}`,
              });
              traceStarted = true;
              capture.markMilestone('traceStartedAt');
            } catch {
              await capture.abandon();
              throw new HmsRuntimeError('AUDIT_CAPTURE', 'TRACE_START_FAILED');
            }
          } else if (process.env.HMS_PROOF_DIAGNOSTICS === '1') {
            process.stderr.write(
              `${JSON.stringify({
                type: 'HMS_PROOF_DIAGNOSTIC',
                stage: 'trace_start',
                code: 'TRACE_SKIPPED_SOFT',
                executionClass: input.auditSpec?.executionClass ?? null,
              })}\n`,
            );
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
      }

      let storageState: HmsStorageState | null = reuseAuthenticatedStorageState
        ? cachedAuthenticatedStorageState
        : null;
      let landingUrl: string | null = reuseAuthenticatedStorageState
        ? cachedAuthenticatedLandingUrl
        : null;

      // Production read calls are serialized by sessionSemaphore. Reuse only
      // the native state captured after a successful, property-verified login;
      // the proof context and page remain fresh for every call. A failed proof
      // clears this cache in the outer catch, so the next call logs in again.
      if (!storageState || !landingUrl) {
        const auth = await awaitContextCreationForSetup(
          beginAuthContextCreation(async () => {
            assertNotAborted(input.signal);
            assertDeadline(input.signal);
            if (terminal || closing) {
              throw new HmsRuntimeError('aborted', 'HMS operation aborted');
            }
            return b.newContext(contextCreationOptions());
          }),
        );
        if (input.signal.aborted || terminal || closing) {
          await closeAuthContext();
          throw new HmsRuntimeError('aborted', 'HMS operation aborted');
        }
        await installContextGuards(auth);
        assertNotAborted(input.signal);
        assertDeadline(input.signal);
        const authPage = await auth.newPage();
        authPage.setDefaultTimeout(timeoutMs);
        authPage.setDefaultNavigationTimeout(timeoutMs);
        await gotoLoginWithTiming(
          authPage,
          secret.loginUrl,
          remainingBudgetMs(input.signal, timeoutMs),
        );
        await authPage.fillLogin(secret.username, secret.password);
        await authPage.submitLogin();
        await waitForAuthenticatedShell(
          authPage,
          secret,
          remainingBudgetMs(input.signal, timeoutMs),
        );
        await verifyProperty(authPage, secret);

        const authenticatedLandingUrl = authPage.url();
        if (
          !authenticatedLandingUrl ||
          new URL(authenticatedLandingUrl).origin !== new URL(secret.loginUrl).origin
        ) {
          throw new HmsRuntimeError(
            'AUTH_STATE_NOT_PORTABLE',
            'authenticated landing URL is not same-origin',
          );
        }
        let authenticatedStorageState: HmsStorageState;
        try {
          authenticatedStorageState = await auth.storageState();
        } catch {
          throw new HmsRuntimeError(
            'AUTH_STATE_UNAVAILABLE',
            'native storage state unavailable',
          );
        }
        if (
          authenticatedStorageState === null ||
          typeof authenticatedStorageState !== 'object'
        ) {
          throw new HmsRuntimeError(
            'AUTH_STATE_NOT_PORTABLE',
            'native storage state is not portable',
          );
        }
        storageState = authenticatedStorageState;
        landingUrl = authenticatedLandingUrl;
        if (reuseAuthenticatedStorageState) {
          cachedAuthenticatedStorageState = authenticatedStorageState;
          cachedAuthenticatedLandingUrl = authenticatedLandingUrl;
        }
      }
      if (!storageState || !landingUrl) {
        throw new HmsRuntimeError(
          'AUTH_STATE_NOT_PORTABLE',
          'authenticated storage state unavailable',
        );
      }
      if (capture) {
        capture.addSecretValues(collectHmsStorageStateSecretValues(storageState));
      }
      // Keep the auth context alive until the proof shell is verified. Closing
      // the authenticated Infor document first has been observed to invalidate
      // the restored session (proof COMMON loads, waitForAuthenticatedShell
      // times out as AUTH_FAILED). Credentials are never typed into the
      // recorded proof context; teardown still closes auth on every path.

      // The lease, role proof, evidence binding, abort signal, and deadline are
      // all checked again after authentication and before creating the camera
      // context. Credentials can never be entered after this point.
      assertNotAborted(input.signal);
      assertDeadline(input.signal);
      if (closing || terminal) {
        throw new HmsRuntimeError('aborted', 'HMS operation aborted');
      }
      await revalidateRoleProof();
      revalidateEvidenceIfConfigured();
      await revalidateSessionAuthorization();
      assertNotAborted(input.signal);
      assertDeadline(input.signal);
      if (terminal || closing) {
        throw new HmsRuntimeError('aborted', 'HMS operation aborted');
      }
      const proofOpts: HmsNewContextOptions = {
        ...contextCreationOptions(),
        storageState,
        ...(capture?.videoDir
          ? {
              recordVideo: {
                dir: capture.videoDir,
                size: { width: 1280, height: 720 },
              },
            }
          : {}),
      };
      const proof = await awaitContextCreationForSetup(
        beginProofContextCreation(async () => {
          assertNotAborted(input.signal);
          assertDeadline(input.signal);
          if (terminal || closing) {
            throw new HmsRuntimeError('aborted', 'HMS operation aborted');
          }
          return b.newContext(proofOpts);
        }),
      );
      if (input.signal.aborted || terminal || closing) {
        await closeProofContext();
        throw new HmsRuntimeError('aborted', 'HMS operation aborted');
      }
      await installContextGuards(proof);

      if (capture) {
        const skipTrace = process.env.HMS_PROOF_SOFT_TRACE_FINALIZE === '1';
        if (!skipTrace) {
          try {
            await proof.tracing.start({
              screenshots: true,
              snapshots: true,
              sources: false,
              name: capture.nativeTraceName,
              title: `${input.auditSpec!.toolId}:${input.auditSpec!.operationId}`,
            });
            traceStarted = true;
            capture.markMilestone('traceStartedAt');
          } catch {
            await capture.abandon();
            throw new HmsRuntimeError('AUDIT_CAPTURE', 'TRACE_START_FAILED');
          }
        } else if (process.env.HMS_PROOF_DIAGNOSTICS === '1') {
          process.stderr.write(
            `${JSON.stringify({
              type: 'HMS_PROOF_DIAGNOSTIC',
              stage: 'trace_start',
              code: 'TRACE_SKIPPED_SOFT',
              executionClass: input.auditSpec?.executionClass ?? null,
            })}\n`,
          );
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

      assertNotAborted(input.signal);
      assertDeadline(input.signal);
      const page = await proof.newPage();
      primaryPage = page;
      page.setDefaultTimeout(timeoutMs);
      page.setDefaultNavigationTimeout(timeoutMs);
      const proofLandingUrl = resolveProofLandingUrl(landingUrl);
      await page.goto(proofLandingUrl, {
        timeout: remainingBudgetMs(input.signal, timeoutMs),
      });
      const proofContent = await page.content();
      if (looksLikeUnauthenticatedLoginPage(page.url(), proofContent)) {
        throw new HmsRuntimeError(
          'AUTH_STATE_NOT_PORTABLE',
          'authenticated storage state redirected to login',
        );
      }
      await waitForAuthenticatedShell(
        page,
        secret,
        remainingBudgetMs(input.signal, timeoutMs),
      );
      await verifyProperty(page, secret);
      await closeAuthContext();

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
      cachedAuthenticatedStorageState = null;
      cachedAuthenticatedLandingUrl = null;
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
        // Explicit: never drop plan-scoped lease when spreading input.
        sessionAuthorization: input.sessionAuthorization,
      });
    },

    health,

    stats: () => ({ browserLaunches, contextsCreated, contextsClosed }),

    async close() {
      closing = true;
      started = false;
      state = 'stopped';
      cachedSecret = null;
      cachedAuthenticatedStorageState = null;
      cachedAuthenticatedLandingUrl = null;
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
            await drainActiveTeardown();
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
export function createPlaywrightBrowserFactory(options: {
  /** Trusted development composition only; normal callers use Chromium launch. */
  launchBrowser?: (options: {
    executablePath?: string;
    headless: boolean;
    tracesDir?: string;
  }) => Promise<Pick<import('playwright').Browser, 'newContext' | 'close'>>;
} = {}): BrowserFactory {
  return async ({ executablePath, signal, tracesDir }) => {
    assertNotAborted(signal ?? new AbortController().signal);
    const pw = await import('playwright');
    const launch = options.launchBrowser ?? ((input) => pw.chromium.launch(input));
    const browser = await launch({
      executablePath,
      headless: true,
      ...(tracesDir ? { tracesDir } : {}),
    });
    return {
      async newContext(opts) {
        const context = await browser.newContext(
          opts as Parameters<typeof browser.newContext>[0],
        );
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
          storageState: () => context.storageState(),
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

const NATIVE_NOTES_INQUIRY_PATH = '/api/booking/HRCEN/notesInquiry';
// Keep native transport bound equal to notes-inquiry-read-facade source bound.
const NATIVE_NOTES_INQUIRY_MAX_BYTES = 32 * 1024;
const NATIVE_NOTES_INQUIRY_TIMEOUT_MS = 8_000;
const NATIVE_TRACES_FORM_PATH = '/web/base/OSRESV.TRC';
const NATIVE_FOLIO_FORM_PATHS = [
  '/web/base/OSRESV.FOL',
  '/web/base/OSRESV.FOL.xmlhttp',
  '/web/base/GETCACHE',
] as const;
const NATIVE_BOUNDED_FORM_PATHS = [
  NATIVE_TRACES_FORM_PATH,
  ...NATIVE_FOLIO_FORM_PATHS,
] as const;
const NATIVE_BOUNDED_RESPONSE_MAX_BYTES = 32 * 1024;
const NATIVE_FOLIO_BOUNDED_RESPONSE_MAX_BYTES = 256 * 1024;
const NATIVE_BOUNDED_RESPONSE_TIMEOUT_MS = 5_000;

function legacyFolioDiagnosticPath(url: string): string | null {
  try {
    const path = new URL(url).pathname;
    return NATIVE_FOLIO_FORM_PATHS.includes(
      path as (typeof NATIVE_FOLIO_FORM_PATHS)[number],
    )
      ? path
      : null;
  } catch {
    return null;
  }
}

function assertNativeNotesInquiryUrl(url: string, pageUrl: string): void {
  try {
    const target = new URL(url);
    const current = new URL(pageUrl);
    if (
      target.origin !== current.origin ||
      target.pathname !== NATIVE_NOTES_INQUIRY_PATH ||
      target.search !== '' ||
      target.hash !== '' ||
      target.username !== '' ||
      target.password !== '' ||
      /[?#]/.test(url)
    ) {
      throw new Error('rejected');
    }
  } catch {
    throw new HmsRuntimeError('SOURCE_UNAVAILABLE', 'approved notes JSON endpoint rejected');
  }
}

function assertNativeBoundedFormUrl(url: string, pageUrl: string): string {
  try {
    const target = new URL(url);
    const current = new URL(pageUrl);
    if (
      target.origin !== current.origin ||
      !NATIVE_BOUNDED_FORM_PATHS.includes(target.pathname as (typeof NATIVE_BOUNDED_FORM_PATHS)[number]) ||
      target.search !== '' ||
      target.hash !== '' ||
      target.username !== '' ||
      target.password !== '' ||
      /[?#]/.test(url)
    ) {
      throw new Error('rejected');
    }
    return target.pathname;
  } catch {
    throw new HmsRuntimeError('SOURCE_UNAVAILABLE', 'approved bounded form endpoint rejected');
  }
}

function assertNativeResponseBounds(
  bounds: HmsPostFormResponseBounds,
  path: string,
): void {
  const maxBytes = NATIVE_FOLIO_FORM_PATHS.includes(
    path as (typeof NATIVE_FOLIO_FORM_PATHS)[number],
  )
    ? NATIVE_FOLIO_BOUNDED_RESPONSE_MAX_BYTES
    : NATIVE_BOUNDED_RESPONSE_MAX_BYTES;
  if (
    !Number.isSafeInteger(bounds.maxBytes) ||
    bounds.maxBytes < 1 ||
    bounds.maxBytes > maxBytes ||
    !Number.isSafeInteger(bounds.timeoutMs) ||
    bounds.timeoutMs < 1 ||
    bounds.timeoutMs > NATIVE_BOUNDED_RESPONSE_TIMEOUT_MS
  ) {
    throw new HmsRuntimeError('SOURCE_UNAVAILABLE', 'bounded form response limits rejected');
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
    opts: { name: string; exact?: boolean },
  ): {
    click(): Promise<void>;
    count?(): Promise<number>;
    isVisible?(): Promise<boolean>;
  };
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
  request?: {
    post(
      url: string,
      options?: {
        headers?: Record<string, string>;
        data?: string;
        timeout?: number;
        maxRedirects?: number;
      },
    ): Promise<{ text(): Promise<string>; status(): number }>;
  };
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
      const startedAt = Date.now();
      let selectorBranch: LoginTimingBranch = 'userid';
      try {
        const userid = page.locator('input[name="userid"]');
        const userLegacy = page.locator('input[name="username"]');
        try {
          await userid.fill(username);
        } catch {
          selectorBranch = 'label';
          try {
            await page.getByLabel('Username').fill(username);
          } catch {
            selectorBranch = 'username';
            await userLegacy.fill(username);
          }
        }
        try {
          await page.locator('input[name="password"]').fill(password);
        } catch {
          await page.getByLabel('Password').fill(password);
        }
      } finally {
        emitLoginTiming('login_fill', startedAt, selectorBranch);
      }
    },
    async submitLogin() {
      const startedAt = Date.now();
      // The faster selector experiment did not establish reliable live detail
      // reads. Retain the baseline flow while the HDR failure is investigated.
      let selectorBranch: LoginTimingBranch = 'button';
      try {
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
          selectorBranch = 'enter';
          await Promise.all([
            waitCommon(),
            page.locator('input[name="password"]').press('Enter'),
          ]);
        }
        await page.waitForLoadState('domcontentloaded').catch(() => undefined);
        await new Promise((r) => setTimeout(r, 500));
      } finally {
        emitLoginTiming('login_submit', startedAt, selectorBranch);
      }
    },
    async postForm(url, fields, responseBounds) {
      const legacyPath = legacyFolioDiagnosticPath(url);
      const legacyStartedAt = Date.now();
      const postData = new URLSearchParams(fields).toString();
      if (responseBounds) {
        const boundedPath = assertNativeBoundedFormUrl(url, page.url());
        assertNativeResponseBounds(responseBounds, boundedPath);
        const result = await page.evaluate(
          async ({ url, postData, expectedPaths, maxBytes, timeoutMs }) => {
            type FormResult = {
              text: string | null;
              status: number;
              responseType: string;
              redirected: boolean;
              bodyBytes: number | null;
              errorCode?:
                | 'response_status_rejected'
                | 'response_type_rejected'
                | 'response_body_missing'
                | 'response_body_invalid'
                | 'response_too_large'
                | 'timeout'
                | 'fetch_failed';
            };
            const rejected = (
              errorCode: FormResult['errorCode'] = 'fetch_failed',
              bodyBytes: number | null = null,
            ): FormResult => ({
              text: null,
              status: 0,
              responseType: 'rejected',
              redirected: false,
              bodyBytes,
              errorCode,
            });
            let timedOut = false;
            let observedBytes = 0;
            const controller = new AbortController();
            const deadline = setTimeout(() => {
              timedOut = true;
              controller.abort();
            }, timeoutMs);
            try {
              const pageLocation = (
                globalThis as unknown as {
                  location?: { origin?: unknown; href?: unknown };
                }
              ).location;
              if (
                !pageLocation ||
                typeof pageLocation.origin !== 'string' ||
                typeof pageLocation.href !== 'string'
              ) {
                return rejected('fetch_failed');
              }
              const target = new URL(url, pageLocation.href);
              if (
                target.origin !== pageLocation.origin ||
                !(expectedPaths as readonly string[]).includes(target.pathname) ||
                target.search !== '' ||
                target.hash !== ''
              ) {
                return rejected('fetch_failed');
              }
              const res = await fetch(target.href, {
                method: 'POST',
                headers: { 'content-type': 'application/x-www-form-urlencoded' },
                body: postData,
                credentials: 'same-origin',
                redirect: 'manual',
                signal: controller.signal,
              });
              if (!res || typeof res !== 'object') {
                return rejected('response_type_rejected');
              }
              const responseType = String(res.type);
              const status = res.status;
              const redirected = res.redirected === true;
              if (
                !['basic', 'cors', 'default'].includes(responseType) ||
                typeof status !== 'number' ||
                status < 200 ||
                status >= 300 ||
                redirected ||
                responseType === 'opaque' ||
                responseType === 'opaqueredirect'
              ) {
                return {
                  text: null,
                  status: typeof status === 'number' ? status : 0,
                  responseType,
                  redirected,
                  bodyBytes: null,
                  errorCode:
                    !['basic', 'cors', 'default'].includes(responseType) ||
                    responseType === 'opaque' ||
                    responseType === 'opaqueredirect'
                      ? 'response_type_rejected'
                      : 'response_status_rejected',
                } satisfies FormResult;
              }
              if (!res.body || typeof res.body.getReader !== 'function') {
                return {
                  text: null,
                  status,
                  responseType,
                  redirected,
                  bodyBytes: null,
                  errorCode: 'response_body_missing',
                } satisfies FormResult;
              }
              const reader = res.body.getReader();
              if (
                !reader ||
                typeof reader.read !== 'function' ||
                typeof reader.releaseLock !== 'function'
              ) {
                return {
                  text: null,
                  status,
                  responseType,
                  redirected,
                  bodyBytes: null,
                  errorCode: 'response_body_invalid',
                } satisfies FormResult;
              }
              const decoder = new TextDecoder();
              const cancelReader = () => {
                if (typeof reader.cancel !== 'function') return;
                try {
                  void reader.cancel().catch(() => undefined);
                } catch {
                  // Cancellation is best-effort; never hold the read result on cleanup.
                }
              };
              const cancelOnAbort = () => {
                cancelReader();
              };
              controller.signal.addEventListener('abort', cancelOnAbort, { once: true });
              try {
                let text = '';
                while (true) {
                  const chunk = await reader.read();
                  if (!chunk || typeof chunk !== 'object') {
                    return {
                      text: null,
                      status,
                      responseType,
                      redirected,
                      bodyBytes: observedBytes,
                      errorCode: 'response_body_invalid',
                    } satisfies FormResult;
                  }
                  if (chunk.done) break;
                  if (!(chunk.value instanceof Uint8Array)) {
                    return {
                      text: null,
                      status,
                      responseType,
                      redirected,
                      bodyBytes: observedBytes,
                      errorCode: 'response_body_invalid',
                    } satisfies FormResult;
                  }
                  observedBytes += chunk.value.byteLength;
                  if (observedBytes > maxBytes) {
                    cancelReader();
                    return {
                      text: null,
                      status,
                      responseType,
                      redirected,
                      bodyBytes: observedBytes,
                      errorCode: 'response_too_large',
                    } satisfies FormResult;
                  }
                  text += decoder.decode(chunk.value, { stream: true });
                }
                text += decoder.decode();
                return {
                  text,
                  status,
                  responseType,
                  redirected,
                  bodyBytes: observedBytes,
                } satisfies FormResult;
              } finally {
                controller.signal.removeEventListener('abort', cancelOnAbort);
                reader.releaseLock();
              }
            } catch {
              return rejected(timedOut ? 'timeout' : 'fetch_failed', observedBytes);
            } finally {
              clearTimeout(deadline);
            }
          },
          {
            url,
            postData,
            expectedPaths: NATIVE_BOUNDED_FORM_PATHS,
            maxBytes: responseBounds.maxBytes,
            timeoutMs: responseBounds.timeoutMs,
          },
        );
        if (result?.errorCode === 'timeout') {
          throw new HmsRuntimeError('TIMEOUT', 'bounded form response timed out');
        }
        if (result?.errorCode === 'response_too_large') {
          throw new HmsRuntimeError('SIZE_LIMIT', 'bounded form response exceeded its byte limit');
        }
        if (
          !result ||
          typeof result !== 'object' ||
          result.text === null ||
          typeof result.text !== 'string' ||
          typeof result.status !== 'number' ||
          result.status < 200 ||
          result.status >= 300 ||
          !['basic', 'cors', 'default'].includes(result.responseType) ||
          result.responseType === 'opaque' ||
          result.responseType === 'opaqueredirect' ||
          result.redirected
        ) {
          throw new HmsRuntimeError('SOURCE_UNAVAILABLE', 'bounded form response status/type rejected');
        }
        return result.text;
      }
      // Prefer in-page fetch after Guest Stay is open: ExtJS same-origin session
      // + cookies. page.request.post previously returned logindisp HTML bounce
      // even when COMMON was authenticated; keep it as fallback only.
      try {
        const result = await page.evaluate(
          async ({ url, postData }) => {
            const res = await fetch(url, {
              method: 'POST',
              headers: { 'content-type': 'application/x-www-form-urlencoded' },
              body: postData,
              credentials: 'same-origin',
              redirect: 'manual',
            });
            return {
              text: await res.text(),
              status: res.status,
              responseUrl: res.url,
              redirected: res.redirected,
              responseType: res.type,
            };
          },
          { url, postData },
        );
        if (process.env.HMS_PROOF_DIAGNOSTICS === '1' && /OSRESV\.HDR/i.test(url)) {
          process.stderr.write(
            `${JSON.stringify({
              type: 'HMS_PROOF_DIAGNOSTIC',
              stage: 'post_form_response',
              path: new URL(url).pathname,
              status: result.status,
              responseUrlPath: (() => {
                try {
                  return new URL(result.responseUrl).pathname;
                } catch {
                  return '';
                }
              })(),
              redirected: result.redirected,
              responseType: result.responseType,
              bodyBytes: result.text.length,
            })}\n`,
          );
        }
        if (process.env.HMS_PROOF_DIAGNOSTICS === '1' && legacyPath) {
          process.stderr.write(
            `${JSON.stringify({
              type: 'HMS_PROOF_DIAGNOSTIC',
              stage: 'legacy_read_post_form',
              path: legacyPath,
              status: result.status,
              responseType: result.responseType,
              bodyBytes: result.text.length,
              durationMs: Math.max(0, Date.now() - legacyStartedAt),
            })}\n`,
          );
        }
        return result.text;
      } catch (err) {
        if (typeof page.request?.post !== 'function') throw err;
      }
      if (typeof page.request?.post === 'function') {
        const response = await page.request.post(url, {
          headers: { 'content-type': 'application/x-www-form-urlencoded' },
          data: postData,
          timeout: 30_000,
          maxRedirects: 0,
        });
        return response.text();
      }
      throw new Error('postForm unavailable');
    },
    async postJson(url, body) {
      assertNativeNotesInquiryUrl(url, page.url());
      const postData = JSON.stringify(body);
      const result = await page.evaluate(
        async ({ url, postData, expectedPath, maxBytes, timeoutMs }) => {
          type JsonResult = {
            text: string | null;
            status: number;
            responseType: string;
            redirected: boolean;
            bodyBytes: number | null;
            errorCode?:
              | 'response_status_rejected'
              | 'response_type_rejected'
              | 'response_body_missing'
              | 'response_body_invalid'
              | 'response_too_large'
              | 'timeout'
              | 'fetch_failed';
          };
          const rejected = (
            errorCode: JsonResult['errorCode'] = 'fetch_failed',
            bodyBytes: number | null = null,
          ): JsonResult => ({
            text: null,
            status: 0,
            responseType: 'rejected',
            redirected: false,
            bodyBytes,
            errorCode,
          });
          let timedOut = false;
          let observedBytes = 0;
          const controller = new AbortController();
          const deadline = setTimeout(() => {
            timedOut = true;
            controller.abort();
          }, timeoutMs);
          try {
            const pageLocation = (
              globalThis as unknown as {
                location?: { origin?: unknown; href?: unknown };
              }
            ).location;
            if (
              !pageLocation ||
              typeof pageLocation.origin !== 'string' ||
              typeof pageLocation.href !== 'string'
            ) {
              return rejected('fetch_failed');
            }
            const target = new URL(url, pageLocation.href);
            if (
              target.origin !== pageLocation.origin ||
              target.pathname !== expectedPath ||
              target.search !== '' ||
              target.hash !== ''
            ) {
              return rejected('fetch_failed');
            }
            const globals = globalThis as unknown as {
              EAM?: {
                AppData?: {
                  getRawAppData?: () => unknown;
                };
              };
              CryptoJS?: {
                SHA256?: (value: string) => unknown;
                enc?: {
                  Base64?: {
                    stringify?: (value: unknown) => unknown;
                  };
                };
              };
            };
            const appDataApi = globals.EAM?.AppData;
            const cryptoJs = globals.CryptoJS;
            const base64 = cryptoJs?.enc?.Base64;
            if (
              typeof appDataApi?.getRawAppData !== 'function' ||
              typeof cryptoJs?.SHA256 !== 'function' ||
              typeof base64?.stringify !== 'function'
            ) {
              return rejected('fetch_failed');
            }
            const appData = appDataApi.getRawAppData();
            if (!appData || typeof appData !== 'object') return rejected('fetch_failed');
            const cookieName = (appData as { HMSLoginSessionCookieName?: unknown })
              .HMSLoginSessionCookieName;
            if (typeof cookieName !== 'string' || cookieName.length === 0) {
              return rejected('fetch_failed');
            }
            const authorization = base64.stringify(cryptoJs.SHA256(cookieName));
            if (typeof authorization !== 'string' || authorization.length === 0) {
              return rejected('fetch_failed');
            }
            const res = await fetch(target.href, {
              method: 'POST',
              headers: {
                'content-type': 'application/json',
                authorization: `Bearer ${authorization}`,
              },
              body: postData,
              credentials: 'same-origin',
              redirect: 'manual',
              signal: controller.signal,
            });
            const responseType = String(res.type);
            const status = res.status;
            const redirected = res.redirected === true;
            if (
              !['basic', 'cors', 'default'].includes(responseType) ||
              status < 200 ||
              status >= 300 ||
              responseType === 'opaque' ||
              responseType === 'opaqueredirect' ||
              redirected
            ) {
              return {
                text: null,
                status,
                responseType,
                redirected,
                bodyBytes: null,
                errorCode:
                  !['basic', 'cors', 'default'].includes(responseType) ||
                  responseType === 'opaque' ||
                  responseType === 'opaqueredirect'
                    ? 'response_type_rejected'
                    : 'response_status_rejected',
              };
            }
            if (!res.body || typeof res.body.getReader !== 'function') {
              return {
                text: null,
                status,
                responseType,
                redirected,
                bodyBytes: null,
                errorCode: 'response_body_missing',
              };
            }
            const reader = res.body.getReader();
            const decoder = new TextDecoder();
            const cancelReader = () => {
              if (typeof reader.cancel !== 'function') return;
              try {
                void reader.cancel().catch(() => undefined);
              } catch {
                // Cancellation is best-effort; never hold the read result on cleanup.
              }
            };
            const cancelOnAbort = () => {
              cancelReader();
            };
            controller.signal.addEventListener('abort', cancelOnAbort, { once: true });
            try {
              let text = '';
              while (true) {
                const chunk = await reader.read();
                if (!chunk || typeof chunk !== 'object') {
                  return {
                    text: null,
                    status,
                    responseType,
                    redirected,
                    bodyBytes: observedBytes,
                    errorCode: 'response_body_invalid',
                  };
                }
                if (chunk.done) break;
                if (!(chunk.value instanceof Uint8Array)) {
                  return {
                    text: null,
                    status,
                    responseType,
                    redirected,
                    bodyBytes: observedBytes,
                    errorCode: 'response_body_invalid',
                  };
                }
                observedBytes += chunk.value.byteLength;
                if (observedBytes > maxBytes) {
                  cancelReader();
                  return {
                    text: null,
                    status,
                    responseType,
                    redirected,
                    bodyBytes: observedBytes,
                    errorCode: 'response_too_large',
                  };
                }
                text += decoder.decode(chunk.value, { stream: true });
              }
              text += decoder.decode();
              return {
                text,
                status,
                responseType,
                redirected,
                bodyBytes: observedBytes,
              };
            } finally {
              controller.signal.removeEventListener('abort', cancelOnAbort);
              reader.releaseLock();
            }
          } catch {
            // Never return provider/auth errors or any browser credential data.
            return rejected(timedOut ? 'timeout' : 'fetch_failed', observedBytes);
          } finally {
            clearTimeout(deadline);
          }
        },
        {
          url,
          postData,
          expectedPath: NATIVE_NOTES_INQUIRY_PATH,
          maxBytes: NATIVE_NOTES_INQUIRY_MAX_BYTES,
          timeoutMs: NATIVE_NOTES_INQUIRY_TIMEOUT_MS,
        },
      );
      if (process.env.HMS_PROOF_DIAGNOSTICS === '1') {
        process.stderr.write(`${JSON.stringify({
          type: 'HMS_PROOF_DIAGNOSTIC',
          stage: 'post_json_response',
          status: result.status,
          responseType: result.responseType,
          bodyBytes: result.bodyBytes,
          errorCode: result.errorCode ?? null,
        })}\n`);
      }
      if (result.errorCode === 'timeout') {
        throw new HmsRuntimeError('TIMEOUT', 'JSON response timed out');
      }
      if (result.errorCode === 'response_too_large') {
        throw new HmsRuntimeError('SIZE_LIMIT', 'JSON response exceeded its byte limit');
      }
      if (
        result.text === null ||
        result.status < 200 ||
        result.status >= 300 ||
        result.responseType === 'opaque' ||
        result.responseType === 'opaqueredirect' ||
        result.redirected
      ) {
        throw new HmsRuntimeError('SOURCE_UNAVAILABLE', 'JSON response status/type rejected');
      }
      return result.text;
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
    async dblclick(selector) {
      // Prefer Playwright locator.dblclick (ExtJS grid). Soft-capture typings omit dblclick.
      const loc = page.locator(selector);
      const count = await loc.count().catch(() => 0);
      for (let i = 0; i < count; i += 1) {
        const el = loc.nth(i) as unknown as {
          isVisible(): Promise<boolean>;
          scrollIntoViewIfNeeded(): Promise<void>;
          dblclick: (opts?: { force?: boolean; timeout?: number }) => Promise<void>;
        };
        const visible = await el.isVisible().catch(() => false);
        if (!visible) continue;
        await el.scrollIntoViewIfNeeded().catch(() => undefined);
        await el.dblclick({ force: true, timeout: 8_000 });
        return;
      }
      const first = loc.first() as unknown as {
        dblclick: (opts?: { force?: boolean; timeout?: number }) => Promise<void>;
      };
      await first.dblclick({ force: true, timeout: 8_000 });
    },
    async dblclickRowContaining(token) {
      const needle = String(token || '').trim();
      if (!needle || needle.length > 64) {
        throw new Error('dblclickRowContaining token invalid');
      }
      const rows = page.locator('.x-grid3-row, .x-grid-row, tr.x-grid3-row') as unknown as {
        filter: (opts: { hasText: string | RegExp }) => {
          first: () => {
            scrollIntoViewIfNeeded(): Promise<void>;
            dblclick: (opts?: { force?: boolean; timeout?: number }) => Promise<void>;
            isVisible(): Promise<boolean>;
          };
          count(): Promise<number>;
        };
      };
      const matched = rows.filter({ hasText: needle });
      if ((await matched.count().catch(() => 0)) < 1) {
        throw new Error('no grid row containing match token');
      }
      const first = matched.first();
      await first.scrollIntoViewIfNeeded().catch(() => undefined);
      await first.dblclick({ force: true, timeout: 8_000 });
    },
    async fill(selector, value) {
      await page.locator(selector).fill(value);
    },
    async press(selector, key) {
      await page.locator(selector).press(key);
    },
    async waitForCorrelatedResponse(pathSubstring) {
      const res = await page.waitForResponse(
        (response: { url(): string }) => {
          const withRequest = response as unknown as {
            request?: () => { method(): string };
          };
          const method =
            typeof withRequest.request === 'function'
              ? withRequest.request().method()
              : 'POST';
          return response.url().includes(pathSubstring) && method === 'POST';
        },
        { timeout: 15_000 },
      );
      return (res as { text(): Promise<string> }).text();
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

/** Private EC2-only discovery owner. No model/API key here; no PMS writes. */
import {
  buildBoundFolioRefreshRule,
  buildBoundFolioAllGridRule,
  buildBoundFolioAllDataRule,
  buildFolioCacheReadRule,
  buildPropertyLedgerEntryReadRules,
  buildPropertyLedgerDetailReadRule,
} from '../src/hms/folio-manifest.js';
import {
  stagehandDiscoveryCommandSchema,
  discoveryTabLabel,
  createStagehandControlToken,
  stagehandBearerTokenMatches,
  confirmStagehandParentFromSearch,
  bindStagehandFolioRule,
  stagehandParentRowMatchesExactIdentity,
} from '../src/hms/stagehand-discovery.js';
import {
  buildExactOsressSearchThenDetailManifest,
  buildLiveFolioFunctionalRules,
  buildLiveOsnotsReadRule,
  osressSearchFillValue,
  type ReservationSearchCandidate,
} from '../src/hms/live-read-manifest.js';
import {
  extractOsressDetailOpenHints,
  parseAndCorrelateGuestStayHtml,
} from '../src/hms/live-guest-stay-driver.js';
import {
  createReservationDetailFacade,
  extractBoundOsresvLstRow,
} from '../src/hms/reservation-detail-facade.js';
import {
  buildNotesInquiryReadRule,
  buildBoundNotesTracesReadRule,
} from '../src/hms/notes-traces-manifest.js';
import {
  extractLookupCandidates,
  selectConnectedLookupCandidate,
} from '../src/ai/thread-context.js';
import { createHmsRuntime, hmsSecretSchema, type HmsReadSession } from '../src/hms/runtime.js';
import { GetSecretValueCommand, SecretsManagerClient } from '@aws-sdk/client-secrets-manager';
import { createFindReservationFacade } from '../src/hms/find-reservation-facade.js';
import { createStagehandBrowserFactory } from '../src/hms/stagehand-browser.js';
import { redactStagehandCapture } from '../src/hms/stagehand-capture-redaction.js';
import {
  persistStagehandCapture,
  projectStagehandResponseRecord,
  type StagehandCapturePersistenceResult,
} from '../src/hms/stagehand-capture-persistence.js';
import type { NarrowRequestProjection } from '../src/hms/request-signature-projection.js';
import { chmod, mkdir, readFile, writeFile } from 'node:fs/promises';
import type { BrowserContext, Page } from 'playwright';
import { randomUUID, createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { join, resolve } from 'node:path';
import { createServer } from 'node:http';

type NativeScreencast = {
  start(options: { path: string; size: { width: number; height: number } }): Promise<void>;
  stop(): Promise<void>;
};

type NativeScreencastPage = Page & {
  screencast?: NativeScreencast;
};

type BoundAccountRead = Readonly<{
  account: string;
  propertycode: string;
  acctname: string;
  reference: string;
}>;

type BoundScheduleRead = Readonly<{
  confirmationnumber: string;
  reservationstayid: string;
  propertycode: string;
}>;

const MAX_CAPTURED_RESPONSE_BYTES = 2 * 1024 * 1024;
const RESPONSE_READ_TIMEOUT_MS = 15_000;
const CAPTURE_REDACTION_REQUIRED = 'CAPTURE_REDACTION_REQUIRED';
const SIGNATURE_ONLY_CAPTURE = process.env.HMS_STAGEHAND_SIGNATURE_ONLY === '1';
const STRUCTURED_ONLY_CAPTURE = process.env.HMS_STAGEHAND_STRUCTURED_ONLY === '1';
const SAFE_DIAGNOSTICS_ONLY = SIGNATURE_ONLY_CAPTURE || STRUCTURED_ONLY_CAPTURE;
const VISUAL_CAPTURE_ENABLED = !SAFE_DIAGNOSTICS_ONLY;
const SAFE_RUNTIME_PROJECTION_PATH_PREFIXES = [
  '/web/base/',
  '/api/booking/',
  '/api/hotelOperation/',
] as const;

async function loadBoundAccountRead(path: string | undefined): Promise<BoundAccountRead> {
  if (!path || !path.startsWith('/opt/nava/stagehand-trial-20260917/'))
    throw new Error('ACCOUNT_BINDING_REQUIRED');
  let parsed: unknown;
  try {
    parsed = JSON.parse(await readFile(path, 'utf8'));
  } catch {
    throw new Error('ACCOUNT_BINDING_INVALID');
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed))
    throw new Error('ACCOUNT_BINDING_INVALID');
  const value = parsed as Record<string, unknown>;
  const account = value.account;
  const propertycode = value.propertycode;
  const acctname = value.acctname;
  const reference = value.reference;
  if (
    typeof account !== 'string' ||
    !/^\d{1,32}$/.test(account) ||
    typeof propertycode !== 'string' ||
    !/^[A-Z0-9]{1,16}$/.test(propertycode) ||
    typeof acctname !== 'string' ||
    acctname.length === 0 ||
    acctname.length > 128 ||
    typeof reference !== 'string' ||
    !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$/.test(reference)
  )
    throw new Error('ACCOUNT_BINDING_INVALID');
  return { account, propertycode, acctname, reference };
}

async function loadBoundScheduleRead(path: string | undefined): Promise<BoundScheduleRead> {
  if (!path || !path.startsWith('/opt/nava/stagehand-trial-20260917/'))
    throw new Error('SCHEDULE_BINDING_REQUIRED');
  let parsed: unknown;
  try {
    parsed = JSON.parse(await readFile(path, 'utf8'));
  } catch {
    throw new Error('SCHEDULE_BINDING_INVALID');
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed))
    throw new Error('SCHEDULE_BINDING_INVALID');
  const value = parsed as Record<string, unknown>;
  const confirmationnumber = value.confirmationnumber;
  const reservationstayid = value.reservationstayid;
  const propertycode = value.propertycode;
  if (
    typeof confirmationnumber !== 'string' ||
    !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$/.test(confirmationnumber) ||
    typeof reservationstayid !== 'string' ||
    !/^\d{1,32}$/.test(reservationstayid) ||
    typeof propertycode !== 'string' ||
    !/^[A-Z0-9]{1,16}$/.test(propertycode)
  )
    throw new Error('SCHEDULE_BINDING_INVALID');
  return { confirmationnumber, reservationstayid, propertycode };
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number, code: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await new Promise<T>((resolve, reject) => {
      timer = setTimeout(() => reject(new Error(code)), timeoutMs);
      promise.then(resolve, reject);
    });
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function readResponseBodyBounded(response: {
  headers(): Record<string, string>;
  text(): Promise<string>;
}): Promise<string> {
  const contentLength = Number(response.headers()['content-length'] ?? '');
  if (Number.isFinite(contentLength) && contentLength > MAX_CAPTURED_RESPONSE_BYTES)
    throw new Error('RESPONSE_BODY_TOO_LARGE');
  const body = await withTimeout(
    response.text(),
    RESPONSE_READ_TIMEOUT_MS,
    'RESPONSE_BODY_READ_TIMEOUT',
  );
  if (Buffer.byteLength(body, 'utf8') > MAX_CAPTURED_RESPONSE_BYTES)
    throw new Error('RESPONSE_BODY_TOO_LARGE');
  return body;
}

function exactMenuLabelPattern(label: string): RegExp {
  return new RegExp(`^\\s*${label.replace(/[.*+?^${}()|[\\]\\]/g, '\\$&')}\\s*$`);
}

async function clickReviewedMenuItem(page: Page, label: string): Promise<void> {
  const menu = page.locator('.application-menu:visible');
  if ((await menu.count()) !== 1) throw Error('MENU_NOT_OPEN');
  const search = menu.locator(
    "input[name='appmenusearch'], input[placeholder*='Search this menu' i]",
  );
  if ((await search.count()) !== 1) throw Error('MENU_SEARCH_NOT_UNIQUE');
  await search.fill(label);
  await page.waitForTimeout(400);
  const item = menu
    .locator('.x-grid-row:visible')
    .filter({ hasText: exactMenuLabelPattern(label) });
  if ((await item.count()) !== 1) throw Error('MENU_ITEM_SEARCH_NOT_UNIQUE');
  await item.click({ timeout: 8000 });
}

async function main() {
  if (process.env.HMS_DISCOVERY_ALLOW_LIVE !== '1') throw Error('LIVE_DISABLED');
  const out = resolve(
    process.env.HMS_STAGEHAND_OUT ?? '/opt/nava/stagehand-trial-20260917/discovery-1',
  );
  if (!out.startsWith('/opt/nava/stagehand-trial-20260917/'))
    throw Error('EC2_PRIVATE_OUTPUT_REQUIRED');
  const boundAccount = await loadBoundAccountRead(
    process.env.HMS_STAGEHAND_ACCOUNT_BINDING_PATH,
  );
  const boundSchedule = await loadBoundScheduleRead(
    process.env.HMS_STAGEHAND_SCHEDULE_BINDING_PATH,
  );
  const boundScheduleInquiryPath =
    `/api/hotelOperation/${boundSchedule.propertycode}/depositScheduleInquiry`;
  process.umask(0o077);
  const arn = process.env.HMS_READ_SECRET_ARN;
  const casePath = process.env.HMS_CONNECTED_CASE_PATH;
  const sdk = process.env.HMS_STAGEHAND_SDK_ROOT;
  const extensionId = process.env.HMS_STAGEHAND_EXTENSION_ID;
  if (!arn || !casePath || !sdk || !/^[a-p]{32}$/.test(extensionId ?? ''))
    throw Error('CONFIG_REQUIRED');
  const packet = JSON.parse(await readFile(casePath, 'utf8'));
  if (
    packet.schemaVersion !== 'connected-read-case/v1' ||
    packet.propertyCode !== 'HRCEN' ||
    typeof packet.incoming?.body !== 'string'
  )
    throw Error('CONNECTED_INPUT_REQUIRED');
  const selected = selectConnectedLookupCandidate(extractLookupCandidates(packet.incoming.body));
  if (!selected) throw Error('UNIQUE_CONNECTED_CANDIDATE_REQUIRED');
  const candidate: ReservationSearchCandidate =
    selected.kind === 'surname_dates'
      ? {
          id: selected.id,
          kind: selected.kind,
          surname: selected.surname,
          arrivalDate: selected.arrivalDate,
          departureDate: selected.departureDate,
        }
      : { id: selected.id, kind: selected.kind, value: selected.value };
  const secretRaw = await new SecretsManagerClient({
    region: process.env.AWS_REGION ?? 'af-south-1',
  }).send(new GetSecretValueCommand({ SecretId: arn }));
  const secret = hmsSecretSchema.parse(JSON.parse(secretRaw.SecretString ?? 'null'));
  const origin = new URL(secret.loginUrl).origin;
  const requireSdk = createRequire(join(sdk, 'hms-trial.cjs'));
  const { chromium } = requireSdk('playwright') as typeof import('playwright');
  const videoDir = join(out, 'video');
  await mkdir(out, { recursive: true, mode: 0o700 });
  await chmod(out, 0o700);
  await mkdir(videoDir, { recursive: true, mode: 0o700 });
  await chmod(videoDir, 0o700);
  const privateJson = async (
    name: string,
    data: unknown,
  ): Promise<StagehandCapturePersistenceResult | undefined> => {
    const path = join(out, name);
    // owner.json is private runtime control state: its bearer is required for
    // the loopback controller and is never evidence sent to a model. Every
    // other persisted JSON artifact goes through the shared fail-closed helper.
    if (name === 'owner.json') {
      await writeFile(path, JSON.stringify(data, null, 2), { mode: 0o600 });
      await chmod(path, 0o600);
      return;
    }
    return persistStagehandCapture(
      path,
      data,
      name === 'network.json' ? 'response-body' : 'message',
    );
  };
  const captureStatus = (
    result: StagehandCapturePersistenceResult | undefined,
  ): Pick<StagehandCapturePersistenceResult, 'ok' | 'partial' | 'rejectedCount'> & {
    reason?: string;
  } | undefined =>
    result
      ? {
          ok: result.ok,
          partial: result.partial,
          rejectedCount: result.rejectedCount,
          ...(result.reason ? { reason: result.reason } : {}),
        }
      : undefined;
  const privateScreenshot = async (name: string, page: Page) => {
    const path = join(out, name);
    await page.screenshot({ path });
    await chmod(path, 0o600);
  };
  const emptyParentHints = (): ReturnType<typeof extractOsressDetailOpenHints> => ({
    confirmationNumber: null,
    externalReference: null,
    reservationStayId: null,
  });
  let nativeContext: BrowserContext | undefined;
  let nativePage: Page | undefined;
  let session: HmsReadSession | undefined;
  const captures: unknown[] = [];
  const runSignatureOnlyNavigation = async <T>(operation: () => Promise<T>): Promise<T> => {
    return operation();
  };
  const pending = new Set<Promise<void>>();
  const drainPending = async (): Promise<void> => {
    while (pending.size > 0) await Promise.allSettled([...pending]);
  };
  let captureEnabled = false;
  const appendRuntimeRequestProjection = (projection: NarrowRequestProjection): void => {
    // Runtime guard projections are already value-safe and may be the only
    // evidence available when a fail-closed setup request aborts before the
    // owner reaches its ready/capture lifecycle flag.
    if ((!SIGNATURE_ONLY_CAPTURE && !STRUCTURED_ONLY_CAPTURE) || closing || captures.length >= 300)
      return;
    if (
      projection.origin !== origin ||
      !SAFE_RUNTIME_PROJECTION_PATH_PREFIXES.some((prefix) =>
        projection.path.startsWith(prefix),
      )
    )
      return;
    captures.push(projection);
  };
  const marker = `hms-stagehand-${randomUUID()}`;
  const controlToken = createStagehandControlToken();
  const parentRecord = {
    marker,
    candidate,
    hints: {
      confirmationNumber: null as string | null,
      externalReference: null as string | null,
      reservationStayId: null as string | null,
    },
    dump: null as unknown,
    incomingBodySha256: createHash('sha256').update(packet.incoming.body).digest('hex'),
    goldAnswerUsed: false,
    manualIdUsed: false,
  };
  let parentHints: ReturnType<typeof extractOsressDetailOpenHints> = parentRecord.hints;
  let parentRulesInstalled = false;
  let folioRuleInstalled = false;
  let closing = false;
  type ResponseWaiter = {
    resolve: () => void;
    reject: (error: unknown) => void;
    timer: ReturnType<typeof setTimeout>;
  };
  const responseWaiters = new Map<'search' | 'lst', ResponseWaiter>();
  const waitForResponse = (kind: 'search' | 'lst'): Promise<void> => {
    const previous = responseWaiters.get(kind);
    if (previous) {
      clearTimeout(previous.timer);
      previous.reject(new Error('RESPONSE_WAIT_REPLACED'));
    }
    return new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        responseWaiters.delete(kind);
        reject(new Error(kind === 'search' ? 'OSRESS_SEARCH_TIMEOUT' : 'OSRESV_LST_TIMEOUT'));
      }, RESPONSE_READ_TIMEOUT_MS);
      responseWaiters.set(kind, { resolve, reject, timer });
    });
  };
  const waitForSearchResponse = (): Promise<void> => waitForResponse('search');
  const waitForLstResponse = (): Promise<void> => waitForResponse('lst');
  const settleResponse = (kind: 'search' | 'lst', error?: unknown): void => {
    const waiter = responseWaiters.get(kind);
    if (!waiter) return;
    responseWaiters.delete(kind);
    clearTimeout(waiter.timer);
    if (error) waiter.reject(error);
    else waiter.resolve();
  };
  const settleCurrentResponse = (
    kind: 'search' | 'lst',
    expected: ResponseWaiter | undefined,
    error?: unknown,
  ): void => {
    if (responseWaiters.get(kind) !== expected) return;
    settleResponse(kind, error);
  };
  const cancelResponseWaiters = (error: unknown): void => {
    settleResponse('search', error);
    settleResponse('lst', error);
  };
  let screencastPage: NativeScreencastPage | undefined;
  let screencastPath: string | undefined;
  let screencastStarted = false;
  let stopScreencastBeforeContextClose: (() => Promise<void>) | undefined;
  const manifest = buildExactOsressSearchThenDetailManifest(origin, candidate);
  // Property Ledger is a documented display-only surface. Allow entry/list
  // only; detail requests are still abort-first until their exact body is seen.
  manifest.rules.push(...buildPropertyLedgerEntryReadRules(origin));
  // Discovery-only operator-selected day. No broad historical/date wildcard.
  if (process.env.HMS_STAGEHAND_LEDGER_DATE)
    manifest.rules.push(
      buildPropertyLedgerDetailReadRule(origin, 'HRCEN', process.env.HMS_STAGEHAND_LEDGER_DATE),
    );
  // Exact native Account entry read observed from the guarded UI projection.
  // This is intentionally one fixed form shape; Advance Deposit/Schedule
  // controls remain blocked until their own native read shapes are observed.
   manifest.rules.push({
     id: 'live-account-osacct-open',
    origin,
    method: 'POST',
    path: '/web/base/OSACCT',
    resourceTypes: ['xhr'],
    contentType: 'application/x-www-form-urlencoded',
    fixedQuery: {
      USER_FUNCTION_NAME: 'OSACCT',
      FUNCTION_CLASS: 'WEBL',
    },
    variableQuery: {},
    queryKeySequence: ['USER_FUNCTION_NAME', 'FUNCTION_CLASS'],
    fixedBody: {
      USER_FUNCTION_NAME: 'OSACCT',
      FUNCTION_CLASS: 'WEBL',
      SYSTEM_FUNCTION_NAME: 'OSACCT',
      CURRENT_TAB_NAME: '',
      MENU_MODULE_KEY: '0',
      removescreenflows: 'yes',
    },
    variableBody: {},
    bodyKeySequence: [
      'USER_FUNCTION_NAME',
      'FUNCTION_CLASS',
      'SYSTEM_FUNCTION_NAME',
      'CURRENT_TAB_NAME',
      'MENU_MODULE_KEY',
      'removescreenflows',
    ],
    maxBodyBytes: 4096,
     redirectPolicy: 'same-reviewed-chain',
   });
   // The finalized Account projection showed two immediate, read-only
   // follow-ups after the open response. Their body hashes independently
   // resolve all non-secret values: HDR uses four empty filters, while LST
   // requests HEAD_ONLY. Keep each native path and key order separate; this is
   // not an OSACCT wildcard or a generic screenflow allowance.
   manifest.rules.push({
     id: 'live-account-osacct-hdr-read',
     origin,
     method: 'POST',
     path: '/web/base/OSACCT.HDR',
     resourceTypes: ['xhr'],
     contentType: 'application/x-www-form-urlencoded',
     fixedQuery: {},
     variableQuery: {},
     fixedBody: {
       account: '',
       propertycode: '',
       acctname: '',
       reference: '',
       SYSTEM_FUNCTION_NAME: 'OSACCT',
       USER_FUNCTION_NAME: 'OSACCT',
       CURRENT_TAB_NAME: 'HDR',
       MENU_MODULE_KEY: '0',
       removescreenflows: 'yes',
     },
     variableBody: {},
     bodyKeySequence: [
       'account',
       'propertycode',
       'acctname',
       'reference',
       'SYSTEM_FUNCTION_NAME',
       'USER_FUNCTION_NAME',
       'CURRENT_TAB_NAME',
       'MENU_MODULE_KEY',
       'removescreenflows',
     ],
     maxBodyBytes: 4096,
     redirectPolicy: 'same-reviewed-chain',
   });
   manifest.rules.push({
     id: 'live-account-osacct-lst-read',
     origin,
     method: 'POST',
     path: '/web/base/OSACCT.LST',
     resourceTypes: ['xhr'],
     contentType: 'application/x-www-form-urlencoded',
     fixedQuery: {},
     variableQuery: {},
     fixedBody: {
       COMPONENT_INFO_TYPE: 'HEAD_ONLY',
       SYSTEM_FUNCTION_NAME: 'OSACCT',
       USER_FUNCTION_NAME: 'OSACCT',
       CURRENT_TAB_NAME: 'LST',
       MENU_MODULE_KEY: '0',
       removescreenflows: 'yes',
     },
     variableBody: {},
     bodyKeySequence: [
       'COMPONENT_INFO_TYPE',
       'SYSTEM_FUNCTION_NAME',
       'USER_FUNCTION_NAME',
       'CURRENT_TAB_NAME',
       'MENU_MODULE_KEY',
       'removescreenflows',
     ],
     maxBodyBytes: 4096,
     redirectPolicy: 'same-reviewed-chain',
   });
   // Selecting the documented All Guest Accounts dataspy is a read-only list
   // refresh. Its native identifiers and serialized order are hash-verified;
   // quick-filter values remain blocked until their own body is observed.
   manifest.rules.push({
     id: 'live-account-osacct-lst-all-guest-read',
     origin,
     method: 'POST',
     path: '/web/base/OSACCT.LST',
     resourceTypes: ['xhr'],
     contentType: 'application/x-www-form-urlencoded',
     fixedQuery: {},
     variableQuery: {},
     fixedBody: {
       GRID_ID: '749',
       GRID_NAME: 'OSACCT',
       DATASPY_ID: '867',
       USER_FUNCTION_NAME: 'OSACCT',
       SYSTEM_FUNCTION_NAME: 'OSACCT',
       CURRENT_TAB_NAME: 'LST',
       COMPONENT_INFO_TYPE: 'HEAD_ONLY',
     },
     variableBody: {},
     bodyKeySequence: [
       'GRID_ID',
       'GRID_NAME',
       'DATASPY_ID',
       'USER_FUNCTION_NAME',
       'SYSTEM_FUNCTION_NAME',
       'CURRENT_TAB_NAME',
       'COMPONENT_INFO_TYPE',
     ],
     maxBodyBytes: 4096,
     redirectPolicy: 'same-reviewed-chain',
   });
   // The All Guest dataspy response triggered this exact header refresh before
   // its filter controls rendered. Values/order are hash-verified from the
   // finalized native projection; do not generalize this to arbitrary HDR
   // filters or to a wildcard OSACCT path.
   manifest.rules.push({
     id: 'live-account-osacct-hdr-all-guest-read',
     origin,
     method: 'POST',
     path: '/web/base/OSACCT.HDR',
     resourceTypes: ['xhr'],
     contentType: 'application/x-www-form-urlencoded',
     fixedQuery: {},
     variableQuery: {},
     fixedBody: {
       SYSTEM_FUNCTION_NAME: 'OSACCT',
       USER_FUNCTION_NAME: 'OSACCT',
       CURRENT_TAB_NAME: 'HDR',
       account: '',
       propertycode: '',
       acctname: '',
       reference: '',
       ONLY_DATA_REQUIRED: 'true',
       SCROLLROW: 'YES',
     },
     variableBody: {},
     bodyKeySequence: [
       'SYSTEM_FUNCTION_NAME',
       'USER_FUNCTION_NAME',
       'CURRENT_TAB_NAME',
       'account',
       'propertycode',
       'acctname',
       'reference',
       'ONLY_DATA_REQUIRED',
       'SCROLLROW',
     ],
     maxBodyBytes: 4096,
     redirectPolicy: 'same-reviewed-chain',
   });
   // This is the exact read-only filter request captured after binding the
   // source-verified guest account. Keep the bound account fixed in this
   // trial artifact; a different account requires a new verified projection
   // and fresh artifact rather than a broad variable or wildcard rule.
   manifest.rules.push({
     id: 'live-account-osacct-filter-read',
     origin,
     method: 'POST',
     path: '/web/base/OSACCT.xmlhttp',
     resourceTypes: ['xhr'],
     contentType: 'application/x-www-form-urlencoded',
     fixedQuery: {},
     variableQuery: {},
     fixedBody: {
       GRID_ID: '749',
       GRID_NAME: 'OSACCT',
       DATASPY_ID: '867',
       USER_FUNCTION_NAME: 'OSACCT',
       SYSTEM_FUNCTION_NAME: 'OSACCT',
       CURRENT_TAB_NAME: 'LST',
       COMPONENT_INFO_TYPE: 'DATA_ONLY',
       filterfields: 'account',
       filteroperator: 'CONTAINS',
       filtervalue: boundAccount.account,
     },
     variableBody: {},
     bodyKeySequence: [
       'GRID_ID',
       'GRID_NAME',
       'DATASPY_ID',
       'USER_FUNCTION_NAME',
       'SYSTEM_FUNCTION_NAME',
       'CURRENT_TAB_NAME',
       'COMPONENT_INFO_TYPE',
       'filterfields',
       'filteroperator',
       'filtervalue',
     ],
     maxBodyBytes: 4096,
     redirectPolicy: 'same-reviewed-chain',
   });
   // Opening the one source-verified row emits this exact bound HDR read. The
   // four identity values and the display name are fixed to that row; its
   // 198-byte encodeURIComponent body was hash-verified as
   // 5eba43ac229e5c0372122c4719b0e06d3a3bcb34f7d5c1ab58f01a7a2575e3e7.
   // Keep this native read separate from the blank/all-guest HDR requests and
   // do not widen it to an arbitrary account or OSACCT wildcard.
   manifest.rules.push({
     id: 'live-account-osacct-hdr-bound-read',
     origin,
     method: 'POST',
     path: '/web/base/OSACCT.HDR',
     resourceTypes: ['xhr'],
     contentType: 'application/x-www-form-urlencoded',
     fixedQuery: {},
     variableQuery: {},
     fixedBody: {
       SYSTEM_FUNCTION_NAME: 'OSACCT',
       USER_FUNCTION_NAME: 'OSACCT',
       CURRENT_TAB_NAME: 'HDR',
       account: boundAccount.account,
       propertycode: boundAccount.propertycode,
       acctname: boundAccount.acctname,
       reference: boundAccount.reference,
       SCROLLROW: 'YES',
       ONLY_DATA_REQUIRED: 'true',
     },
     variableBody: {},
     bodyKeySequence: [
       'SYSTEM_FUNCTION_NAME',
       'USER_FUNCTION_NAME',
       'CURRENT_TAB_NAME',
       'account',
       'propertycode',
       'acctname',
       'reference',
       'SCROLLROW',
       'ONLY_DATA_REQUIRED',
     ],
     maxBodyBytes: 4096,
     redirectPolicy: 'same-reviewed-chain',
   });
   // The bound Account response exposes this exact Advance Deposit tab. Its
   // click emitted a 160-byte native read projection; allow only that fixed
   // bound shape for the next inert response capture. Deposit Schedule remains
   // a separate, unobserved action and is not widened by this rule.
   manifest.rules.push({
     id: 'live-account-osacct-adp-bound-read',
     origin,
     method: 'POST',
     path: '/web/base/OSACCT.ADP',
     resourceTypes: ['xhr'],
     contentType: 'application/x-www-form-urlencoded',
     fixedQuery: {},
     variableQuery: {},
     fixedBody: {
       SYSTEM_FUNCTION_NAME: 'OSACCT',
       USER_FUNCTION_NAME: 'OSACCT',
       CURRENT_TAB_NAME: 'ADP',
       account: boundAccount.account,
       propertycode: boundAccount.propertycode,
       acctname: boundAccount.acctname,
       reference: boundAccount.reference,
     },
     variableBody: {},
     bodyKeySequence: [
       'SYSTEM_FUNCTION_NAME',
       'USER_FUNCTION_NAME',
       'CURRENT_TAB_NAME',
       'account',
       'propertycode',
       'acctname',
       'reference',
     ],
     maxBodyBytes: 4096,
     redirectPolicy: 'same-reviewed-chain',
   });
   // The bound Advance Deposit Actions menu exposes Deposit Schedule as a
   // separate OSRSDS read. Keep its stay/confirmation/property identity in a
   // second private binding; it must not be inferred from the Account rule or
   // widened to arbitrary reservations.
   manifest.rules.push({
     id: 'live-account-osrsds-schedule-bound-read',
     origin,
     method: 'POST',
     path: '/web/base/OSRSDS',
     resourceTypes: ['xhr'],
     contentType: 'application/x-www-form-urlencoded',
     fixedQuery: {},
     variableQuery: {},
     fixedBody: {
       SYSTEM_FUNCTION_NAME: 'OSRSDS',
       USER_FUNCTION_NAME: 'OSRSDS',
       confirmationnumber: boundSchedule.confirmationnumber,
       reservationstayid: boundSchedule.reservationstayid,
       propertycode: boundSchedule.propertycode,
     },
     variableBody: {},
     bodyKeySequence: [
       'SYSTEM_FUNCTION_NAME',
       'USER_FUNCTION_NAME',
       'confirmationnumber',
       'reservationstayid',
       'propertycode',
     ],
     maxBodyBytes: 4096,
     redirectPolicy: 'same-reviewed-chain',
   });
   // The first Schedule replay exposed this exact property-scoped JSON inquiry
   // after the OSRSDS read. Its two identity fields and serialized order are
   // hash-verified against the same private confirmation/stay binding. Keep
   // the property path exact for this run; no API wildcard or account input is
   // authorized.
   manifest.rules.push({
     id: 'live-account-hotel-operation-schedule-bound-read',
     origin,
     method: 'POST',
     path: boundScheduleInquiryPath,
     resourceTypes: ['xhr'],
     contentType: 'application/json',
     fixedQuery: {},
     variableQuery: {},
     fixedBody: {
       confirmationNumber: boundSchedule.confirmationnumber,
       reservationStayID: boundSchedule.reservationstayid,
     },
     variableBody: {},
     bodyKeySequence: ['confirmationNumber', 'reservationStayID'],
     maxBodyBytes: 4096,
     redirectPolicy: 'same-reviewed-chain',
   });
    // The initial owner may search/open only. OSNOTS and all FOL rules stay
  // absent until the exact parent and, for FOL, its actual LST row are bound.
  manifest.rules = manifest.rules.filter((rule) => rule.id !== 'live-osnots-read');
  const removeDependentRules = (): void => {
    manifest.rules = manifest.rules.filter(
      (rule) =>
        rule.id !== 'live-notes-inquiry-read' &&
        rule.id !== 'live-osnots-read' &&
        rule.id !== 'live-osresv-trc-read' &&
        rule.id !== 'live-osresv-not-read' &&
        rule.id !== 'live-folio-osresv-fol' &&
        rule.id !== 'live-folio-osresv-fol-refresh' &&
        rule.id !== 'live-folio-osresv-all-grid' &&
        rule.id !== 'live-folio-osresv-all-data' &&
        !rule.id.startsWith('live-folio-cache-'),
    );
    parentRulesInstalled = false;
    folioRuleInstalled = false;
  };
  const invalidateParent = async (): Promise<void> => {
    removeDependentRules();
    parentHints = emptyParentHints();
    parentRecord.hints = parentHints;
    await privateJson('parent.json', parentRecord);
  };
  const removeFolioRule = (): void => {
    manifest.rules = manifest.rules.filter(
      (rule) =>
        rule.id !== 'live-folio-osresv-fol' &&
        rule.id !== 'live-folio-osresv-fol-refresh' &&
        rule.id !== 'live-folio-osresv-all-grid' &&
        rule.id !== 'live-folio-osresv-all-data' &&
        !rule.id.startsWith('live-folio-cache-') &&
        rule.id !== 'live-osresv-not-read' &&
        rule.id !== 'live-osresv-trc-read',
    );
    folioRuleInstalled = false;
  };
  const replaceRule = (rule: (typeof manifest.rules)[number]): void => {
    const index = manifest.rules.findIndex((existing) => existing.id === rule.id);
    if (index >= 0) manifest.rules.splice(index, 1, rule);
    else manifest.rules.push(rule);
  };
  process.env.HMS_SINGLE_CONTEXT_LOGIN = '1';
  process.env.HMS_SKIP_GUEST_STAY_NAV = '1';
  const runtime = createHmsRuntime({
    manifest,
    secretArn: arn,
    loadSecret: async () => secret,
    expectedOrigin: origin,
    requireViewOnly: true,
    runStartupCanary: false,
    requireSessionAuthorization: false,
    requireAuditCapture: false,
    onRequestProjection: appendRuntimeRequestProjection,
    reuseAuthenticatedStorageState: false,
    browserFactory: createStagehandBrowserFactory({
      profileRoot: join(out, 'profiles'),
      extensionDir: join(sdk, '@browserbasehq/stagehand/dist/extension'),
      extensionId: extensionId!,
      cdpPort: 19223,
      launchPersistentContext: (profile, options) =>
        chromium.launchPersistentContext(profile, {
          ...options,
          executablePath: process.env.HMS_CHROMIUM_EXECUTABLE_PATH,
        }),
      onContextCreated(context) {
        nativeContext = context;
        context.on('page', (page) =>
          page.on('pageerror', (error) => {
            if (!captureEnabled || captures.length >= 300) return;
            if (SAFE_DIAGNOSTICS_ONLY) {
              captures.push({
                kind: 'pageerror-signature',
                at: new Date().toISOString(),
                code: 'PAGEERROR_SUPPRESSED_SIGNATURE_ONLY',
              });
              return;
            }
            captures.push({
              kind: 'pageerror',
              at: new Date().toISOString(),
              code: 'PAGEERROR_CAPTURED',
            });
          }),
        );
        context.on('response', (response) => {
          if (!captureEnabled || closing || captures.length >= 300) return;
          const url = new URL(response.url());
          if (
            url.origin !== origin ||
            !(
              /(?:\/web\/base\/(?:OSACCT|OSRESS|OSRESV|OSNOTS|GETCACHE|OSLEDG)(?:[.?/]|$)|\/api\/booking\/)/.test(
                url.pathname,
              ) || url.pathname === boundScheduleInquiryPath
            )
          )
            return;
          const method = response.request().method();
          const isSearch = url.pathname === '/web/base/OSRESS.search';
          const isLst = url.pathname === '/web/base/OSRESV.LST';
          const searchWaiter = isSearch ? responseWaiters.get('search') : undefined;
          const lstWaiter = isLst ? responseWaiters.get('lst') : undefined;
          const waitingForSearch = Boolean(searchWaiter);
          const waitingForLst = Boolean(lstWaiter);
          const record: Record<string, unknown> = {
            kind: 'response',
            at: new Date().toISOString(),
            path: url.pathname,
            method,
            status: response.status(),
          };
          const location = response.headers()['location'];
          if (location) {
            try {
              record.redirectPath = new URL(location, origin).pathname;
            } catch {}
          }
          captures.push(record);
          let task: Promise<void>;
          task = (async () => {
            if (SIGNATURE_ONLY_CAPTURE) {
              record.bodyUnavailable = true;
              record.bodyRedaction = 'SIGNATURE_ONLY_CAPTURE';
              return;
            }
            const bodyRaw = await readResponseBodyBounded(response);
            const projectedBody = projectStagehandResponseRecord(bodyRaw);
            record.originalBodySha256 = projectedBody.originalBodySha256;
            if (!projectedBody.ok) {
              record.bodyUnavailable = true;
              record.bodyRedaction = projectedBody.bodyRedaction;
              throw Error('RESPONSE_BODY_UNSAFE');
            }
            const body = projectedBody.body;
            record.body = body;
            record.storedBodySha256 = projectedBody.storedBodySha256;
            record.redactedPaths = projectedBody.redactedPaths;
            // Only the awaited POST from this owner may grant the dependent
            // rules. A stale/failed GET or background response never binds.
            if (waitingForSearch) {
              if (responseWaiters.get('search') !== searchWaiter)
                throw Error('OSRESS_SEARCH_STALE');
              if (method !== 'POST' || response.status() !== 200)
                throw Error('OSRESS_SEARCH_FAILED');
              const confirmed = confirmStagehandParentFromSearch({
                parent: parentRecord,
                ownerMarker: marker,
                search: parseAndCorrelateGuestStayHtml(body, candidate, undefined, {
                  requireLiveEnvelope: true,
                }),
                hints: extractOsressDetailOpenHints(body, candidate),
              });
              const confirmation = confirmed.hints.confirmationNumber;
              if (!confirmation) throw Error('PARENT_CONFIRMATION_REQUIRED');
              parentHints = confirmed.hints;
              parentRecord.hints = confirmed.hints;
              removeDependentRules();
              replaceRule(buildNotesInquiryReadRule(origin, confirmation));
              replaceRule(buildLiveOsnotsReadRule(origin, confirmation));
              await privateJson('effective-manifest.json', manifest);
              await privateJson('parent.json', parentRecord);
              if (responseWaiters.get('search') !== searchWaiter)
                throw Error('OSRESS_SEARCH_STALE');
              parentRulesInstalled = true;
              settleCurrentResponse('search', searchWaiter);
            }
            if (waitingForLst) {
              if (responseWaiters.get('lst') !== lstWaiter) throw Error('OSRESV_LST_STALE');
              if (method !== 'POST' || response.status() !== 200) throw Error('OSRESV_LST_FAILED');
              const confirmation = parentHints.confirmationNumber;
              const opaqueRowId = parentHints.reservationStayId;
              if (!confirmation || !opaqueRowId) throw Error('FOLIO_PARENT_BINDING_REQUIRED');
              const binding = extractBoundOsresvLstRow(body, confirmation, opaqueRowId);
              if (!binding) throw Error('FOLIO_PARENT_BINDING_REQUIRED');
              const folioTemplate = buildLiveFolioFunctionalRules(origin).find(
                (rule) => rule.id === 'live-folio-osresv-fol',
              );
              if (!folioTemplate) throw Error('FOLIO_RULE_TEMPLATE_MISSING');
              const folioRule = bindStagehandFolioRule(folioTemplate, {
                confirmationNumber: confirmation,
                reservationStayId: binding.reservationStayId,
                hdrFields: binding.hdrFields,
              });
              replaceRule(folioRule);
              replaceRule(
                buildBoundFolioRefreshRule({
                  origin,
                  confirmationNumber: confirmation,
                  reservationStayId: binding.reservationStayId,
                  expectedPropertyCode: 'HRCEN',
                  detailValues: binding.hdrFields,
                }),
              );
              replaceRule(
                buildBoundFolioAllGridRule({
                  origin,
                  confirmationNumber: confirmation,
                  reservationStayId: binding.reservationStayId,
                  expectedPropertyCode: 'HRCEN',
                  detailValues: binding.hdrFields,
                }),
              );
              const tracesReadRule = buildBoundNotesTracesReadRule({
                origin,
                confirmationNumber: confirmation,
                reservationStayId: binding.reservationStayId,
                detailValues: binding.hdrFields,
              });
              replaceRule(
                buildBoundFolioAllDataRule({
                  origin,
                  confirmationNumber: confirmation,
                  reservationStayId: binding.reservationStayId,
                  expectedPropertyCode: 'HRCEN',
                  detailValues: binding.hdrFields,
                }),
              );
              replaceRule(tracesReadRule);
              for (const cursorPosition of [51, 101, 151])
                replaceRule(buildFolioCacheReadRule({ origin, cursorPosition }));
              // Captured Notes-tab read has the same exact parent fields.
              replaceRule({
                ...tracesReadRule,
                id: 'live-osresv-not-read',
                path: '/web/base/OSRESV.NOT',
                fixedBody: { ...tracesReadRule.fixedBody, CURRENT_TAB_NAME: 'NOT' },
              });
              await privateJson('effective-manifest.json', manifest);
              if (responseWaiters.get('lst') !== lstWaiter) throw Error('OSRESV_LST_STALE');
              folioRuleInstalled = true;
              settleCurrentResponse('lst', lstWaiter);
            }
          })()
            .catch((error) => {
              record.bodyUnavailable = true;
              if (waitingForSearch && responseWaiters.get('search') === searchWaiter) {
                removeDependentRules();
                settleCurrentResponse('search', searchWaiter, error);
              }
              if (waitingForLst && responseWaiters.get('lst') === lstWaiter) {
                removeFolioRule();
                settleCurrentResponse('lst', lstWaiter, error);
              }
            })
            .finally(() => pending.delete(task));
          pending.add(task);
        });
        context.on('requestfailed', (request) => {
          if (!captureEnabled || closing || captures.length >= 300) return;
          const url = new URL(request.url());
          if (url.origin === origin) {
            if (SAFE_DIAGNOSTICS_ONLY) {
              captures.push({
                kind: 'requestfailed-signature',
                path: url.pathname,
                at: new Date().toISOString(),
                code: 'REQUEST_FAILURE_TEXT_SUPPRESSED_SIGNATURE_ONLY',
              });
              if (url.pathname === '/web/base/OSRESS.search' && responseWaiters.has('search'))
                settleResponse('search', new Error('OSRESS_SEARCH_FAILED'));
              if (url.pathname === '/web/base/OSRESV.LST' && responseWaiters.has('lst'))
                settleResponse('lst', new Error('OSRESV_LST_FAILED'));
              return;
            }
            captures.push({
              kind: 'requestfailed',
              path: url.pathname,
              at: new Date().toISOString(),
              code: 'REQUEST_FAILURE_CAPTURED',
            });
            if (url.pathname === '/web/base/OSRESS.search' && responseWaiters.has('search'))
              settleResponse('search', new Error('OSRESS_SEARCH_FAILED'));
            if (url.pathname === '/web/base/OSRESV.LST' && responseWaiters.has('lst'))
              settleResponse('lst', new Error('OSRESV_LST_FAILED'));
          }
        });
      },
      onBeforeContextClose: async () => {
        if (!VISUAL_CAPTURE_ENABLED) return;
        try {
          await stopScreencastBeforeContextClose?.();
        } catch (error) {
          await privateJson('capture-error.json', {
            name: error instanceof Error ? error.name : 'unknown',
            message: error instanceof Error ? error.message : String(error),
          }).catch(() => undefined);
          throw error;
        }
      },
    }),
  });
  const startScreencast = async (): Promise<void> => {
    if (!nativePage) throw Error('EXACT_OWNER_PAGE_NOT_FOUND');
    const page = nativePage as NativeScreencastPage;
    if (!page.screencast?.start || !page.screencast.stop) throw Error('SCREENCAST_UNAVAILABLE');
    const path = join(videoDir, `${marker}.webm`);
    await page.screencast.start({ path, size: { width: 1280, height: 720 } });
    screencastPage = page;
    screencastPath = path;
    screencastStarted = true;
  };
  let stopScreencastPromise: Promise<void> | undefined;
  const stopScreencast = (): Promise<void> => {
    if (!screencastStarted || !screencastPage?.screencast) return Promise.resolve();
    if (stopScreencastPromise) return stopScreencastPromise;
    const operation = (async () => {
      let failure: unknown;
      try {
        await screencastPage.screencast.stop();
      } catch (error) {
        failure = error;
      }
      screencastStarted = false;
      if (screencastPath) {
        try {
          await chmod(screencastPath, 0o600);
        } catch (error) {
          failure ??= error;
        }
      }
      if (failure) throw failure;
    })();
    stopScreencastPromise = operation;
    operation.then(
      () => {
        if (stopScreencastPromise === operation) stopScreencastPromise = undefined;
      },
      () => {
        if (stopScreencastPromise === operation) stopScreencastPromise = undefined;
      },
    );
    return operation;
  };
  stopScreencastBeforeContextClose = stopScreencast;
  const signal = AbortSignal.timeout(20 * 60_000);
  let phase = 'starting';
  let sequence = 0;
  let busy = false;
  let finish!: () => void;
  const finished = new Promise<void>((resolve) => {
    finish = resolve;
  });
  const server = createServer(async (request, response) => {
    const reply = (status: number, value: unknown) => {
      response.writeHead(status, { 'content-type': 'application/json' });
      response.end(JSON.stringify(value));
    };
    if (!['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(request.socket.remoteAddress ?? ''))
      return reply(403, { error: 'LOOPBACK_REQUIRED' });
    if (request.url === '/v1/traces' && request.method === 'POST') {
      request.resume();
      response.writeHead(204);
      response.end();
      return;
    }
    const authorization =
      typeof request.headers.authorization === 'string' ? request.headers.authorization : undefined;
    if (request.url === '/state' && request.method === 'GET') {
      if (!stagehandBearerTokenMatches(authorization, controlToken))
        return reply(401, { error: 'CONTROL_AUTH_REQUIRED' });
      return reply(200, {
        phase,
        marker,
        extensionId,
        pageUrl: nativePage?.url(),
        terminal: session?.terminal(),
        violation: session?.violation(),
      });
    }
    if (request.url !== '/command' || request.method !== 'POST')
      return reply(404, { error: 'NOT_FOUND' });
    if (!stagehandBearerTokenMatches(authorization, controlToken))
      return reply(401, { error: 'CONTROL_AUTH_REQUIRED' });
    if (busy) return reply(409, { error: 'BUSY' });
    busy = true;
    try {
      let body = '';
      for await (const chunk of request) {
        body += chunk;
        if (Buffer.byteLength(body) > 1024) throw Error('COMMAND_TOO_LARGE');
      }
      const { action } = stagehandDiscoveryCommandSchema.parse(JSON.parse(body));
      if (action === 'close') {
        closing = true;
        captureEnabled = false;
        cancelResponseWaiters(new Error('OWNER_CLOSING'));
        finish();
        return reply(200, { accepted: true });
      }
      if (phase !== 'ready' || !nativePage || !session || session.terminal())
        return reply(409, { error: 'NOT_READY' });
      const dependentAction =
        action === 'open_parent' ||
        action === 'folio' ||
        action === 'folio_all_view' ||
        action === 'folio_all_run' ||
        action === 'folio_all_next' ||
        action === 'traces' ||
        action === 'notes';
      if (dependentAction && !parentRulesInstalled) throw Error('PARENT_NOT_CONFIRMED');
      if (
        (action === 'folio' ||
          action === 'folio_all_view' ||
          action === 'folio_all_run' ||
          action === 'folio_all_next' ||
          action === 'traces' ||
          action === 'notes') &&
        !folioRuleInstalled
      )
        throw Error('FOLIO_PARENT_NOT_BOUND');
      if (action === 'open_menu') {
        const menu = nativePage.locator('a.app-menu-trigger');
        if ((await menu.count()) !== 1) throw Error('EXACT_MENU_NOT_UNIQUE');
        await menu.click({ timeout: 8000 });
      } else if (
        action === 'front_desk' ||
        action === 'account' ||
        action === 'guest_stay' ||
        action === 'property_ledger'
      ) {
        await runSignatureOnlyNavigation(async () => {
          if (action === 'property_ledger') await invalidateParent();
          const label =
            action === 'front_desk'
              ? 'Front Desk'
              : action === 'account'
                ? 'Accounts'
                : action === 'property_ledger'
                  ? 'Property Ledger'
                  : 'Guest Stay';
          await clickReviewedMenuItem(nativePage!, label);
        });
      } else if (action === 'advance_deposit') {
        await runSignatureOnlyNavigation(async () => {
          // The finalized OSACCT response bound this exact visible label to
          // native OSACCT.ADP. Keep the endpoint blocked until this click
          // yields its own native request projection.
          const tab = nativePage!
            .locator('.x-tab-inner')
            .filter({ hasText: /^Advance Deposit$/ });
          if ((await tab.count()) !== 1) throw Error('EXACT_ADVANCE_DEPOSIT_TAB_NOT_UNIQUE');
          const tabButton = tab.locator(
            'xpath=ancestor::a[contains(concat(" ", normalize-space(@class), " "), " x-tab ")][1]',
          );
          if ((await tabButton.count()) !== 1)
            throw Error('EXACT_ADVANCE_DEPOSIT_BUTTON_NOT_UNIQUE');
          await tabButton.click({ timeout: 8000 });
        });
      } else if (action === 'deposit_schedule') {
        await runSignatureOnlyNavigation(async () => {
          const actions = nativePage!.getByText('Actions', { exact: true });
          if ((await actions.count()) !== 1) throw Error('EXACT_ACTIONS_MENU_NOT_UNIQUE');
          await actions.click({ timeout: 8000 });
          const schedule = nativePage!.getByText('Deposit Schedule', { exact: true });
          if ((await schedule.count()) !== 1)
            throw Error('EXACT_DEPOSIT_SCHEDULE_ACTION_NOT_UNIQUE');
          await schedule.click({ timeout: 8000 });
        });
      } else if (action === 'search_parent') {
        const search = nativePage.locator('input[name="search"]');
        if ((await search.count()) !== 1) throw Error('EXACT_SEARCH_NOT_UNIQUE');
        removeDependentRules();
        const responseWait = waitForSearchResponse();
        try {
          await search.fill(osressSearchFillValue(candidate));
          await search.press('Enter');
          await responseWait;
        } catch (error) {
          settleResponse('search', error);
          await invalidateParent();
          throw error;
        }
      } else if (action === 'open_parent') {
        const confirmation = parentHints?.confirmationNumber;
        if (!confirmation) throw Error('PARENT_CONFIRMATION_REQUIRED');
        const row = nativePage.locator('.x-grid-row').filter({ hasText: confirmation });
        if ((await row.count()) !== 1) throw Error('PARENT_ROW_NOT_UNIQUE');
        const cells = await row.locator('.x-grid-cell-inner').evaluateAll((elements) =>
          elements.map((element) => ({
            text: element.textContent,
            nestedTexts: Array.from(element.querySelectorAll('*')).map(
              (nested) => nested.textContent ?? '',
            ),
            tokens: Array.from(
              element.querySelectorAll('[data-value], [data-record-value], [aria-label]'),
            ).flatMap((token) =>
              ['data-value', 'data-record-value', 'aria-label']
                .map((attribute) => token.getAttribute(attribute))
                .filter((value): value is string => value !== null),
            ),
          })),
        );
        if (
          !stagehandParentRowMatchesExactIdentity({
            confirmationNumber: confirmation,
            externalReference: parentHints?.externalReference ?? null,
            cells,
          })
        )
          throw Error('PARENT_CELL_MISMATCH');
        removeFolioRule();
        await privateJson('effective-manifest.json', manifest);
        const responseWait = waitForLstResponse();
        try {
          await row.dblclick({ timeout: 8000 });
          await responseWait;
        } catch (error) {
          settleResponse('lst', error);
          throw error;
        }
      } else if (action === 'folio_all_next') {
        const dataspy = nativePage.locator('input[name=dataspylist]');
        if ((await dataspy.count()) !== 1 || (await dataspy.inputValue()) !== 'All Folios')
          throw Error('ALL_FOLIOS_REQUIRED');
        const grid = nativePage.locator('.x-grid-view:visible');
        if ((await grid.count()) !== 1) throw Error('EXACT_GRID_REQUIRED');
        const response = nativePage.waitForResponse(
          (r) =>
            r.request().method() === 'POST' &&
            r.status() === 200 &&
            new URL(r.url()).origin === origin &&
            new URL(r.url()).pathname === '/web/base/GETCACHE',
          { timeout: RESPONSE_READ_TIMEOUT_MS },
        );
        await grid.evaluate((element) => {
          element.scrollTop = element.scrollHeight;
        });
        await response;
      } else if (action === 'folio_all_run') {
        const dataspy = nativePage.locator('input[name=dataspylist]');
        if ((await dataspy.count()) !== 1 || (await dataspy.inputValue()) !== 'All Folios')
          throw Error('ALL_FOLIOS_REQUIRED');
        const run = nativePage.locator('a.x-btn-toolbar').filter({ hasText: /^Run$/ });
        if ((await run.count()) !== 1) throw Error('EXACT_GRID_RUN_REQUIRED');
        const response = nativePage.waitForResponse(
          (r) =>
            r.request().method() === 'POST' &&
            r.status() === 200 &&
            new URL(r.url()).origin === origin &&
            new URL(r.url()).pathname === '/web/base/OSRESV.FOL.xmlhttp',
          { timeout: RESPONSE_READ_TIMEOUT_MS },
        );
        await run.click({ timeout: 8000 });
        await response;
      } else if (action === 'folio_all_view') {
        const visibleInputs = nativePage.locator('input:visible');
        const standardFolios = await visibleInputs.evaluateAll((inputs) =>
          inputs
            .map((input, index) => ({ index, value: (input as HTMLInputElement).value.trim() }))
            .filter((input) => input.value === 'Standard Folios'),
        );
        if (standardFolios.length !== 1) throw Error('EXACT_STANDARD_FOLIOS_NOT_UNIQUE');
        const input = visibleInputs.nth(standardFolios[0]!.index);
        const table = input.locator('xpath=ancestor::table[1]');
        if ((await table.count()) !== 1) throw Error('EXACT_FOLIO_TABLE_NOT_UNIQUE');
        const trigger = table.locator('.x-form-arrow-trigger');
        if ((await trigger.count()) !== 1) throw Error('EXACT_FOLIO_TRIGGER_NOT_UNIQUE');
        await trigger.click({ timeout: 8000 });
        const option = nativePage
          .locator('.x-boundlist:visible .x-boundlist-item')
          .filter({ hasText: /^All Folios$/ });
        if ((await option.count()) !== 1) throw Error('EXACT_ALL_FOLIOS_NOT_UNIQUE');
        const folioResponse = nativePage.waitForResponse(
          (response) => {
            const url = new URL(response.url());
            return (
              response.request().method() === 'POST' &&
              response.status() === 200 &&
              url.origin === origin &&
              url.pathname === '/web/base/OSRESV.FOL'
            );
          },
          { timeout: RESPONSE_READ_TIMEOUT_MS },
        );
        await option.click({ timeout: 8000 });
        await folioResponse;
      } else if (action === 'folio' || action === 'traces' || action === 'notes') {
        const tab = nativePage
          .locator('a.x-tab')
          .filter({ hasText: new RegExp(`^${discoveryTabLabel(action)}$`) });
        if ((await tab.count()) !== 1) throw Error('EXACT_READ_TAB_NOT_UNIQUE');
        await tab.click({ timeout: 8000 });
      }
      sequence += 1;
      if (SAFE_DIAGNOSTICS_ONLY) {
        await privateJson(`action-metadata-${sequence}.json`, {
          kind: 'action-metadata',
          action,
          sequence,
          terminal: session.terminal(),
          violation: session.violation(),
        });
      } else {
        await privateScreenshot(`screen-${sequence}.png`, nativePage);
        await privateJson(`dom-${sequence}.json`, {
          text: await nativePage.locator('body').innerText(),
          marker,
          at: new Date().toISOString(),
        });
      }
      await drainPending();
      const capturePersistence = await privateJson('network.json', captures);
      return reply(200, {
        action,
        sequence,
        terminal: session.terminal(),
        violation: session.violation(),
        capturePersistence: captureStatus(capturePersistence),
      });
    } catch (error) {
      // A fail-closed request can abort the UI action before the success path
      // reaches its normal network persistence. Preserve the value-safe
      // projection first so an exact native signature is not lost to the
      // command error path.
      const capturePersistence = await privateJson('network.json', captures);
      await privateJson('command-error.json', {
        name: error instanceof Error ? error.name : 'unknown',
         message: SAFE_DIAGNOSTICS_ONLY ? 'ERROR_MESSAGE_SUPPRESSED_SAFE_CAPTURE' : String(error),
        violation: session?.violation(),
        capturePersistence: captureStatus(capturePersistence),
      });
      return reply(422, {
        error: 'COMMAND_FAILED',
        terminal: session?.terminal(),
        violation: session?.violation(),
        capturePersistence: captureStatus(capturePersistence),
      });
    } finally {
      busy = false;
    }
  });
  signal.addEventListener('abort', finish, { once: true });
  process.once('SIGTERM', finish);
  process.once('SIGINT', finish);
  const summarizeError = (error: unknown) => ({
    name: error instanceof Error ? error.name : 'unknown',
    code:
      error && typeof error === 'object' && 'code' in error
        ? String((error as { code?: unknown }).code ?? '')
        : undefined,
    message: SAFE_DIAGNOSTICS_ONLY
      ? 'ERROR_MESSAGE_SUPPRESSED_SAFE_CAPTURE'
      : error instanceof Error
        ? error.message
        : String(error),
  });
  let primaryError: unknown;
  let cleanupError: unknown;
  try {
    await runtime.start(signal);
    session = await runtime.openReadSession({
      transportId: secret.mailboxTransportId,
      signal,
      // options.manifest is already exact-candidate-bound and includes reviewed
      // detail/folio reads. Passing exactSearchCandidate without a lease would
      // intentionally replace it with the runtime's narrower find-only manifest.
      allowUnstarted: true,
    });
    nativePage = nativeContext?.pages().find((p) => p.url() === session!.page.url());
    if (!nativePage) throw Error('EXACT_OWNER_PAGE_NOT_FOUND');
    if (VISUAL_CAPTURE_ENABLED) await startScreencast();
    captureEnabled = true;
    const facade = createFindReservationFacade(session);
    let hints: ReturnType<typeof extractOsressDetailOpenHints> = {
      confirmationNumber: null,
      externalReference: null,
      reservationStayId: null,
    };
    if (process.env.HMS_STAGEHAND_UI_FIRST !== '1') {
      const responseWait = waitForSearchResponse();
      try {
        const searchText = await facade.searchExact(candidate);
        await responseWait;
        const search = parseAndCorrelateGuestStayHtml(searchText, candidate, signal, {
          requireLiveEnvelope: true,
        });
        if (search.outcome !== 'matched' || search.observations.length !== 1)
          throw Error('UNIQUE_PARENT_REQUIRED');
        if (!parentRulesInstalled) throw Error('PARENT_NOT_CONFIRMED');
        hints = parentHints;
      } catch (error) {
        settleResponse('search', error);
        await invalidateParent();
        throw error;
      }
    }
    parentHints = hints;
    // Default to real UI discovery after the proven identity lookup. A direct
    // HDR fetch does not render/select the reservation in the SPA.
    const dump =
      process.env.HMS_STAGEHAND_DIAGNOSTIC_HDR === '1'
        ? await createReservationDetailFacade({ session }).openMatchedRowAndDump({
            captureValues: true,
            matchToken: hints.confirmationNumber ?? hints.externalReference ?? undefined,
            reservationStayId: hints.reservationStayId,
          })
        : null;
    parentRecord.hints = hints;
    parentRecord.dump = dump;
    await nativePage.evaluate((value) => {
      document.documentElement.dataset.proofSession = value;
    }, marker);
    await privateJson('parent.json', parentRecord);
    if (VISUAL_CAPTURE_ENABLED) await privateScreenshot('screen-initial.png', nativePage);
    phase = 'ready';
    await privateJson('owner.json', {
      phase,
      marker,
      extensionId,
      pageUrl: nativePage.url(),
      pid: process.pid,
      controlToken,
    });
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(19224, '127.0.0.1', resolve);
    });
    console.log(JSON.stringify({ phase, output: out }));
    await finished;
  } catch (error) {
    primaryError = error;
  } finally {
    phase = 'closing';
    closing = true;
    captureEnabled = false;
    cancelResponseWaiters(new Error('OWNER_CLOSING'));
    const failures: unknown[] = [];
    const attempt = async (operation: () => Promise<void>) => {
      try {
        await operation();
      } catch (error) {
        failures.push(error);
      }
    };
    // Close the control plane immediately and independently of browser/runtime
    // teardown. No late command can authorize a request while it closes.
    const serverClose = server.listening
      ? new Promise<void>((resolve, reject) => {
          server.close((error) => (error ? reject(error) : resolve()));
        })
      : Promise.resolve();
    // Stop camera before closing its owner context. Never record login: camera
    // starts only after openReadSession has completed authentication.
    await attempt(stopScreencast);
    await attempt(async () => {
      await drainPending();
    });
    await attempt(async () => {
      await privateJson('network.json', captures);
    });
    await attempt(async () => {
      await session?.close();
    });
    await attempt(async () => {
      await runtime.close();
    });
    await attempt(async () => serverClose);
    await attempt(async () => {
      await privateJson('terminal.json', {
        phase,
        terminal: session?.terminal(),
        violation: session?.violation(),
        stats: runtime.stats(),
        primaryError: primaryError ? summarizeError(primaryError) : undefined,
        cleanupErrors: failures.map(summarizeError),
      });
    });
    cleanupError =
      failures.length === 0
        ? undefined
        : failures.length === 1
          ? failures[0]
          : new AggregateError(failures, 'discovery owner cleanup failed');
  }
  if (primaryError) {
    if (cleanupError)
      throw new AggregateError(
        [primaryError, cleanupError],
        'discovery owner failed; cleanup also failed',
        { cause: primaryError },
      );
    throw primaryError;
  }
  if (cleanupError) throw cleanupError;
}

main().catch(async (error) => {
  // Error details may contain customer data; caller redirects to a private log.
  console.error(error);
  process.exitCode = 1;
});

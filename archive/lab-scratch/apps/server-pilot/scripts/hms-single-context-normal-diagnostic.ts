/**
 * Private RCA probe: compare one normal session (find → detail) with the
 * normal runner's two-session shape.  This is not a production tool contract.
 * It prints hashes/shape only and requires an explicit live-discovery guard.
 */
import {
  createHmsRuntime,
  createPlaywrightBrowserFactory,
  hmsSecretSchema,
  type HmsPage,
  type HmsSecret,
  type HmsRuntime,
} from '../../../../../apps/server-pilot/src/hms/runtime.js';
import {
  extractLookupCandidates,
  selectConnectedLookupCandidate,
  type LookupCandidate,
} from '../../../../../apps/server-pilot/src/ai/thread-context.js';
import {
  buildExactOsressSearchThenDetailManifest,
  type ReservationSearchCandidate,
} from '../../../../../apps/server-pilot/src/hms/live-read-manifest.js';
import {
  extractOsressDetailOpenHints,
  parseAndCorrelateGuestStayHtml,
} from '../../../../../apps/server-pilot/src/hms/live-guest-stay-driver.js';
import { GetSecretValueCommand, SecretsManagerClient } from '@aws-sdk/client-secrets-manager';
import { createReservationDetailFacade } from '../../../../../apps/server-pilot/src/hms/reservation-detail-facade.js';
import { createFindReservationFacade } from '../../../../../apps/server-pilot/src/hms/find-reservation-facade.js';
import { connectedCaseSchema } from '../src/hms/connected-case-contract.js';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { dirname } from 'node:path';
import { diagnosticLocaleBootstrap } from './hms-diagnostic-read-shapes.js';
export { diagnosticLocaleBootstrap } from './hms-diagnostic-read-shapes.js';

const sha256 = (value: string): string => createHash('sha256').update(value, 'utf8').digest('hex');

export const DIAGNOSTIC_MAX_RESPONSE_BYTES = 4_096;

const SENSITIVE_RESPONSE_MARKERS = [
  ['password', /\bpassword\b/i],
  ['secret', /\bsecret\b/i],
  ['cookie', /\bcookie\b/i],
  ['authorization', /\bauthorization\b/i],
  ['bearer', /\bbearer\b/i],
  ['token', /\btoken\b|(?:^|[_-])token(?:$|[_-])/i],
  ['access_token', /\baccess[_-]?token\b/i],
  ['session', /\bsession(?:id|_id)?\b|(?:^|[_-])session(?:$|[_-])/i],
  ['csrf', /\bcsrf(?:token|tckt)?\b|\bcsrftckt\b/i],
  ['card', /\bcard(?:number|_number)?\b/i],
  ['cvv', /\bcvv\b/i],
  ['cvc', /\bcvc\b/i],
  ['payment', /\bpayment\b/i],
  ['iban', /\biban\b/i],
  ['routing', /\brouting\b/i],
  ['account', /\baccount(?:number|_number)?\b/i],
] as const;

const SAFE_MESSAGE_KEY =
  /^(?:error|errors|message|messages|exception|reason|detail|title|status|code)$/i;
const SENSITIVE_KEY =
  /^(?:password|secret|cookie|authorization|bearer|token|access[_-]?token|session(?:id|_id)?|csrf(?:token|tckt)?|csrftckt|card(?:number|_number)?|cvv|cvc|payment|iban|routing|account(?:number|_number)?)$/i;
// Preserve the original conservative substring check for raw retention.
// Structured diagnostics may still report safe messages when token1/etc exists.
const SENSITIVE_RAW_BODY =
  /password|secret|cookie|authorization|bearer|token|session|csrf|card|cvv|cvc|payment|iban|routing|account/i;
const STRUCTURE_SAMPLE_BYTES = 16_384;
const SAFE_MESSAGE_LIMIT = 512;

export type DiagnosticResponseFormat = 'json' | 'html' | 'text' | 'unknown';

export type DiagnosticResponseStructure = {
  format: DiagnosticResponseFormat;
  /** Structural names only; no field values. */
  keys: string[];
  /** Marker names seen in the raw response or structural keys. */
  markerNames: string[];
  /** Bounded values from error/message-like fields after redaction. */
  messages: string[];
};

export type DiagnosticFieldHashResult = {
  names: string[];
  valueSha256: Record<string, string>;
  fieldsSha256: string;
};

export function diagnosticFieldHashes(fields: Record<string, string>): DiagnosticFieldHashResult {
  const names = Object.keys(fields).sort();
  const valueSha256 = Object.fromEntries(names.map((name) => [name, sha256(String(fields[name]))]));
  return {
    names,
    valueSha256,
    fieldsSha256: sha256(JSON.stringify(names.map((name) => [name, valueSha256[name]]))),
  };
}

export type DiagnosticResponseCapture = {
  bytes: number;
  sha256: string;
  retention: 'captured' | 'metadata_only';
  reason?: 'sensitive_marker' | 'size_limit';
  body: string | null;
  structure: DiagnosticResponseStructure;
};

function responseFormat(body: string): DiagnosticResponseFormat {
  const trimmed = body.trimStart();
  if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
    try {
      JSON.parse(trimmed);
      return 'json';
    } catch {
      // Some legacy responses look like JSON but contain unescaped text.
    }
  }
  if (/^<!doctype\s+html\b|^<html[\s>]|^<body[\s>]/i.test(trimmed)) return 'html';
  if (trimmed.startsWith('<') && /<[a-z][^>]*>/i.test(trimmed)) return 'html';
  if (/^[\w.-]+\s*[=:]/.test(trimmed)) return 'text';
  return 'unknown';
}

function markerNames(body: string, keys: readonly string[] = []): string[] {
  const names = new Set<string>();
  for (const [name, pattern] of SENSITIVE_RESPONSE_MARKERS) {
    if (pattern.test(body) || keys.some((key) => pattern.test(key))) names.add(name);
  }
  return [...names].sort();
}

function redactDiagnosticText(
  value: string,
  secrets: Pick<HmsSecret, 'username' | 'password'>,
): string {
  let safe = value
    .replace(/[\u0000-\u001f\u007f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  for (const secret of [secrets.username, secrets.password]) {
    if (secret) safe = safe.split(secret).join('[redacted-secret]');
  }
  // Remove values attached to sensitive labels, including bearer-like tokens.
  safe = safe.replace(
    /\b(password|secret|cookie|authorization|bearer|token|access[_-]?token|card(?:number|_number)?|cvv|cvc|payment|iban|routing|account(?:number|_number)?)\b\s*[:=]\s*(?:Bearer\s+)?[^\s,;&<>]+/gi,
    '$1=[redacted-sensitive]',
  );
  safe = safe.replace(/\b(?:Bearer|Basic)\s+[A-Za-z0-9._~+/=-]{8,}/gi, '[redacted-authorization]');
  safe = safe.replace(/\beyJ[A-Za-z0-9_-]{8,}(?:\.[A-Za-z0-9_-]{8,}){1,2}\b/g, '[redacted-opaque]');
  safe = safe.replace(/\b[A-Za-z0-9+/_=-]{32,}\b/g, '[redacted-opaque]');
  safe = safe.replace(/\b\d[\d -]{11,}\d\b/g, '[redacted-number]');
  return safe.slice(0, SAFE_MESSAGE_LIMIT);
}

function pushSafeMessage(
  messages: string[],
  value: unknown,
  secrets: Pick<HmsSecret, 'username' | 'password'>,
): void {
  if (typeof value !== 'string' && typeof value !== 'number' && typeof value !== 'boolean') return;
  const safe = redactDiagnosticText(String(value), secrets);
  if (safe && !messages.includes(safe)) messages.push(safe);
}

function htmlStructure(
  body: string,
  secrets: Pick<HmsSecret, 'username' | 'password'>,
): DiagnosticResponseStructure {
  const keys = new Set<string>();
  for (const match of body.matchAll(
    /\b(?:name|id|data-[a-z0-9_-]+)\s*=\s*["']([^"']{1,128})["']/gi,
  )) {
    const value = match[1]?.trim();
    if (value && /^[A-Za-z][A-Za-z0-9_.:-]{0,127}$/.test(value)) keys.add(value);
  }
  const messages: string[] = [];
  const collect = (matches: Iterable<RegExpMatchArray>): void => {
    for (const match of matches) {
      const text = match[2]?.replace(/<[^>]*>/g, ' ') ?? '';
      pushSafeMessage(messages, text, secrets);
    }
  };
  collect(body.matchAll(/<(title|h[1-6])\b[^>]*>([\s\S]*?)<\/\1>/gi));
  for (const match of body.matchAll(/<(div|span|p)\b([^>]*)>([\s\S]*?)<\/\1>/gi)) {
    const attrs = match[2] ?? '';
    if (!/(?:class|id)\s*=\s*["'][^"']*(?:error|message|alert|status)[^"']*["']/i.test(attrs)) {
      continue;
    }
    const text = match[3]?.replace(/<[^>]*>/g, ' ') ?? '';
    pushSafeMessage(messages, text, secrets);
  }
  return {
    format: 'html',
    keys: [...keys].sort().slice(0, 256),
    markerNames: markerNames(body, [...keys]),
    messages: messages.slice(0, 8),
  };
}

function responseStructure(
  body: string,
  secrets: Pick<HmsSecret, 'username' | 'password'>,
): DiagnosticResponseStructure {
  const format = responseFormat(body);
  if (format === 'html') return htmlStructure(body.slice(0, STRUCTURE_SAMPLE_BYTES), secrets);

  const keys = new Set<string>();
  const messages: string[] = [];
  const add = (key: string, value: unknown): boolean => {
    if (!key || key.length > 128) return false;
    keys.add(key);
    if (SENSITIVE_KEY.test(key)) return false;
    if (SAFE_MESSAGE_KEY.test(key)) pushSafeMessage(messages, value, secrets);
    return true;
  };
  const walk = (value: unknown, depth: number): void => {
    if (depth > 5 || keys.size >= 256) return;
    if (Array.isArray(value)) {
      for (const item of value.slice(0, 32)) walk(item, depth + 1);
      return;
    }
    if (!value || typeof value !== 'object') return;
    for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
      if (!add(key, child)) continue;
      walk(child, depth + 1);
    }
  };
  if (format === 'json') {
    try {
      walk(JSON.parse(body.slice(0, STRUCTURE_SAMPLE_BYTES)), 0);
    } catch {
      // Fall through to bounded key/value extraction below.
    }
  }
  if (keys.size === 0 || messages.length === 0) {
    const sample = body.slice(0, STRUCTURE_SAMPLE_BYTES);
    const field =
      /["']?(error|errors|message|messages|exception|reason|detail|title|status|code)["']?\s*[:=]\s*["']([^"'&<>\r\n]{0,512})["']/gi;
    for (const match of sample.matchAll(field)) add(match[1]!, match[2]!);
  }
  return {
    format,
    keys: [...keys].sort().slice(0, 256),
    markerNames: markerNames(body, [...keys]),
    messages: messages.slice(0, 8),
  };
}

export function sanitizeDiagnosticResponse(
  body: string,
  secrets: Pick<HmsSecret, 'username' | 'password'>,
): DiagnosticResponseCapture {
  const bytes = Buffer.byteLength(body, 'utf8');
  const digest = sha256(body);
  const structure = responseStructure(body, secrets);
  if (bytes > DIAGNOSTIC_MAX_RESPONSE_BYTES) {
    return {
      bytes,
      sha256: digest,
      retention: 'metadata_only',
      reason: 'size_limit',
      body: null,
      structure,
    };
  }
  if (structure.markerNames.length > 0 || SENSITIVE_RAW_BODY.test(body)) {
    return {
      bytes,
      sha256: digest,
      retention: 'metadata_only',
      reason: 'sensitive_marker',
      body: null,
      structure,
    };
  }
  let safeBody = body;
  for (const secret of [secrets.username, secrets.password]) {
    if (secret) safeBody = safeBody.split(secret).join('[redacted-secret]');
  }
  return { bytes, sha256: digest, retention: 'captured', body: safeBody, structure };
}

type DiagnosticReadFamily = 'OSRESV' | 'LST' | 'HDR' | 'OTHER';

type DiagnosticRead = {
  path: string;
  family: DiagnosticReadFamily;
  requestFieldNames: string[];
  requestFieldValueSha256: Record<string, string>;
  requestFieldsSha256: string;
  responseBytes: number | null;
  responseSha256: string | null;
  responseRetention: DiagnosticResponseCapture['retention'] | 'error';
  responseReason?: DiagnosticResponseCapture['reason'];
  responseStructure?: DiagnosticResponseStructure;
  responseBody?: string;
  errorCode?: string;
  localeBootstrap?: ReturnType<typeof diagnosticLocaleBootstrap>;
  readinessAfterHdr?: DiagnosticReadiness;
};

type DiagnosticReadiness = {
  readyState: 'loading' | 'interactive' | 'complete' | null;
  maskCount: number | null;
  ajaxLoading: boolean | null;
  errorCode?: string;
  localeCookiePresent?: boolean;
  localeCookieValue?: string | null;
  defaultXhrHeader?: 'XMLHttpRequest' | null;
  useDefaultXhrHeader?: boolean | null;
};

function diagnosticReadTarget(url: string): {
  path: string;
  family: DiagnosticReadFamily;
} {
  try {
    const path = new URL(url).pathname.slice(0, 256);
    const family = path.endsWith('/OSRESV')
      ? 'OSRESV'
      : path.endsWith('.LST')
        ? 'LST'
        : path.endsWith('.HDR')
          ? 'HDR'
          : 'OTHER';
    return { path, family };
  } catch {
    return { path: '[invalid-url]', family: 'OTHER' };
  }
}

function attachDiagnosticReads(error: unknown, reads: readonly DiagnosticRead[]): void {
  if (!(error instanceof Error)) return;
  Object.defineProperty(error, 'diagnosticReads', {
    configurable: true,
    enumerable: false,
    value: [...reads],
  });
}

function diagnosticReadsFrom(error: unknown): DiagnosticRead[] | null {
  if (!(error instanceof Error) || !('diagnosticReads' in error)) return null;
  const reads = (error as Error & { diagnosticReads?: unknown }).diagnosticReads;
  return Array.isArray(reads) ? (reads as DiagnosticRead[]) : null;
}

function attachDiagnosticReadiness(error: unknown, readiness: DiagnosticReadiness): void {
  if (!(error instanceof Error)) return;
  Object.defineProperty(error, 'diagnosticReadiness', {
    configurable: true,
    enumerable: false,
    value: readiness,
  });
}

function diagnosticReadinessFrom(error: unknown): DiagnosticReadiness | null {
  if (!(error instanceof Error) || !('diagnosticReadiness' in error)) return null;
  const readiness = (error as Error & { diagnosticReadiness?: unknown }).diagnosticReadiness;
  return readiness && typeof readiness === 'object' ? (readiness as DiagnosticReadiness) : null;
}

async function diagnosticReadiness(page: HmsPage): Promise<DiagnosticReadiness> {
  try {
    return await page.evaluate(() => {
      const browserGlobal = globalThis as typeof globalThis & {
        document?: {
          cookie?: string;
          readyState?: string;
          querySelectorAll?: (selectors: string) => { length: number };
        };
        Ext?: {
          Ajax?: {
            isLoading?: () => boolean;
            defaultXhrHeader?: unknown;
            useDefaultXhrHeader?: unknown;
          };
        };
      };
      const readyState = browserGlobal.document?.readyState;
      const localeCookie = (browserGlobal.document?.cookie ?? '')
        .split(';')
        .map((value) => value.trim())
        .find((value) => /^EWSLanguage=/i.test(value));
      const localeValue = localeCookie?.slice(localeCookie.indexOf('=') + 1) ?? '';
      return {
        defaultXhrHeader:
          browserGlobal.Ext?.Ajax?.defaultXhrHeader === 'XMLHttpRequest'
            ? ('XMLHttpRequest' as const)
            : null,
        useDefaultXhrHeader:
          typeof browserGlobal.Ext?.Ajax?.useDefaultXhrHeader === 'boolean'
            ? browserGlobal.Ext.Ajax.useDefaultXhrHeader
            : null,
        localeCookiePresent: Boolean(localeCookie),
        localeCookieValue: /^[A-Za-z]{2}(?:[_-][A-Za-z]{2,8})?$/.test(localeValue)
          ? localeValue
          : null,
        readyState:
          readyState === 'loading' || readyState === 'interactive' || readyState === 'complete'
            ? readyState
            : null,
        maskCount: browserGlobal.document?.querySelectorAll
          ? browserGlobal.document.querySelectorAll('.x-mask,.x-mask-msg').length
          : null,
        ajaxLoading:
          typeof browserGlobal.Ext?.Ajax?.isLoading === 'function'
            ? Boolean(browserGlobal.Ext.Ajax.isLoading())
            : null,
      };
    });
  } catch (error) {
    return {
      readyState: null,
      maskCount: null,
      ajaxLoading: null,
      errorCode: errorCode(error),
    };
  }
}

export type DiagnosticMode = 'single' | 'after_find';

export function diagnosticMode(value: string | undefined): DiagnosticMode {
  if (value === undefined || value === 'single') return 'single';
  if (value === 'after_find') return 'after_find';
  throw new Error('DIAGNOSTIC_MODE_INVALID');
}

export function diagnosticKeysHash(keys: readonly string[]): string {
  return sha256(JSON.stringify([...keys].sort()));
}

function candidateOf(input: LookupCandidate): ReservationSearchCandidate {
  if (input.kind === 'surname_dates') return { ...input };
  return { id: input.id, kind: input.kind, value: input.value };
}

function errorCode(error: unknown): string {
  if (!(error instanceof Error) || !('code' in error)) return 'UNKNOWN';
  const code = (error as { code?: unknown }).code;
  return typeof code === 'string' && code ? code.slice(0, 80) : 'UNKNOWN';
}

function errorMessage(error: unknown): string {
  if (!(error instanceof Error)) return 'unknown_error';
  const message = error.message.trim();
  if (!message || /password|secret|cookie|authorization|bearer|token|https?:\/\//i.test(message)) {
    return message ? 'redacted_error' : 'unknown_error';
  }
  return message.replace(/\b\d{6,}\b/g, '[redacted-number]').slice(0, 160);
}

async function loadSecret(arn: string): Promise<HmsSecret> {
  const client = new SecretsManagerClient({ region: process.env.AWS_REGION ?? 'af-south-1' });
  const result = await client.send(new GetSecretValueCommand({ SecretId: arn }));
  if (!result.SecretString) throw new Error('HMS secret is empty');
  return hmsSecretSchema.parse(JSON.parse(result.SecretString));
}

export function diagnosticSessionInput(
  secret: HmsSecret,
  signal: AbortSignal,
): Parameters<HmsRuntime['openReadSession']>[0] {
  // The runtime options already contain the exact search+detail manifest.
  // Supplying exactSearchCandidate here would replace it with find-only.
  return { transportId: secret.mailboxTransportId, signal, allowUnstarted: true };
}

async function oneSession(
  runtime: HmsRuntime,
  secret: HmsSecret,
  candidate: ReservationSearchCandidate,
  signal: AbortSignal,
  includeDetail: boolean,
) {
  const session = await runtime.openReadSession(diagnosticSessionInput(secret, signal));
  const reads: DiagnosticRead[] = [];
  const readinessBeforeSearch = await diagnosticReadiness(session.page);
  const originalPostForm = session.page.postForm;
  session.page.postForm = async (url, fields, responseBounds) => {
    const target = diagnosticReadTarget(url);
    const request = diagnosticFieldHashes(fields);
    try {
      const body =
        responseBounds === undefined
          ? await Reflect.apply(originalPostForm, session.page, [url, fields])
          : await Reflect.apply(originalPostForm, session.page, [url, fields, responseBounds]);
      const capture = sanitizeDiagnosticResponse(body, secret);
      const readinessAfterHdr =
        target.family === 'HDR' ? await diagnosticReadiness(session.page) : undefined;
      reads.push({
        path: target.path,
        family: target.family,
        requestFieldNames: request.names,
        requestFieldValueSha256: request.valueSha256,
        requestFieldsSha256: request.fieldsSha256,
        responseBytes: capture.bytes,
        responseSha256: capture.sha256,
        responseRetention: capture.retention,
        ...(capture.reason ? { responseReason: capture.reason } : {}),
        responseStructure: capture.structure,
        ...(target.family === 'HDR'
          ? { localeBootstrap: diagnosticLocaleBootstrap(body), readinessAfterHdr }
          : {}),
        ...(target.family === 'HDR' && capture.body !== null ? { responseBody: capture.body } : {}),
      });
      return body;
    } catch (error) {
      reads.push({
        path: target.path,
        family: target.family,
        requestFieldNames: request.names,
        requestFieldValueSha256: request.valueSha256,
        requestFieldsSha256: request.fieldsSha256,
        responseBytes: null,
        responseSha256: null,
        responseRetention: 'error',
        errorCode: errorCode(error),
      });
      throw error;
    }
  };
  try {
    const facade = createFindReservationFacade(session);
    const html = await facade.searchExact(candidate);
    const search = parseAndCorrelateGuestStayHtml(html, candidate, signal, {
      requireLiveEnvelope: facade.requireLiveEnvelope,
    });
    const rowCount = await facade.ensureSearchResultRows(candidate);
    const result: Record<string, unknown> = {
      searchOutcome: search.outcome,
      observationCount: search.observations.length,
      rowCount,
      readDiagnostics: reads,
      readinessBeforeSearch,
    };
    if (!includeDetail) return result;
    if (search.outcome !== 'matched' || search.observations.length !== 1) {
      throw new Error('DIAGNOSTIC_SEARCH_NOT_UNIQUE');
    }
    const observation = search.observations[0]!;
    const hints = extractOsressDetailOpenHints(html, candidate);
    const matchToken = (
      observation.confirmationNumber ||
      observation.externalReference ||
      hints.confirmationNumber ||
      hints.externalReference ||
      ''
    ).trim();
    const opaqueRowId = hints.reservationStayId?.trim() || null;
    result.matchTokenKind = observation.confirmationNumber
      ? 'confirmation'
      : observation.externalReference
        ? 'external_reference'
        : hints.confirmationNumber
          ? 'hint_confirmation'
          : hints.externalReference
            ? 'hint_external_reference'
            : 'none';
    result.matchTokenSha256 = matchToken ? sha256(matchToken) : null;
    result.opaqueRowIdPresent = Boolean(opaqueRowId);
    result.opaqueRowIdSha256 = opaqueRowId ? sha256(opaqueRowId) : null;
    const dump = await createReservationDetailFacade({ session }).openMatchedRowAndDump({
      captureValues: false,
      matchToken: matchToken || undefined,
      reservationStayId: opaqueRowId,
    });
    result.detail = {
      schemaVersion: dump.schemaVersion,
      surface: dump.surface,
      keyCount: dump.keys.length,
      keysSha256: diagnosticKeysHash(dump.keys),
      keys: [...dump.keys].sort(),
      valuesRetained: Boolean(dump.values),
    };
    return result;
  } catch (error) {
    attachDiagnosticReads(error, reads);
    attachDiagnosticReadiness(error, readinessBeforeSearch);
    throw error;
  } finally {
    session.page.postForm = originalPostForm;
    await session.close();
  }
}

async function main(): Promise<void> {
  if (process.env.HMS_DISCOVERY_ALLOW_LIVE !== '1') {
    throw new Error('refused: set HMS_DISCOVERY_ALLOW_LIVE=1');
  }
  const casePath = process.env.HMS_SINGLE_CONTEXT_NORMAL_CASE_PATH;
  const secretArn = process.env.HMS_READ_SECRET_ARN;
  if (!casePath || !secretArn) {
    throw new Error('HMS_SINGLE_CONTEXT_NORMAL_CASE_PATH and HMS_READ_SECRET_ARN are required');
  }
  const outputPath =
    process.env.HMS_SINGLE_CONTEXT_NORMAL_OUT ??
    '.private/stagehand-trial-20260917/single-context-normal-diagnostic.json';
  const mode = diagnosticMode(process.env.HMS_SINGLE_CONTEXT_NORMAL_MODE);
  let runtime: HmsRuntime | null = null;
  let output: Record<string, unknown>;
  let cleanupErrorCode: string | null = null;
  try {
    const connectedCase = connectedCaseSchema.parse(JSON.parse(await readFile(casePath, 'utf8')));
    const selected = selectConnectedLookupCandidate(
      extractLookupCandidates(connectedCase.incoming.body),
    );
    if (!selected) throw new Error('DIAGNOSTIC_CANDIDATE_NOT_UNIQUE');
    const candidate = candidateOf(selected);
    const secret = await loadSecret(secretArn);
    const origin = new URL(secret.loginUrl).origin;
    process.env.HMS_SINGLE_CONTEXT_LOGIN = '1';
    process.env.HMS_SKIP_GUEST_STAY_NAV = '1';
    process.env.HMS_PROOF_DIAGNOSTICS = '1';
    runtime = createHmsRuntime({
      manifest: buildExactOsressSearchThenDetailManifest(origin, candidate),
      secretArn,
      loadSecret: async () => secret,
      browserFactory: createPlaywrightBrowserFactory(),
      executablePath: process.env.HMS_CHROMIUM_EXECUTABLE_PATH || undefined,
      expectedOrigin: origin,
      requireViewOnly: true,
      runStartupCanary: false,
      requireAuditCapture: false,
      requireSessionAuthorization: false,
      reuseAuthenticatedStorageState: false,
      sourceRevision: 'single-context-normal-diagnostic-v1',
      playwrightRevision: '1.52.0',
      chromiumRevision: '1169',
    });
    const signal = AbortSignal.timeout(120_000);
    await runtime.start(signal);
    const candidateMeta = {
      kind: candidate.kind,
      idSha256: sha256(candidate.id),
      valueSha256: sha256(
        candidate.kind === 'surname_dates'
          ? `${candidate.surname}|${candidate.arrivalDate}|${candidate.departureDate}`
          : candidate.value,
      ),
    };
    const first = await oneSession(runtime, secret, candidate, signal, mode === 'single');
    const second =
      mode === 'after_find' ? await oneSession(runtime, secret, candidate, signal, true) : null;
    const bound = (second ?? first) as Record<string, unknown>;
    const detail = bound.detail as Record<string, unknown> | undefined;
    const parentHash = sha256(
      JSON.stringify({
        candidate: candidateMeta,
        matchTokenSha256: bound.matchTokenSha256 ?? null,
        opaqueRowIdSha256: bound.opaqueRowIdSha256 ?? null,
        detailKeysSha256: detail?.keysSha256 ?? null,
      }),
    );
    output = {
      schemaVersion: 'hms-single-context-normal-diagnostic/v1',
      status: 'ok',
      mode,
      caseIdSha256: sha256(connectedCase.caseId),
      candidate: candidateMeta,
      parentHash,
      runtime: { playwright: '1.52.0', chromium: '1169', singleContextLogin: true },
      sessions: mode === 'single' ? 1 : 2,
      first,
      ...(second ? { second } : {}),
      runtimeStats: runtime.stats(),
    };
  } catch (error) {
    const failedReads = diagnosticReadsFrom(error);
    const failedReadiness = diagnosticReadinessFrom(error);
    output = {
      schemaVersion: 'hms-single-context-normal-diagnostic/v1',
      status: 'error',
      mode,
      errorCode: errorCode(error),
      error: errorMessage(error),
      ...(failedReads ? { readDiagnostics: failedReads } : {}),
      ...(failedReadiness ? { readinessBeforeSearch: failedReadiness } : {}),
    };
    process.exitCode = 1;
  } finally {
    try {
      await runtime?.close();
    } catch (error) {
      cleanupErrorCode = errorCode(error);
    }
    if (runtime) output = { ...output!, runtimeStats: runtime.stats() };
    if (cleanupErrorCode) {
      output = {
        ...output!,
        status: 'error',
        errorCode: 'CLEANUP_FAILED',
        cleanupErrorCode,
      };
      process.exitCode = 1;
    }
    await mkdir(dirname(outputPath), { recursive: true });
    await writeFile(outputPath, JSON.stringify(output!, null, 2), { mode: 0o600 });
  }
  console.log(JSON.stringify({ phase: 'done', status: output!.status, mode, out: outputPath }));
}

const invokedDirectly = process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url;
if (invokedDirectly) {
  void main().catch((error) => {
    console.error(
      JSON.stringify({ phase: 'failed', errorCode: errorCode(error), error: errorMessage(error) }),
    );
    process.exitCode = 1;
  });
}

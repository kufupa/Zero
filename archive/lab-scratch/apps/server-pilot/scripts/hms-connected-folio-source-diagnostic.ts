/**
 * Development-only FOL source probe. It discovers one exact parent, closes
 * that browser runtime, then reads one exact-bound OSRESV.FOL in a new runtime.
 * No raw PMS body, identity value, or payment field is written or printed.
 */
import {
  buildExactOsressSearchThenDetailManifest,
  buildLiveFolioReadManifest,
  buildLiveGuestStayChromeGetRules,
  buildLiveHmsAuthenticationRules,
  type ReservationSearchCandidate,
} from '../../../../../apps/server-pilot/src/hms/live-read-manifest.js';
import {
  extractOsressDetailOpenHints,
  extractValidatedReservationStayId,
  parseAndCorrelateGuestStayHtml,
} from '../../../../../apps/server-pilot/src/hms/live-guest-stay-driver.js';
import {
  createHmsRuntime,
  createPlaywrightBrowserFactory,
  hmsSecretSchema,
  type HmsRuntime,
  type HmsSecret,
} from '../../../../../apps/server-pilot/src/hms/runtime.js';
import {
  extractLookupCandidates,
  selectConnectedLookupCandidate,
  type LookupCandidate,
} from '../../../../../apps/server-pilot/src/ai/thread-context.js';
import {
  createReservationDetailFacade,
  parseReservationDetailBody,
} from '../../../../../apps/server-pilot/src/hms/reservation-detail-facade.js';
import {
  parseBoundFolioFolTransport,
  type FolioFolParentProof,
} from '../../../../../apps/server-pilot/src/hms/folio-fol-parse.js';
import {
  FOLIO_READ_MAX_BYTES,
  FOLIO_READ_MAX_DURATION_MS,
} from '../../../../../apps/server-pilot/src/hms/folio-read-contract.js';
import { buildBoundFolioReadFields, createFolioReadFacade } from '../../../../../apps/server-pilot/src/hms/folio-read-facade.js';
import { GetSecretValueCommand, SecretsManagerClient } from '@aws-sdk/client-secrets-manager';
import { createFindReservationFacade } from '../../../../../apps/server-pilot/src/hms/find-reservation-facade.js';
import { connectedCaseSchema } from '../src/hms/connected-case-contract.js';
import { requestPolicyManifestSchema } from '../../../../../apps/server-pilot/src/hms/contracts.js';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { dirname } from 'node:path';
import { diagnosticLocaleBootstrap } from './hms-diagnostic-read-shapes.js';

const sha256 = (value: string): string => createHash('sha256').update(value, 'utf8').digest('hex');
export function summarizeHdrTrial(body: string, fields: Record<string, string>, mode: string) {
  const values = parseReservationDetailBody(body).values;
  return {
    mode,
    bytes: Buffer.byteLength(body, 'utf8'),
    sourceHash: sha256(body),
    locale: diagnosticLocaleBootstrap(body),
    parentMatched: Boolean(fields.confirmationnumber && fields.reservationstayid &&
      values.confirmationnumber === fields.confirmationnumber &&
      values.reservationstayid === fields.reservationstayid && values.propertycode === 'HRCEN'),
  };
}
const DEPOSIT_FIELDS = [
  { key: 'untransferreddeposit', kind: 'numeric' as const },
  { key: 'untransferreddepositcurr', kind: 'currency' as const },
] as const;

export type FolioDepositDiagnosticField = {
  key: (typeof DEPOSIT_FIELDS)[number]['key'];
  kind: (typeof DEPOSIT_FIELDS)[number]['kind'];
  present: boolean;
  masked: boolean | 'unknown';
  value: string | null;
};

export function summarizeFolioDepositFields(input: {
  keys: readonly string[];
  values: Record<string, string>;
}): FolioDepositDiagnosticField[] {
  const keys = new Set(input.keys.map((key) => key.toLowerCase()));
  return DEPOSIT_FIELDS.map(({ key, kind }) => {
    const present = keys.has(key) || Object.prototype.hasOwnProperty.call(input.values, key);
    const raw = input.values[key]?.trim();
    const value =
      kind === 'currency'
        ? raw && /^[A-Za-z]{3}$/.test(raw)
          ? raw.toUpperCase()
          : null
        : raw && /^-?(?:0|[1-9]\d{0,11})(?:\.\d{1,2})?$/.test(raw.replace(/,/g, ''))
          ? (() => {
              const normalized = raw.replace(/,/g, '');
              const [whole, fraction = ''] = normalized.split('.');
              return `${whole}.${(fraction + '00').slice(0, 2)}`;
            })()
          : null;
    return { key, kind, present, masked: value === null ? 'unknown' : false, value };
  });
}

export function buildBoundFolioDiagnosticManifest(origin: string, fields: Record<string, string>) {
  const template = buildLiveFolioReadManifest(origin).rules.find(
    (rule) => rule.id === 'live-folio-osresv-fol',
  );
  if (!template) throw new Error('FOLIO_RULE_TEMPLATE_REQUIRED');
  return requestPolicyManifestSchema.parse({
    rules: [
      ...buildLiveGuestStayChromeGetRules(origin),
      ...buildLiveHmsAuthenticationRules(origin),
      { ...template, fixedBody: { ...fields }, variableBody: {} },
    ],
  });
}

function candidateOf(input: LookupCandidate): ReservationSearchCandidate {
  return input.kind === 'surname_dates'
    ? { ...input }
    : { id: input.id, kind: input.kind, value: input.value };
}

function field(values: Record<string, string>, name: string): string | null {
  const matches = Object.entries(values).filter(([key]) => key.toLowerCase() === name);
  return matches.length === 1 && matches[0]![1].trim() ? matches[0]![1].trim() : null;
}

function errorCode(error: unknown): string {
  if (!(error instanceof Error) || !('code' in error)) return 'DIAGNOSTIC_FAILED';
  const code = (error as { code?: unknown }).code;
  return typeof code === 'string' && code ? code.slice(0, 80) : 'DIAGNOSTIC_FAILED';
}

async function loadSecret(arn: string): Promise<HmsSecret> {
  const result = await new SecretsManagerClient({
    region: process.env.AWS_REGION ?? 'af-south-1',
  }).send(new GetSecretValueCommand({ SecretId: arn }));
  if (!result.SecretString) throw new Error('HMS secret is empty');
  return hmsSecretSchema.parse(JSON.parse(result.SecretString));
}

async function discoverParent(
  runtime: HmsRuntime,
  secret: HmsSecret,
  candidate: ReservationSearchCandidate,
  signal: AbortSignal,
  hdrTrials: unknown[],
) {
  const session = await runtime.openReadSession({
    transportId: secret.mailboxTransportId,
    signal,
    allowUnstarted: true,
  });
  const originalPost = session.page.postForm.bind(session.page);
  session.page.postForm = async (url, fields, bounds) => {
    const first = await originalPost(url, fields, bounds);
    if (new URL(url).pathname !== '/web/base/OSRESV.HDR') return first;
    const summary = summarizeHdrTrial(first, fields, 'original');
    hdrTrials.push(summary);
    if (process.env.HMS_DIAGNOSTIC_XHR_COMPARE === '1' && summary.locale.recognized) {
      // Diagnostic A/B/A only: same reviewed read body, one observed browser
      // header changed. The facade still receives the ORIGINAL outcome.
      try {
        const xhr = await session.page.evaluate(async ({ url, fields }) => {
          const location = (globalThis as unknown as { location: { origin: string } }).location;
          const target = new URL(url);
          if (target.origin !== location.origin || target.pathname !== '/web/base/OSRESV.HDR') throw Error('DIAGNOSTIC_TARGET_DENIED');
          const controller = new AbortController();
          const timer = setTimeout(() => controller.abort(), 8_000);
          try {
            const response = await fetch(target.href, {
              method: 'POST', credentials: 'same-origin', redirect: 'manual', signal: controller.signal,
              headers: { 'content-type': 'application/x-www-form-urlencoded', 'X-Requested-With': 'XMLHttpRequest' },
              body: new URLSearchParams(fields).toString(),
            });
            if (!response.ok || response.redirected || response.type !== 'basic') throw Error('DIAGNOSTIC_RESPONSE_DENIED');
            const text = await response.text();
            if (new TextEncoder().encode(text).byteLength > 262_144) throw Error('DIAGNOSTIC_RESPONSE_TOO_LARGE');
            return text;
          } finally { clearTimeout(timer); }
        }, { url, fields });
        hdrTrials.push(summarizeHdrTrial(xhr, fields, 'xhr_header'));
        hdrTrials.push(summarizeHdrTrial(await originalPost(url, fields, bounds), fields, 'original_again'));
      } catch (error) { hdrTrials.push({ mode: 'comparison_failed', errorCode: errorCode(error) }); }
    }
    return first;
  };
  try {
    const facade = createFindReservationFacade(session);
    const html = await facade.searchExact(candidate);
    const search = parseAndCorrelateGuestStayHtml(html, candidate, signal, {
      requireLiveEnvelope: facade.requireLiveEnvelope,
    });
    if (search.outcome !== 'matched' || search.observations.length !== 1) {
      throw new Error('PARENT_NOT_UNIQUE');
    }
    await facade.ensureSearchResultRows(candidate);
    const observation = search.observations[0]!;
    const hints = extractOsressDetailOpenHints(html, candidate);
    const matchToken = (
      observation.confirmationNumber ||
      observation.externalReference ||
      hints.confirmationNumber ||
      hints.externalReference ||
      ''
    ).trim();
    const dump = await createReservationDetailFacade({ session }).openMatchedRowAndDump({
      captureValues: true,
      matchToken: matchToken || undefined,
      reservationStayId: hints.reservationStayId || null,
    });
    if (!dump.values) throw new Error('PARENT_VALUES_UNAVAILABLE');
    const confirmationNumber = field(dump.values, 'confirmationnumber');
    const reservationStayId = extractValidatedReservationStayId(dump);
    const propertyCode = field(dump.values, 'propertycode');
    const account = field(dump.values, 'account');
    // Match the production bound-folio parent's observed currency aliases.
    const currency = ['balancecurr', 'propertycurrency', 'hotelcurrency', 'currency']
      .map(key => field(dump.values!, key))
      .find(value => value !== null && /^[A-Z]{3}$/.test(value)) ?? null;
    if (!confirmationNumber || !reservationStayId || !propertyCode || !account || !currency) {
      throw new Error('PARENT_PROOF_INCOMPLETE');
    }
    const proof: FolioFolParentProof = {
      confirmationNumber,
      reservationStayId,
      propertyCode,
      account,
      currency,
    };
    const parentHash = sha256(
      JSON.stringify(
        Object.fromEntries(Object.entries(proof).map(([key, value]) => [key, sha256(value)])),
      ),
    );
    return { proof, detailValues: dump.values, parentHash };
  } finally {
    await session.close();
  }
}

async function runFolioSource(
  runtime: HmsRuntime,
  secret: HmsSecret,
  parent: Awaited<ReturnType<typeof discoverParent>>,
  expectedPropertyCode: string,
  signal: AbortSignal,
) {
  const fields = buildBoundFolioReadFields({
    confirmationNumber: parent.proof.confirmationNumber,
    reservationStayId: parent.proof.reservationStayId,
    expectedPropertyCode,
    detailValues: parent.detailValues,
  });
  const session = await runtime.openReadSession({
    transportId: secret.mailboxTransportId,
    signal,
    allowUnstarted: true,
  });
  try {
    const body = await createFolioReadFacade(session, { expectedPropertyCode }).openBoundOsresvFol({
      confirmationNumber: parent.proof.confirmationNumber,
      reservationStayId: parent.proof.reservationStayId,
      detailValues: parent.detailValues,
      responseBounds: { maxBytes: FOLIO_READ_MAX_BYTES, timeoutMs: FOLIO_READ_MAX_DURATION_MS },
    });
    const parsed = parseReservationDetailBody(body);
    const observedAt = new Date().toISOString();
    const bound = parseBoundFolioFolTransport(body, parent.proof, {
      evidenceRef: `folio-diagnostic:${parent.parentHash.slice(0, 24)}`,
      observedAt,
      expiresAt: new Date(Date.parse(observedAt) + 300_000).toISOString(),
    });
    const fieldsSummary = summarizeFolioDepositFields(parsed);
    return {
      status: bound.scopeVerified ? 'ok' : 'unbound',
      scopeVerified: bound.scopeVerified,
      blocker: bound.blocker,
      sourceHash: sha256(body),
      sourceBytes: Buffer.byteLength(body, 'utf8'),
      fields: fieldsSummary.map((item) =>
        bound.scopeVerified ? item : { ...item, value: null, masked: 'unknown' },
      ),
    };
  } finally {
    await session.close();
  }
}

async function main(): Promise<void> {
  if (process.env.HMS_DISCOVERY_ALLOW_LIVE !== '1') throw new Error('LIVE_GUARD_REQUIRED');
  const casePath = process.env.HMS_CONNECTED_CASE_PATH;
  const secretArn = process.env.HMS_READ_SECRET_ARN;
  if (!casePath || !secretArn) throw new Error('CASE_AND_SECRET_REQUIRED');
  const outputPath =
    process.env.HMS_CONNECTED_FOLIO_DIAGNOSTIC_OUT ??
    '.private/stagehand-trial-20260917/connected-folio-source-diagnostic.json';
  const signal = AbortSignal.timeout(120_000);
  let output: Record<string, unknown> = {
    schemaVersion: 'hms-connected-folio-source-diagnostic/v1',
    status: 'error',
  };
  let cleanupError: string | null = null;
  const hdrTrials: unknown[] = [];
  try {
    const connectedCase = connectedCaseSchema.parse(JSON.parse(await readFile(casePath, 'utf8')));
    const selected = selectConnectedLookupCandidate(
      extractLookupCandidates(connectedCase.incoming.body),
    );
    if (!selected) throw new Error('PARENT_NOT_UNIQUE');
    const candidate = candidateOf(selected);
    const secret = await loadSecret(secretArn);
    const origin = new URL(secret.loginUrl).origin;
    process.env.HMS_SINGLE_CONTEXT_LOGIN = '1';
    process.env.HMS_SKIP_GUEST_STAY_NAV = '1';
    const runtime1 = createHmsRuntime({
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
      sourceRevision: 'hms-connected-folio-source-diagnostic-v1',
      playwrightRevision: '1.52.0',
      chromiumRevision: '1169',
    });
    let parent: Awaited<ReturnType<typeof discoverParent>>;
    try {
      await runtime1.start(signal);
      parent = await discoverParent(runtime1, secret, candidate, signal, hdrTrials);
    } finally {
      try {
        await runtime1.close();
      } catch (error) {
        cleanupError = errorCode(error);
      }
    }
    if (cleanupError) throw new Error('FIRST_RUNTIME_CLEANUP_FAILED');
    const runtime2 = createHmsRuntime({
      manifest: buildBoundFolioDiagnosticManifest(
        origin,
        buildBoundFolioReadFields({
          confirmationNumber: parent.proof.confirmationNumber,
          reservationStayId: parent.proof.reservationStayId,
          expectedPropertyCode: connectedCase.propertyCode,
          detailValues: parent.detailValues,
        }),
      ),
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
      sourceRevision: 'hms-connected-folio-source-diagnostic-v1',
      playwrightRevision: '1.52.0',
      chromiumRevision: '1169',
    });
    try {
      await runtime2.start(signal);
      const folio = await runFolioSource(
        runtime2,
        secret,
        parent,
        connectedCase.propertyCode,
        signal,
      );
      output = {
        schemaVersion: 'hms-connected-folio-source-diagnostic/v1',
        status: folio.status,
        caseIdSha256: sha256(connectedCase.caseId),
        candidateKind: candidate.kind,
        candidateValueSha256: sha256(
          candidate.kind === 'surname_dates'
            ? `${candidate.surname}|${candidate.arrivalDate}|${candidate.departureDate}`
            : candidate.value,
        ),
        parentHash: parent.parentHash,
        folio,
      };
    } finally {
      try {
        await runtime2.close();
      } catch (error) {
        cleanupError = errorCode(error);
      }
    }
  } catch (error) {
    output = { ...output, errorCode: cleanupError ?? errorCode(error) };
    process.exitCode = 1;
  }
  if (cleanupError) {
    output = { ...output, status: 'error', errorCode: 'CLEANUP_FAILED' };
    process.exitCode = 1;
  }
  output.hdrTrials = hdrTrials;
  await mkdir(dirname(outputPath), { recursive: true });
  await writeFile(outputPath, JSON.stringify(output, null, 2), { mode: 0o600 });
  console.log(JSON.stringify({ phase: 'done', status: output.status, out: outputPath }));
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href)
  void main().catch(() => {
    process.exitCode = 1;
  });

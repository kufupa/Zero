/**
 * Env parser for @zero/server-pilot.
 *
 * Parses required backend/deploy env plus deferred real-mail env when present.
 * Throws on missing/invalid required values; deferred keys are optional and
 * only validated when provided.
 */

import { z } from 'zod';

export type NodeEnv = 'production' | 'development' | 'test';

/** `fixture` (default) in-memory fake; `wire` TCP to Mailpit; `real` Exchange. */
export type MailTransportMode = 'fixture' | 'wire' | 'real';
export type AiExecutorLane = 'default' | 'hms';
/** Explicit approved processing route; unavailable is the safe default. */
export type AiModelRoute = 'unavailable' | 'approved-local';
/** Process-neutral HMS mode. Literal `enabled` is rejected forever. */
export type HmsDraftEnrichmentMode = 'off' | 'shadow';

const TRANSPORT_MODES: readonly MailTransportMode[] = ['fixture', 'wire', 'real'];
const AI_WORKER_LANES: readonly AiExecutorLane[] = ['default', 'hms'];
const AI_MODEL_ROUTES: readonly AiModelRoute[] = ['unavailable', 'approved-local'];
export type AiTriageModelProfile = 'nova_lite' | 'gpt6_luna_max';
export const AI_TRIAGE_MODEL_PROFILES: readonly AiTriageModelProfile[] = ['nova_lite', 'gpt6_luna_max'];

/** Missing means Azure GPT-6 Luna; `nova_lite` stays selectable. Unknown throws so no silent fallback. */
export function parseAiTriageModelProfile(raw: string | undefined): AiTriageModelProfile {
  const value = raw ?? 'gpt6_luna_max';
  if (!AI_TRIAGE_MODEL_PROFILES.includes(value as AiTriageModelProfile)) {
    throw new Error(
      `env AI_TRIAGE_MODEL_PROFILE must be one of ${AI_TRIAGE_MODEL_PROFILES.join(', ')}, got: ${value}`,
    );
  }
  return value as AiTriageModelProfile;
}
const HMS_DRAFT_ENRICHMENT_MODES: readonly HmsDraftEnrichmentMode[] = ['off', 'shadow'];
const DEFAULT_HMS_HEALTH_PATH = '/tmp/nava-zero-hms-health.json';

/** Process-neutral controls — safe for default worker / http without HMS secrets. */
export type HmsControlConfig = {
  mode: HmsDraftEnrichmentMode;
  healthPath: string;
};

/** HMS-worker runtime requirements — only when shadow lane needs browser/secret. */
export type HmsWorkerRuntimeConfig = {
  secretArn: string;
  chromiumExecutablePath: string;
  roleProofPath: string;
  /** Root-owned active registry v2 path — sole production activation authority. */
  activeRegistryPath: string;
  /** Immutable release JSON directory. */
  releaseRoot: string;
  healthPath: string;
  expectedTenant: string;
  expectedPropertyCode: 'HRCEN';
  expectedTransportId: string;
  runDeadlineMs: number;
  circuitCooldownMs: number;
  /** Evidence HMAC secret ARN — metadata only; never the raw key. */
  evidenceHmacSecretArn: string;
  /** Evidence HMAC key VersionId / version label from Secrets Manager metadata. */
  evidenceHmacKeyVersion: string;
};

/**
 * Child-process-only evidence HMAC key. Never persisted in MailEnv or
 * `.env.production` — injected at exec time via asm-exec.
 */
export type HmsEvidenceHmacChildKey = {
  key: Buffer;
};

export interface MailEnv {
  NODE_ENV: NodeEnv;
  PORT: number;
  DATABASE_URL: string;
  BETTER_AUTH_URL: string;
  BETTER_AUTH_SECRET: string;
  AWS_REGION: string;
  S3_BUCKET: string;
  MAIL_TRANSPORT_MODE: MailTransportMode;
  /** Optional server-only prospective measurement config; parsed by metrics code. */
  MAIL_MEASUREMENT_CONFIG_JSON?: string;
  POP3_POLL_INTERVAL_MS: number;
  POP3_MAX_MESSAGES_PER_CYCLE: number;
  INGEST_FIXTURE_DIR?: string;
  POP3_HOST?: string;
  POP3_PORT?: number;
  POP3_TLS?: boolean;
  POP3_USER?: string;
  POP3_PASSWORD?: string;
  POP3_SECRET_ARN?: string;
  SMTP_HOST?: string;
  SMTP_PORT?: number;
  SMTP_SECURE?: boolean;
  SMTP_USER?: string;
  SMTP_PASSWORD?: string;
  SMTP_SECRET_ARN?: string;
  INGEST_MAX_MESSAGE_BYTES?: number;
  INGEST_MAX_ATTACHMENT_BYTES?: number;
  AI_ENABLED: boolean;
  AI_MODEL_ROUTE: AiModelRoute;
  AI_TRIAGE_MODEL_PROFILE: AiTriageModelProfile;
  AI_WRITE_GATE_ENABLED: boolean;
  AI_DRAFTS_ENABLED: boolean;
  /** Centurion catch-up manual upload (.pst/.zip/.msg) capability gate. */
  CATCHUP_UPLOAD_ENABLED: boolean;
  /** Durable/schema workflow triage capability; independent from frontend nav. */
  WORKFLOW_TRIAGE_V6: boolean;
  INGEST_REQUIRE_OWNER_HEADER: boolean;
  AI_STALE_RUN_TIMEOUT_MS: number;
  AI_WORKER_LANE: AiExecutorLane;
  AI_MODEL_ID?: string;
  BEDROCK_REGION?: string;
  BEDROCK_GUARDRAIL_ID?: string;
  BEDROCK_GUARDRAIL_VERSION?: string;
  MASTRA_STORAGE_PATH?: string;
  HMS_DRAFT_ENRICHMENT_MODE: HmsDraftEnrichmentMode;
  /** Independent model-free HMS read worker gate; defaults off. */
  HMS_READ_SERVICE_ENABLED: boolean;
  /** Pause the hms executor lane: it claims nothing while true. Defaults off. */
  HMS_LANE_PAUSED: boolean;
  /** Confirmation-number prefetch of inbound mail into the hms lane. Defaults off. */
  HMS_PREFETCH_ENABLED: boolean;
  /** Staff quotes prepared from inbound quote extractions. Requires HMS_JOB_QUEUE=on. Defaults off. */
  HMS_QUOTE_PREPARE: boolean;
  /** System-prepared staff quotes enqueued per transport in a rolling hour. */
  HMS_QUOTE_PREPARE_PER_HOUR: number;
  /** New precision-first party search/pick on quote prefetch. Defaults off until live HMS validation. */
  PARTY_MATCH_V2: boolean;
  /** Prefetch runs enqueued per transport in a rolling hour. */
  HMS_PREFETCH_PER_HOUR: number;
  /** Guest-name search prefetches enqueued per transport in a rolling hour. */
  HMS_GUEST_PREFETCH_PER_HOUR: number;
  HMS_RUN_DEADLINE_MS: number;
  HMS_HEALTH_STATUS_PATH: string;
  HMS_CIRCUIT_COOLDOWN_MS: number;
  HMS_READ_SECRET_ARN?: string;
  HMS_CHROMIUM_EXECUTABLE_PATH?: string;
  /** Optional cutoff for the pilot Needs-you view. Unset keeps the full current queue. */
  NEEDS_YOU_SINCE?: string;
}

export type EnvInput = Record<string, string | undefined>;

const needsYouSinceSchema = z.string().datetime({ offset: true });

/** The pilot cutoff, or undefined to keep the existing Needs-you view. */
export function parseNeedsYouSince(raw: string | undefined): Date | undefined {
  if (raw === undefined || raw === '') return undefined;
  const parsed = needsYouSinceSchema.safeParse(raw);
  if (!parsed.success) throw new Error(`env NEEDS_YOU_SINCE must be an ISO timestamp, got: ${raw}`);
  return new Date(parsed.data);
}

const REQUIRED = [
  'PORT',
  'DATABASE_URL',
  'BETTER_AUTH_URL',
  'BETTER_AUTH_SECRET',
  'AWS_REGION',
  'S3_BUCKET',
] as const;

const NODE_ENVS: readonly NodeEnv[] = ['production', 'development', 'test'];

const DEFAULT_AI_MODEL_ID = 'amazon.nova-lite-v1:0';
const DEFAULT_BEDROCK_REGION = 'us-east-1';
const DEFAULT_MASTRA_STORAGE_PATH = './data/mastra';

/**
 * Visible drafting is fail-closed: both the feature switch and the explicitly
 * approved local model route must be present. The route is deliberately kept
 * independent from the general AI worker switch so no hosted fallback can be
 * inferred by a visible compose action.
 */
export function isVisibleDraftAssistanceEnabled(input: EnvInput = process.env): boolean {
  // Existing DB contract fixtures exercise the candidate state seam without
  // loading deployment controls. They do not invoke a model or SMTP; keep
  // that isolated test harness compatible while production remains fail-closed.
  if (
    input.NODE_ENV === 'test' &&
    input.AI_DRAFTS_ENABLED === undefined &&
    input.AI_MODEL_ROUTE === undefined
  ) {
    return true;
  }
  const draftsEnabled = input.AI_DRAFTS_ENABLED === 'true' || input.AI_DRAFTS_ENABLED === '1';
  return draftsEnabled && input.AI_MODEL_ROUTE === 'approved-local';
}

const HOSTED_OBSERVABILITY_PREFIXES = [
  'LANGFUSE_',
  'LANGSMITH_',
  'MASTRA_CLOUD_',
  'MASTRA_PLATFORM_',
] as const;

function assertNoHostedObservabilityEnv(input: EnvInput, aiEnabled: boolean): void {
  if (!aiEnabled) return;

  const forbidden = Object.keys(input).filter((key) =>
    HOSTED_OBSERVABILITY_PREFIXES.some((prefix) => key.startsWith(prefix)),
  );
  if (forbidden.length > 0) {
    throw new Error(
      `hosted observability env keys are not allowed when AI is enabled: ${forbidden.join(', ')}`,
    );
  }
}

function toInt(name: string, raw: string): number {
  const n = Number(raw);
  if (!Number.isFinite(n) || !Number.isInteger(n)) {
    throw new Error(`env ${name} must be integer, got: ${raw}`);
  }
  return n;
}

function toBool(name: string, raw: string, acceptOn = false): boolean {
  if (raw === 'true' || raw === '1' || (acceptOn && raw === 'on')) return true;
  if (raw === 'false' || raw === '0' || (acceptOn && raw === 'off')) return false;
  const acceptedValues = acceptOn ? 'true|false|1|0|on|off' : 'true|false|1|0';
  throw new Error(`env ${name} must be boolean (${acceptedValues}), got: ${raw}`);
}

/**
 * HITL decision ledger writes. Only the exact value `on` enables them; unset, `off`,
 * or anything else keeps the ledger closed, so no row is written.
 */
export function isHitlLedgerEnabled(input: EnvInput = process.env): boolean {
  return input.HITL_LEDGER === 'on';
}

let warnedClassifierOffWithoutExtraction = false;

/**
 * Old inbound folder/label classifier. Default ON. It retires only when INBOUND_TRIAGE_CLASSIFIER is exactly `off` AND
 * INBOUND_EXTRACTION is exactly `on`, because extraction then carries spam, the mail baseline, the pane warmer, the
 * prefetch and the pills. `off` without extraction keeps the classifier on and logs one warning.
 */
/** AI_WRITE_GATE_ENABLED without parsing the full env (admission paths). Same values as parseEnv. */
export function isAiWriteGateEnabled(input: EnvInput = process.env): boolean {
  const raw = input.AI_WRITE_GATE_ENABLED;
  return raw ? toBool('AI_WRITE_GATE_ENABLED', raw) : false;
}

export function isInboundTriageClassifierEnabled(input: EnvInput = process.env): boolean {
  if (input.INBOUND_TRIAGE_CLASSIFIER !== 'off') return true;
  if (input.INBOUND_EXTRACTION === 'on') return false;
  if (!warnedClassifierOffWithoutExtraction) {
    warnedClassifierOffWithoutExtraction = true;
    console.warn(
      JSON.stringify({
        event: 'inbound_triage_classifier_kept_on',
        code: 'INBOUND_EXTRACTION_NOT_ON',
      }),
    );
  }
  return true;
}

/**
 * Vision fallback for scanned voucher PDFs. Only the exact value `on` enables it; unset, `off`, or anything else keeps
 * voucher reads text-only.
 */
export function isScannedPdfVisionEnabled(input: EnvInput = process.env): boolean {
  return input.SCANNED_PDF_VISION === 'on';
}

/**
 * Da Vinci Make quote. Exact `on` routes the five DV staff mailboxes to HRDAV.
 * Unset, `off`, or anything else keeps the Centurion-only refuse. Independent of
 * HMS_DAVINCI_READS and HMS_QUOTE_PREPARE.
 */
export function hmsDavinciMakeQuoteEnabled(input: NodeJS.Dict<string> = process.env): boolean {
  return input.HMS_DAVINCI_MAKE_QUOTE === 'on';
}

/** Check whether catch-up manual mail dump upload is enabled at runtime. */
export function isCatchupUploadEnabled(input: EnvInput = process.env): boolean {
  const val = input.CATCHUP_UPLOAD_ENABLED;
  if (val === undefined || val === '') return false;
  return toBool('CATCHUP_UPLOAD_ENABLED', val);
}

function requireNonEmpty(name: string, raw: string | undefined): string {
  if (raw === undefined || raw.trim() === '') {
    throw new Error(`env ${name} is required`);
  }
  return raw;
}

/** Parse process-neutral HMS controls. Does not require secret/browser values. */
export function parseHmsControlConfig(input: EnvInput): HmsControlConfig {
  const rawHmsMode = input.HMS_DRAFT_ENRICHMENT_MODE ?? 'off';
  if (rawHmsMode === 'enabled') {
    throw new Error(
      'env HMS_DRAFT_ENRICHMENT_MODE=enabled is forbidden (MODE_ENABLED_FORBIDDEN); use off|shadow',
    );
  }
  if (!HMS_DRAFT_ENRICHMENT_MODES.includes(rawHmsMode as HmsDraftEnrichmentMode)) {
    throw new Error(
      `env HMS_DRAFT_ENRICHMENT_MODE must be one of ${HMS_DRAFT_ENRICHMENT_MODES.join(', ')}, got: ${rawHmsMode}`,
    );
  }
  const healthPath = input.HMS_HEALTH_STATUS_PATH?.trim()
    ? input.HMS_HEALTH_STATUS_PATH
    : DEFAULT_HMS_HEALTH_PATH;
  return {
    mode: rawHmsMode as HmsDraftEnrichmentMode,
    healthPath,
  };
}

function requireHmsRuntimeConfig(input: EnvInput): HmsWorkerRuntimeConfig {
  const healthPath = requireNonEmpty('HMS_HEALTH_STATUS_PATH', input.HMS_HEALTH_STATUS_PATH);
  const expectedPropertyCode = requireNonEmpty(
    'HMS_EXPECTED_PROPERTY_CODE',
    input.HMS_EXPECTED_PROPERTY_CODE,
  );
  if (expectedPropertyCode !== 'HRCEN') {
    throw new Error(`env HMS_EXPECTED_PROPERTY_CODE must be HRCEN, got: ${expectedPropertyCode}`);
  }
  return {
    secretArn: requireNonEmpty('HMS_READ_SECRET_ARN', input.HMS_READ_SECRET_ARN),
    chromiumExecutablePath: requireNonEmpty(
      'HMS_CHROMIUM_EXECUTABLE_PATH',
      input.HMS_CHROMIUM_EXECUTABLE_PATH,
    ),
    roleProofPath: requireNonEmpty('HMS_READ_ROLE_PROOF_PATH', input.HMS_READ_ROLE_PROOF_PATH),
    activeRegistryPath:
      input.HMS_ACTIVE_REGISTRY_PATH?.trim() || '/opt/nava/shared/hms-active-registry/active.json',
    releaseRoot: input.HMS_RELEASE_ROOT?.trim() || '/opt/nava/shared/hms-releases',
    healthPath,
    expectedTenant: requireNonEmpty('HMS_EXPECTED_TENANT', input.HMS_EXPECTED_TENANT),
    expectedPropertyCode: 'HRCEN',
    expectedTransportId: requireNonEmpty(
      'HMS_EXPECTED_TRANSPORT_ID',
      input.HMS_EXPECTED_TRANSPORT_ID,
    ),
    runDeadlineMs: input.HMS_RUN_DEADLINE_MS
      ? toInt('HMS_RUN_DEADLINE_MS', input.HMS_RUN_DEADLINE_MS)
      : 150_000,
    circuitCooldownMs: input.HMS_CIRCUIT_COOLDOWN_MS
      ? toInt('HMS_CIRCUIT_COOLDOWN_MS', input.HMS_CIRCUIT_COOLDOWN_MS)
      : 30_000,
    evidenceHmacSecretArn: requireNonEmpty(
      'HMS_EVIDENCE_HMAC_SECRET_ARN',
      input.HMS_EVIDENCE_HMAC_SECRET_ARN,
    ),
    evidenceHmacKeyVersion: requireNonEmpty(
      'HMS_EVIDENCE_HMAC_KEY_VERSION',
      input.HMS_EVIDENCE_HMAC_KEY_VERSION,
    ),
  };
}

/**
 * Require full HMS worker runtime config for shadow. Call from hms-ai-worker
 * startup only — default worker must not invoke this.
 */
export function requireHmsWorkerRuntimeConfig(input: EnvInput): HmsWorkerRuntimeConfig {
  const control = parseHmsControlConfig(input);
  if (control.mode !== 'shadow') {
    throw new Error(
      `requireHmsWorkerRuntimeConfig requires HMS_DRAFT_ENRICHMENT_MODE=shadow, got: ${control.mode}`,
    );
  }
  return requireHmsRuntimeConfig(input);
}

/**
 * Require the browser/secret configuration for the independent model-free
 * read lane.  Read service enablement is intentionally orthogonal to draft
 * enrichment, so `HMS_DRAFT_ENRICHMENT_MODE=off` is valid here.
 */
export function requireHmsReadRuntimeConfig(input: EnvInput): HmsWorkerRuntimeConfig {
  return requireHmsRuntimeConfig(input);
}

/**
 * Read child-only evidence HMAC key. Call from HMS worker child after asm-exec;
 * never assign into MailEnv or write to disk env files.
 */
export function requireHmsEvidenceHmacChildKey(input: EnvInput): HmsEvidenceHmacChildKey {
  const raw = requireNonEmpty('HMS_EVIDENCE_HMAC_KEY', input.HMS_EVIDENCE_HMAC_KEY);
  const key = Buffer.from(raw, 'base64');
  if (key.byteLength < 32) {
    throw new Error('env HMS_EVIDENCE_HMAC_KEY must be base64 for at least 32 bytes');
  }
  return { key };
}

export function parseEnv(input: EnvInput): MailEnv {
  const missing = REQUIRED.filter((k) => input[k] === undefined || input[k] === '');
  if (missing.length > 0) {
    throw new Error(`env missing required: ${missing.join(', ')}`);
  }

  const rawNodeEnv = input.NODE_ENV ?? 'development';
  if (!NODE_ENVS.includes(rawNodeEnv as NodeEnv)) {
    throw new Error(`env NODE_ENV must be one of ${NODE_ENVS.join(', ')}, got: ${rawNodeEnv}`);
  }

  const rawTransportMode = input.MAIL_TRANSPORT_MODE ?? 'fixture';
  if (!TRANSPORT_MODES.includes(rawTransportMode as MailTransportMode)) {
    throw new Error(
      `env MAIL_TRANSPORT_MODE must be one of ${TRANSPORT_MODES.join(', ')}, got: ${rawTransportMode}`,
    );
  }

  const env: MailEnv = {
    NODE_ENV: rawNodeEnv as NodeEnv,
    PORT: toInt('PORT', input.PORT as string),
    DATABASE_URL: input.DATABASE_URL as string,
    BETTER_AUTH_URL: input.BETTER_AUTH_URL as string,
    BETTER_AUTH_SECRET: input.BETTER_AUTH_SECRET as string,
    AWS_REGION: input.AWS_REGION as string,
    S3_BUCKET: input.S3_BUCKET as string,
    MAIL_TRANSPORT_MODE: rawTransportMode as MailTransportMode,
    POP3_POLL_INTERVAL_MS: toInt('POP3_POLL_INTERVAL_MS', input.POP3_POLL_INTERVAL_MS ?? '30000'),
    POP3_MAX_MESSAGES_PER_CYCLE: toInt(
      'POP3_MAX_MESSAGES_PER_CYCLE',
      input.POP3_MAX_MESSAGES_PER_CYCLE ?? '500',
    ),
    AI_ENABLED: false,
    AI_MODEL_ROUTE: 'unavailable',
    AI_TRIAGE_MODEL_PROFILE: 'gpt6_luna_max',
    AI_WRITE_GATE_ENABLED: false,
    AI_DRAFTS_ENABLED: false,
    CATCHUP_UPLOAD_ENABLED: isCatchupUploadEnabled(input),
    WORKFLOW_TRIAGE_V6: false,
    INGEST_REQUIRE_OWNER_HEADER: true,
    AI_STALE_RUN_TIMEOUT_MS: 15 * 60_000,
    AI_WORKER_LANE: 'default',
    HMS_DRAFT_ENRICHMENT_MODE: 'off',
    HMS_READ_SERVICE_ENABLED: false,
    HMS_LANE_PAUSED: false,
    HMS_PREFETCH_ENABLED: false,
    HMS_QUOTE_PREPARE: false,
    HMS_QUOTE_PREPARE_PER_HOUR: 6,
    PARTY_MATCH_V2: false,
    HMS_PREFETCH_PER_HOUR: 30,
    HMS_GUEST_PREFETCH_PER_HOUR: 12,
    HMS_RUN_DEADLINE_MS: 150_000,
    HMS_HEALTH_STATUS_PATH: '/tmp/nava-zero-hms-health.json',
    HMS_CIRCUIT_COOLDOWN_MS: 30_000,
  };

  const needsYouSince = input.NEEDS_YOU_SINCE;
  if (needsYouSince !== undefined && needsYouSince !== '') {
    parseNeedsYouSince(needsYouSince);
    env.NEEDS_YOU_SINCE = needsYouSince;
  }

  if (input.MAIL_MEASUREMENT_CONFIG_JSON !== undefined) {
    // Keep this raw and optional here: malformed measurement config must not
    // prevent ordinary mail startup. Dependent metrics parse it fail-closed.
    env.MAIL_MEASUREMENT_CONFIG_JSON = input.MAIL_MEASUREMENT_CONFIG_JSON;
  }

  if (input.INGEST_FIXTURE_DIR) env.INGEST_FIXTURE_DIR = input.INGEST_FIXTURE_DIR;
  if (input.POP3_HOST) env.POP3_HOST = input.POP3_HOST;
  if (input.POP3_PORT) env.POP3_PORT = toInt('POP3_PORT', input.POP3_PORT);
  if (input.POP3_TLS) env.POP3_TLS = toBool('POP3_TLS', input.POP3_TLS);
  if (input.POP3_USER) env.POP3_USER = input.POP3_USER;
  if (input.POP3_PASSWORD) env.POP3_PASSWORD = input.POP3_PASSWORD;
  if (input.POP3_SECRET_ARN) env.POP3_SECRET_ARN = input.POP3_SECRET_ARN;
  if (input.SMTP_HOST) env.SMTP_HOST = input.SMTP_HOST;
  if (input.SMTP_PORT) env.SMTP_PORT = toInt('SMTP_PORT', input.SMTP_PORT);
  if (input.SMTP_SECURE) env.SMTP_SECURE = toBool('SMTP_SECURE', input.SMTP_SECURE);
  if (input.SMTP_USER) env.SMTP_USER = input.SMTP_USER;
  if (input.SMTP_PASSWORD) env.SMTP_PASSWORD = input.SMTP_PASSWORD;
  if (input.SMTP_SECRET_ARN) env.SMTP_SECRET_ARN = input.SMTP_SECRET_ARN;
  if (input.INGEST_MAX_MESSAGE_BYTES) {
    env.INGEST_MAX_MESSAGE_BYTES = toInt(
      'INGEST_MAX_MESSAGE_BYTES',
      input.INGEST_MAX_MESSAGE_BYTES,
    );
  }
  if (input.INGEST_MAX_ATTACHMENT_BYTES) {
    env.INGEST_MAX_ATTACHMENT_BYTES = toInt(
      'INGEST_MAX_ATTACHMENT_BYTES',
      input.INGEST_MAX_ATTACHMENT_BYTES,
    );
  }

  const aiEnabled = input.AI_ENABLED === 'true' || input.AI_ENABLED === '1';
  assertNoHostedObservabilityEnv(input, aiEnabled);
  env.AI_ENABLED = aiEnabled;

  const rawModelRoute = input.AI_MODEL_ROUTE ?? 'unavailable';
  if (!AI_MODEL_ROUTES.includes(rawModelRoute as AiModelRoute)) {
    throw new Error(
      `env AI_MODEL_ROUTE must be one of ${AI_MODEL_ROUTES.join(', ')}, got: ${rawModelRoute}`,
    );
  }
  env.AI_MODEL_ROUTE = rawModelRoute as AiModelRoute;
  env.AI_TRIAGE_MODEL_PROFILE = parseAiTriageModelProfile(input.AI_TRIAGE_MODEL_PROFILE);

  env.AI_WRITE_GATE_ENABLED = input.AI_WRITE_GATE_ENABLED
    ? toBool('AI_WRITE_GATE_ENABLED', input.AI_WRITE_GATE_ENABLED)
    : false;
  env.AI_DRAFTS_ENABLED = input.AI_DRAFTS_ENABLED
    ? toBool('AI_DRAFTS_ENABLED', input.AI_DRAFTS_ENABLED)
    : false;
  env.WORKFLOW_TRIAGE_V6 =
    input.WORKFLOW_TRIAGE_V6 === undefined
      ? false
      : toBool('WORKFLOW_TRIAGE_V6', input.WORKFLOW_TRIAGE_V6);
  env.INGEST_REQUIRE_OWNER_HEADER = input.INGEST_REQUIRE_OWNER_HEADER
    ? toBool('INGEST_REQUIRE_OWNER_HEADER', input.INGEST_REQUIRE_OWNER_HEADER)
    : true;
  env.AI_STALE_RUN_TIMEOUT_MS = input.AI_STALE_RUN_TIMEOUT_MS
    ? toInt('AI_STALE_RUN_TIMEOUT_MS', input.AI_STALE_RUN_TIMEOUT_MS)
    : 15 * 60_000;

  const rawLane = input.AI_WORKER_LANE ?? 'default';
  if (!AI_WORKER_LANES.includes(rawLane as AiExecutorLane)) {
    throw new Error(
      `env AI_WORKER_LANE must be one of ${AI_WORKER_LANES.join(', ')}, got: ${rawLane}`,
    );
  }
  env.AI_WORKER_LANE = rawLane as AiExecutorLane;

  // Process-neutral HMS controls — secret/browser required only via
  // requireHmsWorkerRuntimeConfig() on the HMS worker path.
  const hmsControl = parseHmsControlConfig(input);
  env.HMS_DRAFT_ENRICHMENT_MODE = hmsControl.mode;
  env.HMS_READ_SERVICE_ENABLED = input.HMS_READ_SERVICE_ENABLED
    ? toBool('HMS_READ_SERVICE_ENABLED', input.HMS_READ_SERVICE_ENABLED)
    : false;
  env.HMS_LANE_PAUSED = input.HMS_LANE_PAUSED
    ? toBool('HMS_LANE_PAUSED', input.HMS_LANE_PAUSED)
    : false;
  env.HMS_PREFETCH_ENABLED = input.HMS_PREFETCH_ENABLED
    ? toBool('HMS_PREFETCH_ENABLED', input.HMS_PREFETCH_ENABLED)
    : false;
  env.HMS_QUOTE_PREPARE = input.HMS_QUOTE_PREPARE
    ? toBool('HMS_QUOTE_PREPARE', input.HMS_QUOTE_PREPARE, true)
    : false;
  env.HMS_QUOTE_PREPARE_PER_HOUR = input.HMS_QUOTE_PREPARE_PER_HOUR
    ? toInt('HMS_QUOTE_PREPARE_PER_HOUR', input.HMS_QUOTE_PREPARE_PER_HOUR)
    : 6;
  env.PARTY_MATCH_V2 = input.PARTY_MATCH_V2 ? toBool('PARTY_MATCH_V2', input.PARTY_MATCH_V2) : false;
  env.HMS_PREFETCH_PER_HOUR = input.HMS_PREFETCH_PER_HOUR
    ? toInt('HMS_PREFETCH_PER_HOUR', input.HMS_PREFETCH_PER_HOUR)
    : 30;
  env.HMS_GUEST_PREFETCH_PER_HOUR = input.HMS_GUEST_PREFETCH_PER_HOUR
    ? toInt('HMS_GUEST_PREFETCH_PER_HOUR', input.HMS_GUEST_PREFETCH_PER_HOUR)
    : 12;
  env.HMS_HEALTH_STATUS_PATH = hmsControl.healthPath;
  env.HMS_RUN_DEADLINE_MS = input.HMS_RUN_DEADLINE_MS
    ? toInt('HMS_RUN_DEADLINE_MS', input.HMS_RUN_DEADLINE_MS)
    : 150_000;
  env.HMS_CIRCUIT_COOLDOWN_MS = input.HMS_CIRCUIT_COOLDOWN_MS
    ? toInt('HMS_CIRCUIT_COOLDOWN_MS', input.HMS_CIRCUIT_COOLDOWN_MS)
    : 30_000;

  if (input.HMS_READ_SECRET_ARN) env.HMS_READ_SECRET_ARN = input.HMS_READ_SECRET_ARN;
  if (input.HMS_CHROMIUM_EXECUTABLE_PATH) {
    env.HMS_CHROMIUM_EXECUTABLE_PATH = input.HMS_CHROMIUM_EXECUTABLE_PATH;
  }
  // Never persist HMS_EVIDENCE_HMAC_KEY into MailEnv — child-only via asm-exec.

  if (aiEnabled) {
    env.AI_MODEL_ID = input.AI_MODEL_ID ?? DEFAULT_AI_MODEL_ID;
    env.BEDROCK_REGION = input.BEDROCK_REGION ?? DEFAULT_BEDROCK_REGION;
    env.MASTRA_STORAGE_PATH = input.MASTRA_STORAGE_PATH ?? DEFAULT_MASTRA_STORAGE_PATH;
    if (input.BEDROCK_GUARDRAIL_ID) env.BEDROCK_GUARDRAIL_ID = input.BEDROCK_GUARDRAIL_ID;
    if (input.BEDROCK_GUARDRAIL_VERSION) {
      env.BEDROCK_GUARDRAIL_VERSION = input.BEDROCK_GUARDRAIL_VERSION;
    }
  }

  return env;
}

/** Runtime check for ingest routing strictness (default strict). */
export function ingestRequireOwnerHeader(input: EnvInput = process.env as EnvInput): boolean {
  if (!input.INGEST_REQUIRE_OWNER_HEADER) return true;
  return toBool('INGEST_REQUIRE_OWNER_HEADER', input.INGEST_REQUIRE_OWNER_HEADER);
}

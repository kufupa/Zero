/**
 * Env parser for @zero/server-pilot.
 *
 * Parses required backend/deploy env plus deferred real-mail env when present.
 * Throws on missing/invalid required values; deferred keys are optional and
 * only validated when provided.
 */

export type NodeEnv = 'production' | 'development' | 'test';

/** `fixture` (default) in-memory fake; `wire` TCP to Mailpit; `real` Exchange. */
export type MailTransportMode = 'fixture' | 'wire' | 'real';

const TRANSPORT_MODES: readonly MailTransportMode[] = ['fixture', 'wire', 'real'];

export interface MailEnv {
  NODE_ENV: NodeEnv;
  PORT: number;
  DATABASE_URL: string;
  BETTER_AUTH_URL: string;
  BETTER_AUTH_SECRET: string;
  AWS_REGION: string;
  S3_BUCKET: string;
  MAIL_TRANSPORT_MODE: MailTransportMode;
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
  AI_WRITE_GATE_ENABLED: boolean;
  AI_DRAFTS_ENABLED: boolean;
  AI_STALE_RUN_TIMEOUT_MS: number;
  AI_MODEL_ID?: string;
  BEDROCK_REGION?: string;
  BEDROCK_GUARDRAIL_ID?: string;
  BEDROCK_GUARDRAIL_VERSION?: string;
  MASTRA_STORAGE_PATH?: string;
}

export type EnvInput = Record<string, string | undefined>;

const REQUIRED = [
  'PORT',
  'DATABASE_URL',
  'BETTER_AUTH_URL',
  'BETTER_AUTH_SECRET',
  'AWS_REGION',
  'S3_BUCKET',
  'POP3_POLL_INTERVAL_MS',
  'POP3_MAX_MESSAGES_PER_CYCLE',
] as const;

const NODE_ENVS: readonly NodeEnv[] = ['production', 'development', 'test'];

const DEFAULT_AI_MODEL_ID = 'amazon.nova-lite-v1:0';
const DEFAULT_BEDROCK_REGION = 'us-east-1';
const DEFAULT_MASTRA_STORAGE_PATH = './data/mastra';

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

function toBool(name: string, raw: string): boolean {
  if (raw === 'true' || raw === '1') return true;
  if (raw === 'false' || raw === '0') return false;
  throw new Error(`env ${name} must be boolean (true|false|1|0), got: ${raw}`);
}

export function parseEnv(input: EnvInput): MailEnv {
  const missing = REQUIRED.filter((k) => input[k] === undefined || input[k] === '');
  if (missing.length > 0) {
    throw new Error(`env missing required: ${missing.join(', ')}`);
  }

  const rawNodeEnv = input.NODE_ENV ?? 'development';
  if (!NODE_ENVS.includes(rawNodeEnv as NodeEnv)) {
    throw new Error(
      `env NODE_ENV must be one of ${NODE_ENVS.join(', ')}, got: ${rawNodeEnv}`,
    );
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
    POP3_POLL_INTERVAL_MS: toInt(
      'POP3_POLL_INTERVAL_MS',
      input.POP3_POLL_INTERVAL_MS as string,
    ),
    POP3_MAX_MESSAGES_PER_CYCLE: toInt(
      'POP3_MAX_MESSAGES_PER_CYCLE',
      input.POP3_MAX_MESSAGES_PER_CYCLE as string,
    ),
    AI_ENABLED: false,
    AI_WRITE_GATE_ENABLED: false,
    AI_DRAFTS_ENABLED: false,
    AI_STALE_RUN_TIMEOUT_MS: 15 * 60_000,
  };

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

  env.AI_WRITE_GATE_ENABLED = input.AI_WRITE_GATE_ENABLED
    ? toBool('AI_WRITE_GATE_ENABLED', input.AI_WRITE_GATE_ENABLED)
    : false;
  env.AI_DRAFTS_ENABLED = input.AI_DRAFTS_ENABLED
    ? toBool('AI_DRAFTS_ENABLED', input.AI_DRAFTS_ENABLED)
    : false;
  env.AI_STALE_RUN_TIMEOUT_MS = input.AI_STALE_RUN_TIMEOUT_MS
    ? toInt('AI_STALE_RUN_TIMEOUT_MS', input.AI_STALE_RUN_TIMEOUT_MS)
    : 15 * 60_000;

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

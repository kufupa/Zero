import {
  parseAiTriageModelProfile,
  parseEnv,
  parseHmsControlConfig,
  requireHmsEvidenceHmacChildKey,
  requireHmsWorkerRuntimeConfig,
} from '../src/env';
import { describe, expect, it } from 'vitest';

function baseEnv(overrides: Record<string, string | undefined> = {}) {
  return {
    NODE_ENV: 'production',
    PORT: '8788',
    DATABASE_URL: 'postgres://zero:secret@host:5432/zero',
    BETTER_AUTH_URL: 'https://nava.legacy.local',
    BETTER_AUTH_SECRET: 'x'.repeat(32),
    AWS_REGION: 'af-south-1',
    S3_BUCKET: 'nava-mail-artifacts-test',
    POP3_POLL_INTERVAL_MS: '30000',
    POP3_MAX_MESSAGES_PER_CYCLE: '500',
    ...overrides,
  };
}

function hmsShadowRuntimeEnv(
  overrides: Record<string, string | undefined> = {},
): Record<string, string | undefined> {
  return {
    HMS_DRAFT_ENRICHMENT_MODE: 'shadow',
    HMS_READ_SECRET_ARN: 'arn:aws:secretsmanager:af-south-1:123:secret:hms-read',
    HMS_CHROMIUM_EXECUTABLE_PATH: '/opt/nava/chromium/chrome',
    HMS_READ_ROLE_PROOF_PATH: '/opt/nava/shared/hms-read-role-proof.v1.json',
    HMS_HEALTH_STATUS_PATH: '/tmp/nava-zero-hms-health.json',
    HMS_EXPECTED_TENANT: 'HMS_LEGACY',
    HMS_EXPECTED_PROPERTY_CODE: 'HRCEN',
    HMS_EXPECTED_TRANSPORT_ID: 'transport-centurion',
    HMS_RUN_DEADLINE_MS: '150000',
    HMS_CIRCUIT_COOLDOWN_MS: '30000',
    HMS_EVIDENCE_HMAC_SECRET_ARN: 'arn:aws:secretsmanager:af-south-1:123:secret:hms-evidence-hmac',
    HMS_EVIDENCE_HMAC_KEY_VERSION: 'evidence-key-v1',
    ...overrides,
  };
}

describe('env', () => {
  it('parses production AWS mail env', () => {
    const env = parseEnv({
      NODE_ENV: 'production',
      PORT: '8788',
      DATABASE_URL: 'postgres://zero:secret@example.rds.amazonaws.com:5432/zero',
      BETTER_AUTH_URL: 'https://nava.legacy.local',
      BETTER_AUTH_SECRET: 'x'.repeat(32),
      AWS_REGION: 'af-south-1',
      S3_BUCKET: 'nava-mail-artifacts-test',
      POP3_MAX_MESSAGES_PER_CYCLE: '500',
      POP3_POLL_INTERVAL_MS: '30000',
      SMTP_PORT: '587',
    });

    expect(env.AWS_REGION).toBe('af-south-1');
    expect(env.POP3_MAX_MESSAGES_PER_CYCLE).toBe(500);
    expect(env.CATCHUP_UPLOAD_ENABLED).toBe(false);
    expect(env.NEEDS_YOU_SINCE).toBeUndefined();
  });

  it('parses an optional ISO Needs-you cutoff and rejects invalid timestamps', () => {
    expect(parseEnv(baseEnv({ NEEDS_YOU_SINCE: '2026-10-08T00:00:00.000Z' })).NEEDS_YOU_SINCE).toBe(
      '2026-10-08T00:00:00.000Z',
    );
    expect(() => parseEnv(baseEnv({ NEEDS_YOU_SINCE: '2026-10-08' }))).toThrow(/NEEDS_YOU_SINCE/);
  });

  it('keeps optional measurement config server-only and does not reject ordinary mail on malformed JSON', () => {
    const rawConfig = JSON.stringify({
      version: 1,
      transportId: 'transport-centurion',
      cohortId: 'centurion',
      measurementStartAt: null,
      captureAssumptionBasis: 'operator-confirmed',
      confirmedGapIntervals: [],
    });

    expect(parseEnv(baseEnv({ MAIL_MEASUREMENT_CONFIG_JSON: rawConfig }))).toMatchObject({
      MAIL_MEASUREMENT_CONFIG_JSON: rawConfig,
    });
    expect(parseEnv(baseEnv({ MAIL_MEASUREMENT_CONFIG_JSON: '{not-json' }))).toMatchObject({
      MAIL_MEASUREMENT_CONFIG_JSON: '{not-json',
    });
  });

  it('parses CATCHUP_UPLOAD_ENABLED correctly', () => {
    expect(parseEnv(baseEnv({ CATCHUP_UPLOAD_ENABLED: 'true' })).CATCHUP_UPLOAD_ENABLED).toBe(true);
    expect(parseEnv(baseEnv({ CATCHUP_UPLOAD_ENABLED: '1' })).CATCHUP_UPLOAD_ENABLED).toBe(true);
    expect(parseEnv(baseEnv({ CATCHUP_UPLOAD_ENABLED: 'false' })).CATCHUP_UPLOAD_ENABLED).toBe(
      false,
    );
    expect(parseEnv(baseEnv({ CATCHUP_UPLOAD_ENABLED: '0' })).CATCHUP_UPLOAD_ENABLED).toBe(false);
    expect(() => parseEnv(baseEnv({ CATCHUP_UPLOAD_ENABLED: 'invalid' }))).toThrow(
      /CATCHUP_UPLOAD_ENABLED/,
    );
  });

  it('throws on missing required keys', () => {
    expect(() =>
      parseEnv({
        PORT: '8788',
        DATABASE_URL: 'postgres://zero:secret@host:5432/zero',
        BETTER_AUTH_URL: 'https://nava.legacy.local',
        BETTER_AUTH_SECRET: 'x'.repeat(32),
        AWS_REGION: 'af-south-1',
      }),
    ).toThrow(/S3_BUCKET/);
  });

  it('parses deferred SMTP/POP3 fields when present', () => {
    const env = parseEnv({
      NODE_ENV: 'production',
      PORT: '8788',
      DATABASE_URL: 'postgres://zero:secret@host:5432/zero',
      BETTER_AUTH_URL: 'https://nava.legacy.local',
      BETTER_AUTH_SECRET: 'x'.repeat(32),
      AWS_REGION: 'af-south-1',
      S3_BUCKET: 'nava-mail-artifacts-test',
      POP3_POLL_INTERVAL_MS: '30000',
      POP3_MAX_MESSAGES_PER_CYCLE: '500',
      POP3_HOST: 'pop.example.local',
      POP3_PORT: '995',
      POP3_TLS: 'true',
      SMTP_HOST: 'smtp.example.local',
      SMTP_PORT: '465',
      SMTP_SECURE: 'true',
    });

    expect(env.POP3_HOST).toBe('pop.example.local');
    expect(env.POP3_PORT).toBe(995);
    expect(env.POP3_TLS).toBe(true);
    expect(env.SMTP_SECURE).toBe(true);
  });

  it('parses optional ingest size limit env', () => {
    const env = parseEnv({
      NODE_ENV: 'production',
      PORT: '8788',
      DATABASE_URL: 'postgres://zero:secret@host:5432/zero',
      BETTER_AUTH_URL: 'https://nava.legacy.local',
      BETTER_AUTH_SECRET: 'x'.repeat(32),
      AWS_REGION: 'af-south-1',
      S3_BUCKET: 'nava-mail-artifacts-test',
      POP3_POLL_INTERVAL_MS: '30000',
      POP3_MAX_MESSAGES_PER_CYCLE: '500',
      INGEST_MAX_MESSAGE_BYTES: '26214400',
      INGEST_MAX_ATTACHMENT_BYTES: '15728640',
    });

    expect(env.INGEST_MAX_MESSAGE_BYTES).toBe(26214400);
    expect(env.INGEST_MAX_ATTACHMENT_BYTES).toBe(15728640);
  });

  it('rejects non-integer numeric env', () => {
    expect(() =>
      parseEnv({
        NODE_ENV: 'production',
        PORT: 'not-a-port',
        DATABASE_URL: 'postgres://zero:secret@host:5432/zero',
        BETTER_AUTH_URL: 'https://nava.legacy.local',
        BETTER_AUTH_SECRET: 'x'.repeat(32),
        AWS_REGION: 'af-south-1',
        S3_BUCKET: 'nava-mail-artifacts-test',
        POP3_POLL_INTERVAL_MS: '30000',
        POP3_MAX_MESSAGES_PER_CYCLE: '500',
      }),
    ).toThrow(/PORT/);
  });

  it('defaults AI write and draft gates to false', () => {
    expect(parseEnv(baseEnv()).AI_WRITE_GATE_ENABLED).toBe(false);
    expect(parseEnv(baseEnv()).AI_DRAFTS_ENABLED).toBe(false);
    expect(parseEnv(baseEnv()).AI_STALE_RUN_TIMEOUT_MS).toBe(15 * 60_000);
    expect(parseEnv(baseEnv()).AI_MODEL_ROUTE).toBe('unavailable');
  });

  it('defaults AI_TRIAGE_MODEL_PROFILE to gpt6_luna_max and keeps nova_lite selectable', () => {
    expect(parseAiTriageModelProfile(undefined)).toBe('gpt6_luna_max');
    expect(parseEnv(baseEnv()).AI_TRIAGE_MODEL_PROFILE).toBe('gpt6_luna_max');
    expect(parseEnv(baseEnv({ AI_TRIAGE_MODEL_PROFILE: 'nova_lite' })).AI_TRIAGE_MODEL_PROFILE).toBe(
      'nova_lite',
    );
  });

  it('keeps quote preparation off by default and parses its independent hourly cap', () => {
    expect(parseEnv(baseEnv())).toMatchObject({
      HMS_QUOTE_PREPARE: false,
      HMS_QUOTE_PREPARE_PER_HOUR: 6,
    });
    expect(
      parseEnv(baseEnv({ HMS_QUOTE_PREPARE: '1', HMS_QUOTE_PREPARE_PER_HOUR: '9' })),
    ).toMatchObject({ HMS_QUOTE_PREPARE: true, HMS_QUOTE_PREPARE_PER_HOUR: 9 });
  });

  it.each(['true', '1', 'on'])('parses HMS_QUOTE_PREPARE=%s as enabled', (value) => {
    expect(parseEnv(baseEnv({ HMS_QUOTE_PREPARE: value })).HMS_QUOTE_PREPARE).toBe(true);
  });

  it.each(['false', '0', 'off'])('parses HMS_QUOTE_PREPARE=%s as disabled', (value) => {
    expect(parseEnv(baseEnv({ HMS_QUOTE_PREPARE: value })).HMS_QUOTE_PREPARE).toBe(false);
  });

  it('accepts only the explicit approved-local model route marker', () => {
    expect(parseEnv(baseEnv({ AI_MODEL_ROUTE: 'approved-local' })).AI_MODEL_ROUTE).toBe(
      'approved-local',
    );
    expect(() => parseEnv(baseEnv({ AI_MODEL_ROUTE: 'bedrock' }))).toThrow(/AI_MODEL_ROUTE/);
  });

  it('defaults durable workflow triage off', () => {
    expect(parseEnv(baseEnv()).WORKFLOW_TRIAGE_V6).toBe(false);
  });

  it('keeps PARTY_MATCH_V2 off by default and parses its explicit boolean gate', () => {
    expect(parseEnv(baseEnv()).PARTY_MATCH_V2).toBe(false);
    expect(parseEnv(baseEnv({ PARTY_MATCH_V2: 'true' })).PARTY_MATCH_V2).toBe(true);
    expect(parseEnv(baseEnv({ PARTY_MATCH_V2: '0' })).PARTY_MATCH_V2).toBe(false);
    expect(() => parseEnv(baseEnv({ PARTY_MATCH_V2: 'on' }))).toThrow(/PARTY_MATCH_V2/);
  });

  it.each(['1', 'true', '0', 'false'])('parses durable workflow triage value %s', (value) => {
    expect(parseEnv(baseEnv({ WORKFLOW_TRIAGE_V6: value })).WORKFLOW_TRIAGE_V6).toBe(
      value === '1' || value === 'true',
    );
  });

  it.each(['yes', 'on', ''])('rejects invalid durable workflow triage value %s', (value) => {
    expect(() => parseEnv(baseEnv({ WORKFLOW_TRIAGE_V6: value }))).toThrow(/WORKFLOW_TRIAGE_V6/);
  });

  it('parses AI write and draft gates when enabled', () => {
    expect(
      parseEnv({ ...baseEnv(), AI_WRITE_GATE_ENABLED: '1', AI_DRAFTS_ENABLED: 'true' }),
    ).toMatchObject({
      AI_WRITE_GATE_ENABLED: true,
      AI_DRAFTS_ENABLED: true,
    });
  });

  it('rejects invalid AI_WRITE_GATE_ENABLED values', () => {
    expect(() => parseEnv({ ...baseEnv(), AI_WRITE_GATE_ENABLED: 'yes' })).toThrow(
      /AI_WRITE_GATE_ENABLED/,
    );
  });

  it('defaults INGEST_REQUIRE_OWNER_HEADER to true', () => {
    expect(parseEnv(baseEnv()).INGEST_REQUIRE_OWNER_HEADER).toBe(true);
  });

  it('parses INGEST_REQUIRE_OWNER_HEADER when relaxed', () => {
    expect(parseEnv({ ...baseEnv(), INGEST_REQUIRE_OWNER_HEADER: 'false' })).toMatchObject({
      INGEST_REQUIRE_OWNER_HEADER: false,
    });
    expect(parseEnv({ ...baseEnv(), INGEST_REQUIRE_OWNER_HEADER: '0' })).toMatchObject({
      INGEST_REQUIRE_OWNER_HEADER: false,
    });
  });

  it('rejects invalid INGEST_REQUIRE_OWNER_HEADER values', () => {
    expect(() => parseEnv({ ...baseEnv(), INGEST_REQUIRE_OWNER_HEADER: 'maybe' })).toThrow(
      /INGEST_REQUIRE_OWNER_HEADER/,
    );
  });

  it('disables AI by default when AI_ENABLED is absent', () => {
    const env = parseEnv({
      NODE_ENV: 'production',
      PORT: '8788',
      DATABASE_URL: 'postgres://zero:secret@host:5432/zero',
      BETTER_AUTH_URL: 'https://nava.legacy.local',
      BETTER_AUTH_SECRET: 'x'.repeat(32),
      AWS_REGION: 'af-south-1',
      S3_BUCKET: 'nava-mail-artifacts-test',
      POP3_POLL_INTERVAL_MS: '30000',
      POP3_MAX_MESSAGES_PER_CYCLE: '500',
    });

    expect(env.AI_ENABLED).toBe(false);
  });

  it('enables AI with default model when AI_ENABLED=true', () => {
    const env = parseEnv({
      NODE_ENV: 'production',
      PORT: '8788',
      DATABASE_URL: 'postgres://zero:secret@host:5432/zero',
      BETTER_AUTH_URL: 'https://nava.legacy.local',
      BETTER_AUTH_SECRET: 'x'.repeat(32),
      AWS_REGION: 'af-south-1',
      S3_BUCKET: 'nava-mail-artifacts-test',
      POP3_POLL_INTERVAL_MS: '30000',
      POP3_MAX_MESSAGES_PER_CYCLE: '500',
      AI_ENABLED: 'true',
      AI_MODEL_ID: 'amazon.nova-lite-v1:0',
    });

    expect(env.AI_ENABLED).toBe(true);
    expect(env.AI_MODEL_ID).toBe('amazon.nova-lite-v1:0');
    expect(env.BEDROCK_REGION).toBe('us-east-1');
    expect(env.MASTRA_STORAGE_PATH).toBeDefined();
  });

  it('defaults BEDROCK_REGION to us-east-1 when AI enabled and region omitted', () => {
    const env = parseEnv({
      NODE_ENV: 'production',
      PORT: '8788',
      DATABASE_URL: 'postgres://zero:secret@host:5432/zero',
      BETTER_AUTH_URL: 'https://nava.legacy.local',
      BETTER_AUTH_SECRET: 'x'.repeat(32),
      AWS_REGION: 'af-south-1',
      S3_BUCKET: 'nava-mail-artifacts-test',
      POP3_POLL_INTERVAL_MS: '30000',
      POP3_MAX_MESSAGES_PER_CYCLE: '500',
      AI_ENABLED: 'true',
    });

    expect(env.BEDROCK_REGION).toBe('us-east-1');
  });

  it.each([
    'LANGFUSE_PUBLIC_KEY',
    'LANGFUSE_SECRET_KEY',
    'LANGSMITH_API_KEY',
    'MASTRA_CLOUD_API_KEY',
    'MASTRA_PLATFORM_TOKEN',
  ])('rejects hosted observability env %s when AI is enabled', (key) => {
    expect(() =>
      parseEnv({
        NODE_ENV: 'production',
        PORT: '8788',
        DATABASE_URL: 'postgres://zero:secret@host:5432/zero',
        BETTER_AUTH_URL: 'https://nava.legacy.local',
        BETTER_AUTH_SECRET: 'x'.repeat(32),
        AWS_REGION: 'af-south-1',
        S3_BUCKET: 'nava-mail-artifacts-test',
        POP3_POLL_INTERVAL_MS: '30000',
        POP3_MAX_MESSAGES_PER_CYCLE: '500',
        AI_ENABLED: 'true',
        [key]: 'secret-value',
      }),
    ).toThrow(/hosted observability/i);
  });

  it('rejects literal HMS_DRAFT_ENRICHMENT_MODE=enabled', () => {
    expect(() => parseEnv(baseEnv({ HMS_DRAFT_ENRICHMENT_MODE: 'enabled' }))).toThrow(
      /HMS_DRAFT_ENRICHMENT_MODE/,
    );
    expect(() => parseHmsControlConfig({ HMS_DRAFT_ENRICHMENT_MODE: 'enabled' })).toThrow(
      /HMS_DRAFT_ENRICHMENT_MODE|enabled/i,
    );
  });

  it('default worker parses off without HMS secret or browser values', () => {
    const env = parseEnv(baseEnv({ HMS_DRAFT_ENRICHMENT_MODE: 'off' }));
    expect(env.HMS_DRAFT_ENRICHMENT_MODE).toBe('off');
    expect(env.HMS_READ_SECRET_ARN).toBeUndefined();
    expect(env.HMS_CHROMIUM_EXECUTABLE_PATH).toBeUndefined();

    const control = parseHmsControlConfig({
      HMS_DRAFT_ENRICHMENT_MODE: 'off',
    });
    expect(control).toEqual({
      mode: 'off',
      healthPath: '/tmp/nava-zero-hms-health.json',
    });
  });

  it('parseHmsControlConfig accepts shadow without secret/browser coupling', () => {
    const control = parseHmsControlConfig({
      HMS_DRAFT_ENRICHMENT_MODE: 'shadow',
      HMS_HEALTH_STATUS_PATH: '/tmp/custom-hms-health.json',
    });
    expect(control).toEqual({
      mode: 'shadow',
      healthPath: '/tmp/custom-hms-health.json',
    });
  });

  it('HMS worker shadow runtime requires secret ARN, Chromium, role-proof, health', () => {
    expect(() =>
      requireHmsWorkerRuntimeConfig({
        HMS_DRAFT_ENRICHMENT_MODE: 'shadow',
      }),
    ).toThrow(/env HMS_/);

    expect(() =>
      requireHmsWorkerRuntimeConfig(hmsShadowRuntimeEnv({ HMS_READ_SECRET_ARN: undefined })),
    ).toThrow(/HMS_READ_SECRET_ARN/);

    expect(() =>
      requireHmsWorkerRuntimeConfig(
        hmsShadowRuntimeEnv({ HMS_CHROMIUM_EXECUTABLE_PATH: undefined }),
      ),
    ).toThrow(/HMS_CHROMIUM_EXECUTABLE_PATH/);

    expect(() =>
      requireHmsWorkerRuntimeConfig(hmsShadowRuntimeEnv({ HMS_READ_ROLE_PROOF_PATH: undefined })),
    ).toThrow(/HMS_READ_ROLE_PROOF_PATH/);

    expect(() =>
      requireHmsWorkerRuntimeConfig(hmsShadowRuntimeEnv({ HMS_HEALTH_STATUS_PATH: '' })),
    ).toThrow(/HMS_HEALTH_STATUS_PATH/);

    const runtime = requireHmsWorkerRuntimeConfig(hmsShadowRuntimeEnv());
    expect(runtime).toMatchObject({
      secretArn: 'arn:aws:secretsmanager:af-south-1:123:secret:hms-read',
      chromiumExecutablePath: '/opt/nava/chromium/chrome',
      roleProofPath: '/opt/nava/shared/hms-read-role-proof.v1.json',
      healthPath: '/tmp/nava-zero-hms-health.json',
      expectedTenant: 'HMS_LEGACY',
      expectedPropertyCode: 'HRCEN',
      expectedTransportId: 'transport-centurion',
      runDeadlineMs: 150_000,
      circuitCooldownMs: 30_000,
      evidenceHmacSecretArn: 'arn:aws:secretsmanager:af-south-1:123:secret:hms-evidence-hmac',
      evidenceHmacKeyVersion: 'evidence-key-v1',
    });

    expect(() =>
      requireHmsWorkerRuntimeConfig(
        hmsShadowRuntimeEnv({ HMS_EVIDENCE_HMAC_SECRET_ARN: undefined }),
      ),
    ).toThrow(/HMS_EVIDENCE_HMAC_SECRET_ARN/);
    expect(() =>
      requireHmsWorkerRuntimeConfig(
        hmsShadowRuntimeEnv({ HMS_EVIDENCE_HMAC_KEY_VERSION: undefined }),
      ),
    ).toThrow(/HMS_EVIDENCE_HMAC_KEY_VERSION/);

    const childKey = requireHmsEvidenceHmacChildKey({
      HMS_EVIDENCE_HMAC_KEY: Buffer.alloc(32, 7).toString('base64'),
    });
    expect(childKey.key.byteLength).toBe(32);
    expect(() => requireHmsEvidenceHmacChildKey({})).toThrow(/HMS_EVIDENCE_HMAC_KEY/);

    // parseEnv must never persist the child-only key onto MailEnv.
    const env = parseEnv(baseEnv({ HMS_EVIDENCE_HMAC_KEY: 'should-not-land' }));
    expect(env).not.toHaveProperty('HMS_EVIDENCE_HMAC_KEY');
  });
});

import { describe, expect, it } from 'vitest';
import { parseEnv } from '../src/env';

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
    expect(
      parseEnv({ ...baseEnv(), INGEST_REQUIRE_OWNER_HEADER: 'false' }),
    ).toMatchObject({ INGEST_REQUIRE_OWNER_HEADER: false });
    expect(
      parseEnv({ ...baseEnv(), INGEST_REQUIRE_OWNER_HEADER: '0' }),
    ).toMatchObject({ INGEST_REQUIRE_OWNER_HEADER: false });
  });

  it('rejects invalid INGEST_REQUIRE_OWNER_HEADER values', () => {
    expect(() =>
      parseEnv({ ...baseEnv(), INGEST_REQUIRE_OWNER_HEADER: 'maybe' }),
    ).toThrow(/INGEST_REQUIRE_OWNER_HEADER/);
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
});

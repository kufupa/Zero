import { describe, expect, it } from 'vitest';
import { parseEnv } from '../src/env';

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
});

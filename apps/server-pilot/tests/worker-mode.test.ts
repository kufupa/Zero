import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { FakePop3Client } from '../src/mail/ingest/pop3-client.js';
import { runWorker } from '../src/mail/ingest/worker.js';

const workerMocks = vi.hoisted(() => ({
  closeDb: vi.fn().mockResolvedValue(undefined),
  createPop3Client: vi.fn(),
  flushDue: vi.fn().mockResolvedValue({ flushed: 0 }),
  getDb: vi.fn(() => ({})),
  getS3Storage: vi.fn(() => ({})),
}));

vi.mock('../src/db/client.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/db/client.js')>()),
  closeDb: workerMocks.closeDb,
  getDb: workerMocks.getDb,
}));

vi.mock('../src/storage/s3.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/storage/s3.js')>()),
  getS3Storage: workerMocks.getS3Storage,
}));

vi.mock('../src/mail/ingest/pop3-client.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/mail/ingest/pop3-client.js')>()),
  createPop3Client: workerMocks.createPop3Client,
}));

vi.mock('../src/mail/send/outbound-queue.js', () => ({
  flushDue: workerMocks.flushDue,
}));

vi.mock('../src/env.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/env.js')>()),
  parseEnv: vi.fn(
    () =>
      ({
        MAIL_TRANSPORT_MODE: 'fixture',
        POP3_MAX_MESSAGES_PER_CYCLE: 1,
        POP3_POLL_INTERVAL_MS: 0,
      }) as never,
  ),
}));

const workerEnv = {
  AWS_REGION: process.env.AWS_REGION,
  BETTER_AUTH_SECRET: process.env.BETTER_AUTH_SECRET,
  BETTER_AUTH_URL: process.env.BETTER_AUTH_URL,
  MAIL_TRANSPORT_MODE: process.env.MAIL_TRANSPORT_MODE,
  POP3_MAX_MESSAGES_PER_CYCLE: process.env.POP3_MAX_MESSAGES_PER_CYCLE,
  POP3_POLL_INTERVAL_MS: process.env.POP3_POLL_INTERVAL_MS,
  PORT: process.env.PORT,
  S3_BUCKET: process.env.S3_BUCKET,
  WORKER_ONE_SHOT: process.env.WORKER_ONE_SHOT,
};

function restoreWorkerEnv(): void {
  for (const [key, value] of Object.entries(workerEnv)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
}

describe('worker outbound flush modes', () => {
  beforeEach(() => {
    Object.assign(process.env, {
      AWS_REGION: 'af-south-1',
      BETTER_AUTH_SECRET: 'x'.repeat(32),
      BETTER_AUTH_URL: 'http://localhost',
      MAIL_TRANSPORT_MODE: 'fixture',
      POP3_MAX_MESSAGES_PER_CYCLE: '1',
      POP3_POLL_INTERVAL_MS: '0',
      PORT: '8788',
      S3_BUCKET: 'worker-mode-test-bucket',
    });
    workerMocks.closeDb.mockReset().mockResolvedValue(undefined);
    workerMocks.createPop3Client.mockReset().mockReturnValue(new FakePop3Client());
    workerMocks.flushDue.mockReset().mockResolvedValue({ flushed: 0 });
    workerMocks.getDb.mockReset().mockReturnValue({});
    workerMocks.getS3Storage.mockReset().mockReturnValue({});
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
  });

  afterEach(() => {
    restoreWorkerEnv();
    vi.restoreAllMocks();
  });

  it('runs fixture input once without flushing due outbound mail', async () => {
    const listUidl = vi.spyOn(FakePop3Client.prototype, 'listUidl');

    await runWorker({ fixtures: [], pollIntervalMs: 0 });

    expect(listUidl).toHaveBeenCalledTimes(1);
    expect(workerMocks.flushDue).not.toHaveBeenCalled();
    expect(workerMocks.getDb).toHaveBeenCalledTimes(1);
  });

  it.each(['1', 'true'])(
    'runs WORKER_ONE_SHOT=%s ingest without flushing due outbound mail',
    async (oneShot) => {
      process.env.WORKER_ONE_SHOT = oneShot;
      const listUidl = vi.spyOn(FakePop3Client.prototype, 'listUidl');

      await runWorker();

      expect(listUidl).toHaveBeenCalledTimes(1);
      expect(workerMocks.flushDue).not.toHaveBeenCalled();
      expect(workerMocks.getDb).toHaveBeenCalledTimes(1);
    },
  );

  it('flushes due outbound mail only after a continuous ingest cycle', async () => {
    const listUidl = vi.spyOn(FakePop3Client.prototype, 'listUidl');
    workerMocks.flushDue.mockImplementation(async () => {
      process.emit('SIGTERM');
      return { flushed: 0 };
    });

    await runWorker({ pollIntervalMs: 0 });

    expect(listUidl).toHaveBeenCalledTimes(1);
    expect(workerMocks.flushDue).toHaveBeenCalledTimes(1);
    expect(workerMocks.getDb).toHaveBeenCalledTimes(1);
  });
});

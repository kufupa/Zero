import { resetFixtureLoopbackStoreForTests } from '../src/mail/fixture-loopback.js';
import { FakeS3Storage, resetS3Storage, setS3Storage } from '../src/storage/s3.js';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as outboundQueue from '../src/mail/send/outbound-queue.js';
import { FakePop3Client } from '../src/mail/ingest/pop3-client.js';
import { runWorker } from '../src/mail/ingest/worker.js';
import { TEST_DB_AVAILABLE } from './helpers/test-db.js';

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

describe.skipIf(!TEST_DB_AVAILABLE)('worker outbound flush modes', () => {
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
    resetFixtureLoopbackStoreForTests();
    resetS3Storage();
    setS3Storage(new FakeS3Storage('worker-mode-test-bucket'));
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
  });

  afterEach(() => {
    resetFixtureLoopbackStoreForTests();
    resetS3Storage();
    restoreWorkerEnv();
    vi.restoreAllMocks();
  });

  it('runs fixture input once without flushing due outbound mail', async () => {
    const listUidl = vi.spyOn(FakePop3Client.prototype, 'listUidl');
    const flushDue = vi.spyOn(outboundQueue, 'flushDue').mockResolvedValue({ flushed: 0 });

    await runWorker({ fixtures: [], pollIntervalMs: 0 });

    expect(listUidl).toHaveBeenCalledTimes(1);
    expect(flushDue).not.toHaveBeenCalled();
  });

  it.each(['1', 'true'])(
    'runs WORKER_ONE_SHOT=%s ingest without flushing due outbound mail',
    async (oneShot) => {
      process.env.WORKER_ONE_SHOT = oneShot;
      const listUidl = vi.spyOn(FakePop3Client.prototype, 'listUidl');
      const flushDue = vi.spyOn(outboundQueue, 'flushDue').mockResolvedValue({ flushed: 0 });

      await runWorker();

      expect(listUidl).toHaveBeenCalledTimes(1);
      expect(flushDue).not.toHaveBeenCalled();
    },
  );

  it('flushes due outbound mail only after a continuous ingest cycle', async () => {
    const listUidl = vi.spyOn(FakePop3Client.prototype, 'listUidl');
    const flushDue = vi.spyOn(outboundQueue, 'flushDue').mockImplementation(async () => {
      process.emit('SIGTERM');
      return { flushed: 0 };
    });

    await runWorker({ pollIntervalMs: 0 });

    expect(listUidl).toHaveBeenCalledTimes(1);
    expect(flushDue).toHaveBeenCalledTimes(1);
  });
});

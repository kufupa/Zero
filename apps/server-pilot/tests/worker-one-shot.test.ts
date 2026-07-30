import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { runWorker } from '../src/mail/ingest/worker.js';
import type { Pop3Client } from '../src/mail/ingest/pop3-client.js';

describe('worker outbound flush policy', () => {
  const pop3 = { kind: 'fake' } as Pop3Client;
  const cycleResult = {
    listed: 0,
    processed: 0,
    deled: 0,
    items: [],
    usedFakePop3: true,
  };
  let processOn: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.stubEnv('DATABASE_URL', '');
    vi.stubEnv('WORKER_ONE_SHOT', '0');
    processOn = vi.spyOn(process, 'on').mockImplementation(() => process);
  });

  afterEach(() => {
    processOn.mockRestore();
    vi.unstubAllEnvs();
  });

  function workerDeps(opts: { maxCycles?: number } = {}) {
    const ingestOnce = vi.fn().mockResolvedValue(cycleResult);
    const flushDue = vi.fn().mockResolvedValue({ flushed: 1 });
    const closeDb = vi.fn().mockResolvedValue(undefined);
    const createPop3Client = vi.fn().mockReturnValue(pop3);
    return {
      deps: {
        env: {
          MAIL_TRANSPORT_MODE: 'fixture',
          POP3_POLL_INTERVAL_MS: 0,
        },
        createPop3Client,
        ingestOnce,
        flushDue,
        closeDb,
        registerSignalHandlers: false,
        maxCycles: opts.maxCycles,
      },
      ingestOnce,
      flushDue,
      closeDb,
      createPop3Client,
    };
  }

  it('actual runWorker fixture branch ingests without outbound flush', async () => {
    const runtime = workerDeps();

    await runWorker({ fixtures: [] }, runtime.deps);

    expect(runtime.ingestOnce).toHaveBeenCalledOnce();
    expect(runtime.flushDue).not.toHaveBeenCalled();
    expect(runtime.createPop3Client).not.toHaveBeenCalled();
    expect(runtime.closeDb).toHaveBeenCalledOnce();
    expect(processOn).not.toHaveBeenCalled();
  });

  it('actual runWorker WORKER_ONE_SHOT branch never flushes', async () => {
    vi.stubEnv('WORKER_ONE_SHOT', '1');
    const runtime = workerDeps();

    await runWorker({}, runtime.deps);

    expect(runtime.createPop3Client).toHaveBeenCalledOnce();
    expect(runtime.ingestOnce).toHaveBeenCalledOnce();
    expect(runtime.flushDue).not.toHaveBeenCalled();
    expect(runtime.closeDb).toHaveBeenCalledOnce();
    expect(processOn).not.toHaveBeenCalled();
  });

  it('actual runWorker regular branch flushes after ingest', async () => {
    const runtime = workerDeps({ maxCycles: 1 });

    await runWorker({ pollIntervalMs: 0 }, runtime.deps);

    expect(runtime.createPop3Client).toHaveBeenCalledOnce();
    expect(runtime.ingestOnce).toHaveBeenCalledOnce();
    expect(runtime.flushDue).toHaveBeenCalledOnce();
    expect(runtime.closeDb).toHaveBeenCalledOnce();
    expect(processOn).not.toHaveBeenCalled();
  });
});

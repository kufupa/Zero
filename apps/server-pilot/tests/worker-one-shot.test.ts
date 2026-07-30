import { describe, expect, it, vi } from 'vitest';
import { runWorkerCycle } from '../src/mail/ingest/worker.js';
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

  it('runWorker one-shot callsite ingests without outbound flush', async () => {
    const ingestOnce = vi.fn().mockResolvedValue(cycleResult);
    const flushDue = vi.fn().mockResolvedValue({ flushed: 1 });

    await expect(
      runWorkerCycle(
        { oneShot: true, pop3 },
        { ingestOnce, flushDue },
      ),
    ).resolves.toEqual(cycleResult);

    expect(ingestOnce).toHaveBeenCalledWith({ pop3, maxMessages: undefined });
    expect(flushDue).not.toHaveBeenCalled();
  });

  it('runWorker regular callsite flushes due outbound rows', async () => {
    const ingestOnce = vi.fn().mockResolvedValue(cycleResult);
    const flushDue = vi.fn().mockResolvedValue({ flushed: 2 });

    await expect(
      runWorkerCycle(
        { oneShot: false, pop3 },
        { ingestOnce, flushDue },
      ),
    ).resolves.toEqual(cycleResult);

    expect(ingestOnce).toHaveBeenCalledWith({ pop3, maxMessages: undefined });
    expect(flushDue).toHaveBeenCalledOnce();
  });
});

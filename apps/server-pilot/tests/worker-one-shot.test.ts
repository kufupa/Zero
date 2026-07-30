import { describe, expect, it, vi } from 'vitest';
import { flushOutboundAfterIngest } from '../src/mail/ingest/worker.js';

describe('worker outbound flush policy', () => {
  it('skips outbound flush for one-shot ingest', async () => {
    const flushDue = vi.fn().mockResolvedValue({ flushed: 1 });

    await flushOutboundAfterIngest(true, flushDue);

    expect(flushDue).not.toHaveBeenCalled();
  });

  it('flushes due outbound rows in regular loop mode', async () => {
    const flushDue = vi.fn().mockResolvedValue({ flushed: 2 });

    await flushOutboundAfterIngest(false, flushDue);

    expect(flushDue).toHaveBeenCalledOnce();
  });
});

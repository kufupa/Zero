import { afterEach, describe, expect, it, vi } from 'vitest';

const stubs = vi.hoisted(() => ({
  db: {},
  getDb: vi.fn(),
  closeDb: vi.fn(),
  evaluate: vi.fn(),
  prefetch: vi.fn(),
}));

vi.mock('../src/db/client.js', () => ({ getDb: stubs.getDb, closeDb: stubs.closeDb }));
vi.mock('../src/ai/hms-jobs.js', () => ({
  HMS_JOB_PRIORITY_DEV: -10,
  evaluateQuoteReadyForMessage: stubs.evaluate,
  prefetchQuoteReadyForExtraction: stubs.prefetch,
}));

import { main } from '../scripts/quote-ready-eval.js';
import { HMS_JOB_PRIORITY_DEV, prefetchQuoteReadyForExtraction } from '../src/ai/hms-jobs.js';

afterEach(() => {
  vi.restoreAllMocks();
  stubs.getDb.mockReset();
  stubs.closeDb.mockReset();
  stubs.evaluate.mockReset();
  stubs.prefetch.mockReset();
});

describe('quote-ready-eval', () => {
  it('passes DEV priority for --enqueue', async () => {
    stubs.getDb.mockReturnValue(stubs.db);
    stubs.closeDb.mockResolvedValue(undefined);
    stubs.evaluate.mockResolvedValue({
      messageId: 'message-1',
      transportId: 'transport-1',
      threadId: 'thread-1',
      preparationEnabled: true,
      plan: { stays: [], inputs: [], partyBound: false },
      reason: null,
    });
    stubs.prefetch.mockResolvedValue(1);
    vi.spyOn(console, 'log').mockImplementation(() => undefined);

    await expect(main(['--enqueue', 'message-1'])).resolves.toBe(0);

    expect(prefetchQuoteReadyForExtraction).toHaveBeenCalledWith(
      { runKind: 'inbound_extraction', transportId: 'transport-1', triggerMessageId: 'message-1' },
      stubs.db,
      process.env,
      expect.any(Date),
      HMS_JOB_PRIORITY_DEV,
    );
  });
});

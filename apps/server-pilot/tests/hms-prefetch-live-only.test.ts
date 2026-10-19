import { afterEach, describe, expect, it, vi } from 'vitest';

const dbClient = vi.hoisted(() => ({ getDb: vi.fn() }));

vi.mock('../src/db/client.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/db/client.js')>()),
  getDb: dbClient.getDb,
}));

import { scheduleQuotePreparationForExtraction } from '../src/ai/hms-jobs.js';

const RUN = {
  runKind: 'inbound_extraction' as const,
  transportId: 'transport-centurion',
  triggerMessageId: 'message-1',
};

describe('scheduleQuotePreparationForExtraction', () => {
  afterEach(() => {
    dbClient.getDb.mockReset();
  });

  it('never reads or queues for a backfill re-extraction (no admission snapshot)', async () => {
    scheduleQuotePreparationForExtraction({ ...RUN, admissionSnapshotId: null });
    await new Promise((resolve) => setImmediate(resolve));
    expect(dbClient.getDb).not.toHaveBeenCalled();
  });

  it('schedules party then quote preparation for a live admission', async () => {
    dbClient.getDb.mockImplementation(() => {
      throw new Error('stop after scheduling');
    });
    scheduleQuotePreparationForExtraction({ ...RUN, admissionSnapshotId: 'snapshot-1' });
    await new Promise((resolve) => setImmediate(resolve));
    expect(dbClient.getDb).toHaveBeenCalled();
  });
});

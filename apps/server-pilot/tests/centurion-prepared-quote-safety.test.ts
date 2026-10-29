import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { queueAutoStaffQuoteHmsJob, readHmsJobView } from '../src/ai/hms-jobs.js';
import { staffQuoteInput, type StaffQuoteInput } from '../src/ai/staff-quote-workflow.js';
import { aiDraftGeneration, aiWorkflowRun } from '../src/db/schema/mail.js';
import type { DB } from '../src/db/client.js';
import { DAVINCI_TRANSPORT_ID, TRANSPORT_ID } from '../src/db/seed.js';

const input = staffQuoteInput.parse({
  messageId: 'message-1', sourceHash: 'a'.repeat(64), selectionEpoch: 1, inputRevision: 1,
  groups: [{
    id: 'room-1', arrivalDate: '2027-11-12', departureDate: '2027-11-14', quantity: 1,
    adults: 2, childrenPerRoom: 0, childrenAges: [], board: 'room_only',
  }],
  salesStrategy: 'BAR',
  parties: { agency: { kind: 'agency', nativeId: 'A123', name: 'Example Agency' } },
});

function preparedRun(id: string, transportId: string, quote: StaffQuoteInput, contract: boolean) {
  const now = new Date();
  return {
    id, transportId, threadId: 'thread-1', triggerMessageId: input.messageId,
    state: 'succeeded', priority: 0, attempts: 0, failureClass: null, createdAt: now,
    metrics: { quotePrepared: true, userId: null },
    readRequest: { kind: 'staff_quote', input: quote },
    readResult: {
      kind: 'staff_quote', status: 'ready', asOf: now.toISOString(), totalMinor: 100_000,
      rateOptions: [{ selected: true, contract }],
    },
    readResultExpiresAt: new Date(now.getTime() + 60_000),
  };
}

/** A query stub for the actual auto-start picker; inserted rows are returned as fresh jobs. */
function quoteDb(rows: ReturnType<typeof preparedRun>[]) {
  const database = {
    transaction: async (run: (tx: unknown) => Promise<unknown>) => run(database),
    execute: async () => undefined,
    select: () => ({
      from: (table: unknown) => {
        if (table === aiWorkflowRun) return {
          where: () => ({ orderBy: async () => rows, limit: async () => rows.slice(0, 1) }),
        };
        if (table === aiDraftGeneration) return {
          where: () => ({ orderBy: () => ({ limit: async () => [] }) }),
        };
        throw new Error('unexpected query');
      },
    }),
    insert: () => ({
      values: (value: Record<string, unknown>) => ({
        onConflictDoNothing: () => ({ returning: async () => [{ ...value, id: 'fresh' }] }),
      }),
    }),
  };
  return database as unknown as DB;
}

function autoStart(transportId: string) {
  return {
    transportId, threadId: 'thread-1', triggerMessageId: input.messageId, workItemId: null,
    userId: 'staff-1', priority: 10, request: { kind: 'staff_quote' as const, input },
  };
}

beforeEach(() => {
  vi.stubEnv('HMS_JOB_QUEUE', 'on');
  vi.stubEnv('HMS_QUOTE_PREPARE', 'on');
});
afterEach(() => vi.unstubAllEnvs());

describe('prepared quote reuse', () => {
  it('uses the matching Centurion strategy even when an incompatible contract is first', async () => {
    const ws = preparedRun('ws', TRANSPORT_ID, { ...input, salesStrategy: 'WS' }, true);
    const bar = preparedRun('bar', TRANSPORT_ID, input, false);
    const result = await queueAutoStaffQuoteHmsJob(autoStart(TRANSPORT_ID), quoteDb([ws, bar]));
    expect(result).toMatchObject({ created: false, run: { id: 'bar' } });
  });

  it('queues a fresh Centurion strategy when only the other strategy is prepared', async () => {
    const ws = preparedRun('ws', TRANSPORT_ID, { ...input, salesStrategy: 'WS' }, true);
    const result = await queueAutoStaffQuoteHmsJob(autoStart(TRANSPORT_ID), quoteDb([ws]));
    expect(result).toMatchObject({ created: true, run: { id: 'fresh', readRequest: { input: { salesStrategy: 'BAR' } } } });
  });

  it('preserves the existing Da Vinci preference for a bound contract', async () => {
    const ws = preparedRun('ws', DAVINCI_TRANSPORT_ID, { ...input, salesStrategy: 'WS' }, true);
    const bar = preparedRun('bar', DAVINCI_TRANSPORT_ID, input, false);
    const result = await queueAutoStaffQuoteHmsJob(autoStart(DAVINCI_TRANSPORT_ID), quoteDb([bar, ws]));
    expect(result).toMatchObject({ created: false, run: { id: 'ws' } });
  });

  it.each([undefined, null, 2])('holds a cached Centurion price with incomplete child count %s', async (count) => {
    const quote = { ...input, groups: [{ ...input.groups[0]!, childrenPerRoom: count, childrenAges: [] }] };
    const run = preparedRun('stale', TRANSPORT_ID, quote, false);
    const view = await readHmsJobView({ transportId: TRANSPORT_ID, runId: run.id }, quoteDb([run]));
    expect(view).toMatchObject({ status: 'failed', result: { ok: false, code: 'staff_quote_child_occupancy_incomplete' } });
    expect(view?.result).not.toHaveProperty('totalMinor');
  });

  it('keeps a completed Centurion price and a legacy Da Vinci price readable', async () => {
    const centurion = preparedRun('cen', TRANSPORT_ID, input, false);
    const davinci = preparedRun('dav', DAVINCI_TRANSPORT_ID, {
      ...input, groups: [{ ...input.groups[0]!, childrenPerRoom: undefined }],
    }, false);
    expect(await readHmsJobView({ transportId: TRANSPORT_ID, runId: centurion.id }, quoteDb([centurion])))
      .toMatchObject({ status: 'done', result: { totalMinor: 100_000 } });
    expect(await readHmsJobView({ transportId: DAVINCI_TRANSPORT_ID, runId: davinci.id }, quoteDb([davinci])))
      .toMatchObject({ status: 'done', result: { totalMinor: 100_000 } });
  });
});

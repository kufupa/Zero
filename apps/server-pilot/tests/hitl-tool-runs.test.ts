import { TRPCError } from '@trpc/server';
import { PgDialect } from 'drizzle-orm/pg-core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { paneCancelDigest } from '../src/ai/pane-stay-cancel.js';
import {
  classifyBookingDraft,
  classifyCancelCommit,
  classifyCancelPreview,
  classifyFind,
  classifyPdf,
  classifySearch,
  classifyStaffQuote,
  classifyStayCommit,
  classifyStayPreview,
  createToolRunRecorder,
  ledgerQuoteInput,
  mergeEpisodeOnToolRun,
  recordedToolRun,
  recordToolOutcome,
  recordToolRunCapped,
  toolErrorCode,
  toolErrorStatus,
  toolInputDigest,
  toolRunLoaders,
  type EpisodeToolState,
  type ToolRunDraft,
  type ToolRunRecorder,
  type ToolRunSpec,
} from '../src/ai/hitl-tool-run.js';
import { staffQuoteInput } from '../src/ai/staff-quote-workflow.js';
import { hitlEpisode } from '../src/db/schema/hitl.js';
import type { DB } from '../src/db/client.js';
import { appRouter } from '../src/trpc/router.js';

const mocks = vi.hoisted(() => ({
  getDb: vi.fn((): never => {
    throw new Error('getDb must not be called');
  }),
  runPaneStay: vi.fn(),
  previewCancel: vi.fn(),
  commitCancel: vi.fn(),
  findStay: vi.fn(),
  searchGuest: vi.fn(),
}));

vi.mock('../src/db/client.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/db/client.js')>()),
  getDb: mocks.getDb,
}));
vi.mock('../src/ai/pane-stay-save.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/ai/pane-stay-save.js')>()),
  runPaneStay: mocks.runPaneStay,
}));
vi.mock('../src/ai/pane-stay-cancel.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/ai/pane-stay-cancel.js')>()),
  previewCancel: mocks.previewCancel,
  commitCancel: mocks.commitCancel,
}));
vi.mock('../src/ai/pane-stay-lookup.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/ai/pane-stay-lookup.js')>()),
  findStay: mocks.findStay,
  searchGuest: mocks.searchGuest,
}));

const savedFlag = process.env.HITL_LEDGER;

function setLedger(value: string | undefined): void {
  if (value === undefined) delete process.env.HITL_LEDGER;
  else process.env.HITL_LEDGER = value;
}

afterEach(() => {
  setLedger(savedFlag);
  toolRunLoaders.recorder = null;
  vi.clearAllMocks();
  vi.restoreAllMocks();
});

const DIGEST = 'd'.repeat(64);
const ok = () => ({ status: 'ok' as const });

function draft(over: Partial<ToolRunDraft> = {}): ToolRunDraft {
  return {
    kind: 'stay_lookup',
    status: 'ok',
    transportId: 'transport-1',
    messageId: null,
    userId: 'user-1',
    workflowRunId: null,
    input: null,
    inputDigest: DIGEST,
    errorCode: null,
    result: null,
    confirmationNo: null,
    hmsRunId: null,
    startedAt: new Date('2026-10-09T08:00:00Z'),
    durationMs: 12,
    episodeOutcome: null,
    ...over,
  };
}

function spec(over: Partial<ToolRunSpec> = {}): ToolRunSpec {
  return {
    kind: 'stay_lookup',
    transportId: 'transport-1',
    messageId: null,
    userId: 'user-1',
    inputDigest: DIGEST,
    ...over,
  };
}

/** An in-memory sink. "throws" and "hangs" stand for a failing and a stalled ledger. */
function memorySink(behaviour: 'records' | 'throws' | 'hangs' = 'records') {
  const rows: ToolRunDraft[] = [];
  const recorder: ToolRunRecorder = {
    async record(row) {
      if (behaviour === 'throws') throw new Error('postgres://ledger:hunter2@db.internal refused');
      if (behaviour === 'hangs') return new Promise<void>(() => {});
      rows.push(row);
    },
  };
  return { rows, recorder };
}

function caller(userId = 'user-1', transportId = 'transport-1') {
  return appRouter.createCaller({
    auth: null as never,
    reqHeaders: new Headers(),
    sessionUser: { id: userId, email: 'desk@example.test', name: 'Desk' },
    activeTransportId: transportId,
    transportEmail: 'centurion@example.test',
    accessRole: 'owner',
  } as never);
}

const stayInput = {
  firstName: 'Thandi',
  lastName: 'Mokoena',
  arrival: '2027-09-14',
  departure: '2027-09-16',
  adults: 2,
  sourceOfBusiness: 'Direct',
  roomType: 'Room Only R',
  ratePlan: 'TAXYZ',
  track: 'BAR',
  guaranteeType: 'Credit card',
};

describe('tool-run ledger: flag gating', () => {
  it('with the flag off the tool runs and nothing is written, even to an injected recorder', async () => {
    setLedger(undefined);
    const sink = memorySink();
    const value = await recordedToolRun(spec(), async () => 'found', ok, undefined, {
      recorder: sink.recorder,
    });
    expect(value).toBe('found');
    expect(sink.rows).toEqual([]);
  });

  it('with the flag off the database is never opened', async () => {
    setLedger(undefined);
    const value = await recordedToolRun(spec(), async () => 'found', ok);
    expect(value).toBe('found');
    expect(mocks.getDb).not.toHaveBeenCalled();
  });

  it('reads the flag as on only for the exact value "on"', async () => {
    setLedger('1');
    const sink = memorySink();
    await recordedToolRun(spec(), async () => 'found', ok, undefined, { recorder: sink.recorder });
    expect(sink.rows).toEqual([]);
  });
});

describe('tool-run ledger: one run', () => {
  beforeEach(() => setLedger('on'));

  it('records a completed run with its kind, digest and timing, and returns the tool value', async () => {
    const sink = memorySink();
    const value = await recordedToolRun(
      spec({ kind: 'guest_search', inputDigest: 'e'.repeat(64) }),
      async () => ({ outcome: 'ok', rows: [{ name: 'Jane Doe' }, { name: 'John Doe' }] }),
      classifySearch as never,
      undefined,
      { recorder: sink.recorder, now: () => 1_000 },
    );
    expect(value).toEqual({ outcome: 'ok', rows: [{ name: 'Jane Doe' }, { name: 'John Doe' }] });
    expect(sink.rows).toHaveLength(1);
    expect(sink.rows[0]).toMatchObject({
      kind: 'guest_search',
      status: 'ok',
      transportId: 'transport-1',
      userId: 'user-1',
      messageId: null,
      inputDigest: 'e'.repeat(64),
      result: { outcome: 'ok', rowCount: 2 },
      durationMs: 0,
    });
    expect(sink.rows[0]!.startedAt).toEqual(new Date(1_000));
    expect(JSON.stringify(sink.rows)).not.toContain('Jane');
  });

  it('records a refusal from the error code and rethrows the same error', async () => {
    const sink = memorySink();
    const error = new TRPCError({ code: 'BAD_REQUEST', message: 'lastName Jane Doe is not valid' });
    await expect(
      recordedToolRun(
        spec(),
        async () => {
          throw error;
        },
        ok,
        undefined,
        { recorder: sink.recorder },
      ),
    ).rejects.toBe(error);
    expect(sink.rows).toHaveLength(1);
    expect(sink.rows[0]).toMatchObject({ status: 'refused', errorCode: 'BAD_REQUEST', result: null });
    expect(JSON.stringify(sink.rows)).not.toContain('Jane');
  });

  it('records a failure for a server error code, and "unknown" for a code that is not an identifier', async () => {
    const sink = memorySink();
    const server = Object.assign(new Error('boom'), { code: 'INTERNAL_SERVER_ERROR' });
    const odd = Object.assign(new Error('x'), { code: 'has spaces and a value' });
    await expect(
      recordedToolRun(
        spec(),
        async () => {
          throw server;
        },
        ok,
        undefined,
        { recorder: sink.recorder },
      ),
    ).rejects.toBe(server);
    await expect(
      recordedToolRun(
        spec(),
        async () => {
          throw odd;
        },
        ok,
        undefined,
        { recorder: sink.recorder },
      ),
    ).rejects.toBe(odd);
    expect(sink.rows.map((row) => [row.status, row.errorCode])).toEqual([
      ['failed', 'INTERNAL_SERVER_ERROR'],
      ['failed', 'unknown'],
    ]);
  });

  it('records classify_failed when the classifier throws, and still returns the value', async () => {
    const sink = memorySink();
    const value = await recordedToolRun(
      spec(),
      async () => 'v',
      () => {
        throw new Error('bad shape');
      },
      undefined,
      { recorder: sink.recorder },
    );
    expect(value).toBe('v');
    expect(sink.rows[0]).toMatchObject({ status: 'failed', errorCode: 'classify_failed' });
  });
});

describe('tool-run ledger: a ledger error never fails the tool', () => {
  beforeEach(() => setLedger('on'));

  it('returns the tool value when the write fails, and logs only the code and kind', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const sink = memorySink('throws');
    const value = await recordedToolRun(spec({ kind: 'pdf' }), async () => 'pdf', ok, undefined, {
      recorder: sink.recorder,
    });
    expect(value).toBe('pdf');
    expect(warn).toHaveBeenCalledWith('hitl_tool_record_skipped', { code: 'error', kind: 'pdf' });
    expect(JSON.stringify(warn.mock.calls)).not.toContain('hunter2');
  });

  it('waits at most the cap for a write that never finishes', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const sink = memorySink('hangs');
    const started = Date.now();
    const value = await recordedToolRun(spec(), async () => 'v', ok, undefined, {
      recorder: sink.recorder,
      capMs: 25,
    });
    expect(value).toBe('v');
    expect(Date.now() - started).toBeLessThan(2_000);
    expect(warn).toHaveBeenCalledWith('hitl_tool_record_skipped', { code: 'timeout', kind: 'stay_lookup' });
  });

  it('reports a sink that finishes in time as written', async () => {
    const sink = memorySink();
    expect(await recordToolRunCapped(sink.recorder, draft(), 1_000)).toBe(true);
    expect(sink.rows).toHaveLength(1);
  });
});

describe('tool-run ledger: classifiers by site', () => {
  it('stay preview: ok carries the digest; a refusal carries its reason as the code', () => {
    expect(
      classifyStayPreview({ status: 'ok', previewDigest: DIGEST, outcome: 'preview' } as never),
    ).toMatchObject({ status: 'ok', inputDigest: DIGEST, result: { outcome: 'preview' } });
    expect(classifyStayPreview({ status: 'refused', reason: 'room_unavailable' } as never)).toEqual({
      status: 'refused',
      errorCode: 'room_unavailable',
    });
  });

  it('stay commit: a confirmation is booked; an unconfirmed save is unconfirmed; refusals keep the preview digest', () => {
    expect(
      classifyStayCommit({ status: 'ok', confirmationNumber: '57291630-1', outcome: 'booked' } as never, DIGEST),
    ).toMatchObject({ status: 'ok', confirmationNo: '57291630-1', episodeOutcome: 'booked', inputDigest: DIGEST });
    expect(
      classifyStayCommit({ status: 'refused', reason: 'pane_save_unconfirmed' } as never, DIGEST),
    ).toMatchObject({ status: 'unconfirmed', errorCode: 'pane_save_unconfirmed' });
    expect(classifyStayCommit({ status: 'ok' } as never, DIGEST)).toMatchObject({
      status: 'unconfirmed',
      errorCode: 'pane_save_unconfirmed',
    });
    expect(
      classifyStayCommit({ status: 'refused', reason: 'duplicate_booking' } as never, DIGEST),
    ).toMatchObject({ status: 'refused', errorCode: 'duplicate_booking', inputDigest: DIGEST });
  });

  it('cancel preview: preview_ok is ok; cancel_unconfirmed is unconfirmed; refusals and other outcomes differ', () => {
    expect(classifyCancelPreview({ outcome: 'preview_ok' } as never, DIGEST)).toEqual({
      status: 'ok',
      inputDigest: DIGEST,
      result: { outcome: 'preview_ok' },
    });
    expect(classifyCancelPreview({ outcome: 'cancel_unconfirmed' } as never, DIGEST)).toMatchObject({
      status: 'unconfirmed',
      errorCode: 'cancel_unconfirmed',
    });
    expect(classifyCancelPreview({ outcome: 'refused_no_access' } as never, DIGEST)).toMatchObject({
      status: 'refused',
      errorCode: 'refused_no_access',
    });
    expect(classifyCancelPreview({ outcome: 'exploded' } as never, DIGEST)).toMatchObject({
      status: 'failed',
      errorCode: 'exploded',
    });
  });

  it('cancel commit: cancelled moves the episode to cancelled and keeps the confirmation', () => {
    expect(
      classifyCancelCommit({ outcome: 'cancelled', statusAfter: null } as never, '57291630-1', DIGEST),
    ).toMatchObject({
      status: 'ok',
      confirmationNo: '57291630-1',
      episodeOutcome: 'cancelled',
      result: { outcome: 'cancelled' },
    });
    expect(
      classifyCancelCommit({ outcome: 'other', statusAfter: 'Cancelled' } as never, '57291630-1', DIGEST),
    ).toMatchObject({ status: 'ok', episodeOutcome: 'cancelled' });
    expect(
      classifyCancelCommit({ outcome: 'cancel_unconfirmed' } as never, '57291630-1', DIGEST),
    ).toMatchObject({ status: 'unconfirmed', confirmationNo: '57291630-1' });
    // A penalty after the OK is needs check even when the booking reads Cancelled, and it is not an episode cancel.
    const penalty = classifyCancelCommit(
      { outcome: 'cancel_penalty_pending', statusAfter: 'Cancelled' } as never,
      '57291630-1',
      DIGEST,
    );
    expect(penalty).toMatchObject({
      status: 'unconfirmed',
      errorCode: 'cancel_penalty_pending',
      confirmationNo: '57291630-1',
    });
    expect(penalty.episodeOutcome).toBeUndefined();
    expect(
      classifyCancelCommit({ outcome: 'refused_penalty_not_accepted' } as never, '57291630-1', DIGEST),
    ).toMatchObject({ status: 'refused', errorCode: 'refused_penalty_not_accepted' });
  });

  it('stay find and guest search: completed reads are ok, execution failures failed, refusals refused', () => {
    expect(classifyFind({ outcome: 'found' } as never)).toEqual({ status: 'ok', result: { outcome: 'found' } });
    expect(classifyFind({ outcome: 'ambiguous' } as never)).toMatchObject({ status: 'ok' });
    expect(classifyFind({ outcome: 'execution_failure' } as never)).toEqual({
      status: 'failed',
      errorCode: 'execution_failure',
    });
    expect(classifyFind({ outcome: 'refused_bad_hotel' } as never)).toMatchObject({
      status: 'refused',
      errorCode: 'refused_bad_hotel',
    });
    expect(classifySearch({ outcome: 'ambiguous_capped', rows: [{}, {}, {}] } as never)).toEqual({
      status: 'ok',
      result: { outcome: 'ambiguous_capped', rowCount: 3 },
    });
    expect(classifySearch({ outcome: 'execution_failure', rows: [] } as never)).toMatchObject({ status: 'failed' });
  });

  it('staff quote: ready is ok and moves the episode to quoted; anything else is refused with its status', () => {
    expect(
      classifyStaffQuote({
        status: 'ready',
        workflowRunId: 'wf-1',
        revisionRef: 'quote:abc',
        totalMinor: 1_234_500,
        currency: 'ZAR',
      }),
    ).toEqual({
      status: 'ok',
      workflowRunId: 'wf-1',
      result: { revisionRef: 'quote:abc', totalMinor: 1_234_500, currency: 'ZAR' },
      episodeOutcome: 'quoted',
    });
    expect(classifyStaffQuote({ status: 'needs_input' })).toEqual({ status: 'refused', errorCode: 'needs_input' });
  });

  it('pdf: keeps the hash and total, never the file; an invalid hash is dropped', () => {
    const hash = 'a'.repeat(64);
    expect(classifyPdf({ pdfHash: hash, totalMinor: 99_000, revisionId: 'quote:abc' })).toEqual({
      status: 'ok',
      result: { pdfHash: hash, totalMinor: 99_000, revisionId: 'quote:abc' },
      episodeOutcome: 'quoted',
    });
    expect(classifyPdf({ pdfHash: 'not-a-hash' }).result).toEqual({
      pdfHash: null,
      totalMinor: null,
      revisionId: null,
    });
  });

  it('booking draft: ready is ok; anything else is refused with its reason as the code', () => {
    expect(classifyBookingDraft({ status: 'ready' })).toEqual({ status: 'ok' });
    expect(classifyBookingDraft({ status: 'unavailable', reason: 'no_confirmed_quote' })).toEqual({
      status: 'refused',
      errorCode: 'no_confirmed_quote',
    });
  });

  it('error codes: request problems are refused, everything else failed, and only identifiers pass', () => {
    expect(toolErrorStatus({ code: 'PRECONDITION_FAILED' })).toBe('refused');
    expect(toolErrorStatus({ code: 'INTERNAL_SERVER_ERROR' })).toBe('failed');
    expect(toolErrorStatus(null)).toBe('failed');
    expect(toolErrorCode({ code: 'BAD_REQUEST' })).toBe('BAD_REQUEST');
    expect(toolErrorCode({ code: 'two words' })).toBe('unknown');
  });

  it('the input digest does not depend on key order', () => {
    expect(toolInputDigest({ lastName: 'Doe', arrival: '2027-09-14' })).toBe(
      toolInputDigest({ arrival: '2027-09-14', lastName: 'Doe' }),
    );
    expect(toolInputDigest({ lastName: 'Doe', arrival: '2027-09-14' })).not.toBe(
      toolInputDigest({ lastName: 'Roe', arrival: '2027-09-14' }),
    );
  });
});

describe('tool-run ledger: episode state', () => {
  it('keeps the first tool time, moves the outcome forward only, and keeps the strongest label', () => {
    let episode: EpisodeToolState | null = mergeEpisodeOnToolRun(
      null,
      draft({ kind: 'quote', startedAt: new Date('2026-10-09T08:00:00Z'), episodeOutcome: 'quoted' }),
    );
    expect(episode).toEqual({
      firstToolAt: new Date('2026-10-09T08:00:00Z'),
      outcome: 'quoted',
      bookedConfirmationNo: null,
      labelStrength: 'tool_input',
    });
    episode = mergeEpisodeOnToolRun(
      episode,
      draft({
        kind: 'stay_commit',
        startedAt: new Date('2026-10-09T09:00:00Z'),
        episodeOutcome: 'booked',
        confirmationNo: '57291630-1',
      }),
    );
    expect(episode).toEqual({
      firstToolAt: new Date('2026-10-09T08:00:00Z'),
      outcome: 'booked',
      bookedConfirmationNo: '57291630-1',
      labelStrength: 'booked',
    });
    episode = mergeEpisodeOnToolRun(
      episode,
      draft({ kind: 'quote', startedAt: new Date('2026-10-09T10:00:00Z'), episodeOutcome: 'quoted' }),
    );
    expect(episode).toMatchObject({ outcome: 'booked', bookedConfirmationNo: '57291630-1', labelStrength: 'booked' });
    episode = mergeEpisodeOnToolRun(
      episode,
      draft({
        kind: 'cancel_commit',
        startedAt: new Date('2026-10-09T11:00:00Z'),
        episodeOutcome: 'cancelled',
        confirmationNo: '57291630-1',
      }),
    );
    expect(episode).toMatchObject({ outcome: 'cancelled', firstToolAt: new Date('2026-10-09T08:00:00Z') });
  });

  it('a refused or unconfirmed run sets the first tool time and moves nothing else', () => {
    const refused = mergeEpisodeOnToolRun(
      null,
      draft({
        kind: 'stay_commit',
        status: 'refused',
        errorCode: 'PRECONDITION_FAILED',
        startedAt: new Date('2026-10-09T08:00:00Z'),
      }),
    );
    expect(refused).toEqual({
      firstToolAt: new Date('2026-10-09T08:00:00Z'),
      outcome: 'open',
      bookedConfirmationNo: null,
      labelStrength: 'none',
    });
    const unconfirmed = mergeEpisodeOnToolRun(
      refused,
      draft({ kind: 'stay_commit', status: 'unconfirmed', startedAt: new Date('2026-10-09T09:00:00Z') }),
    );
    expect(unconfirmed).toEqual(refused);
  });
});

/** A handle that answers the episode lookup from `existing`, and records each write and the SET LOCAL statements. */
function fakeLedgerDb(existing: Record<string, unknown> | null) {
  const executed: string[] = [];
  const written: Array<{ table: string; values: Record<string, unknown> }> = [];
  const dialect = new PgDialect();
  const insert = (table: unknown) => ({
    values: (values: Record<string, unknown>) => {
      if (table === hitlEpisode) {
        written.push({ table: 'episode', values });
        return {
          onConflictDoNothing: () => ({
            returning: async () => (existing ? [] : [{ id: 'episode-new' }]),
          }),
        };
      }
      written.push({ table: 'run', values });
      return Promise.resolve();
    },
  });
  const tx = {
    execute: async (query: unknown) => {
      executed.push(dialect.sqlToQuery(query as never).sql);
    },
    insert,
    select: () => ({
      from: () => ({
        where: () => ({ limit: () => ({ for: async () => (existing ? [existing] : []) }) }),
      }),
    }),
    update: () => ({
      set: (values: Record<string, unknown>) => ({
        where: async () => {
          written.push({ table: 'episode-update', values });
        },
      }),
    }),
  };
  const transaction = vi.fn(async (work: (handle: unknown) => Promise<unknown>) => work(tx));
  const db = { transaction, insert };
  return { db: db as unknown as DB, executed, written, transaction };
}

describe('tool-run ledger: database recorder', () => {
  const at = new Date('2026-10-09T08:00:05Z');
  const recorderFor = (db: DB): ToolRunRecorder => createToolRunRecorder(db, { enabled: true, now: () => at })!;

  it('creates the mail episode and links the run to it, inside one ledger transaction', async () => {
    const fake = fakeLedgerDb(null);
    await recorderFor(fake.db).record(
      draft({
        kind: 'quote',
        messageId: 'message-1',
        workflowRunId: 'wf-1',
        episodeOutcome: 'quoted',
        result: { totalMinor: 99_000 },
      }),
    );
    expect(fake.transaction).toHaveBeenCalledTimes(1);
    expect(fake.executed).toEqual(["SET LOCAL lock_timeout = '250ms'", "SET LOCAL statement_timeout = '250ms'"]);
    expect(fake.written[0]).toMatchObject({
      table: 'episode',
      values: {
        transportId: 'transport-1',
        messageId: 'message-1',
        userId: 'user-1',
        outcome: 'quoted',
        labelStrength: 'tool_input',
      },
    });
    expect(fake.written[1]).toMatchObject({
      table: 'run',
      values: { kind: 'quote', status: 'ok', workflowRunId: 'wf-1', episodeId: 'episode-new' },
    });
  });

  it('moves an existing episode forward on a booking and keeps its first tool time', async () => {
    const firstToolAt = new Date('2026-10-09T07:00:00Z');
    const fake = fakeLedgerDb({
      id: 'episode-1',
      outcome: 'quoted',
      bookedConfirmationNo: null,
      labelStrength: 'tool_input',
      firstToolAt,
      retentionExpiresAt: new Date('2027-01-01T00:00:00Z'),
    });
    await recorderFor(fake.db).record(
      draft({
        kind: 'stay_commit',
        messageId: 'message-1',
        confirmationNo: '57291630-1',
        episodeOutcome: 'booked',
      }),
    );
    const update = fake.written.find((write) => write.table === 'episode-update');
    expect(update?.values).toMatchObject({
      outcome: 'booked',
      labelStrength: 'booked',
      bookedConfirmationNo: '57291630-1',
      firstToolAt,
    });
    expect(fake.written.at(-1)).toMatchObject({
      table: 'run',
      values: { kind: 'stay_commit', episodeId: 'episode-1' },
    });
  });

  it('a later quote never undoes a booking', async () => {
    const fake = fakeLedgerDb({
      id: 'episode-1',
      outcome: 'booked',
      bookedConfirmationNo: '57291630-1',
      labelStrength: 'booked',
      firstToolAt: at,
      retentionExpiresAt: new Date('2027-01-01T00:00:00Z'),
    });
    await recorderFor(fake.db).record(draft({ kind: 'quote', messageId: 'message-1', episodeOutcome: 'quoted' }));
    const update = fake.written.find((write) => write.table === 'episode-update');
    expect(update?.values).toMatchObject({
      outcome: 'booked',
      bookedConfirmationNo: '57291630-1',
      labelStrength: 'booked',
    });
  });

  it('a run with no mail is written in the bounded ledger transaction, without an episode', async () => {
    const fake = fakeLedgerDb(null);
    await recorderFor(fake.db).record(draft({ kind: 'stay_lookup', messageId: null }));
    expect(fake.transaction).toHaveBeenCalledTimes(1);
    expect(fake.executed).toEqual(["SET LOCAL lock_timeout = '250ms'", "SET LOCAL statement_timeout = '250ms'"]);
    expect(fake.written).toEqual([
      expect.objectContaining({ table: 'run', values: expect.objectContaining({ episodeId: null, kind: 'stay_lookup' }) }),
    ]);
  });
});

describe('tool-run ledger: quote input', () => {
  it('keeps amounts, dates, counts and business names; leaves out contact details, notes and labels', () => {
    const parsed = staffQuoteInput.parse({
      messageId: 'message-1',
      sourceHash: 'a'.repeat(64),
      selectionEpoch: 1,
      inputRevision: 1,
      groups: [
        {
          id: 'g1',
          arrivalDate: '2026-10-12',
          departureDate: '2026-10-15',
          quantity: 1,
          adults: 2,
          childrenAges: [],
          board: 'bb',
          roomCodes: ['STQN'],
        },
      ],
      company: 'Acme Travel Ltd',
      agency: 'XYZ TRAVEL',
      attention: 'Thandi Mokoena',
      clientEmail: 'thandi@example.test',
      clientTelephone: '+27 82 555 0100',
      dinnerAllowanceMinor: 12_500,
      dinnerAllowanceUnit: 'per_person',
      dinnerAllowanceGroupIds: ['g1'],
      dinnerAllowanceLabel: 'food only',
      officeTransferMinor: 20_000,
      officeTransferDays: 2,
      other: { label: 'Parking pass', amountMinor: 30_000, unit: 'item' },
      notes: 'Late arrival, call Thandi',
    });
    const stored = ledgerQuoteInput({ ...parsed, party: { kind: 'agency', nativeId: '455', name: 'XYZ TRAVEL' } });
    expect(stored).toMatchObject({
      company: 'Acme Travel Ltd',
      agency: 'XYZ TRAVEL',
      party: { kind: 'agency', nativeId: '455', name: 'XYZ TRAVEL' },
      dinnerAllowanceMinor: 12_500,
      dinnerAllowanceUnit: 'per_person',
      dinnerAllowanceGroupIds: ['g1'],
      officeTransferMinor: 20_000,
      officeTransferDays: 2,
      other: { amountMinor: 30_000, unit: 'item' },
      groups: [expect.objectContaining({ arrivalDate: '2026-10-12', quantity: 1, roomCodes: ['STQN'] })],
    });
    expect(ledgerQuoteInput(parsed).party).toBeUndefined();
    const text = JSON.stringify(stored);
    for (const secret of ['Thandi', 'thandi@example', '555 0100', 'food only', 'Parking', 'Late arrival']) {
      expect(text).not.toContain(secret);
    }
  });
});

describe('tool-run ledger: middleware outcome', () => {
  beforeEach(() => setLedger('on'));

  const quoteSpec = (): ToolRunSpec => ({
    kind: 'quote',
    transportId: 'transport-1',
    messageId: 'message-1',
    userId: 'user-1',
    inputDigest: DIGEST,
  });
  const pdfSpec = (): ToolRunSpec => ({ ...quoteSpec(), kind: 'pdf' });
  const ready = { status: 'ready', revisionRef: 'quote:abc', totalMinor: 99_000, currency: 'ZAR' };

  it('with the flag off the procedure runs, nothing is built or written, and the database stays closed', async () => {
    setLedger(undefined);
    const sink = memorySink();
    toolRunLoaders.recorder = sink.recorder;
    const spec = vi.fn(quoteSpec);
    const outcome = { ok: true as const, data: ready };
    const next = vi.fn(async () => outcome);
    await expect(recordToolOutcome(spec, classifyStaffQuote, next)).resolves.toBe(outcome);
    expect(next).toHaveBeenCalledTimes(1);
    expect(spec).not.toHaveBeenCalled();
    expect(sink.rows).toEqual([]);
    expect(mocks.getDb).not.toHaveBeenCalled();
  });

  it('records a successful outcome from its data, and returns it unchanged', async () => {
    const sink = memorySink();
    toolRunLoaders.recorder = sink.recorder;
    const outcome = { ok: true as const, data: ready };
    await expect(recordToolOutcome(quoteSpec, classifyStaffQuote, async () => outcome)).resolves.toBe(outcome);
    expect(sink.rows[0]).toMatchObject({
      kind: 'quote',
      status: 'ok',
      messageId: 'message-1',
      userId: 'user-1',
      episodeOutcome: 'quoted',
      result: { revisionRef: 'quote:abc', totalMinor: 99_000, currency: 'ZAR' },
    });
  });

  it('records a thrown error from the code the procedure threw, not the wrapper tRPC puts around it', async () => {
    const sink = memorySink();
    toolRunLoaders.recorder = sink.recorder;
    const refusal = { ok: false as const, error: new TRPCError({ code: 'BAD_REQUEST', message: 'lastName Jane is not valid' }) };
    const wrapped = {
      ok: false as const,
      error: new TRPCError({
        code: 'INTERNAL_SERVER_ERROR',
        cause: Object.assign(new Error('render failed'), { code: 'PDF_RENDER_FAILED' }),
      }),
    };
    await expect(recordToolOutcome(pdfSpec, classifyPdf, async () => refusal)).resolves.toBe(refusal);
    await expect(recordToolOutcome(pdfSpec, classifyPdf, async () => wrapped)).resolves.toBe(wrapped);
    expect(sink.rows.map((row) => [row.status, row.errorCode])).toEqual([
      ['refused', 'BAD_REQUEST'],
      ['failed', 'PDF_RENDER_FAILED'],
    ]);
    expect(JSON.stringify(sink.rows)).not.toContain('Jane');
  });

  it('a ledger failure never changes the outcome', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    toolRunLoaders.recorder = memorySink('throws').recorder;
    const outcome = { ok: true as const, data: ready };
    await expect(recordToolOutcome(quoteSpec, classifyStaffQuote, async () => outcome)).resolves.toBe(outcome);
  });

  it('a spec that throws is logged as a draft failure, and the outcome still returns', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const sink = memorySink();
    toolRunLoaders.recorder = sink.recorder;
    const outcome = { ok: true as const, data: ready };
    await expect(
      recordToolOutcome(
        () => {
          throw new Error('bad input');
        },
        classifyStaffQuote,
        async () => outcome,
      ),
    ).resolves.toBe(outcome);
    expect(warn).toHaveBeenCalledWith('hitl_tool_record_skipped', { code: 'draft_failed' });
    expect(sink.rows).toEqual([]);
  });
});

describe('tool-run ledger: route sites', () => {
  beforeEach(() => setLedger('on'));

  it('quoteWorkflow.previewStay records a stay_preview with the preview digest', async () => {
    const sink = memorySink();
    toolRunLoaders.recorder = sink.recorder;
    mocks.runPaneStay.mockResolvedValue({ status: 'ok', previewDigest: DIGEST, outcome: 'preview' });
    await expect(caller().quoteWorkflow.previewStay(stayInput)).resolves.toMatchObject({ status: 'ok' });
    expect(sink.rows).toHaveLength(1);
    expect(sink.rows[0]).toMatchObject({
      kind: 'stay_preview',
      status: 'ok',
      transportId: 'transport-1',
      userId: 'user-1',
      messageId: null,
      inputDigest: DIGEST,
    });
  });

  it('quoteWorkflow.commitStay records a booked stay_commit, and an unconfirmed save as unconfirmed', async () => {
    const sink = memorySink();
    toolRunLoaders.recorder = sink.recorder;
    const previewDigest = 'c'.repeat(64);
    mocks.runPaneStay.mockResolvedValueOnce({ status: 'ok', confirmationNumber: '57291630-1', outcome: 'booked' });
    mocks.runPaneStay.mockResolvedValueOnce({ status: 'refused', reason: 'pane_save_unconfirmed' });
    await caller().quoteWorkflow.commitStay({ ...stayInput, previewDigest });
    await caller().quoteWorkflow.commitStay({ ...stayInput, previewDigest });
    expect(sink.rows.map((row) => [row.kind, row.status])).toEqual([
      ['stay_commit', 'ok'],
      ['stay_commit', 'unconfirmed'],
    ]);
    expect(sink.rows[0]).toMatchObject({
      confirmationNo: '57291630-1',
      inputDigest: previewDigest,
      episodeOutcome: 'booked',
    });
  });

  it('paneStayCancel.previewCancel and commitCancel record the cancel kinds with the cancel digest', async () => {
    const sink = memorySink();
    toolRunLoaders.recorder = sink.recorder;
    const cancel = { confirmation: '57291630-1', arrival: '2027-09-14' };
    const commit = { ...cancel, reason: 'guest request', previewDigest: DIGEST };
    mocks.previewCancel.mockResolvedValue({
      outcome: 'preview_ok',
      statusBefore: 'Confirmed',
      statusAfter: null,
      reasons: [],
      penaltyText: null,
    });
    mocks.commitCancel.mockResolvedValue({
      outcome: 'cancelled',
      statusBefore: 'Confirmed',
      statusAfter: 'Cancelled',
      reasons: [],
      penaltyText: null,
    });
    await caller().paneStayCancel.previewCancel(cancel);
    await caller().paneStayCancel.commitCancel(commit);
    expect(sink.rows).toEqual([
      expect.objectContaining({ kind: 'cancel_preview', status: 'ok', inputDigest: paneCancelDigest(cancel) }),
      expect.objectContaining({
        kind: 'cancel_commit',
        status: 'ok',
        confirmationNo: '57291630-1',
        episodeOutcome: 'cancelled',
        inputDigest: paneCancelDigest(commit),
      }),
    ]);
  });

  it('paneStayLookup.findStay records the request as a digest only', async () => {
    const sink = memorySink();
    toolRunLoaders.recorder = sink.recorder;
    mocks.findStay.mockResolvedValue({ outcome: 'found' });
    const request = { confirmation: '57291630-1', arrival: '2027-09-14' };
    await caller().paneStayLookup.findStay(request);
    expect(sink.rows[0]).toMatchObject({
      kind: 'stay_lookup',
      status: 'ok',
      inputDigest: toolInputDigest(request),
      result: { outcome: 'found' },
    });
    expect(JSON.stringify(sink.rows)).not.toContain('57291630');
  });

  it('paneStayLookup.searchGuest records the row count, never the names', async () => {
    const sink = memorySink();
    toolRunLoaders.recorder = sink.recorder;
    mocks.searchGuest.mockResolvedValue({ outcome: 'ok', rows: [{ name: 'Jane Doe' }, { name: 'John Doe' }] });
    await caller().paneStayLookup.searchGuest({ lastName: 'Doe', arrival: '2027-09-14' });
    expect(sink.rows[0]).toMatchObject({
      kind: 'guest_search',
      status: 'ok',
      result: { outcome: 'ok', rowCount: 2 },
    });
    expect(JSON.stringify(sink.rows)).not.toContain('Jane');
  });

  it('a refused lookup is recorded as refused, and the error still reaches the caller', async () => {
    const sink = memorySink();
    toolRunLoaders.recorder = sink.recorder;
    mocks.findStay.mockRejectedValue(
      new TRPCError({ code: 'BAD_REQUEST', message: 'confirmation 57291630-1 is not valid' }),
    );
    await expect(caller().paneStayLookup.findStay({ confirmation: '57291630-1' })).rejects.toThrow('not valid');
    expect(sink.rows[0]).toMatchObject({ kind: 'stay_lookup', status: 'refused', errorCode: 'BAD_REQUEST' });
    expect(JSON.stringify(sink.rows)).not.toContain('57291630');
  });

  it('a failing ledger never fails a route', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    toolRunLoaders.recorder = memorySink('throws').recorder;
    mocks.findStay.mockResolvedValue({ outcome: 'not_found' });
    await expect(caller().paneStayLookup.findStay({ confirmation: '57291630-1' })).resolves.toEqual({
      outcome: 'not_found',
    });
  });

  it('with the flag off the route runs, nothing is written, and the database stays closed', async () => {
    setLedger(undefined);
    const sink = memorySink();
    toolRunLoaders.recorder = sink.recorder;
    mocks.findStay.mockResolvedValue({ outcome: 'found' });
    await expect(caller().paneStayLookup.findStay({ confirmation: '57291630-1' })).resolves.toEqual({
      outcome: 'found',
    });
    expect(sink.rows).toEqual([]);
    expect(mocks.getDb).not.toHaveBeenCalled();
  });
});

describe('tool-run ledger: workstation route', () => {
  // The mailbox does not match the outlook address, so the procedure refuses before it reads the database.
  const request = {
    workflowRunId: 'wf-1',
    revisionRef: 'quote:abc',
    messageId: 'message-1',
    outlookEmail: 'someone-else@example.test',
  };

  it('records the refused PDF from the middleware, and the refusal still reaches the caller', async () => {
    setLedger('on');
    const sink = memorySink();
    toolRunLoaders.recorder = sink.recorder;
    await expect(caller().workstation.qualifiedQuoteProposalPdf(request)).rejects.toMatchObject({
      code: 'FORBIDDEN',
      message: 'OUTLOOK_EMAIL_MISMATCH',
    });
    expect(sink.rows).toEqual([
      expect.objectContaining({
        kind: 'pdf',
        status: 'refused',
        errorCode: 'FORBIDDEN',
        transportId: 'transport-1',
        userId: 'user-1',
        messageId: 'message-1',
        workflowRunId: 'wf-1',
      }),
    ]);
    expect(mocks.getDb).not.toHaveBeenCalled();
  });

  it('with the flag off the refusal is unchanged and nothing is written', async () => {
    setLedger(undefined);
    const sink = memorySink();
    toolRunLoaders.recorder = sink.recorder;
    await expect(caller().workstation.qualifiedQuoteProposalPdf(request)).rejects.toMatchObject({ code: 'FORBIDDEN' });
    expect(sink.rows).toEqual([]);
  });
});

/** A ledger handle whose transaction never settles: the request sees a stalled database or a drained pool. */
function stalledLedgerDb(): DB {
  const transaction = vi.fn(() => new Promise<never>(() => {}));
  return { transaction, insert: vi.fn() } as unknown as DB;
}

describe('tool-run ledger: a stalled write', () => {
  beforeEach(() => setLedger('on'));

  it('a stalled insert holds the tool for at most the cap, with a mail or without one', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const recorder = createToolRunRecorder(stalledLedgerDb(), { enabled: true })!;
    const started = Date.now();
    await expect(
      recordedToolRun(spec(), async () => 'found', ok, undefined, { recorder, capMs: 25 }),
    ).resolves.toBe('found');
    await expect(
      recordedToolRun(spec({ messageId: 'message-1' }), async () => 'pdf', ok, undefined, { recorder, capMs: 25 }),
    ).resolves.toBe('pdf');
    expect(Date.now() - started).toBeLessThan(1_000);
  });

  it('a stalled insert holds a middleware outcome for at most the cap', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    toolRunLoaders.recorder = createToolRunRecorder(stalledLedgerDb(), { enabled: true });
    const outcome = { ok: true as const, data: { status: 'ready' } };
    const started = Date.now();
    await expect(
      recordToolOutcome(
        () => ({ kind: 'quote', transportId: 'transport-1', messageId: 'message-1', userId: 'user-1', inputDigest: DIGEST }),
        classifyStaffQuote,
        async () => outcome,
      ),
    ).resolves.toBe(outcome);
    expect(Date.now() - started).toBeLessThan(2_000);
  });

  it('a stalled ledger does not hold a stay lookup past the cap', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    mocks.getDb.mockReturnValueOnce(stalledLedgerDb() as never);
    mocks.findStay.mockResolvedValue({ outcome: 'found' });
    const started = Date.now();
    await expect(caller().paneStayLookup.findStay({ confirmation: '57291630-1' })).resolves.toEqual({
      outcome: 'found',
    });
    expect(Date.now() - started).toBeLessThan(2_000);
  });
});

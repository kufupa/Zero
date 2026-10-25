import { and, eq } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import {
  enqueueReplyCheckIfNeeded,
  executeReplyCheckRun,
  parseReplyRecheckMode,
  replyCheckIdempotencyKey,
  REPLY_CHECK_MODEL_ID,
  REPLY_CHECK_PROMPT_VERSION,
  staffReplyBody,
} from '../src/ai/reply-check.js';
import type { ModelAdapter, ModelInvokeResult } from '../src/ai/bedrock/adapter.js';
import { toAiRunFence } from '../src/ai/run-ledger.js';
import { __setDbForTests, type DB } from '../src/db/client.js';
import { aiWorkflowRun, mailboxTransport, message } from '../src/db/schema/mail.js';
import { workEvent, workItem } from '../src/db/schema/work.js';
import { DAVINCI_TRANSPORT_EMAIL, DAVINCI_TRANSPORT_ID } from '../src/db/seed.js';
import { seedInboxThread } from './helpers/seed-inbox-thread.js';
import { withIngestionDb } from './helpers/ingestion-db.js';

const CENTURION = 'transport-centurion';
const CENTURION_EMAIL = 'centurion@legacyhotels.co.za';
const DAVINCI = DAVINCI_TRANSPORT_ID;
const COLLECTOR = 'transport-nava';
const COLLECTOR_EMAIL = 'navaai@legacyhotels.co.za';
const GUEST = 'guest@example.com';

const USAGE: ModelInvokeResult['usage'] = {
  inputTokens: 8,
  outputTokens: 4,
  totalTokens: 12,
  latencyMs: 4,
  estimatedCostUsd: 0,
  rateTableVersion: 'test',
};

function withDb(run: (db: DB) => Promise<void>) {
  return withIngestionDb(async ({ db, sql }) => {
    __setDbForTests({ db, conn: sql });
    try {
      await run(db);
    } finally {
      __setDbForTests(null);
    }
  });
}

function adapterReturning(
  outcome: 'handled' | 'waiting_on_guest' | 'needs_more_action' | Record<string, unknown>,
  reason = 'one-line reason',
): ModelAdapter {
  const output =
    typeof outcome === 'string' ? { outcome, reason } : outcome;
  return {
    async invoke() {
      return { modelId: REPLY_CHECK_MODEL_ID, output, usage: USAGE };
    },
  };
}

function failingAdapter(): ModelAdapter {
  return {
    async invoke() {
      throw new Error('model down');
    },
  };
}

function keywordAdapter(): ModelAdapter {
  return {
    async invoke(input) {
      const text = input.userPrompt.toLowerCase();
      if (text.includes('come back with rates')) {
        return {
          modelId: REPLY_CHECK_MODEL_ID,
          output: { outcome: 'needs_more_action', reason: "said they'd come back with rates" },
          usage: USAGE,
        };
      }
      if (text.includes('what dates') || text.includes('please send the dates')) {
        return {
          modelId: REPLY_CHECK_MODEL_ID,
          output: { outcome: 'waiting_on_guest', reason: 'asked guest for dates' },
          usage: USAGE,
        };
      }
      return {
        modelId: REPLY_CHECK_MODEL_ID,
        output: { outcome: 'handled', reason: 'full quote sent' },
        usage: USAGE,
      };
    },
  };
}

async function seedHotel(
  db: DB,
  opts: { transportId: string; transportEmail: string },
) {
  await db
    .insert(mailboxTransport)
    .values({
      id: opts.transportId,
      email: opts.transportEmail,
      ownerHeaderValue: opts.transportEmail,
      mailboxType: 'personal',
      sendFromConfig: { aliases: [] },
    })
    .onConflictDoNothing({ target: mailboxTransport.id });
}

async function quoteClosedByReply(
  db: DB,
  opts: {
    id: string;
    transportId?: string;
    transportEmail?: string;
    replyBody: string;
    requestBody?: string;
  },
) {
  const transportId = opts.transportId ?? CENTURION;
  const transportEmail = opts.transportEmail ?? CENTURION_EMAIL;
  const threadId = `thread-${opts.id}`;
  const requestId = `msg-${opts.id}-in`;
  const replyId = `msg-${opts.id}-out`;
  await seedInboxThread(db, {
    threadId,
    transportId,
    transportEmail,
    messageId: requestId,
    fromAddress: GUEST,
    subject: 'Rooms request',
    textBody: opts.requestBody ?? 'Please quote 2 rooms 26–28 Oct.',
    messageIdHeader: `${opts.id}-in@example.com`,
  });
  await db.insert(message).values({
    id: replyId,
    transportId,
    threadId,
    direction: 'outbound',
    fromAddress: transportEmail,
    toAddresses: [GUEST],
    subject: 'Re: Rooms request',
    textBody: opts.replyBody,
    ownerHeaderValue: transportEmail,
    messageIdHeader: `${opts.id}-out@example.com`,
    sentAt: new Date('2027-10-01T09:00:00Z'),
  });
  const [item] = await db
    .insert(workItem)
    .values({
      transportId,
      threadId,
      sourceMessageId: requestId,
      kind: 'quote',
      status: 'done',
      sentMessageId: replyId,
      sentAt: new Date('2027-10-01T09:00:00Z'),
    })
    .returning({ id: workItem.id });
  if (!item) throw new Error('work item missing');
  await db.insert(workEvent).values({
    workItemId: item.id,
    actorKind: 'system',
    type: 'status.changed',
    value: { from: 'needs_you', to: 'done', reason: 'hotel_replied', sentMessageId: replyId },
  });
  return { itemId: item.id, replyId, threadId, transportId };
}

async function claimReplyCheck(db: DB, workItemId: string, replyId: string) {
  const [run] = await db
    .update(aiWorkflowRun)
    .set({
      state: 'running',
      claimOwner: 'reply-check-test',
      claimToken: `token-${workItemId}`,
      deadlineAt: new Date(Date.now() + 60_000),
    })
    .where(
      and(eq(aiWorkflowRun.workItemId, workItemId), eq(aiWorkflowRun.triggerMessageId, replyId)),
    )
    .returning();
  if (!run) throw new Error('no reply_check run');
  const fence = toAiRunFence(run);
  if (!fence) throw new Error('claimed run has no fence');
  return { run, fence };
}

describe('parseReplyRecheckMode', () => {
  it('defaults off, and only shadow or on leave off', () => {
    expect(parseReplyRecheckMode(undefined)).toBe('off');
    expect(parseReplyRecheckMode('')).toBe('off');
    expect(parseReplyRecheckMode('SHADOW')).toBe('shadow');
    expect(parseReplyRecheckMode('on')).toBe('on');
    expect(parseReplyRecheckMode('nova_lite')).toBe('off');
  });
});

describe('staffReplyBody', () => {
  it('strips quoted history and a signature', () => {
    expect(
      staffReplyBody(
        "We'll come back with rates.\n\nOn Mon, guest wrote:\nPlease quote\n-- \nReservations",
      ),
    ).toBe("We'll come back with rates.");
  });
});

describe('reply-check job', () => {
  it('does not enqueue when REPLY_RECHECK is off', () =>
    withDb(async (db) => {
      const closed = await quoteClosedByReply(db, {
        id: 'off-1',
        replyBody: "We'll come back with rates.",
      });
      await enqueueReplyCheckIfNeeded(db, {
        transportId: closed.transportId,
        threadId: closed.threadId,
        workItemId: closed.itemId,
        replyMessageId: closed.replyId,
      }, { REPLY_RECHECK: 'off' });
      expect(
        await db.select({ id: aiWorkflowRun.id }).from(aiWorkflowRun),
      ).toEqual([]);
    }));

  it('never checks a collector mailbox', () =>
    withDb(async (db) => {
      await seedHotel(db, { transportId: COLLECTOR, transportEmail: COLLECTOR_EMAIL });
      const closed = await quoteClosedByReply(db, {
        id: 'collector-1',
        transportId: COLLECTOR,
        transportEmail: COLLECTOR_EMAIL,
        replyBody: "We'll come back with rates.",
      });
      await enqueueReplyCheckIfNeeded(db, {
        transportId: closed.transportId,
        threadId: closed.threadId,
        workItemId: closed.itemId,
        replyMessageId: closed.replyId,
      }, { REPLY_RECHECK: 'on' });
      expect(
        await db.select({ id: aiWorkflowRun.id }).from(aiWorkflowRun),
      ).toEqual([]);
    }));

  it('enqueues reply_check keyed by work item and reply, on gpt-6-luna', () =>
    withDb(async (db) => {
      const closed = await quoteClosedByReply(db, {
        id: 'key-1',
        replyBody: 'Please find our quote.',
      });
      await enqueueReplyCheckIfNeeded(db, {
        transportId: closed.transportId,
        threadId: closed.threadId,
        workItemId: closed.itemId,
        replyMessageId: closed.replyId,
      }, { REPLY_RECHECK: 'shadow' });
      const [run] = await db.select().from(aiWorkflowRun);
      expect(run).toMatchObject({
        runKind: 'reply_check',
        idempotencyKey: replyCheckIdempotencyKey(closed.itemId, closed.replyId),
        modelId: REPLY_CHECK_MODEL_ID,
        promptVersion: REPLY_CHECK_PROMPT_VERSION,
        workItemId: closed.itemId,
        triggerMessageId: closed.replyId,
      });
    }));

  it("we'll come back with rates reopens the same to-do with a one-line reason", () =>
    withDb(async (db) => {
      const closed = await quoteClosedByReply(db, {
        id: 'rates-1',
        replyBody: "We'll come back with rates tomorrow.",
      });
      await enqueueReplyCheckIfNeeded(db, {
        transportId: closed.transportId,
        threadId: closed.threadId,
        workItemId: closed.itemId,
        replyMessageId: closed.replyId,
      }, { REPLY_RECHECK: 'on' });
      const { run, fence } = await claimReplyCheck(db, closed.itemId, closed.replyId);
      expect(
        await executeReplyCheckRun({
          run,
          fence,
          db,
          env: { REPLY_RECHECK: 'on' },
          adapter: keywordAdapter(),
        }),
      ).toEqual({ runId: run.id, state: 'succeeded' });
      const [item] = await db.select().from(workItem).where(eq(workItem.id, closed.itemId));
      expect(item?.status).toBe('needs_you');
      const events = await db
        .select({ type: workEvent.type, value: workEvent.value })
        .from(workEvent)
        .where(eq(workEvent.workItemId, closed.itemId));
      expect(events).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            type: 'status.changed',
            value: expect.objectContaining({
              to: 'needs_you',
              reason: 'reply_needs_action',
              reasonLine: "said they'd come back with rates",
            }),
          }),
        ]),
      );
    }));

  it('a full quote stays done', () =>
    withDb(async (db) => {
      const closed = await quoteClosedByReply(db, {
        id: 'quote-1',
        replyBody: 'Please find the attached quotation for 2 rooms, R1 850 per night B&B.',
      });
      await enqueueReplyCheckIfNeeded(db, {
        transportId: closed.transportId,
        threadId: closed.threadId,
        workItemId: closed.itemId,
        replyMessageId: closed.replyId,
      }, { REPLY_RECHECK: 'on' });
      const { run, fence } = await claimReplyCheck(db, closed.itemId, closed.replyId);
      await executeReplyCheckRun({
        run,
        fence,
        db,
        env: { REPLY_RECHECK: 'on' },
        adapter: keywordAdapter(),
      });
      const [item] = await db.select().from(workItem).where(eq(workItem.id, closed.itemId));
      expect(item?.status).toBe('done');
    }));

  it('asking the guest for dates stays done as waiting on guest', () =>
    withDb(async (db) => {
      const closed = await quoteClosedByReply(db, {
        id: 'dates-1',
        replyBody: 'Could you please send the dates you need?',
      });
      await enqueueReplyCheckIfNeeded(db, {
        transportId: closed.transportId,
        threadId: closed.threadId,
        workItemId: closed.itemId,
        replyMessageId: closed.replyId,
      }, { REPLY_RECHECK: 'on' });
      const { run, fence } = await claimReplyCheck(db, closed.itemId, closed.replyId);
      await executeReplyCheckRun({
        run,
        fence,
        db,
        env: { REPLY_RECHECK: 'on' },
        adapter: keywordAdapter(),
      });
      const [item] = await db.select().from(workItem).where(eq(workItem.id, closed.itemId));
      expect(item?.status).toBe('done');
      const [runRow] = await db.select().from(aiWorkflowRun).where(eq(aiWorkflowRun.id, run.id));
      expect(runRow?.metrics).toEqual(
        expect.objectContaining({
          replyCheck: expect.objectContaining({ outcome: 'waiting_on_guest' }),
        }),
      );
    }));

  it('shadow logs needs_more_action and leaves the to-do done', () =>
    withDb(async (db) => {
      const closed = await quoteClosedByReply(db, {
        id: 'shadow-1',
        replyBody: "We'll come back with rates.",
      });
      await enqueueReplyCheckIfNeeded(db, {
        transportId: closed.transportId,
        threadId: closed.threadId,
        workItemId: closed.itemId,
        replyMessageId: closed.replyId,
      }, { REPLY_RECHECK: 'shadow' });
      const { run, fence } = await claimReplyCheck(db, closed.itemId, closed.replyId);
      await executeReplyCheckRun({
        run,
        fence,
        db,
        env: { REPLY_RECHECK: 'shadow' },
        adapter: keywordAdapter(),
      });
      const [item] = await db.select().from(workItem).where(eq(workItem.id, closed.itemId));
      expect(item?.status).toBe('done');
      const [runRow] = await db.select().from(aiWorkflowRun).where(eq(aiWorkflowRun.id, run.id));
      expect(runRow?.metrics).toEqual(
        expect.objectContaining({
          replyCheck: expect.objectContaining({
            outcome: 'needs_more_action',
            mode: 'shadow',
            applied: false,
          }),
        }),
      );
    }));

  it('a model failure leaves the to-do done', () =>
    withDb(async (db) => {
      const closed = await quoteClosedByReply(db, {
        id: 'fail-1',
        replyBody: "We'll come back with rates.",
      });
      await enqueueReplyCheckIfNeeded(db, {
        transportId: closed.transportId,
        threadId: closed.threadId,
        workItemId: closed.itemId,
        replyMessageId: closed.replyId,
      }, { REPLY_RECHECK: 'on' });
      const { run, fence } = await claimReplyCheck(db, closed.itemId, closed.replyId);
      expect(
        await executeReplyCheckRun({
          run,
          fence,
          db,
          env: { REPLY_RECHECK: 'on' },
          adapter: failingAdapter(),
        }),
      ).toEqual({ runId: run.id, state: 'succeeded' });
      const [item] = await db.select().from(workItem).where(eq(workItem.id, closed.itemId));
      expect(item?.status).toBe('done');
    }));

  it('a second reply supersedes the first check', () =>
    withDb(async (db) => {
      const closed = await quoteClosedByReply(db, {
        id: 'super-1',
        replyBody: "We'll come back with rates.",
      });
      await enqueueReplyCheckIfNeeded(db, {
        transportId: closed.transportId,
        threadId: closed.threadId,
        workItemId: closed.itemId,
        replyMessageId: closed.replyId,
      }, { REPLY_RECHECK: 'on' });
      const secondId = 'msg-super-1-out-2';
      await db.insert(message).values({
        id: secondId,
        transportId: closed.transportId,
        threadId: closed.threadId,
        direction: 'outbound',
        fromAddress: CENTURION_EMAIL,
        toAddresses: [GUEST],
        subject: 'Re: Rooms request',
        textBody: 'Please find the attached quotation for 2 rooms.',
        ownerHeaderValue: CENTURION_EMAIL,
        messageIdHeader: 'super-1-out-2@example.com',
        sentAt: new Date('2027-10-01T10:00:00Z'),
      });
      await db
        .update(workItem)
        .set({ sentMessageId: secondId, sentAt: new Date('2027-10-01T10:00:00Z') })
        .where(eq(workItem.id, closed.itemId));
      const { run, fence } = await claimReplyCheck(db, closed.itemId, closed.replyId);
      await executeReplyCheckRun({
        run,
        fence,
        db,
        env: { REPLY_RECHECK: 'on' },
        adapter: adapterReturning('needs_more_action', "said they'd come back with rates"),
      });
      const [item] = await db.select().from(workItem).where(eq(workItem.id, closed.itemId));
      expect(item?.status).toBe('done');
      const [runRow] = await db.select().from(aiWorkflowRun).where(eq(aiWorkflowRun.id, run.id));
      expect(runRow?.metrics).toEqual(
        expect.objectContaining({
          replyCheck: expect.objectContaining({ skipped: 'superseded' }),
        }),
      );
    }));

  it('a Centurion reply never touches a Da Vinci to-do', () =>
    withDb(async (db) => {
      await seedHotel(db, { transportId: DAVINCI, transportEmail: DAVINCI_TRANSPORT_EMAIL });
      const cen = await quoteClosedByReply(db, {
        id: 'cen-1',
        replyBody: "We'll come back with rates.",
      });
      const dv = await quoteClosedByReply(db, {
        id: 'dv-1',
        transportId: DAVINCI,
        transportEmail: DAVINCI_TRANSPORT_EMAIL,
        replyBody: 'Please find our quote.',
      });
      await enqueueReplyCheckIfNeeded(db, {
        transportId: cen.transportId,
        threadId: cen.threadId,
        workItemId: cen.itemId,
        replyMessageId: cen.replyId,
      }, { REPLY_RECHECK: 'on' });
      const { run, fence } = await claimReplyCheck(db, cen.itemId, cen.replyId);
      await executeReplyCheckRun({
        run,
        fence,
        db,
        env: { REPLY_RECHECK: 'on' },
        adapter: keywordAdapter(),
      });
      const [dvItem] = await db.select().from(workItem).where(eq(workItem.id, dv.itemId));
      expect(dvItem?.status).toBe('done');
      expect(
        await db
          .select({ id: aiWorkflowRun.id })
          .from(aiWorkflowRun)
          .where(eq(aiWorkflowRun.workItemId, dv.itemId)),
      ).toEqual([]);
    }));
});

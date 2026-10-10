import {
  addSaBusinessDays,
  executeQuoteFollowupRun,
  runQuoteFollowupSweep,
} from '../src/ai/quote-followup.js';
import {
  aiWorkflowRun,
  attachment,
  mailDraft,
  mailDraftRevision,
  message,
} from '../src/db/schema/mail.js';
import { NAVA_USER_EMAIL, NAVA_USER_ID } from '../src/db/seed.js';
import { seedInboxThread } from './helpers/seed-inbox-thread.js';
import { workEvent, workItem } from '../src/db/schema/work.js';
import { withIngestionDb } from './helpers/ingestion-db.js';
import { toAiRunFence } from '../src/ai/run-ledger.js';
import { user } from '../src/db/schema/auth.js';
import type { DB } from '../src/db/client.js';
import { describe, expect, it } from 'vitest';
import { and, eq } from 'drizzle-orm';

const TRANSPORT = 'transport-centurion';
const TRANSPORT_EMAIL = 'centurion@legacyhotels.co.za';
const ON = { QUOTE_FOLLOWUPS: 'on' } as NodeJS.ProcessEnv;
const OFF = { QUOTE_FOLLOWUPS: 'off' } as NodeJS.ProcessEnv;
// Mon 2026-10-05 09:00 SAST: the quote request arrives.
const REQUEST_AT = new Date('2026-10-05T07:00:00Z');
// Fri 2026-10-09 10:00 SAST: the quote is sent.
const FRI_SEND = new Date('2026-10-09T08:00:00Z');
// Three SA business days later: Wed 2026-10-14 10:00 SAST.
const WED_DUE = new Date('2026-10-14T08:00:00Z');

describe('addSaBusinessDays', () => {
  it('a Friday send falls due on the Wednesday, skipping the weekend', () => {
    expect(addSaBusinessDays(FRI_SEND, 3)).toEqual(WED_DUE);
  });

  it('skips a weekday public holiday (Youth Day, Tue 16 June 2026)', () => {
    expect(addSaBusinessDays(new Date('2026-06-15T08:00:00Z'), 3).toISOString()).toBe(
      '2026-06-19T08:00:00.000Z',
    );
  });

  it("skips a Sunday holiday and its Monday substitute (Women's Day, 9-10 August 2026)", () => {
    expect(addSaBusinessDays(new Date('2026-08-07T08:00:00Z'), 3).toISOString()).toBe(
      '2026-08-13T08:00:00.000Z',
    );
  });

  it('counts the Johannesburg calendar day, so Fri 23:30 UTC (Sat 01:30 local) starts on a Saturday', () => {
    expect(addSaBusinessDays(new Date('2026-10-09T23:30:00Z'), 3).toISOString()).toBe(
      '2026-10-13T23:30:00.000Z',
    );
  });
});

async function seedNavaUser(db: DB) {
  await db
    .insert(user)
    .values({ id: NAVA_USER_ID, name: 'Nava AI', email: NAVA_USER_EMAIL, emailVerified: true })
    .onConflictDoNothing();
}

/** A quote request that arrived at `requestAt`, with its open work item. Returns the item id. */
async function quoteRequest(
  db: DB,
  threadId: string,
  requestAt: Date,
  status: 'needs_you' | 'review' | 'done' = 'needs_you',
): Promise<string> {
  const requestId = `${threadId}-request`;
  await seedInboxThread(db, {
    threadId,
    transportId: TRANSPORT,
    transportEmail: TRANSPORT_EMAIL,
    messageId: requestId,
    fromAddress: 'guest@example.com',
    subject: 'Quote request',
    textBody: 'Could you quote 2 rooms for 3 nights?',
    messageIdHeader: `${requestId}@example.com`,
  });
  await db.update(message).set({ receivedAt: requestAt }).where(eq(message.id, requestId));
  const [item] = await db
    .insert(workItem)
    .values({ transportId: TRANSPORT, threadId, sourceMessageId: requestId, kind: 'quote', status })
    .returning({ id: workItem.id });
  if (!item) throw new Error('work item not created');
  return item.id;
}

/** Our outbound message. Attached or body-only: the follow-up clock starts either way. */
async function sendReply(
  db: DB,
  opts: { id: string; threadId: string; sentAt: Date; attach?: boolean },
) {
  await db.insert(message).values({
    id: opts.id,
    transportId: TRANSPORT,
    threadId: opts.threadId,
    direction: 'outbound',
    fromAddress: TRANSPORT_EMAIL,
    toAddresses: ['guest@example.com'],
    ccAddresses: [],
    bccAddresses: [],
    subject: 'Re: Quote request',
    textBody: 'Please find our quote below.',
    ownerHeaderValue: TRANSPORT_EMAIL,
    messageIdHeader: `${opts.id}@example.com`,
    references: [],
    isRead: true,
    isStarred: false,
    sentAt: opts.sentAt,
  });
  if (opts.attach) {
    await db.insert(attachment).values({
      id: `${opts.id}-quote`,
      messageId: opts.id,
      filename: 'quote.pdf',
      mimeType: 'application/pdf',
      sizeBytes: 2048,
      s3Key: `test/${opts.id}.pdf`,
    });
  }
}

async function clientReplies(db: DB, threadId: string, id: string, receivedAt: Date) {
  await db.insert(message).values({
    id,
    transportId: TRANSPORT,
    threadId,
    direction: 'inbound',
    fromAddress: 'guest@example.com',
    toAddresses: [TRANSPORT_EMAIL],
    ccAddresses: [],
    bccAddresses: [],
    subject: 'Re: Quote request',
    textBody: 'Yes, please go ahead.',
    ownerHeaderValue: TRANSPORT_EMAIL,
    messageIdHeader: `${id}@example.com`,
    references: [],
    isRead: false,
    isStarred: false,
    receivedAt,
  });
}

async function loadItem(db: DB, id: string) {
  const [row] = await db.select().from(workItem).where(eq(workItem.id, id)).limit(1);
  if (!row) throw new Error('work item missing');
  return row;
}

async function followUpRuns(db: DB, workItemId: string) {
  return db
    .select()
    .from(aiWorkflowRun)
    .where(
      and(eq(aiWorkflowRun.workItemId, workItemId), eq(aiWorkflowRun.runKind, 'quote_followup')),
    );
}

/** Marks the queued run as claimed, the way claimNextAiRun does, and returns it with its fence. */
async function claimRun(db: DB, workItemId: string) {
  const [run] = await db
    .update(aiWorkflowRun)
    .set({
      state: 'running',
      claimOwner: 'w4-test',
      claimToken: `token-${workItemId}`,
      deadlineAt: new Date(Date.now() + 60_000),
    })
    .where(
      and(eq(aiWorkflowRun.workItemId, workItemId), eq(aiWorkflowRun.runKind, 'quote_followup')),
    )
    .returning();
  if (!run) throw new Error('no quote_followup run to claim');
  const fence = toAiRunFence(run);
  if (!fence) throw new Error('claimed run has no fence');
  return { run, fence };
}

async function threadDrafts(db: DB, threadId: string) {
  return db.select().from(mailDraft).where(eq(mailDraft.threadId, threadId));
}

async function runOutcome(db: DB, runId: string) {
  const [row] = await db.select().from(aiWorkflowRun).where(eq(aiWorkflowRun.id, runId));
  const metrics = row?.metrics as { quoteFollowup?: { outcome?: string } } | null | undefined;
  return metrics?.quoteFollowup?.outcome;
}

describe('quote follow-up drafts', () => {
  it('a body-only send and a send with the quote attached both fall due on the Wednesday', async () => {
    await withIngestionDb(async ({ db }) => {
      await seedNavaUser(db);
      const attached = await quoteRequest(db, 'thread-attached', REQUEST_AT);
      const bodyOnly = await quoteRequest(db, 'thread-body', REQUEST_AT);
      await sendReply(db, {
        id: 'out-attached',
        threadId: 'thread-attached',
        sentAt: FRI_SEND,
        attach: true,
      });
      await sendReply(db, { id: 'out-body', threadId: 'thread-body', sentAt: FRI_SEND });

      const counts = await runQuoteFollowupSweep({ db, env: ON, now: FRI_SEND });

      expect(counts).toEqual({ linked: 2, cancelled: 0, queued: 0 });
      for (const [itemId, sentId] of [
        [attached, 'out-attached'],
        [bodyOnly, 'out-body'],
      ] as const) {
        const item = await loadItem(db, itemId);
        expect(item.sentMessageId).toBe(sentId);
        expect(item.sentAt).toEqual(FRI_SEND);
        expect(item.followUpDueAt).toEqual(WED_DUE);
      }
    });
  });

  it('a client reply after the send cancels the follow-up', async () => {
    await withIngestionDb(async ({ db }) => {
      await seedNavaUser(db);
      const itemId = await quoteRequest(db, 'thread-reply', REQUEST_AT);
      await sendReply(db, { id: 'out-reply', threadId: 'thread-reply', sentAt: FRI_SEND });
      await runQuoteFollowupSweep({ db, env: ON, now: FRI_SEND });
      await clientReplies(db, 'thread-reply', 'in-reply', new Date('2026-10-12T07:00:00Z'));

      const counts = await runQuoteFollowupSweep({ db, env: ON, now: WED_DUE });

      expect(counts).toEqual({ linked: 0, cancelled: 1, queued: 0 });
      expect((await loadItem(db, itemId)).followUpDueAt).toBeNull();
      expect(await followUpRuns(db, itemId)).toHaveLength(0);
    });
  });

  it('a due item queues one run, and reruns neither duplicate the run nor the draft', async () => {
    await withIngestionDb(async ({ db }) => {
      await seedNavaUser(db);
      const itemId = await quoteRequest(db, 'thread-rerun', REQUEST_AT, 'review');
      await sendReply(db, { id: 'out-rerun', threadId: 'thread-rerun', sentAt: FRI_SEND });
      await runQuoteFollowupSweep({ db, env: ON, now: FRI_SEND });

      expect(await runQuoteFollowupSweep({ db, env: ON, now: WED_DUE })).toEqual({
        linked: 0,
        cancelled: 0,
        queued: 1,
      });
      // A later pass, or a crash before the due date was cleared, must find the same run key.
      await db.update(workItem).set({ followUpDueAt: WED_DUE }).where(eq(workItem.id, itemId));
      await runQuoteFollowupSweep({ db, env: ON, now: WED_DUE });
      await runQuoteFollowupSweep({ db, env: ON, now: WED_DUE });
      expect(await followUpRuns(db, itemId)).toHaveLength(1);

      const { run, fence } = await claimRun(db, itemId);
      expect(await executeQuoteFollowupRun({ run, fence, db, env: ON })).toEqual({
        runId: run.id,
        state: 'succeeded',
      });
      // The same run executed again (a lost fence) writes nothing new.
      await executeQuoteFollowupRun({ run, fence, db, env: ON });

      const drafts = await threadDrafts(db, 'thread-rerun');
      expect(drafts).toHaveLength(1);
      expect(drafts[0]).toMatchObject({
        id: 'quote-followup:out-rerun',
        status: 'candidate',
        origin: 'manual',
        createdByUserId: NAVA_USER_ID,
        replyToMessageId: 'out-rerun',
        subject: 'Re: Quote request',
      });
      expect(drafts[0]?.textBody).toContain('the quote we sent on 9 October');
      expect(
        await db
          .select()
          .from(mailDraftRevision)
          .where(eq(mailDraftRevision.draftId, 'quote-followup:out-rerun')),
      ).toHaveLength(1);

      expect((await loadItem(db, itemId)).status).toBe('needs_you');
      const events = await db.select().from(workEvent).where(eq(workEvent.workItemId, itemId));
      expect(events.filter((e) => e.type === 'status.changed')).toEqual([
        expect.objectContaining({
          actorKind: 'system',
          value: { from: 'review', to: 'needs_you' },
        }),
      ]);
      expect(await runOutcome(db, run.id)).toBe('drafted');
    });
  });

  it('an existing active draft on the thread is left untouched', async () => {
    await withIngestionDb(async ({ db }) => {
      await seedNavaUser(db);
      const itemId = await quoteRequest(db, 'thread-active', REQUEST_AT);
      await sendReply(db, { id: 'out-active', threadId: 'thread-active', sentAt: FRI_SEND });
      await db.insert(mailDraft).values({
        id: 'active-draft',
        transportId: TRANSPORT,
        threadId: 'thread-active',
        createdByUserId: NAVA_USER_ID,
        subject: 'Re: Quote request',
        textBody: 'Our own draft, in progress.',
        status: 'active',
        origin: 'manual',
      });
      await runQuoteFollowupSweep({ db, env: ON, now: WED_DUE });
      const { run, fence } = await claimRun(db, itemId);

      await executeQuoteFollowupRun({ run, fence, db, env: ON });

      const drafts = await threadDrafts(db, 'thread-active');
      expect(drafts.map((d) => [d.id, d.status, d.textBody]).sort()).toEqual([
        ['active-draft', 'active', 'Our own draft, in progress.'],
        ['quote-followup:out-active', 'candidate', expect.any(String)],
      ]);
    });
  });

  it('a client reply that lands after the run is queued stops the draft', async () => {
    await withIngestionDb(async ({ db }) => {
      await seedNavaUser(db);
      const itemId = await quoteRequest(db, 'thread-late', REQUEST_AT);
      await sendReply(db, { id: 'out-late', threadId: 'thread-late', sentAt: FRI_SEND });
      await runQuoteFollowupSweep({ db, env: ON, now: WED_DUE });
      await clientReplies(db, 'thread-late', 'in-late', new Date('2026-10-14T07:00:00Z'));
      const { run, fence } = await claimRun(db, itemId);

      await executeQuoteFollowupRun({ run, fence, db, env: ON });

      expect(await threadDrafts(db, 'thread-late')).toHaveLength(0);
      expect(await runOutcome(db, run.id)).toBe('client_replied');
    });
  });

  it('with QUOTE_FOLLOWUPS off the sweep does nothing, and a queued run is deferred', async () => {
    await withIngestionDb(async ({ db }) => {
      await seedNavaUser(db);
      const itemId = await quoteRequest(db, 'thread-off', REQUEST_AT);
      await sendReply(db, { id: 'out-off', threadId: 'thread-off', sentAt: FRI_SEND });

      expect(await runQuoteFollowupSweep({ db, env: OFF, now: WED_DUE })).toEqual({
        linked: 0,
        cancelled: 0,
        queued: 0,
      });
      expect((await loadItem(db, itemId)).sentMessageId).toBeNull();

      await runQuoteFollowupSweep({ db, env: ON, now: WED_DUE });
      const { run, fence } = await claimRun(db, itemId);
      expect(await executeQuoteFollowupRun({ run, fence, db, env: OFF })).toEqual({
        runId: run.id,
        state: 'retry_wait',
      });
      expect(await threadDrafts(db, 'thread-off')).toHaveLength(0);
      const [row] = await followUpRuns(db, itemId);
      expect(row).toMatchObject({ state: 'retry_wait', failureClass: 'POLICY_BLOCK' });
    });
  });

  it('a done quote is not followed up', async () => {
    await withIngestionDb(async ({ db }) => {
      await seedNavaUser(db);
      const itemId = await quoteRequest(db, 'thread-done', REQUEST_AT, 'done');
      await sendReply(db, { id: 'out-done', threadId: 'thread-done', sentAt: FRI_SEND });

      expect(await runQuoteFollowupSweep({ db, env: ON, now: WED_DUE })).toEqual({
        linked: 0,
        cancelled: 0,
        queued: 0,
      });
      expect((await loadItem(db, itemId)).sentMessageId).toBeNull();
    });
  });
});

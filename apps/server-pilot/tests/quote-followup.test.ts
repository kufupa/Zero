import {
  addSaBusinessDays,
  dismissFollowUpDraft,
  executeQuoteFollowupRun,
  followUpForMessage,
  QUOTE_FOLLOWUP_DRAFT_PREFIX,
  runQuoteFollowupSweep,
  useFollowUpDraft,
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
import { refreshThreadWork } from '../src/ai/work-items.js';
import { withIngestionDb } from './helpers/ingestion-db.js';
import { toAiRunFence } from '../src/ai/run-ledger.js';
import { user } from '../src/db/schema/auth.js';
import type { DB } from '../src/db/client.js';
import { describe, expect, it } from 'vitest';
import { and, eq } from 'drizzle-orm';

const TRANSPORT = 'transport-centurion';
const TRANSPORT_EMAIL = 'centurion@legacyhotels.co.za';
const ON = {
  QUOTE_FOLLOWUPS: 'on',
  QUOTE_FOLLOWUPS_SINCE: '2026-10-01T00:00:00Z',
} as NodeJS.ProcessEnv;
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

  it('skips Easter 2027 (Good Friday 26 March, Family Day 29 March)', () => {
    expect(addSaBusinessDays(new Date('2027-03-25T08:00:00Z'), 3).toISOString()).toBe(
      '2027-04-01T08:00:00.000Z',
    );
  });

  it('skips Day of Goodwill 2027 (Sunday 26 December) on its Monday substitute', () => {
    expect(addSaBusinessDays(new Date('2027-12-24T08:00:00Z'), 3).toISOString()).toBe(
      '2027-12-30T08:00:00.000Z',
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
  // Live mail: stored when it arrived.
  await db
    .update(message)
    .set({ receivedAt: requestAt, createdAt: requestAt })
    .where(eq(message.id, requestId));
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
    createdAt: receivedAt,
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

      expect(counts).toEqual({ linked: 2, cancelled: 0, queued: 0, discarded: 0 });
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

      expect(counts).toEqual({ linked: 0, cancelled: 1, queued: 0, discarded: 0 });
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
        discarded: 0,
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
        discarded: 0,
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

  it('sends before QUOTE_FOLLOWUPS_SINCE are never followed up; a later send is', async () => {
    await withIngestionDb(async ({ db }) => {
      await seedNavaUser(db);
      const old = await quoteRequest(db, 'thread-old', REQUEST_AT);
      const fresh = await quoteRequest(db, 'thread-fresh', REQUEST_AT);
      await sendReply(db, { id: 'out-old', threadId: 'thread-old', sentAt: FRI_SEND });
      await sendReply(db, { id: 'out-old-2', threadId: 'thread-fresh', sentAt: FRI_SEND });
      const afterCutoff = new Date('2026-10-12T08:00:00Z');
      await sendReply(db, { id: 'out-fresh', threadId: 'thread-fresh', sentAt: afterCutoff });
      const env = { QUOTE_FOLLOWUPS: 'on', QUOTE_FOLLOWUPS_SINCE: '2026-10-10T00:00:00Z' };

      const late = new Date('2026-11-30T08:00:00Z');
      expect(await runQuoteFollowupSweep({ db, env, now: late })).toEqual({
        linked: 1,
        cancelled: 0,
        queued: 1,
        discarded: 0,
      });
      expect((await loadItem(db, old)).sentMessageId).toBeNull();
      expect(await followUpRuns(db, old)).toHaveLength(0);
      expect((await loadItem(db, fresh)).sentMessageId).toBe('out-fresh');

      // A send linked before the cutoff moved forward (flag toggled) is not queued either.
      await db
        .update(workItem)
        .set({ sentMessageId: 'out-old', sentAt: FRI_SEND, followUpDueAt: WED_DUE })
        .where(eq(workItem.id, old));
      await runQuoteFollowupSweep({ db, env, now: late });
      expect(await followUpRuns(db, old)).toHaveLength(0);
    });
  });

  it('without QUOTE_FOLLOWUPS_SINCE, sends before the process started are not followed up', async () => {
    await withIngestionDb(async ({ db }) => {
      await seedNavaUser(db);
      const itemId = await quoteRequest(db, 'thread-nosince', REQUEST_AT);
      await sendReply(db, { id: 'out-nosince', threadId: 'thread-nosince', sentAt: FRI_SEND });
      const env = { QUOTE_FOLLOWUPS: 'on' };

      expect(
        await runQuoteFollowupSweep({ db, env, now: new Date('2027-01-01T08:00:00Z') }),
      ).toEqual({ linked: 0, cancelled: 0, queued: 0, discarded: 0 });
      expect((await loadItem(db, itemId)).sentMessageId).toBeNull();
    });
  });

  it('a quote dismissed after its run was queued gets no draft', async () => {
    await withIngestionDb(async ({ db }) => {
      await seedNavaUser(db);
      const itemId = await quoteRequest(db, 'thread-dismissed', REQUEST_AT);
      await sendReply(db, { id: 'out-dismissed', threadId: 'thread-dismissed', sentAt: FRI_SEND });
      await runQuoteFollowupSweep({ db, env: ON, now: WED_DUE });
      await db.update(workItem).set({ status: 'dismissed' }).where(eq(workItem.id, itemId));
      const { run, fence } = await claimRun(db, itemId);

      await executeQuoteFollowupRun({ run, fence, db, env: ON });

      expect(await threadDrafts(db, 'thread-dismissed')).toHaveLength(0);
      expect(await runOutcome(db, run.id)).toBe('closed');
      expect((await loadItem(db, itemId)).status).toBe('dismissed');
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
        discarded: 0,
      });
      expect((await loadItem(db, itemId)).sentMessageId).toBeNull();
    });
  });
});

/** A quote sent Friday, followed up on Wednesday: the run has written the suggestion. Returns the ids. */
async function suggestionFor(db: DB, threadId: string) {
  const itemId = await quoteRequest(db, threadId, REQUEST_AT);
  await sendReply(db, { id: `out-${threadId}`, threadId, sentAt: FRI_SEND });
  await runQuoteFollowupSweep({ db, env: ON, now: WED_DUE });
  const { run, fence } = await claimRun(db, itemId);
  await executeQuoteFollowupRun({ run, fence, db, env: ON });
  return { itemId, draftId: `${QUOTE_FOLLOWUP_DRAFT_PREFIX}out-${threadId}` };
}

const STAFF = 'staff-1';

describe('follow-up suggestions are discarded once a reply overtakes them', () => {
  it('a client reply after the suggestion exists discards it, and the next pass does nothing more', async () => {
    await withIngestionDb(async ({ db }) => {
      await seedNavaUser(db);
      const { draftId } = await suggestionFor(db, 'thread-overtaken');
      await clientReplies(db, 'thread-overtaken', 'in-overtaken', new Date('2026-10-12T07:00:00Z'));

      expect(await runQuoteFollowupSweep({ db, env: ON, now: WED_DUE })).toMatchObject({
        discarded: 1,
      });
      expect((await threadDrafts(db, 'thread-overtaken')).find((d) => d.id === draftId)?.status).toBe(
        'discarded',
      );
      expect(await runQuoteFollowupSweep({ db, env: ON, now: WED_DUE })).toMatchObject({
        discarded: 0,
      });
    });
  });

  it('the candidate prefilter sees trusted POP3 delivery just after createdAt', async () => {
    await withIngestionDb(async ({ db }) => {
      await seedNavaUser(db);
      await suggestionFor(db, 'thread-delivered-at-prefilter');
      await clientReplies(
        db,
        'thread-delivered-at-prefilter',
        'in-delivered-at-prefilter',
        new Date('2026-10-09T07:59:00Z'),
      );
      await db
        .update(message)
        .set({
          receivedAt: new Date('2026-10-09T07:59:00Z'),
          createdAt: new Date('2026-10-09T07:59:00Z'),
          pop3Uidl: 'uidl-delivered-at-prefilter',
          sourceProvenance: { deliveredAt: '2026-10-09T08:01:00.000Z' },
        })
        .where(eq(message.id, 'in-delivered-at-prefilter'));

      expect(await runQuoteFollowupSweep({ db, env: ON, now: WED_DUE })).toMatchObject({
        discarded: 1,
      });
      expect((await threadDrafts(db, 'thread-delivered-at-prefilter'))[0]?.status).toBe('discarded');
    });
  });

  it('a reply from staff after the suggestion exists discards it', async () => {
    await withIngestionDb(async ({ db }) => {
      await seedNavaUser(db);
      const { draftId } = await suggestionFor(db, 'thread-staff-own');
      await sendReply(db, {
        id: 'out-staff-own',
        threadId: 'thread-staff-own',
        sentAt: new Date('2026-10-12T08:00:00Z'),
      });

      expect(await runQuoteFollowupSweep({ db, env: ON, now: WED_DUE })).toMatchObject({
        discarded: 1,
      });
      expect((await threadDrafts(db, 'thread-staff-own')).find((d) => d.id === draftId)?.status).toBe(
        'discarded',
      );
    });
  });

  it('the discard touches only the follow-up suggestion, never other drafts or waiting suggestions', async () => {
    await withIngestionDb(async ({ db }) => {
      await seedNavaUser(db);
      const { draftId } = await suggestionFor(db, 'thread-mixed');
      const waiting = await suggestionFor(db, 'thread-waiting');
      await db.insert(user).values({ id: STAFF, name: 'Staff', email: 'staff@example.com', emailVerified: true });
      const other = { transportId: TRANSPORT, threadId: 'thread-mixed', subject: 'Re: Quote request' };
      await db.insert(mailDraft).values([
        { ...other, id: 'ai-candidate-mixed', createdByUserId: NAVA_USER_ID, textBody: 'AI.', status: 'candidate', origin: 'ai' },
        { ...other, id: 'staff-candidate-mixed', createdByUserId: STAFF, textBody: 'Mine.', status: 'candidate', origin: 'manual' },
        { ...other, id: 'staff-active-mixed', createdByUserId: STAFF, textBody: 'Open.', status: 'active', origin: 'manual' },
      ]);
      await clientReplies(db, 'thread-mixed', 'in-mixed', new Date('2026-10-12T07:00:00Z'));

      expect(await runQuoteFollowupSweep({ db, env: OFF, now: WED_DUE })).toMatchObject({ discarded: 1 });
      expect((await threadDrafts(db, 'thread-mixed')).map((d) => [d.id, d.status]).sort()).toEqual([
        ['ai-candidate-mixed', 'candidate'],
        [draftId, 'discarded'],
        ['staff-active-mixed', 'active'],
        ['staff-candidate-mixed', 'candidate'],
      ]);
      expect((await threadDrafts(db, 'thread-waiting')).map((d) => [d.id, d.status])).toEqual([
        [waiting.draftId, 'candidate'],
      ]);
    });
  });

  it('a suggestion that was used is kept when the client replies', async () => {
    await withIngestionDb(async ({ db }) => {
      await seedNavaUser(db);
      const { draftId } = await suggestionFor(db, 'thread-used-kept');
      await useFollowUpDraft(db, {
        transportId: TRANSPORT,
        userId: STAFF,
        draftId,
        replaceActive: false,
      });
      await clientReplies(db, 'thread-used-kept', 'in-used-kept', new Date('2026-10-12T07:00:00Z'));

      expect(await runQuoteFollowupSweep({ db, env: ON, now: WED_DUE })).toMatchObject({
        discarded: 0,
      });
      expect((await threadDrafts(db, 'thread-used-kept')).find((d) => d.id === draftId)?.status).toBe(
        'active',
      );
    });
  });

  it('with QUOTE_FOLLOWUPS off, an overtaken suggestion is still discarded', async () => {
    await withIngestionDb(async ({ db }) => {
      await seedNavaUser(db);
      const { draftId } = await suggestionFor(db, 'thread-off-discard');
      await clientReplies(db, 'thread-off-discard', 'in-off', new Date('2026-10-12T07:00:00Z'));

      expect(await runQuoteFollowupSweep({ db, env: OFF, now: WED_DUE })).toMatchObject({
        discarded: 1,
      });
      expect((await threadDrafts(db, 'thread-off-discard')).find((d) => d.id === draftId)?.status).toBe(
        'discarded',
      );
    });
  });

  it('a staff reply before the run is due writes no suggestion', async () => {
    await withIngestionDb(async ({ db }) => {
      await seedNavaUser(db);
      const itemId = await quoteRequest(db, 'thread-staff-early', REQUEST_AT);
      await sendReply(db, { id: 'out-staff-early', threadId: 'thread-staff-early', sentAt: FRI_SEND });
      await sendReply(db, {
        id: 'out-staff-second',
        threadId: 'thread-staff-early',
        sentAt: new Date('2026-10-12T08:00:00Z'),
      });
      await runQuoteFollowupSweep({ db, env: ON, now: WED_DUE });
      const { run, fence } = await claimRun(db, itemId);

      await executeQuoteFollowupRun({ run, fence, db, env: ON });

      expect(await threadDrafts(db, 'thread-staff-early')).toHaveLength(0);
      expect(await runOutcome(db, run.id)).toBe('staff_replied');
    });
  });
});

describe('follow-up suggestion for the pane', () => {
  it('finds the suggestion from the mail it is about, and nothing for another mail', async () => {
    await withIngestionDb(async ({ db }) => {
      await seedNavaUser(db);
      const { draftId } = await suggestionFor(db, 'thread-pane');
      await quoteRequest(db, 'thread-quiet', REQUEST_AT);

      expect(
        await followUpForMessage(db, {
          transportId: TRANSPORT,
          internetMessageId: 'thread-pane-request@example.com',
        }),
      ).toMatchObject({
        state: 'suggested',
        id: draftId,
        subject: 'Re: Quote request',
        replyToMessageId: 'out-thread-pane',
        htmlBody: expect.stringContaining('the quote we sent on 9 October'),
      });
      expect(
        await followUpForMessage(db, {
          transportId: TRANSPORT,
          internetMessageId: 'thread-quiet-request@example.com',
        }),
      ).toBeNull();
      expect(
        await followUpForMessage(db, { transportId: TRANSPORT, internetMessageId: 'unknown@example.com' }),
      ).toBeNull();
    });
  });

  it('use makes the suggestion the active reply, keeps it manual, and logs the accept on the quote', async () => {
    await withIngestionDb(async ({ db }) => {
      await seedNavaUser(db);
      const { itemId, draftId } = await suggestionFor(db, 'thread-use');

      const result = await useFollowUpDraft(db, {
        transportId: TRANSPORT,
        userId: STAFF,
        draftId,
        replaceActive: false,
      });

      expect(result.status).toBe('used');
      const draft = (await threadDrafts(db, 'thread-use')).find((d) => d.id === draftId);
      expect(draft).toMatchObject({ status: 'active', origin: 'manual', isSent: false });
      const revisions = await db
        .select()
        .from(mailDraftRevision)
        .where(eq(mailDraftRevision.draftId, draftId));
      expect(revisions.map((r) => [r.kind, r.actorUserId])).toEqual(
        expect.arrayContaining([
          ['created', NAVA_USER_ID],
          ['promoted', STAFF],
        ]),
      );
      const accepts = (await db.select().from(workEvent).where(eq(workEvent.workItemId, itemId))).filter(
        (e) => e.type === 'field.accept',
      );
      expect(accepts).toEqual([
        expect.objectContaining({
          actorKind: 'user',
          actorUserId: STAFF,
          fieldPath: 'followUp.draft',
          aiSource: 'quote-followup/1',
          aiValue: draft?.textBody,
          value: draft?.textBody,
        }),
      ]);
      expect(
        await followUpForMessage(db, {
          transportId: TRANSPORT,
          internetMessageId: 'thread-use-request@example.com',
        }),
      ).toMatchObject({ state: 'in_reply', id: draftId });
    });
  });

  it('use refuses while another reply is active, and replaceActive discards that reply first', async () => {
    await withIngestionDb(async ({ db }) => {
      await seedNavaUser(db);
      const { itemId, draftId } = await suggestionFor(db, 'thread-busy');
      await db.insert(mailDraft).values({
        id: 'staff-reply-in-progress',
        transportId: TRANSPORT,
        threadId: 'thread-busy',
        createdByUserId: NAVA_USER_ID,
        subject: 'Re: Quote request',
        textBody: 'Our own reply, in progress.',
        status: 'active',
        origin: 'manual',
      });

      expect(
        await useFollowUpDraft(db, { transportId: TRANSPORT, userId: STAFF, draftId, replaceActive: false }),
      ).toEqual({ status: 'active_exists' });
      const before = await threadDrafts(db, 'thread-busy');
      expect(before.map((d) => [d.id, d.status]).sort()).toEqual([
        ['quote-followup:out-thread-busy', 'candidate'],
        ['staff-reply-in-progress', 'active'],
      ]);
      expect(
        (await db.select().from(workEvent).where(eq(workEvent.workItemId, itemId))).some(
          (e) => e.type === 'field.accept',
        ),
      ).toBe(false);

      expect(
        await useFollowUpDraft(db, { transportId: TRANSPORT, userId: STAFF, draftId, replaceActive: true }),
      ).toMatchObject({ status: 'used' });
      const after = await threadDrafts(db, 'thread-busy');
      expect(after.map((d) => [d.id, d.status]).sort()).toEqual([
        ['quote-followup:out-thread-busy', 'active'],
        ['staff-reply-in-progress', 'discarded'],
      ]);
    });
  });

  it('a candidate that is not a follow-up cannot be used or dismissed', async () => {
    await withIngestionDb(async ({ db }) => {
      await seedNavaUser(db);
      const { draftId } = await suggestionFor(db, 'thread-foreign');
      await db.insert(mailDraft).values({
        id: 'ai-candidate-foreign',
        transportId: TRANSPORT,
        threadId: 'thread-foreign',
        createdByUserId: NAVA_USER_ID,
        subject: 'Re: Quote request',
        textBody: 'An AI draft.',
        status: 'candidate',
        origin: 'ai',
      });

      expect(
        await useFollowUpDraft(db, {
          transportId: TRANSPORT,
          userId: STAFF,
          draftId: 'ai-candidate-foreign',
          replaceActive: false,
        }),
      ).toEqual({ status: 'not_found' });
      expect(
        await dismissFollowUpDraft(db, {
          transportId: TRANSPORT,
          userId: STAFF,
          draftId: 'ai-candidate-foreign',
        }),
      ).toBe('not_found');
      // Another transport never sees the suggestion either.
      expect(
        await dismissFollowUpDraft(db, { transportId: 'transport-other', userId: STAFF, draftId }),
      ).toBe('not_found');
    });
  });

  it('dismiss discards the suggestion, logs a reject, and leaves the quote open', async () => {
    await withIngestionDb(async ({ db }) => {
      await seedNavaUser(db);
      const { itemId, draftId } = await suggestionFor(db, 'thread-dismiss');

      expect(
        await dismissFollowUpDraft(db, { transportId: TRANSPORT, userId: STAFF, draftId }),
      ).toBe('dismissed');

      expect((await threadDrafts(db, 'thread-dismiss')).find((d) => d.id === draftId)?.status).toBe(
        'discarded',
      );
      const rejects = (await db.select().from(workEvent).where(eq(workEvent.workItemId, itemId))).filter(
        (e) => e.type === 'field.reject',
      );
      expect(rejects).toEqual([
        expect.objectContaining({
          actorUserId: STAFF,
          fieldPath: 'followUp.draft',
          value: null,
          aiValue: expect.stringContaining('the quote we sent on 9 October'),
        }),
      ]);
      expect((await loadItem(db, itemId)).status).toBe('needs_you');
      expect(
        await followUpForMessage(db, {
          transportId: TRANSPORT,
          internetMessageId: 'thread-dismiss-request@example.com',
        }),
      ).toBeNull();
      expect(
        await useFollowUpDraft(db, { transportId: TRANSPORT, userId: STAFF, draftId, replaceActive: false }),
      ).toEqual({ status: 'not_found' });
    });
  });

  it('a used suggestion leaves the pane once it is sent', async () => {
    await withIngestionDb(async ({ db }) => {
      await seedNavaUser(db);
      const { draftId } = await suggestionFor(db, 'thread-sent');
      await useFollowUpDraft(db, { transportId: TRANSPORT, userId: STAFF, draftId, replaceActive: false });
      await db.update(mailDraft).set({ status: 'sent', isSent: true }).where(eq(mailDraft.id, draftId));

      expect(
        await followUpForMessage(db, {
          transportId: TRANSPORT,
          internetMessageId: 'thread-sent-request@example.com',
        }),
      ).toBeNull();
    });
  });
});

describe('quote follow-up clocks, claims and overtaken suggestions', () => {
  it('a send still queued or failed (no sentAt yet) never starts the clock', async () => {
    await withIngestionDb(async ({ db }) => {
      await seedNavaUser(db);
      const itemId = await quoteRequest(db, 'thread-queued', REQUEST_AT);
      // mail.send stores the row with receivedAt set and sentAt null until delivery is confirmed.
      await sendReply(db, { id: 'out-queued', threadId: 'thread-queued', sentAt: FRI_SEND });
      await db
        .update(message)
        .set({ sentAt: null, receivedAt: FRI_SEND })
        .where(eq(message.id, 'out-queued'));

      expect(await runQuoteFollowupSweep({ db, env: ON, now: WED_DUE })).toMatchObject({
        linked: 0,
        queued: 0,
      });
      expect((await loadItem(db, itemId)).sentMessageId).toBeNull();
    });
  });

  it('a quote links to the first send after the request arrived, not after its POP3 Date header', async () => {
    await withIngestionDb(async ({ db }) => {
      await seedNavaUser(db);
      const itemId = await quoteRequest(db, 'thread-link-arrival', REQUEST_AT);
      // The sender's Date header is hours before the trusted delivery, and Nava imported the mail later.
      await db
        .update(message)
        .set({
          pop3Uidl: 'uidl-link-arrival',
          receivedAt: new Date('2026-10-05T05:00:00Z'),
          createdAt: new Date('2026-10-05T09:00:00Z'),
          sourceProvenance: { deliveredAt: '2026-10-05T07:00:00.000Z' },
        })
        .where(eq(message.id, 'thread-link-arrival-request'));
      // A send between the Date header and the delivery went out before the request reached the mailbox.
      await sendReply(db, {
        id: 'out-before-delivery',
        threadId: 'thread-link-arrival',
        sentAt: new Date('2026-10-05T06:00:00Z'),
      });
      await sendReply(db, { id: 'out-quote-arrival', threadId: 'thread-link-arrival', sentAt: FRI_SEND });

      expect(await runQuoteFollowupSweep({ db, env: ON, now: FRI_SEND })).toMatchObject({ linked: 1 });
      expect(await loadItem(db, itemId)).toMatchObject({ sentMessageId: 'out-quote-arrival' });
    });
  });

  it('a client reply written before the quote but delivered after it cancels the follow-up', async () => {
    await withIngestionDb(async ({ db }) => {
      await seedNavaUser(db);
      const itemId = await quoteRequest(db, 'thread-late-delivery', REQUEST_AT);
      await sendReply(db, { id: 'out-late-delivery', threadId: 'thread-late-delivery', sentAt: FRI_SEND });
      await runQuoteFollowupSweep({ db, env: ON, now: FRI_SEND });
      await clientReplies(db, 'thread-late-delivery', 'in-late-delivery', new Date('2026-10-09T07:00:00Z'));
      // POP3 keeps the client's Date header in receivedAt; Nava fetched it after the quote went out.
      await db
        .update(message)
        .set({ createdAt: new Date('2026-10-09T09:00:00Z'), pop3Uidl: 'uidl-late-delivery' })
        .where(eq(message.id, 'in-late-delivery'));

      expect(await runQuoteFollowupSweep({ db, env: ON, now: WED_DUE })).toMatchObject({
        cancelled: 1,
        queued: 0,
      });
      expect(await followUpRuns(db, itemId)).toHaveLength(0);
    });
  });

  it('two quote requests answered by one send each get a run, and both move to needs_you', async () => {
    await withIngestionDb(async ({ db }) => {
      await seedNavaUser(db);
      const first = await quoteRequest(db, 'thread-shared', REQUEST_AT, 'review');
      const secondAt = new Date(REQUEST_AT.getTime() + 60 * 60 * 1000);
      await db.insert(message).values({
        id: 'thread-shared-request-2',
        transportId: TRANSPORT,
        threadId: 'thread-shared',
        direction: 'inbound',
        fromAddress: 'guest@example.com',
        subject: 'Another quote request',
        textBody: 'And 1 room for the next weekend?',
        messageIdHeader: 'thread-shared-request-2@example.com',
        receivedAt: secondAt,
        createdAt: secondAt,
      });
      const [second] = await db
        .insert(workItem)
        .values({
          transportId: TRANSPORT,
          threadId: 'thread-shared',
          sourceMessageId: 'thread-shared-request-2',
          kind: 'quote',
          status: 'review',
        })
        .returning({ id: workItem.id });
      await sendReply(db, { id: 'out-shared', threadId: 'thread-shared', sentAt: FRI_SEND });
      await runQuoteFollowupSweep({ db, env: ON, now: FRI_SEND });

      expect(await runQuoteFollowupSweep({ db, env: ON, now: WED_DUE })).toMatchObject({ queued: 2 });
      for (const itemId of [first, second!.id]) {
        expect(await followUpRuns(db, itemId)).toHaveLength(1);
        const { run, fence } = await claimRun(db, itemId);
        expect(await executeQuoteFollowupRun({ run, fence, db, env: ON })).toMatchObject({
          state: 'succeeded',
        });
        expect((await loadItem(db, itemId)).status).toBe('needs_you');
      }
      expect(await threadDrafts(db, 'thread-shared')).toHaveLength(1);
    });
  });

  it('without QUOTE_FOLLOWUPS_SINCE, a restart keeps the items an earlier process already linked', async () => {
    await withIngestionDb(async ({ db }) => {
      await seedNavaUser(db);
      const itemId = await quoteRequest(db, 'thread-restart', REQUEST_AT);
      await sendReply(db, { id: 'out-restart', threadId: 'thread-restart', sentAt: FRI_SEND });
      await db
        .update(workItem)
        .set({ sentMessageId: 'out-restart', sentAt: FRI_SEND, followUpDueAt: WED_DUE })
        .where(eq(workItem.id, itemId));

      expect(
        await runQuoteFollowupSweep({ db, env: { QUOTE_FOLLOWUPS: 'on' }, now: WED_DUE }),
      ).toMatchObject({ queued: 1 });
      expect(await followUpRuns(db, itemId)).toHaveLength(1);
    });
  });

  it('a worker that lost its claim writes no draft and leaves the quote as it was', async () => {
    await withIngestionDb(async ({ db }) => {
      await seedNavaUser(db);
      const itemId = await quoteRequest(db, 'thread-lost', REQUEST_AT, 'review');
      await sendReply(db, { id: 'out-lost', threadId: 'thread-lost', sentAt: FRI_SEND });
      await runQuoteFollowupSweep({ db, env: ON, now: FRI_SEND });
      await runQuoteFollowupSweep({ db, env: ON, now: WED_DUE });
      const { run, fence } = await claimRun(db, itemId);
      // Another worker reclaimed the run while this one was delayed.
      await db
        .update(aiWorkflowRun)
        .set({ claimToken: 'token-other-worker' })
        .where(eq(aiWorkflowRun.id, run.id));

      expect(await executeQuoteFollowupRun({ run, fence, db, env: ON })).toEqual({
        runId: run.id,
        state: 'retry_wait',
      });
      expect(await threadDrafts(db, 'thread-lost')).toHaveLength(0);
      expect((await loadItem(db, itemId)).status).toBe('review');
    });
  });

  it('a deferred run gets a fresh deadline on its next claim', async () => {
    await withIngestionDb(async ({ db }) => {
      await seedNavaUser(db);
      const itemId = await quoteRequest(db, 'thread-deadline', REQUEST_AT);
      await sendReply(db, { id: 'out-deadline', threadId: 'thread-deadline', sentAt: FRI_SEND });
      await runQuoteFollowupSweep({ db, env: ON, now: WED_DUE });
      const { run, fence } = await claimRun(db, itemId);
      await executeQuoteFollowupRun({ run, fence, db, env: OFF });
      const [row] = await followUpRuns(db, itemId);
      expect(row).toMatchObject({ state: 'retry_wait', deadlineAt: null });
    });
  });

  it('a suggestion a client reply has overtaken cannot be used before the sweep discards it', async () => {
    await withIngestionDb(async ({ db }) => {
      await seedNavaUser(db);
      const { draftId } = await suggestionFor(db, 'thread-use-overtaken');
      await clientReplies(db, 'thread-use-overtaken', 'in-use-overtaken', new Date('2026-10-14T09:00:00Z'));

      expect(
        await useFollowUpDraft(db, { transportId: TRANSPORT, userId: STAFF, draftId, replaceActive: false }),
      ).toEqual({ status: 'not_found' });
      expect((await threadDrafts(db, 'thread-use-overtaken'))[0]?.status).toBe('candidate');
    });
  });

  it('a used follow-up sent from Outlook is retired once its send is seen, freeing the reply slot', async () => {
    await withIngestionDb(async ({ db }) => {
      await seedNavaUser(db);
      const { draftId } = await suggestionFor(db, 'thread-outlook-sent');
      const usedAt = new Date('2026-10-14T09:00:00Z');
      await useFollowUpDraft(db, {
        transportId: TRANSPORT,
        userId: STAFF,
        draftId,
        replaceActive: false,
        now: usedAt,
      });
      // Nothing sent yet: the used draft stays.
      expect(await runQuoteFollowupSweep({ db, env: ON, now: usedAt })).toMatchObject({ discarded: 0 });
      await sendReply(db, {
        id: 'out-outlook-followup',
        threadId: 'thread-outlook-sent',
        sentAt: new Date('2026-10-14T10:00:00Z'),
      });

      expect(await runQuoteFollowupSweep({ db, env: ON, now: usedAt })).toMatchObject({ discarded: 1 });
      expect((await threadDrafts(db, 'thread-outlook-sent'))[0]?.status).toBe('discarded');
      expect(
        await followUpForMessage(db, {
          transportId: TRANSPORT,
          internetMessageId: 'thread-outlook-sent-request@example.com',
        }),
      ).toBeNull();
    });
  });

  it('the discard pass reaches an overtaken suggestion behind more than a batch of kept ones', async () => {
    await withIngestionDb(async ({ db }) => {
      await seedNavaUser(db);
      await quoteRequest(db, 'thread-kept', REQUEST_AT);
      await sendReply(db, { id: 'out-kept', threadId: 'thread-kept', sentAt: FRI_SEND });
      // Imported history: stored after the quote, written before it. It passes the cheap filter, not the exact check.
      await db.insert(message).values({
        id: 'in-kept-history',
        transportId: TRANSPORT,
        threadId: 'thread-kept',
        direction: 'inbound',
        historyOnly: true,
        fromAddress: 'guest@example.com',
        subject: 'Earlier note',
        textBody: 'Sent before the quote.',
        receivedAt: new Date('2026-10-08T08:00:00Z'),
        createdAt: WED_DUE,
      });
      await db.insert(mailDraft).values(
        Array.from({ length: 201 }, (_, i) => ({
          id: `${QUOTE_FOLLOWUP_DRAFT_PREFIX}kept-${String(i).padStart(3, '0')}`,
          transportId: TRANSPORT,
          threadId: 'thread-kept',
          createdByUserId: NAVA_USER_ID,
          subject: 'Re: Quote request',
          textBody: 'Following up.',
          status: 'candidate' as const,
          origin: 'manual' as const,
          replyToMessageId: 'out-kept',
        })),
      );
      const { draftId } = await suggestionFor(db, 'thread-late');
      await clientReplies(db, 'thread-late', 'in-late', new Date('2026-10-14T09:00:00Z'));

      expect(await runQuoteFollowupSweep({ db, env: OFF, now: WED_DUE })).toMatchObject({ discarded: 1 });
      expect((await threadDrafts(db, 'thread-late')).find((d) => d.id === draftId)?.status).toBe(
        'discarded',
      );
    });
  });
});

describe('a quote a hotel reply closed (C2) keeps its follow-up clock', () => {
  it('the sweep starts the clock from the reply link, then queues one reminder when due', async () => {
    await withIngestionDb(async ({ db }) => {
      await seedNavaUser(db);
      const itemId = await quoteRequest(db, 'thread-c2', REQUEST_AT);
      await sendReply(db, { id: 'out-c2', threadId: 'thread-c2', sentAt: FRI_SEND });
      await refreshThreadWork(db, { transportId: TRANSPORT, threadId: 'thread-c2' });
      expect(await loadItem(db, itemId)).toMatchObject({ status: 'done', sentMessageId: 'out-c2' });

      // Stage one: the clock starts from the reply link, as it does for the send of an open quote.
      expect(await runQuoteFollowupSweep({ db, env: ON, now: FRI_SEND })).toEqual({
        linked: 1,
        cancelled: 0,
        queued: 0,
        discarded: 0,
      });
      expect((await loadItem(db, itemId)).followUpDueAt).toEqual(WED_DUE);
      expect(await runQuoteFollowupSweep({ db, env: ON, now: FRI_SEND })).toEqual({
        linked: 0,
        cancelled: 0,
        queued: 0,
        discarded: 0,
      });

      // Stage two: when due, one run is queued. It reopens the quote with a draft for her review.
      expect(await runQuoteFollowupSweep({ db, env: ON, now: WED_DUE })).toEqual({
        linked: 0,
        cancelled: 0,
        queued: 1,
        discarded: 0,
      });
      const { run, fence } = await claimRun(db, itemId);
      expect(await executeQuoteFollowupRun({ run, fence, db, env: ON })).toEqual({
        runId: run.id,
        state: 'succeeded',
      });
      expect(await threadDrafts(db, 'thread-c2')).toEqual([
        expect.objectContaining({ id: 'quote-followup:out-c2', status: 'candidate', replyToMessageId: 'out-c2' }),
      ]);
      expect(await loadItem(db, itemId)).toMatchObject({ status: 'needs_you', sentMessageId: 'out-c2' });

      // The same reply link never starts a second clock or queues a second run.
      expect(await runQuoteFollowupSweep({ db, env: ON, now: WED_DUE })).toEqual({
        linked: 0,
        cancelled: 0,
        queued: 0,
        discarded: 0,
      });
      expect(await followUpRuns(db, itemId)).toHaveLength(1);
    });
  });

  it('a reply sent before QUOTE_FOLLOWUPS_SINCE starts no clock', async () => {
    await withIngestionDb(async ({ db }) => {
      await seedNavaUser(db);
      const itemId = await quoteRequest(db, 'thread-c2-since', REQUEST_AT);
      await sendReply(db, { id: 'out-c2-since', threadId: 'thread-c2-since', sentAt: FRI_SEND });
      await refreshThreadWork(db, { transportId: TRANSPORT, threadId: 'thread-c2-since' });
      const env = {
        QUOTE_FOLLOWUPS: 'on',
        QUOTE_FOLLOWUPS_SINCE: '2026-10-10T00:00:00Z',
      } as NodeJS.ProcessEnv;

      expect(await runQuoteFollowupSweep({ db, env, now: WED_DUE })).toEqual({
        linked: 0,
        cancelled: 0,
        queued: 0,
        discarded: 0,
      });
      expect((await loadItem(db, itemId)).followUpDueAt).toBeNull();
    });
  });

  it('a client reply reopens a hotel-closed quote, and no reminder goes out for it', async () => {
    await withIngestionDb(async ({ db }) => {
      await seedNavaUser(db);
      const itemId = await quoteRequest(db, 'thread-c2-reopen', REQUEST_AT);
      await sendReply(db, { id: 'out-c2-reopen', threadId: 'thread-c2-reopen', sentAt: FRI_SEND });
      await refreshThreadWork(db, { transportId: TRANSPORT, threadId: 'thread-c2-reopen' });
      await runQuoteFollowupSweep({ db, env: ON, now: FRI_SEND });
      expect((await loadItem(db, itemId)).followUpDueAt).toEqual(WED_DUE);

      await clientReplies(db, 'thread-c2-reopen', 'in-c2-reopen', new Date('2026-10-12T07:00:00Z'));
      await refreshThreadWork(db, { transportId: TRANSPORT, threadId: 'thread-c2-reopen' });
      expect(await loadItem(db, itemId)).toMatchObject({
        status: 'needs_you',
        sentMessageId: null,
        followUpDueAt: null,
      });

      expect(await runQuoteFollowupSweep({ db, env: ON, now: WED_DUE })).toMatchObject({ queued: 0 });
      expect(await followUpRuns(db, itemId)).toHaveLength(0);
    });
  });

  it('a legacy done quote that a later hotel reply links is clocked by the sweep', async () => {
    await withIngestionDb(async ({ db }) => {
      await seedNavaUser(db);
      // Closed before the reply link existed: done, with no link and no hotel_replied event.
      const itemId = await quoteRequest(db, 'thread-c2-legacy', REQUEST_AT, 'done');
      await sendReply(db, { id: 'out-c2-legacy', threadId: 'thread-c2-legacy', sentAt: FRI_SEND });

      // The rules link it to the hotel's reply, and record that link as the close.
      await refreshThreadWork(db, { transportId: TRANSPORT, threadId: 'thread-c2-legacy' });
      expect(await loadItem(db, itemId)).toMatchObject({ status: 'done', sentMessageId: 'out-c2-legacy' });

      // The sweep clocks it from the reply, as it does for any quote a hotel reply closed.
      expect(await runQuoteFollowupSweep({ db, env: ON, now: FRI_SEND })).toEqual({
        linked: 1,
        cancelled: 0,
        queued: 0,
        discarded: 0,
      });
      expect((await loadItem(db, itemId)).followUpDueAt).toEqual(WED_DUE);
    });
  });

  it('a reminder a person sends starts no second clock, so no second reminder', async () => {
    await withIngestionDb(async ({ db }) => {
      await seedNavaUser(db);
      const itemId = await quoteRequest(db, 'thread-c2-reminder', REQUEST_AT);
      await sendReply(db, { id: 'out-c2-quote', threadId: 'thread-c2-reminder', sentAt: FRI_SEND });
      await refreshThreadWork(db, { transportId: TRANSPORT, threadId: 'thread-c2-reminder' });
      await runQuoteFollowupSweep({ db, env: ON, now: FRI_SEND });
      await runQuoteFollowupSweep({ db, env: ON, now: WED_DUE });
      const { run, fence } = await claimRun(db, itemId);
      await executeQuoteFollowupRun({ run, fence, db, env: ON });

      // A person sends the drafted reminder. Its send is the hotel's newest mail, so C2 closes the quote on it.
      await sendReply(db, { id: 'out-c2-reminder', threadId: 'thread-c2-reminder', sentAt: WED_DUE });
      await db
        .update(mailDraft)
        .set({ status: 'sent', isSent: true, sentMessageId: 'out-c2-reminder' })
        .where(eq(mailDraft.id, 'quote-followup:out-c2-quote'));
      await refreshThreadWork(db, { transportId: TRANSPORT, threadId: 'thread-c2-reminder' });
      expect(await loadItem(db, itemId)).toMatchObject({
        status: 'done',
        sentMessageId: 'out-c2-reminder',
        followUpDueAt: null,
      });

      expect(await runQuoteFollowupSweep({ db, env: ON, now: new Date('2026-10-20T08:00:00Z') })).toEqual({
        linked: 0,
        cancelled: 0,
        queued: 0,
        discarded: 0,
      });
      expect(await followUpRuns(db, itemId)).toHaveLength(1);
    });
  });

  it('pane telemetry a person left on a hotel-closed quote does not stop its clock', async () => {
    await withIngestionDb(async ({ db }) => {
      await seedNavaUser(db);
      const itemId = await quoteRequest(db, 'thread-c2-telemetry', REQUEST_AT);
      await sendReply(db, { id: 'out-c2-telemetry', threadId: 'thread-c2-telemetry', sentAt: FRI_SEND });
      await refreshThreadWork(db, { transportId: TRANSPORT, threadId: 'thread-c2-telemetry' });
      await db.insert(workEvent).values({
        workItemId: itemId,
        actorKind: 'user',
        actorUserId: 'user-ropperman',
        type: 'pane.opened',
        value: { surface: 'outlook' },
      });

      expect(await runQuoteFollowupSweep({ db, env: ON, now: FRI_SEND })).toEqual({
        linked: 1,
        cancelled: 0,
        queued: 0,
        discarded: 0,
      });
      expect((await loadItem(db, itemId)).followUpDueAt).toEqual(WED_DUE);
    });
  });

  it('a hotel-closed quote a person has touched gets no clock and no reminder', async () => {
    await withIngestionDb(async ({ db }) => {
      await seedNavaUser(db);
      const itemId = await quoteRequest(db, 'thread-c2-touched', REQUEST_AT);
      await sendReply(db, { id: 'out-c2-touched', threadId: 'thread-c2-touched', sentAt: FRI_SEND });
      await refreshThreadWork(db, { transportId: TRANSPORT, threadId: 'thread-c2-touched' });
      await db.insert(workEvent).values({
        workItemId: itemId,
        actorKind: 'user',
        actorUserId: 'user-ropperman',
        type: 'field.edit',
        fieldPath: 'contact.phone',
        value: '0215550100',
      });

      expect(await runQuoteFollowupSweep({ db, env: ON, now: FRI_SEND })).toEqual({
        linked: 0,
        cancelled: 0,
        queued: 0,
        discarded: 0,
      });
      expect(await runQuoteFollowupSweep({ db, env: ON, now: WED_DUE })).toEqual({
        linked: 0,
        cancelled: 0,
        queued: 0,
        discarded: 0,
      });
      expect(await followUpRuns(db, itemId)).toHaveLength(0);
    });
  });
});

const SENT_FROM_STAFF = 'ops@legacyhotels.co.za';
const FORGED_FROM_HOTEL = 'intruder@legacyhotels.co.za';

/** The transport has sent from this address before, on the thread and before the request: an earlier send, not a reply. */
async function sentFromBefore(db: DB, threadId: string, from: string) {
  const tag = from.split('@')[0];
  await db.insert(message).values({
    id: `${threadId}-earlier-${tag}`,
    transportId: TRANSPORT,
    threadId,
    direction: 'outbound',
    fromAddress: from,
    toAddresses: ['guest@example.com'],
    ccAddresses: [],
    bccAddresses: [],
    subject: 'Earlier',
    textBody: 'Earlier.',
    ownerHeaderValue: TRANSPORT_EMAIL,
    messageIdHeader: `${threadId}-earlier-${tag}@example.com`,
    references: [],
    isRead: true,
    isStarred: false,
    sentAt: new Date('2026-10-01T08:00:00Z'),
  });
}

/** A copy of the hotel's own reply that reached the mailbox: inbound, sent at `sentAt`, fetched at `arrivedAt`. */
async function hotelCopy(
  db: DB,
  opts: { id: string; threadId: string; from: string; sentAt: Date; arrivedAt: Date },
) {
  await db.insert(message).values({
    id: opts.id,
    transportId: TRANSPORT,
    threadId: opts.threadId,
    direction: 'inbound',
    fromAddress: opts.from,
    toAddresses: ['guest@example.com'],
    ccAddresses: [],
    bccAddresses: [],
    subject: 'Re: Quote request',
    textBody: 'Please find our quote below.',
    ownerHeaderValue: TRANSPORT_EMAIL,
    messageIdHeader: `${opts.id}@example.com`,
    pop3Uidl: `uidl-${opts.id}`,
    references: [],
    isRead: true,
    isStarred: false,
    receivedAt: opts.sentAt,
    sentAt: opts.sentAt,
    createdAt: opts.arrivedAt,
  });
}

describe('a hotel copy as the reply link (C2b) neither clears nor restarts the follow-up clock', () => {
  it('a copy fetched after its send time keeps the clock, and its reminder is drafted from the copy', async () => {
    await withIngestionDb(async ({ db }) => {
      await seedNavaUser(db);
      const itemId = await quoteRequest(db, 'thread-c2b-clock', REQUEST_AT);
      await sentFromBefore(db, 'thread-c2b-clock', SENT_FROM_STAFF);
      await hotelCopy(db, {
        id: 'in-c2b-copy',
        threadId: 'thread-c2b-clock',
        from: SENT_FROM_STAFF,
        sentAt: FRI_SEND,
        arrivedAt: new Date(FRI_SEND.getTime() + 4 * 60_000),
      });
      await refreshThreadWork(db, { transportId: TRANSPORT, threadId: 'thread-c2b-clock' });
      expect(await loadItem(db, itemId)).toMatchObject({ status: 'done', sentMessageId: 'in-c2b-copy' });

      // The copy is the hotel's, so it is not a client's reply: the clock starts and stays, sweep after sweep.
      expect(await runQuoteFollowupSweep({ db, env: ON, now: FRI_SEND })).toEqual({
        linked: 1,
        cancelled: 0,
        queued: 0,
        discarded: 0,
      });
      expect((await loadItem(db, itemId)).followUpDueAt).toEqual(WED_DUE);
      expect(
        await runQuoteFollowupSweep({ db, env: ON, now: new Date(FRI_SEND.getTime() + 60 * 60_000) }),
      ).toEqual({ linked: 0, cancelled: 0, queued: 0, discarded: 0 });
      expect((await loadItem(db, itemId)).followUpDueAt).toEqual(WED_DUE);

      // When due, the run drafts the reminder replying to the copy (a copy is a sent message, as the hotel's answer).
      expect(await runQuoteFollowupSweep({ db, env: ON, now: WED_DUE })).toEqual({
        linked: 0,
        cancelled: 0,
        queued: 1,
        discarded: 0,
      });
      const { run, fence } = await claimRun(db, itemId);
      expect(await executeQuoteFollowupRun({ run, fence, db, env: ON })).toEqual({
        runId: run.id,
        state: 'succeeded',
      });
      expect(await runOutcome(db, run.id)).toBe('drafted');
      expect(await threadDrafts(db, 'thread-c2b-clock')).toEqual([
        expect.objectContaining({
          id: 'quote-followup:in-c2b-copy',
          status: 'candidate',
          replyToMessageId: 'in-c2b-copy',
        }),
      ]);
    });
  });

  it('a copy from a sent-from address overtakes a follow-up draft; a forged copy from the hotel domain does not', async () => {
    await withIngestionDb(async ({ db }) => {
      await seedNavaUser(db);
      const itemId = await quoteRequest(db, 'thread-c2b-overtake', REQUEST_AT);
      await sentFromBefore(db, 'thread-c2b-overtake', SENT_FROM_STAFF);
      await sendReply(db, { id: 'out-c2b-overtake', threadId: 'thread-c2b-overtake', sentAt: FRI_SEND });
      await refreshThreadWork(db, { transportId: TRANSPORT, threadId: 'thread-c2b-overtake' });
      await runQuoteFollowupSweep({ db, env: ON, now: FRI_SEND });
      await runQuoteFollowupSweep({ db, env: ON, now: WED_DUE });
      const { run, fence } = await claimRun(db, itemId);
      await executeQuoteFollowupRun({ run, fence, db, env: ON });
      const draftId = 'quote-followup:out-c2b-overtake';
      expect(await threadDrafts(db, 'thread-c2b-overtake')).toEqual([
        expect.objectContaining({ id: draftId, status: 'candidate' }),
      ]);

      // A forged copy from the hotel domain is nobody's answer: it discards nothing, and is no client's reply either.
      const monday = new Date('2026-10-12T09:00:00Z');
      await hotelCopy(db, {
        id: 'in-c2b-forged',
        threadId: 'thread-c2b-overtake',
        from: FORGED_FROM_HOTEL,
        sentAt: monday,
        arrivedAt: monday,
      });
      expect(await runQuoteFollowupSweep({ db, env: ON, now: monday })).toMatchObject({
        cancelled: 0,
        discarded: 0,
      });
      expect(await threadDrafts(db, 'thread-c2b-overtake')).toEqual([
        expect.objectContaining({ id: draftId, status: 'candidate' }),
      ]);

      // The hotel's own copy from a sent-from address is its answer, so the draft is overtaken.
      const monday10 = new Date('2026-10-12T10:00:00Z');
      await hotelCopy(db, {
        id: 'in-c2b-answer',
        threadId: 'thread-c2b-overtake',
        from: SENT_FROM_STAFF,
        sentAt: monday10,
        arrivedAt: monday10,
      });
      expect(await runQuoteFollowupSweep({ db, env: ON, now: monday10 })).toMatchObject({ discarded: 1 });
      expect(await threadDrafts(db, 'thread-c2b-overtake')).toEqual([
        expect.objectContaining({ id: draftId, status: 'discarded' }),
      ]);
    });
  });
});

describe('a follow-up used from the Outlook reminder counts as a touch on the quote (C2b)', () => {
  it('a hotel reply after the use does not close the quote, since the use is the person touch', async () => {
    await withIngestionDb(async ({ db }) => {
      await seedNavaUser(db);
      const { itemId, draftId } = await suggestionFor(db, 'thread-reminder-touch');
      const used = await useFollowUpDraft(db, { transportId: TRANSPORT, userId: STAFF, draftId, replaceActive: false });
      expect(used.status).toBe('used');

      await refreshThreadWork(db, { transportId: TRANSPORT, threadId: 'thread-reminder-touch' });
      expect((await loadItem(db, itemId)).status).toBe('needs_you');
    });
  });

  it('a plain AI-value accept is not a touch: the same hotel reply still closes the quote', async () => {
    await withIngestionDb(async ({ db }) => {
      await seedNavaUser(db);
      const itemId = await quoteRequest(db, 'thread-plain-accept', REQUEST_AT);
      await sendReply(db, { id: 'out-plain-accept', threadId: 'thread-plain-accept', sentAt: FRI_SEND });
      await db.insert(workEvent).values({
        workItemId: itemId,
        actorKind: 'user',
        actorUserId: STAFF,
        type: 'field.accept',
        fieldPath: 'contact.phone',
        aiValue: '0215550100',
        value: '0215550100',
      });

      await refreshThreadWork(db, { transportId: TRANSPORT, threadId: 'thread-plain-accept' });
      expect((await loadItem(db, itemId)).status).toBe('done');
    });
  });
});

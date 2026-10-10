import {
  enqueueAiRun,
  markAiRunRetry,
  markAiRunSucceeded,
  NOT_APPLICABLE_MODEL_ID,
  type AiRunFence,
} from './run-ledger.js';
import { mailboxTransport, mailDraft, mailDraftRevision, message } from '../db/schema/mail.js';
import { and, asc, desc, eq, gt, gte, inArray, isNotNull, isNull, like, sql } from 'drizzle-orm';
import { deriveReplySubject } from './workflows/candidate-draft.js';
import { workEvent, workItem } from '../db/schema/work.js';
import { canonicalInternetMessageId } from './quote-workflow-analyse-selection.js';
import { textToSafeHtml } from './draft-evidence.js';
import { getDb, type DB } from '../db/client.js';
import { NAVA_USER_ID } from '../db/seed.js';
import { alias } from 'drizzle-orm/pg-core';
import { appendWorkEvent } from './work-events.js';
import { randomUUID } from 'node:crypto';
import { messageArrivedAt, OUTLOOK_SYNCED } from './work-items.js';

/**
 * Quote follow-ups (R10). When a quote request's thread gets an outbound message (with or without the quote attached),
 * the first one sent after the request arrived starts a 3-business-day clock. If no client reply arrives before it runs
 * out, one `quote_followup` run writes a candidate draft for her review and moves the item to needs_you. Nothing is
 * sent. Off unless QUOTE_FOLLOWUPS=on. The sweep (server timer) links, cancels and queues; the ai-worker writes drafts.
 */

export const QUOTE_FOLLOWUP_PROMPT_VERSION = 'quote-followup/1';
/** Every follow-up draft id starts with this. With the system author and origin manual, it marks the sweep's drafts. */
export const QUOTE_FOLLOWUP_DRAFT_PREFIX = 'quote-followup:';
/** work_event field path for the suggestion as a whole. Not a stay path, so the field-event route never writes it. */
const FOLLOW_UP_FIELD_PATH = 'followUp.draft';
const FOLLOW_UP_BUSINESS_DAYS = 3;
const SWEEP_BATCH = 200;
const DEFER_MS = 5 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;
// Africa/Johannesburg is UTC+2 all year (no daylight saving), so local wall-clock time is a fixed offset.
const SA_OFFSET_MS = 2 * 60 * 60 * 1000;
// Only open items get follow-ups. A done or dismissed item was closed by a person.
const OPEN_STATUSES = ['needs_you', 'review'] as const;
/** The sweep's drafts: written as the system author, origin manual, under the id prefix (see writeFollowUp). */
const IS_FOLLOW_UP_DRAFT = and(
  eq(mailDraft.createdByUserId, NAVA_USER_ID),
  eq(mailDraft.origin, 'manual'),
  like(mailDraft.id, `${QUOTE_FOLLOWUP_DRAFT_PREFIX}%`),
);

// ponytail: static South African public holidays for 2026-2027, including Sunday-observed Monday substitutes. Extend it
// each December. One-off proclamations (for example an election day) are not in the list, so a due day can land on one.
const ZA_NON_BUSINESS_DAYS = new Set([
  '2026-01-01',
  '2026-03-21',
  '2026-04-03',
  '2026-04-06',
  '2026-04-27',
  '2026-05-01',
  '2026-06-16',
  '2026-08-09',
  '2026-08-10',
  '2026-09-24',
  '2026-12-16',
  '2026-12-25',
  '2027-01-01',
  '2027-03-21',
  '2027-03-22',
  '2027-03-26',
  '2027-03-29',
  '2027-04-27',
  '2027-05-01',
  '2027-06-16',
  '2027-08-09',
  '2027-09-24',
  '2027-12-16',
  '2027-12-25',
  '2027-12-26',
  '2027-12-27',
]);

export function quoteFollowupsEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.QUOTE_FOLLOWUPS === 'on';
}

const PROCESS_STARTED_AT = new Date();
let warnedNoSince = false;

/** QUOTE_FOLLOWUPS_SINCE as an instant, or null when it is unset or invalid. */
function configuredSince(env: NodeJS.ProcessEnv): Date | null {
  const raw = env.QUOTE_FOLLOWUPS_SINCE?.trim();
  const parsed = raw ? new Date(raw) : null;
  return parsed && Number.isFinite(parsed.getTime()) ? parsed : null;
}

/**
 * Only sends at or after this instant get a follow-up, so turning the flag on does not flood her with drafts for old
 * quotes. QUOTE_FOLLOWUPS_SINCE is an ISO timestamp; unset or invalid falls back to the process start time.
 */
export function quoteFollowupsSince(env: NodeJS.ProcessEnv = process.env): Date {
  const configured = configuredSince(env);
  if (configured) return configured;
  if (!warnedNoSince) {
    warnedNoSince = true;
    console.warn(
      'QUOTE_FOLLOWUPS_SINCE unset or invalid; following up only sends after process start',
    );
  }
  return PROCESS_STARTED_AT;
}

function isSaBusinessDay(at: Date): boolean {
  const local = new Date(at.getTime() + SA_OFFSET_MS);
  const weekday = local.getUTCDay();
  return (
    weekday !== 0 && weekday !== 6 && !ZA_NON_BUSINESS_DAYS.has(local.toISOString().slice(0, 10))
  );
}

/** The instant `days` South African business days after `from`, at the same local time of day. */
export function addSaBusinessDays(from: Date, days: number): Date {
  let at = from.getTime();
  for (let counted = 0; counted < days; ) {
    at += DAY_MS;
    if (isSaBusinessDay(new Date(at))) counted++;
  }
  return new Date(at);
}

async function threadMessages(db: DB, transportId: string, threadId: string) {
  return db
    .select({
      id: message.id,
      direction: message.direction,
      subject: message.subject,
      toAddresses: message.toAddresses,
      ccAddresses: message.ccAddresses,
      sentAt: message.sentAt,
      receivedAt: message.receivedAt,
      createdAt: message.createdAt,
      historyOnly: message.historyOnly,
      pop3Uidl: message.pop3Uidl,
      outlookSynced: OUTLOOK_SYNCED,
    })
    .from(message)
    .where(and(eq(message.transportId, transportId), eq(message.threadId, threadId)));
}

type ThreadMessage = Awaited<ReturnType<typeof threadMessages>>[number];

/** When an outbound message left: its send time, else when it was stored. A queued send counts as staff activity. */
function sentTime(m: ThreadMessage): number {
  return (m.sentAt ?? m.receivedAt ?? m.createdAt).getTime();
}

/**
 * When a quote was confirmed sent, or null. A Nava send has no sentAt until delivery is confirmed, so a queued or failed
 * send never starts the clock (or a draft claiming it was sent). Imported history keeps its sent time in receivedAt.
 */
function deliveredTime(m: ThreadMessage): number | null {
  const at = m.sentAt ?? (m.historyOnly ? m.receivedAt : null);
  return at ? at.getTime() : null;
}

/** SQL twin of deliveredTime, for a `message` row. */
const DELIVERED_AT = sql`coalesce(${message.sentAt}, case when ${message.historyOnly} then ${message.receivedAt} end)`;

/** When an inbound message arrived: a reply written before the quote but delivered after counts as after. */
function arrivedTime(m: ThreadMessage): number {
  return messageArrivedAt(m).getTime();
}

/** A client or staff reply after the quote: a follow-up on it is no longer wanted. */
function overtaken(thread: ThreadMessage[], sentAtMs: number): boolean {
  return clientRepliedAfter(thread, sentAtMs) || staffRepliedAfter(thread, sentAtMs);
}

function clientRepliedAfter(thread: ThreadMessage[], sentAtMs: number): boolean {
  return thread.some((m) => m.direction === 'inbound' && arrivedTime(m) > sentAtMs);
}

/** Staff sent something else on the thread after the quote, so a follow-up is no longer needed. */
function staffRepliedAfter(thread: ThreadMessage[], sentAtMs: number): boolean {
  return thread.some((m) => m.direction === 'outbound' && sentTime(m) > sentAtMs);
}

/**
 * Discards a candidate that a client or staff reply has overtaken, paging through every candidate by id so ones that
 * are kept never hide later ones. A used (active) draft is staff's to keep, so this never touches it until a staff send
 * on the thread after she took it: a follow-up sent from Outlook never passes through Nava's send, and its draft
 * would otherwise hold the thread's one reply slot for good. The sent message the draft replies to is the quote.
 */
async function discardOvertakenFollowUps(db: DB, now: Date): Promise<number> {
  const retired = await db
    .update(mailDraft)
    .set({ status: 'discarded', updatedAt: now })
    .where(
      and(
        eq(mailDraft.status, 'active'),
        eq(mailDraft.isSent, false),
        IS_FOLLOW_UP_DRAFT,
        sql`exists (
          select 1 from ${message}
          where ${message.transportId} = ${mailDraft.transportId} and ${message.threadId} = ${mailDraft.threadId}
            and ${message.direction} = 'outbound'
            and ${DELIVERED_AT} > (
              select max(r.created_at) from ${mailDraftRevision} r where r.draft_id = ${mailDraft.id} and r.kind = 'promoted'
            )
        )`,
      ),
    )
    .returning({ id: mailDraft.id });
  let discarded = retired.length;
  let after: string | null = null;
  for (;;) {
    const candidates = await db
      .select({
        id: mailDraft.id,
        transportId: mailDraft.transportId,
        threadId: mailDraft.threadId,
        replyToMessageId: mailDraft.replyToMessageId,
      })
      .from(mailDraft)
      .where(
        and(
          eq(mailDraft.status, 'candidate'),
          IS_FOLLOW_UP_DRAFT,
          after ? gt(mailDraft.id, after) : undefined,
          // Only threads with a message later than the quote. The exact client/staff check below decides.
          sql`exists (
            select 1 from ${message} m join ${message} s on s.id = ${mailDraft.replyToMessageId}
            where m.transport_id = ${mailDraft.transportId} and m.thread_id = ${mailDraft.threadId} and m.id <> s.id
              and greatest(m.sent_at, m.received_at, m.created_at) > coalesce(s.sent_at, s.received_at, s.created_at)
          )`,
        ),
      )
      .orderBy(asc(mailDraft.id))
      .limit(SWEEP_BATCH);
    for (const draft of candidates) {
      if (!draft.threadId || !draft.replyToMessageId) continue;
      const thread = await threadMessages(db, draft.transportId, draft.threadId);
      const sent = thread.find((m) => m.id === draft.replyToMessageId);
      if (!sent || !overtaken(thread, sentTime(sent))) continue;
      const [row] = await db
        .update(mailDraft)
        .set({ status: 'discarded', updatedAt: now })
        .where(and(eq(mailDraft.id, draft.id), eq(mailDraft.status, 'candidate')))
        .returning({ id: mailDraft.id });
      if (row) discarded++;
    }
    const last = candidates.at(-1);
    if (candidates.length < SWEEP_BATCH || !last) return discarded;
    after = last.id;
  }
}

/**
 * One sweep pass. Links each unlinked quote item to its first outbound since the request arrived, cancels a due date
 * once a client has replied, and queues one run per item whose due date has passed. The enqueue and the cleared due
 * date commit together, and the run key is anchored to the sent message, so a rerun queues nothing new.
 */
export async function runQuoteFollowupSweep(
  input: { db?: DB; env?: NodeJS.ProcessEnv; now?: Date } = {},
): Promise<{ linked: number; cancelled: number; queued: number; discarded: number }> {
  const counts = { linked: 0, cancelled: 0, queued: 0, discarded: 0 };
  const env = input.env ?? process.env;
  const db = input.db ?? getDb();
  const now = input.now ?? new Date();
  // Runs even when the flag is off: a suggestion a reply has overtaken must never stay on offer.
  counts.discarded = await discardOvertakenFollowUps(db, now);
  if (!quoteFollowupsEnabled(env)) return counts;
  const since = quoteFollowupsSince(env);
  const sinceConfigured = configuredSince(env);

  const source = alias(message, 'source');
  // Only items with an outbound sent after both the request and the cutoff, so items that never qualify do not fill
  // the batch on every pass.
  const firstEligibleAt = sql`greatest(${since.toISOString()}::timestamp, coalesce(${source.receivedAt}, ${source.createdAt}))`;
  const unlinked = await db
    .select({
      id: workItem.id,
      transportId: workItem.transportId,
      threadId: workItem.threadId,
      requestReceivedAt: source.receivedAt,
      requestCreatedAt: source.createdAt,
    })
    .from(workItem)
    .innerJoin(source, eq(source.id, workItem.sourceMessageId))
    .where(
      and(
        eq(workItem.kind, 'quote'),
        inArray(workItem.status, OPEN_STATUSES),
        isNull(workItem.sentMessageId),
        isNotNull(workItem.threadId),
        sql`exists (select 1 from ${message} where ${message.transportId} = ${workItem.transportId}
          and ${message.threadId} = ${workItem.threadId} and ${message.direction} = 'outbound'
          and ${DELIVERED_AT} >= ${firstEligibleAt})`,
      ),
    )
    .limit(SWEEP_BATCH);
  for (const item of unlinked) {
    if (!item.threadId) continue;
    const requestedAt = (item.requestReceivedAt ?? item.requestCreatedAt).getTime();
    const firstEligible = Math.max(requestedAt, since.getTime());
    const sent = (await threadMessages(db, item.transportId, item.threadId))
      .flatMap((m) => {
        const at = m.direction === 'outbound' ? deliveredTime(m) : null;
        return at !== null && at >= firstEligible ? [{ id: m.id, at }] : [];
      })
      .sort((a, b) => a.at - b.at)[0];
    if (!sent) continue;
    const sentAt = new Date(sent.at);
    const [linked] = await db
      .update(workItem)
      .set({
        sentMessageId: sent.id,
        sentAt,
        followUpDueAt: addSaBusinessDays(sentAt, FOLLOW_UP_BUSINESS_DAYS),
        updatedAt: now,
      })
      .where(and(eq(workItem.id, item.id), isNull(workItem.sentMessageId)))
      .returning({ id: workItem.id });
    if (linked) counts.linked++;
  }

  const linkedItems = await db
    .select({
      id: workItem.id,
      transportId: workItem.transportId,
      threadId: workItem.threadId,
      sentMessageId: workItem.sentMessageId,
      sentAt: workItem.sentAt,
      followUpDueAt: workItem.followUpDueAt,
    })
    .from(workItem)
    .where(
      and(
        eq(workItem.kind, 'quote'),
        inArray(workItem.status, OPEN_STATUSES),
        isNotNull(workItem.sentMessageId),
        isNotNull(workItem.followUpDueAt),
        // An item was linked only after the cutoff let it through. Only a configured cutoff moved later drops it; the
        // process-start fallback moves on every restart and would strand items already waiting.
        sinceConfigured ? gte(workItem.sentAt, sinceConfigured) : undefined,
      ),
    )
    .orderBy(asc(workItem.followUpDueAt))
    .limit(SWEEP_BATCH);
  for (const item of linkedItems) {
    const { id, transportId, threadId, sentMessageId, sentAt, followUpDueAt } = item;
    if (!threadId || !sentMessageId || !sentAt || !followUpDueAt) continue;
    const thread = await threadMessages(db, transportId, threadId);
    if (clientRepliedAfter(thread, sentAt.getTime())) {
      await db
        .update(workItem)
        .set({ followUpDueAt: null, updatedAt: now })
        .where(eq(workItem.id, id));
      counts.cancelled++;
      continue;
    }
    if (followUpDueAt.getTime() > now.getTime()) continue;
    await db.transaction(async (tx) => {
      await enqueueAiRun(
        {
          transportId,
          threadId,
          triggerMessageId: sentMessageId,
          runKind: 'quote_followup',
          // Per item: two quote requests answered by one send each keep their own run (the draft id is per send).
          idempotencyKey: `quote-followup:${sentMessageId}:${id}`,
          modelId: NOT_APPLICABLE_MODEL_ID,
          promptVersion: QUOTE_FOLLOWUP_PROMPT_VERSION,
          workItemId: id,
        },
        tx as unknown as DB,
      );
      await tx
        .update(workItem)
        .set({ followUpDueAt: null, updatedAt: now })
        .where(and(eq(workItem.id, id), eq(workItem.sentMessageId, sentMessageId)));
    });
    counts.queued++;
  }
  return counts;
}

function followUpText(displayName: string | null, sentAt: Date): string {
  const sentOn = new Intl.DateTimeFormat('en-ZA', {
    day: 'numeric',
    month: 'long',
    timeZone: 'Africa/Johannesburg',
  }).format(sentAt);
  return [
    'Hello,',
    `I am following up on the quote we sent on ${sentOn}. Please let us know if you would like to go ahead, or if you need any changes.`,
    ['Kind regards,', displayName].filter(Boolean).join('\n'),
  ].join('\n\n');
}

/** The worker lost its claim on the run before the follow-up committed. Nothing it wrote is kept. */
class FollowUpClaimLostError extends Error {}

/** Writes the follow-up draft for one run, inside the caller's transaction. Returns the outcome for the run's metrics. */
async function writeFollowUp(
  db: DB,
  run: { id: string; transportId: string; triggerMessageId: string; workItemId: string | null },
): Promise<string> {
  if (!run.workItemId) return 'no_work_item';
  const [item] = await db
    .select({
      id: workItem.id,
      status: workItem.status,
      threadId: workItem.threadId,
      sentMessageId: workItem.sentMessageId,
    })
    .from(workItem)
    .where(eq(workItem.id, run.workItemId))
    .limit(1)
    // Locked for the caller's transaction, so staff closing the item now cannot be undone by the status change below.
    .for('update');
  if (!item?.threadId) return 'no_work_item';
  if (item.status !== 'needs_you' && item.status !== 'review') return 'closed';
  if (item.sentMessageId !== run.triggerMessageId) return 'superseded';
  const thread = await threadMessages(db, run.transportId, item.threadId);
  const sent = thread.find((m) => m.id === run.triggerMessageId && m.direction === 'outbound');
  if (!sent) return 'no_sent_message';
  if (deliveredTime(sent) === null) return 'not_sent';
  if (clientRepliedAfter(thread, sentTime(sent))) return 'client_replied';
  if (staffRepliedAfter(thread, sentTime(sent))) return 'staff_replied';

  const [transport] = await db
    .select({ displayName: mailboxTransport.displayName })
    .from(mailboxTransport)
    .where(eq(mailboxTransport.id, run.transportId))
    .limit(1);
  const text = followUpText(transport?.displayName ?? null, new Date(sentTime(sent)));
  const draftId = `${QUOTE_FOLLOWUP_DRAFT_PREFIX}${sent.id}`;
  const now = new Date();
  const fields = {
    toAddresses: sent.toAddresses,
    ccAddresses: sent.ccAddresses,
    bccAddresses: [] as string[],
    subject: deriveReplySubject(sent.subject),
    textBody: text,
    htmlBody: textToSafeHtml(text),
    attachments: [] as { filename: string; mimeType: string; sizeBytes: number; s3Key: string }[],
  };
  // Origin is manual, not ai: an ai draft can only be sent with an approval bound to a candidate_draft run, which a
  // template follow-up does not have. Status candidate keeps it out of the active slot, so an active draft is untouched.
  await db.transaction(async (tx) => {
    await tx
      .insert(mailDraft)
      .values({
        id: draftId,
        transportId: run.transportId,
        threadId: item.threadId,
        createdByUserId: NAVA_USER_ID,
        ...fields,
        status: 'candidate',
        origin: 'manual',
        replyToMessageId: sent.id,
        createdAt: now,
        updatedAt: now,
      })
      .onConflictDoNothing({ target: mailDraft.id });
    await tx
      .insert(mailDraftRevision)
      .values({
        id: `${draftId}:created`,
        draftId,
        actorUserId: NAVA_USER_ID,
        kind: 'created',
        ...fields,
        createdAt: now,
      })
      .onConflictDoNothing({ target: mailDraftRevision.id });
    if (item.status !== 'needs_you') {
      await tx
        .update(workItem)
        .set({ status: 'needs_you', updatedAt: now })
        .where(and(eq(workItem.id, item.id), inArray(workItem.status, OPEN_STATUSES)));
      await tx.insert(workEvent).values({
        workItemId: item.id,
        actorKind: 'system',
        type: 'status.changed',
        value: { from: item.status, to: 'needs_you' },
        evidence: { runId: run.id, draftId },
      });
    }
  });
  return 'drafted';
}

/** Worker entry for a `quote_followup` run. Maps the outcome onto the run's state. */
export async function executeQuoteFollowupRun(input: {
  run: {
    id: string;
    transportId: string;
    triggerMessageId: string;
    workItemId: string | null;
    attempts: number;
  };
  fence: AiRunFence;
  db?: DB;
  env?: NodeJS.ProcessEnv;
}): Promise<{ runId: string; state: 'succeeded' | 'retry_wait' }> {
  const { run, fence } = input;
  const db = input.db ?? getDb();
  const claim = {
    runId: run.id,
    claimOwner: fence.claimOwner,
    claimToken: fence.claimToken,
    expectedStates: ['running' as const],
  };
  if (!quoteFollowupsEnabled(input.env ?? process.env)) {
    await markAiRunRetry(
      {
        ...claim,
        attempts: run.attempts,
        nextRunAt: new Date(Date.now() + DEFER_MS),
        lastError: 'quote follow-ups are off (QUOTE_FOLLOWUPS)',
        failureClass: 'POLICY_BLOCK',
        // The run waits longer than its deadline, so the next claim gets a fresh one instead of dead-lettering it.
        resetDeadline: true,
      },
      db,
    );
    return { runId: run.id, state: 'retry_wait' };
  }
  // The draft, the item change and the run's completion commit together, and only while the claim is still this
  // worker's (as the candidate-draft path does).
  try {
    return await db.transaction(async (tx) => {
      const outcome = await writeFollowUp(tx as unknown as DB, run);
      const marked = await markAiRunSucceeded(
        { ...claim, metrics: { quoteFollowup: { outcome } } },
        tx as unknown as DB,
      );
      if (!marked) throw new FollowUpClaimLostError();
      return { runId: run.id, state: 'succeeded' as const };
    });
  } catch (error) {
    if (error instanceof FollowUpClaimLostError) return { runId: run.id, state: 'retry_wait' };
    throw error;
  }
}

type FollowUpDraft = typeof mailDraft.$inferSelect;

function isUniqueViolation(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false;
  if ((error as { code?: unknown }).code === '23505') return true;
  return isUniqueViolation((error as { cause?: unknown }).cause);
}

/** The quote work item a follow-up belongs to: the one whose first outbound the draft replies to. */
async function followUpWorkItemId(db: DB, draft: FollowUpDraft): Promise<string | null> {
  if (!draft.threadId || !draft.replyToMessageId) return null;
  const [row] = await db
    .select({ id: workItem.id })
    .from(workItem)
    .where(
      and(
        eq(workItem.transportId, draft.transportId),
        eq(workItem.threadId, draft.threadId),
        eq(workItem.kind, 'quote'),
        eq(workItem.sentMessageId, draft.replyToMessageId),
      ),
    )
    .limit(1);
  return row?.id ?? null;
}

/** A follow-up as the pane shows it. The body is stored HTML; the pane sanitises it before it renders. */
export type FollowUpWire = {
  state: 'suggested' | 'in_reply';
  id: string;
  subject: string | null;
  htmlBody: string;
  replyToMessageId: string | null;
};

export function followUpWire(state: FollowUpWire['state'], draft: FollowUpDraft): FollowUpWire {
  return {
    state,
    id: draft.id,
    subject: draft.subject,
    htmlBody: draft.htmlBody ?? '',
    replyToMessageId: draft.replyToMessageId,
  };
}

/**
 * The follow-up on the thread of this mail: a suggestion she has not used, else the draft she used and has not sent.
 * Null when there is neither.
 */
export async function followUpForMessage(
  db: DB,
  input: { transportId: string; internetMessageId: string },
): Promise<FollowUpWire | null> {
  const internetMessageId = canonicalInternetMessageId(input.internetMessageId);
  if (!internetMessageId) return null;
  const found = await db
    .select({ threadId: message.threadId })
    .from(message)
    .where(
      and(eq(message.transportId, input.transportId), eq(message.messageIdHeader, internetMessageId)),
    )
    .limit(2);
  const threadId = found.length === 1 ? found[0]?.threadId : null;
  if (!threadId) return null;
  const drafts = await db
    .select()
    .from(mailDraft)
    .where(
      and(
        eq(mailDraft.transportId, input.transportId),
        eq(mailDraft.threadId, threadId),
        inArray(mailDraft.status, ['candidate', 'active']),
        IS_FOLLOW_UP_DRAFT,
      ),
    )
    .orderBy(desc(mailDraft.updatedAt), desc(mailDraft.id))
    .limit(5);
  const suggested = drafts.find((draft) => draft.status === 'candidate');
  if (suggested) return followUpWire('suggested', suggested);
  const used = drafts.find((draft) => draft.status === 'active');
  return used ? followUpWire('in_reply', used) : null;
}

export type UseFollowUpResult =
  | { status: 'used'; draft: FollowUpDraft }
  | { status: 'active_exists' }
  | { status: 'not_found' };

/**
 * Makes a suggestion the thread's reply draft. It keeps origin manual, so it is sent like a reply she wrote; nothing
 * here sends it. If another active draft holds the thread's slot, this refuses (active_exists) unless replaceActive is
 * set, which discards that draft first, the same status delete gives it. The accept is logged in the same transaction.
 */
export async function useFollowUpDraft(
  db: DB,
  input: { transportId: string; userId: string; draftId: string; replaceActive: boolean; now?: Date },
): Promise<UseFollowUpResult> {
  const now = input.now ?? new Date();
  try {
    return await db.transaction(async (tx) => {
      const [draft] = await tx
        .select()
        .from(mailDraft)
        .where(
          and(
            eq(mailDraft.id, input.draftId),
            eq(mailDraft.transportId, input.transportId),
            eq(mailDraft.status, 'candidate'),
            IS_FOLLOW_UP_DRAFT,
          ),
        )
        .limit(1)
        .for('update');
      if (!draft?.threadId) return { status: 'not_found' as const };
      const workItemId = await followUpWorkItemId(tx as unknown as DB, draft);
      if (!workItemId) return { status: 'not_found' as const };
      // A reply since the quote overtakes the suggestion even before the sweep discards it.
      const thread = await threadMessages(tx as unknown as DB, draft.transportId, draft.threadId);
      const sent = thread.find((m) => m.id === draft.replyToMessageId);
      if (!sent || overtaken(thread, sentTime(sent))) return { status: 'not_found' as const };
      const [active] = await tx
        .select({ id: mailDraft.id })
        .from(mailDraft)
        .where(
          and(
            eq(mailDraft.transportId, input.transportId),
            eq(mailDraft.threadId, draft.threadId),
            eq(mailDraft.status, 'active'),
            eq(mailDraft.isSent, false),
          ),
        )
        .limit(1)
        .for('update');
      if (active && !input.replaceActive) return { status: 'active_exists' as const };
      if (active) {
        await tx
          .update(mailDraft)
          .set({ status: 'discarded', updatedAt: now })
          .where(eq(mailDraft.id, active.id));
      }
      const [used] = await tx
        .update(mailDraft)
        .set({ status: 'active', updatedAt: now })
        .where(and(eq(mailDraft.id, draft.id), eq(mailDraft.status, 'candidate')))
        .returning();
      if (!used) return { status: 'not_found' as const };
      await tx.insert(mailDraftRevision).values({
        id: randomUUID(),
        draftId: draft.id,
        actorUserId: input.userId,
        kind: 'promoted',
        toAddresses: draft.toAddresses,
        ccAddresses: draft.ccAddresses,
        bccAddresses: draft.bccAddresses,
        subject: draft.subject,
        textBody: draft.textBody,
        htmlBody: draft.htmlBody,
        attachments: draft.attachments,
        createdAt: now,
      });
      await appendWorkEvent(tx as unknown as DB, {
        workItemId,
        type: 'field.accept',
        actorUserId: input.userId,
        fieldPath: FOLLOW_UP_FIELD_PATH,
        aiValue: draft.textBody,
        value: draft.textBody,
        aiSource: QUOTE_FOLLOWUP_PROMPT_VERSION,
      });
      return { status: 'used' as const, draft: used };
    });
  } catch (error) {
    // Two suggestions on one thread can race for the active slot. The loser finds the slot taken.
    if (isUniqueViolation(error)) return { status: 'active_exists' as const };
    throw error;
  }
}

/**
 * Discards a suggestion she does not want, and logs the reject in the same transaction. Only an unused suggestion can
 * be dismissed. The work item keeps its status: the quote may still need her.
 */
export async function dismissFollowUpDraft(
  db: DB,
  input: { transportId: string; userId: string; draftId: string; now?: Date },
): Promise<'dismissed' | 'not_found'> {
  const now = input.now ?? new Date();
  return db.transaction(async (tx) => {
    const [draft] = await tx
      .select()
      .from(mailDraft)
      .where(
        and(
          eq(mailDraft.id, input.draftId),
          eq(mailDraft.transportId, input.transportId),
          eq(mailDraft.status, 'candidate'),
          IS_FOLLOW_UP_DRAFT,
        ),
      )
      .limit(1)
      .for('update');
    if (!draft) return 'not_found' as const;
    const workItemId = await followUpWorkItemId(tx as unknown as DB, draft);
    if (!workItemId) return 'not_found' as const;
    await tx
      .update(mailDraft)
      .set({ status: 'discarded', updatedAt: now })
      .where(and(eq(mailDraft.id, draft.id), eq(mailDraft.status, 'candidate')));
    await appendWorkEvent(tx as unknown as DB, {
      workItemId,
      type: 'field.reject',
      actorUserId: input.userId,
      fieldPath: FOLLOW_UP_FIELD_PATH,
      aiValue: draft.textBody,
      value: null,
      aiSource: QUOTE_FOLLOWUP_PROMPT_VERSION,
    });
    return 'dismissed' as const;
  });
}

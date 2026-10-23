import {
  enqueueAiRun,
  markAiRunRetry,
  markAiRunSucceeded,
  NOT_APPLICABLE_MODEL_ID,
  type AiRunFence,
} from './run-ledger.js';
import {
  aiWorkflowRun,
  attachment,
  mailboxTransport,
  mailDraft,
  mailDraftRevision,
  message,
} from '../db/schema/mail.js';
import {
  and,
  asc,
  desc,
  eq,
  gt,
  gte,
  inArray,
  isNotNull,
  isNull,
  like,
  notExists,
  or,
  sql,
} from 'drizzle-orm';
import { deriveReplySubject } from './workflows/candidate-draft.js';
import { FOLLOW_UP_DRAFT_FIELD_PATH, mailExtraction, workEvent, workItem } from '../db/schema/work.js';
import { canonicalInternetMessageId } from './quote-workflow-analyse-selection.js';
import { textToSafeHtml } from './draft-evidence.js';
import { getDb, type DB } from '../db/client.js';
import { NAVA_USER_ID } from '../db/seed.js';
import { alias } from 'drizzle-orm/pg-core';
import { appendWorkEvent } from './work-events.js';
import { randomUUID } from 'node:crypto';
import {
  FOLLOW_UP_WORK_KINDS,
  isStaffSender,
  knownSenders,
  messageArrivedAt,
  MESSAGE_ARRIVED_AT,
  MESSAGE_DELIVERED_AT,
  OUTLOOK_SYNCED,
  personTouchSql,
} from './work-items.js';
import { normalizeEmailAddress } from './never-spam.js';
import { quoteFollowUpBody, quotePropertyIdentity } from '../quote-proposal/filename.js';
import { isDaVinciTransport } from '../hms/hms-read-target.js';

/**
 * Quote and provisional-booking follow-ups (R10 / ask 175). A quote clock starts from a staff send that states a
 * validity or hold window. A booking clock starts from a Nava/staff HMS confirmation send. If no client reply arrives
 * before 66 hours, one `quote_followup` run writes a candidate draft for staff review and moves the item to needs_you.
 * Nothing is sent. Off unless QUOTE_FOLLOWUPS=on. The sweep (server timer) links, cancels and queues; the ai-worker
 * writes drafts.
 */

export const QUOTE_FOLLOWUP_PROMPT_VERSION = 'quote-followup/1';
/** Every follow-up draft id starts with this. With the system author and origin manual, it marks the sweep's drafts. */
export const QUOTE_FOLLOWUP_DRAFT_PREFIX = 'quote-followup:';
/** 66 calendar hours: six hours before the gold 3-day / 72 h quote window ends. */
export const QUOTE_FOLLOWUP_DELAY_MS = 66 * 60 * 60 * 1000;
const SWEEP_BATCH = 200;
const DEFER_MS = 5 * 60 * 1000;
// Open items get follow-ups, and so does a quote a hotel reply closed (below). A dismissed item, or a done one a person
// touched, was closed by a person.
const OPEN_STATUSES = ['needs_you', 'review'] as const;
// Explicit table names throughout: drizzle leaves the columns of a select-list subquery unqualified (see touched in
// work-items.ts), and then the subquery's own id column would be compared.
/**
 * A quote a hotel reply closed (C2), with its reply link, and no person has touched since. Its close is the system's
 * status change with reason hotel_replied. The reply is the send the clock starts from, so it gets a follow-up like an
 * open quote would.
 */
const CLOSED_BY_HOTEL_REPLY = sql`(${workItem}.status = 'done' and ${workItem}.sent_message_id is not null and exists (
  select 1 from ${workEvent} as we where we.work_item_id = ${workItem}.id
    and we.type = 'status.changed' and we.value->>'reason' = 'hotel_replied')
  and not exists (
  select 1 from ${workEvent} as wp where wp.work_item_id = ${workItem}.id and ${personTouchSql('wp')}))`;
/** The sweep's drafts: written as the system author, origin manual, under the id prefix (see writeFollowUp). */
const IS_FOLLOW_UP_DRAFT = and(
  eq(mailDraft.createdByUserId, NAVA_USER_ID),
  eq(mailDraft.origin, 'manual'),
  like(mailDraft.id, `${QUOTE_FOLLOWUP_DRAFT_PREFIX}%`),
);

/**
 * Staff quote replies that state a validity or hold window. Gold cover: "no rooms are currently being held" plus
 * PDF "Valid until: 3 days". An inventory hold is almost never claimed; the window language is the trigger.
 * A deposit or payment deadline of 72 hours is not a window.
 */
const HOLD_OR_VALIDITY_WINDOW =
  /no\s+rooms?\s+(?:are\s+)?(?:currently\s+)?(?:being\s+)?held|(?:rooms?\s+(?:are\s+)?(?:currently\s+)?(?:being\s+)?held|hold(?:ing)?\s+(?:the\s+)?rooms?)|valid(?:ity)?\s*(?:until|till|for|:)/i;
/** HMS confirmation letter file, e.g. HRCEN_Confirmation_Letter_12345678.pdf. */
const CONFIRMATION_LETTER_FILE = /^[A-Z]{3,8}_Confirmation_Letter_\d{8}(?:\b|\.|$)/i;
const CONFIRMATION_LETTER_SUBJECT = /confirmation\s+letter/i;

export function quoteReplyStatesHoldWindow(text: string | null | undefined): boolean {
  if (!text) return false;
  return HOLD_OR_VALIDITY_WINDOW.test(text.replace(/<[^>]+>/g, ' '));
}

function attachmentBasename(filename: string): string {
  const parts = filename.replace(/\\/g, '/').split('/');
  return parts[parts.length - 1] || filename;
}

/** A Nava/staff HMS confirmation send: letter in the subject or the Confirmation_Letter attachment. */
export function messageStatesConfirmationLetter(
  m: { subject?: string | null },
  filenames: readonly string[] = [],
): boolean {
  if (CONFIRMATION_LETTER_SUBJECT.test(m.subject ?? '')) return true;
  return filenames.some((name) => CONFIRMATION_LETTER_FILE.test(attachmentBasename(name)));
}

/** The instant 66 calendar hours after `from`. Weekends and holidays count. */
export function addQuoteFollowupDelay(from: Date): Date {
  return new Date(from.getTime() + QUOTE_FOLLOWUP_DELAY_MS);
}

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

async function threadMessages(db: DB, transportId: string, threadId: string) {
  return db
    .select({
      id: message.id,
      direction: message.direction,
      fromAddress: message.fromAddress,
      // The transport's own address: with its domain it tells the hotel's own copies from a guest's mail (isStaffSender).
      mailboxEmail: mailboxTransport.email,
      subject: message.subject,
      toAddresses: message.toAddresses,
      ccAddresses: message.ccAddresses,
      textBody: message.textBody,
      htmlBody: message.htmlBody,
      sentAt: message.sentAt,
      receivedAt: message.receivedAt,
      deliveredAt: MESSAGE_DELIVERED_AT,
      createdAt: message.createdAt,
      historyOnly: message.historyOnly,
      pop3Uidl: message.pop3Uidl,
      outlookSynced: OUTLOOK_SYNCED,
    })
    .from(message)
    .innerJoin(mailboxTransport, eq(mailboxTransport.id, message.transportId))
    .where(and(eq(message.transportId, transportId), eq(message.threadId, threadId)));
}

type ThreadMessage = Awaited<ReturnType<typeof threadMessages>>[number];

function messageStatesHoldWindow(
  m: Pick<ThreadMessage, 'textBody' | 'htmlBody'>,
  extracts: readonly string[] = [],
): boolean {
  if (quoteReplyStatesHoldWindow(m.textBody) || quoteReplyStatesHoldWindow(m.htmlBody)) return true;
  return extracts.some((text) => quoteReplyStatesHoldWindow(text));
}

function sendStartsFollowUpClock(
  kind: string,
  m: Pick<ThreadMessage, 'subject' | 'textBody' | 'htmlBody'>,
  extracts: readonly string[] = [],
  filenames: readonly string[] = [],
): boolean {
  if (kind === 'booking') return messageStatesConfirmationLetter(m, filenames);
  return messageStatesHoldWindow(m, extracts);
}

/** followUpDueAt === sentAt means we looked, there was no window, and no draft will be written. */
function isSkippedHoldWindow(dueAt: Date, sentAt: Date): boolean {
  return dueAt.getTime() === sentAt.getTime();
}

function textsFromStoredExtract(
  attachments: Record<string, unknown>[] | null | undefined,
  payload: Record<string, unknown> | null | undefined,
): string[] {
  const texts: string[] = [];
  for (const row of attachments ?? []) {
    const text = row?.text;
    if (typeof text === 'string' && text.length > 0) texts.push(text);
  }
  const attachmentText = payload?.attachmentText;
  if (typeof attachmentText === 'string' && attachmentText.length > 0) texts.push(attachmentText);
  const attachmentTexts = payload?.attachmentTexts;
  if (Array.isArray(attachmentTexts)) {
    for (const text of attachmentTexts) {
      if (typeof text === 'string' && text.length > 0) texts.push(text);
    }
  }
  return texts;
}

/** Filenames already on the message. Never fetches objects. */
async function storedAttachmentNames(
  db: DB,
  messageIds: readonly string[],
): Promise<Map<string, string[]>> {
  const out = new Map<string, string[]>();
  if (messageIds.length === 0) return out;
  const rows = await db
    .select({ messageId: attachment.messageId, filename: attachment.filename })
    .from(attachment)
    .where(inArray(attachment.messageId, [...messageIds]));
  for (const row of rows) {
    const prev = out.get(row.messageId) ?? [];
    prev.push(row.filename);
    out.set(row.messageId, prev);
  }
  return out;
}

/** Already-stored attachment extracts only. Never fetches objects. Never logs the text. */
async function storedPdfExtracts(
  db: DB,
  messageIds: readonly string[],
): Promise<Map<string, string[]>> {
  const out = new Map<string, string[]>();
  if (messageIds.length === 0) return out;
  const rows = await db
    .select({
      messageId: mailExtraction.messageId,
      attachments: mailExtraction.attachments,
      payload: mailExtraction.payload,
    })
    .from(mailExtraction)
    .where(
      and(inArray(mailExtraction.messageId, [...messageIds]), eq(mailExtraction.status, 'succeeded')),
    );
  for (const row of rows) {
    const texts = textsFromStoredExtract(row.attachments, row.payload);
    if (texts.length === 0) continue;
    const prev = out.get(row.messageId) ?? [];
    out.set(row.messageId, prev.concat(texts));
  }
  return out;
}

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

/** The hotel's own domain or address on the mailbox (isStaffSender). Its mail is never a guest's. */
function ownMail(m: ThreadMessage): boolean {
  return isStaffSender(m.fromAddress, m.mailboxEmail ?? '');
}

/** A guest's mail, by the planner's rule (work-items planThreadWork): inbound, and not the hotel's own. */
function isGuestMail(m: ThreadMessage): boolean {
  return m.direction === 'inbound' && !ownMail(m);
}

/**
 * The hotel's own copy of a send: inbound from the hotel's domain at an exact address the transport has sent from. Only
 * such a copy is the hotel's answer (the planner's rule, P1 4240335634), so a forged From on the domain is nobody's.
 */
function isHotelCopy(m: ThreadMessage, sentFrom: ReadonlySet<string>): boolean {
  return m.direction === 'inbound' && ownMail(m) && sentFrom.has(normalizeEmailAddress(m.fromAddress));
}

/** The From addresses of the thread's own-domain inbound mail: the only ones whose sent-from status can matter. */
function ownDomainAddresses(thread: ThreadMessage[]): string[] {
  return thread.flatMap((m) => (m.direction === 'inbound' && ownMail(m) ? [m.fromAddress] : []));
}

/** A client or staff reply after the quote: a follow-up on it is no longer wanted. */
function overtaken(thread: ThreadMessage[], sent: ThreadMessage, sentFrom: ReadonlySet<string>): boolean {
  return clientRepliedAfter(thread, sentTime(sent)) || staffRepliedAfter(thread, sent, sentFrom);
}

/**
 * A client's reply after the quote. The hotel's own copies are not a client's (a copy fetched after its send time used to
 * clear the follow-up clock on every sweep, and the sweep restarted it again).
 */
function clientRepliedAfter(thread: ThreadMessage[], sentAtMs: number): boolean {
  return thread.some((m) => isGuestMail(m) && arrivedTime(m) > sentAtMs);
}

/** Staff sent something else on the thread after the quote, so a follow-up is no longer needed. */
function staffRepliedAfter(thread: ThreadMessage[], sent: ThreadMessage, sentFrom: ReadonlySet<string>): boolean {
  const sentAtMs = sentTime(sent);
  return thread.some((m) => {
    if (m.direction === 'outbound') return sentTime(m) > sentAtMs;
    const at = deliveredTime(m);
    return at !== null && at > sentAtMs && isHotelCopy(m, sentFrom);
  });
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
            select 1 from ${message} join ${message} s on s.id = ${mailDraft.replyToMessageId}
            where ${message.transportId} = ${mailDraft.transportId}
              and ${message.threadId} = ${mailDraft.threadId}
              and ${message.id} <> s.id
              and greatest(${MESSAGE_ARRIVED_AT}, ${message.sentAt}, ${message.receivedAt}, ${message.createdAt})
                > coalesce(s.sent_at, s.received_at, s.created_at)
          )`,
        ),
      )
      .orderBy(asc(mailDraft.id))
      .limit(SWEEP_BATCH);
    for (const draft of candidates) {
      if (!draft.threadId || !draft.replyToMessageId) continue;
      const thread = await threadMessages(db, draft.transportId, draft.threadId);
      const sent = thread.find((m) => m.id === draft.replyToMessageId);
      if (!sent) continue;
      const sentFrom = await knownSenders(db, draft.transportId, ownDomainAddresses(thread));
      if (!overtaken(thread, sent, sentFrom)) continue;
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
  // The request's arrival as the planner counts it (MESSAGE_ARRIVED_AT), from its own row: the select and the prefilter
  // share it, so a POP3 request is not dated by the sender's Date header.
  const requestArrivedAt = sql`(select ${MESSAGE_ARRIVED_AT} from ${message} where ${message.id} = ${workItem.sourceMessageId})`;
  // Open quotes/bookings with an outbound after the cutoff still fill this select when that outbound has no window
  // (or no confirmation letter), so page past SWEEP_BATCH or a later qualifying item never links.
  const firstEligibleAt = sql`greatest(${since.toISOString()}::timestamp, ${requestArrivedAt})`;
  let afterUnlinked: string | null = null;
  for (;;) {
    const unlinked = await db
      .select({
        id: workItem.id,
        kind: workItem.kind,
        transportId: workItem.transportId,
        threadId: workItem.threadId,
        requestArrivedAt: sql`${requestArrivedAt}`.mapWith(message.createdAt),
      })
      .from(workItem)
      .innerJoin(source, eq(source.id, workItem.sourceMessageId))
      .where(
        and(
          inArray(workItem.kind, FOLLOW_UP_WORK_KINDS),
          inArray(workItem.status, OPEN_STATUSES),
          isNull(workItem.sentMessageId),
          isNotNull(workItem.threadId),
          afterUnlinked ? gt(workItem.id, afterUnlinked) : undefined,
          sql`exists (select 1 from ${message} where ${message.transportId} = ${workItem.transportId}
            and ${message.threadId} = ${workItem.threadId} and ${message.direction} = 'outbound'
            and ${DELIVERED_AT} >= ${firstEligibleAt})`,
        ),
      )
      .orderBy(asc(workItem.id))
      .limit(SWEEP_BATCH);
    for (const item of unlinked) {
      if (!item.threadId) continue;
      const requestedAt = item.requestArrivedAt.getTime();
      const firstEligible = Math.max(requestedAt, since.getTime());
      const thread = await threadMessages(db, item.transportId, item.threadId);
      const outboundIds = thread.filter((m) => m.direction === 'outbound').map((m) => m.id);
      const extracts = await storedPdfExtracts(db, outboundIds);
      const filenames = await storedAttachmentNames(db, outboundIds);
      const sent = thread
        .flatMap((m) => {
          const at = m.direction === 'outbound' ? deliveredTime(m) : null;
          if (
            at === null ||
            at < firstEligible ||
            !sendStartsFollowUpClock(item.kind, m, extracts.get(m.id), filenames.get(m.id))
          ) {
            return [];
          }
          return [{ id: m.id, at }];
        })
        .sort((a, b) => a.at - b.at)[0];
      if (!sent) continue;
      const sentAt = new Date(sent.at);
      const [linked] = await db
        .update(workItem)
        .set({
          sentMessageId: sent.id,
          sentAt,
          followUpDueAt: addQuoteFollowupDelay(sentAt),
          updatedAt: now,
        })
        .where(and(eq(workItem.id, item.id), isNull(workItem.sentMessageId)))
        .returning({ id: workItem.id });
      if (linked) counts.linked++;
    }
    const lastUnlinked = unlinked.at(-1);
    if (unlinked.length < SWEEP_BATCH || !lastUnlinked) break;
    afterUnlinked = lastUnlinked.id;
  }

  // A hotel reply closes the request and keeps its reply link (C2), so the select above never sees it. Its clock starts
  // from that link, the same way, and once per link: a run already queued for the link keeps it from starting again.
  const closedByReply = await db
    .select({
      id: workItem.id,
      kind: workItem.kind,
      transportId: workItem.transportId,
      threadId: workItem.threadId,
      sentMessageId: workItem.sentMessageId,
      sentAt: workItem.sentAt,
    })
    .from(workItem)
    .where(
      and(
        inArray(workItem.kind, FOLLOW_UP_WORK_KINDS),
        CLOSED_BY_HOTEL_REPLY,
        isNull(workItem.followUpDueAt),
        gte(workItem.sentAt, since),
        // The reminder itself, once a person sends it, is the hotel's newest mail, so C2 closes the quote on it. It is
        // not a reply to the quote, so it starts no second clock (which would send another reminder).
        sql`not exists (select 1 from ${mailDraft} as sf where sf.sent_message_id = ${workItem}.sent_message_id
          and sf.created_by_user_id = ${NAVA_USER_ID} and sf.origin = 'manual'
          and sf.id like ${`${QUOTE_FOLLOWUP_DRAFT_PREFIX}%`})`,
        notExists(
          db
            .select({ one: sql`1` })
            .from(aiWorkflowRun)
            .where(
              and(
                eq(aiWorkflowRun.workItemId, workItem.id),
                eq(aiWorkflowRun.runKind, 'quote_followup'),
                eq(aiWorkflowRun.triggerMessageId, workItem.sentMessageId),
              ),
            ),
        ),
      ),
    )
    .limit(SWEEP_BATCH);
  for (const item of closedByReply) {
    if (!item.sentMessageId || !item.sentAt || !item.threadId) continue;
    const sent = (await threadMessages(db, item.transportId, item.threadId)).find(
      (m) => m.id === item.sentMessageId,
    );
    const extracts = sent ? (await storedPdfExtracts(db, [sent.id])).get(sent.id) : undefined;
    const filenames = sent ? (await storedAttachmentNames(db, [sent.id])).get(sent.id) : undefined;
    if (!sent || !sendStartsFollowUpClock(item.kind, sent, extracts, filenames)) {
      // Sentinel: due === sent. The row leaves this select (followUpDueAt not null) and never queues a draft.
      await db
        .update(workItem)
        .set({ followUpDueAt: item.sentAt, updatedAt: now })
        .where(
          and(
            eq(workItem.id, item.id),
            eq(workItem.sentMessageId, item.sentMessageId),
            isNull(workItem.followUpDueAt),
          ),
        );
      continue;
    }
    const [linked] = await db
      .update(workItem)
      .set({ followUpDueAt: addQuoteFollowupDelay(item.sentAt), updatedAt: now })
      .where(
        and(
          eq(workItem.id, item.id),
          eq(workItem.sentMessageId, item.sentMessageId),
          isNull(workItem.followUpDueAt),
        ),
      )
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
        inArray(workItem.kind, FOLLOW_UP_WORK_KINDS),
        or(inArray(workItem.status, OPEN_STATUSES), CLOSED_BY_HOTEL_REPLY),
        isNotNull(workItem.sentMessageId),
        isNotNull(workItem.followUpDueAt),
        // Sentinel (due === sent) is "no window, no draft". Real clocks are always sent + 66h.
        sql`${workItem.followUpDueAt} > ${workItem.sentAt}`,
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
    if (isSkippedHoldWindow(followUpDueAt, sentAt) || followUpDueAt.getTime() > now.getTime()) {
      continue;
    }
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

function followUpText(
  displayName: string | null,
  sentAt: Date,
  propertyCode: string,
  kind: string,
): string {
  const sentOn = new Intl.DateTimeFormat('en-ZA', {
    day: 'numeric',
    month: 'long',
    timeZone: 'Africa/Johannesburg',
  }).format(sentAt);
  if (kind === 'booking') {
    const hotel = quotePropertyIdentity(propertyCode).name;
    return [
      'Hello,',
      `I am following up on the confirmation we sent on ${sentOn} from ${hotel}. Please let us know if you would like to go ahead, or if you need any changes.`,
      ['Kind regards,', displayName].filter(Boolean).join('\n'),
    ].join('\n\n');
  }
  return quoteFollowUpBody(sentOn, displayName, propertyCode);
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
      kind: workItem.kind,
      status: workItem.status,
      threadId: workItem.threadId,
      sentMessageId: workItem.sentMessageId,
      closedByReply: sql<boolean>`${CLOSED_BY_HOTEL_REPLY}`,
    })
    .from(workItem)
    .where(eq(workItem.id, run.workItemId))
    .limit(1)
    // Locked for the caller's transaction, so staff closing the item now cannot be undone by the status change below.
    .for('update');
  if (!item?.threadId) return 'no_work_item';
  // A hotel-reply close is reopened for the follow-up; a close by a person is never reopened.
  if (item.status !== 'needs_you' && item.status !== 'review' && !item.closedByReply) return 'closed';
  if (item.sentMessageId !== run.triggerMessageId) return 'superseded';
  const thread = await threadMessages(db, run.transportId, item.threadId);
  // The quote the follow-up is for: our send, or the hotel's own copy of its answer when the reply link is that copy.
  const sentFrom = await knownSenders(db, run.transportId, ownDomainAddresses(thread));
  const sent = thread.find(
    (m) => m.id === run.triggerMessageId && (m.direction === 'outbound' || isHotelCopy(m, sentFrom)),
  );
  if (!sent) return 'no_sent_message';
  if (deliveredTime(sent) === null) return 'not_sent';
  if (clientRepliedAfter(thread, sentTime(sent))) return 'client_replied';
  if (staffRepliedAfter(thread, sent, sentFrom)) return 'staff_replied';

  const [transport] = await db
    .select({ displayName: mailboxTransport.displayName })
    .from(mailboxTransport)
    .where(eq(mailboxTransport.id, run.transportId))
    .limit(1);
  const text = followUpText(
    transport?.displayName ?? null,
    new Date(sentTime(sent)),
    isDaVinciTransport(run.transportId) ? 'HRDAV' : 'HRCEN',
    item.kind,
  );
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
        .where(and(eq(workItem.id, item.id), eq(workItem.status, item.status)));
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

/** The quote or booking work item a follow-up belongs to: the one whose first outbound the draft replies to. */
async function followUpWorkItemId(db: DB, draft: FollowUpDraft): Promise<string | null> {
  if (!draft.threadId || !draft.replyToMessageId) return null;
  const [row] = await db
    .select({ id: workItem.id })
    .from(workItem)
    .where(
      and(
        eq(workItem.transportId, draft.transportId),
        eq(workItem.threadId, draft.threadId),
        inArray(workItem.kind, FOLLOW_UP_WORK_KINDS),
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
      if (!sent) return { status: 'not_found' as const };
      const sentFrom = await knownSenders(tx as unknown as DB, draft.transportId, ownDomainAddresses(thread));
      if (overtaken(thread, sent, sentFrom)) return { status: 'not_found' as const };
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
        fieldPath: FOLLOW_UP_DRAFT_FIELD_PATH,
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
      fieldPath: FOLLOW_UP_DRAFT_FIELD_PATH,
      aiValue: draft.textBody,
      value: null,
      aiSource: QUOTE_FOLLOWUP_PROMPT_VERSION,
    });
    return 'dismissed' as const;
  });
}

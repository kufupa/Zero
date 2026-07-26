/**
 * Mail router: mailbox-scoped thread/message/label/attachment routes.
 *
 * Every procedure goes through `mailboxProcedure`, which resolves the caller's
 * active transport via `resolveMailboxContext`. Every thread/message lookup
 * is additionally filtered by `eq(...transportId, ctx.activeTransportId)` so
 * a leaked id from another mailbox returns NOT_FOUND / empty rather than
 * leaking data.
 *
 * `mail.send` is a stub here — Task 8 wires the real SMTP/fake transport.
 * This task wires the route + access guard + outbound row shape, leaving
 * transport as a no-op that records an outbound `message` row.
 */
import { TRPCError } from '@trpc/server';
import { assertSafeOutboundFields } from '../../mail/send/validate-outbound.js';
import { z } from 'zod';
import { and, eq, asc, desc, isNotNull, isNull, inArray, sql, exists, or, lte } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import { mailboxProcedure, router as tRouter } from '../trpc.js';
import { getDb } from '../../db/client.js';
import {
  mailThread,
  message,
  attachment,
  mailLabel,
  mailDraft,
  mailDraftRevision,
  mailCategory,
  mailThreadCategory,
} from '../../db/schema/mail.js';
import {
  requireThreadForTransport,
  requireMessageForTransport,
  encodePageCursor,
  decodePageCursor,
  keysetBefore,
  descNullsLast,
  resolveVisibleThreadIds,
  refreshThreadAfterMessageRemoved,
} from './mail-helpers.js';
import { resolveReplyHeaders } from '../../mail/send/resolve-reply-headers.js';
import {
  cancelOutbound,
  enqueueOutbound,
  flushOne,
  getUndoSendSeconds,
} from '../../mail/send/outbound-queue.js';
import { formatContentDispositionFilename } from '../../mail/attachment-filename.js';
import { sanitizeEmailHtml } from '../../mail/sanitize-email-html.js';
import { processQuotedContent } from '../../mail/collapse-quoted-html.js';
import { withMailboxIngestLock } from '../../mail/ingest/mailbox-ingest-lock.js';
import type { Pop3Client } from '../../mail/ingest/pop3-client.js';
import {
  DEFAULT_AI_MODEL_ID,
  DEFAULT_FEEDBACK_PROMPT_VERSION,
  enqueueAiRun,
} from '../../ai/run-ledger.js';
import {
  parseFromEmail,
  sendInput,
  toParsedMessage,
  buildMetadataDebugHeaders,
} from '../wire-compat.js';
import { toDraftWire } from './draft-wire.js';
import { buildThreadSearchConditions } from '../../mail/search/query.js';
import { parseSearchQueryOrThrow } from '../../mail/search/trpc.js';

/** FE + pilot folder slugs accepted by listThreads. */
export const MAIL_FOLDER_VALUES = [
  'inbox',
  'sent',
  'drafts',
  'draft',
  'archived',
  'archive',
  'bin',
  'spam',
  'starred',
  'snoozed',
  'all',
] as const;

/** FE bulk mutations send `{ ids }`; normalize to internal `threadIds`. */
export const bulkIdsInput = z.union([
  z.object({ ids: z.array(z.string()) }).transform(({ ids }) => ({ threadIds: ids })),
  z.object({ threadIds: z.array(z.string()) }),
]);

function toIsoDateTime(value: string | Date): string {
  const d = value instanceof Date ? value : new Date(value);
  return d.toISOString();
}

/** FE snooze sends `{ ids, wakeAt }`; normalize to internal names. */
export const snoozeThreadsInput = z.union([
  z
    .object({
      ids: z.array(z.string()),
      wakeAt: z.union([z.string(), z.date()]),
    })
    .transform(({ ids, wakeAt }) => ({
      threadIds: ids,
      snoozedUntil: toIsoDateTime(wakeAt),
    })),
  z.object({
    threadIds: z.array(z.string()),
    snoozedUntil: z.string().datetime(),
  }),
]);

/** FE modifyLabels sends `{ threadId }` (array); normalize to `threadIds`. */
export const modifyLabelsInput = z.union([
  z
    .object({
      threadId: z.array(z.string()),
      addLabels: z.array(z.string()).default([]),
      removeLabels: z.array(z.string()).default([]),
    })
    .transform(({ threadId, addLabels, removeLabels }) => ({
      threadIds: threadId,
      addLabels,
      removeLabels,
    })),
  z.object({
    threadIds: z.array(z.string()),
    addLabels: z.array(z.string()).default([]),
    removeLabels: z.array(z.string()).default([]),
  }),
]);

const moveThreadsInput = z.object({
  threadIds: z.array(z.string()).min(1),
  destination: z.enum(['inbox', 'archive', 'spam', 'bin']),
});

export const listThreadsInput = z.object({
  folder: z.enum(MAIL_FOLDER_VALUES).default('inbox'),
  q: z.string().max(512).optional(),
  labelIds: z.array(z.string()).optional(),
  filters: z
    .object({
      unread: z.boolean().optional(),
      important: z.boolean().optional(),
      starred: z.boolean().optional(),
      categoryIds: z.array(z.string()).optional(),
      labelIds: z.array(z.string()).optional(),
    })
    .optional(),
  cursor: z.string().optional(),
  limit: z.number().int().min(1).max(100).default(50),
});

/** Test-only POP3 override for `forceSync` → `ingestOnce`. */
let forceSyncPop3ForTests: Pop3Client | undefined;

export function __setForceSyncPop3ForTests(client: Pop3Client | undefined): void {
  forceSyncPop3ForTests = client;
}

/** Test-only: stub one ingest cycle (no DB / POP3). */
type ForceSyncCycleStub = () => Promise<{
  processed: number;
  listed: number;
  deled?: number;
  cycleError?: string;
}>;

let forceSyncIngestOnceForTests: ForceSyncCycleStub | undefined;

export function __setForceSyncIngestOnceForTests(
  stub: ForceSyncCycleStub | undefined,
): void {
  forceSyncIngestOnceForTests = stub;
}

export { __resetMailboxIngestLocksForTests } from '../../mail/ingest/mailbox-ingest-lock.js';

async function loadCategoryIdsByThreadIds(
  db: ReturnType<typeof getDb>,
  transportId: string,
  threadIds: string[],
): Promise<Map<string, string[]>> {
  const categoryIdsByThread = new Map<string, string[]>();
  if (threadIds.length === 0) return categoryIdsByThread;

  const categoryRows = await db
    .select({
      threadId: mailThreadCategory.threadId,
      categoryId: mailThreadCategory.categoryId,
    })
    .from(mailThreadCategory)
    .where(
      and(
        eq(mailThreadCategory.transportId, transportId),
        inArray(mailThreadCategory.threadId, threadIds),
      ),
    );

  for (const row of categoryRows) {
    const existing = categoryIdsByThread.get(row.threadId) ?? [];
    existing.push(row.categoryId);
    categoryIdsByThread.set(row.threadId, existing);
  }
  return categoryIdsByThread;
}

async function loadThreadCategoriesForGet(
  db: ReturnType<typeof getDb>,
  transportId: string,
  threadId: string,
): Promise<{
  categoryIds: string[];
  categories: Array<{
    id: string;
    slug: string;
    name: string;
    color: string | null;
    sortOrder: number;
  }>;
}> {
  const categoryIdsByThread = await loadCategoryIdsByThreadIds(db, transportId, [threadId]);
  const categoryIds = categoryIdsByThread.get(threadId) ?? [];
  if (categoryIds.length === 0) return { categoryIds: [], categories: [] };

  const categories = await db
    .select({
      id: mailCategory.id,
      slug: mailCategory.slug,
      name: mailCategory.name,
      color: mailCategory.color,
      sortOrder: mailCategory.sortOrder,
    })
    .from(mailCategory)
    .where(
      and(eq(mailCategory.transportId, transportId), inArray(mailCategory.id, categoryIds)),
    );

  return { categoryIds, categories };
}

export const mailRouter = tRouter({
  /**
   * List threads in the caller's active mailbox, filtered by folder/search.
   *
   * Folder semantics:
   *   inbox    -> isArchived=false, not trashed (default view)
   *   archived -> isArchived=true, not trashed
   *   bin      -> trashedAt IS NOT NULL
   *   starred  -> isStarred=true
   *   snoozed  -> snoozedUntil IS NOT NULL
   *   sent     -> exists a message with direction='outbound' on the thread
   *   drafts   -> handled by drafts.list, but returns empty here
   *   all      -> no folder filter
   */
  listThreads: mailboxProcedure
    .input(listThreadsInput)
    .query(async ({ input, ctx }) => {
      const db = getDb();
      const transportId = ctx.activeTransportId;
      const limit = input.limit;

      // Lazy-clear expired snoozes so they reappear in inbox without a cron.
      await db
        .update(mailThread)
        .set({ snoozedUntil: null, updatedAt: new Date() })
        .where(
          and(
            eq(mailThread.transportId, transportId),
            isNotNull(mailThread.snoozedUntil),
            lte(mailThread.snoozedUntil, sql`now()`),
          ),
        );

      if (input.folder === 'drafts' || input.folder === 'draft') {
        return { threads: [] as { id: string; transportId: string }[], nextPageToken: null };
      }

      const conditions = [eq(mailThread.transportId, transportId)];

      if (input.folder === 'bin') {
        conditions.push(isNotNull(mailThread.trashedAt));
      } else {
        conditions.push(isNull(mailThread.trashedAt));
      }

      if (input.folder === 'spam') {
        conditions.push(isNotNull(mailThread.spamAt));
      } else {
        conditions.push(isNull(mailThread.spamAt));
      }

      if (input.folder === 'inbox') {
        conditions.push(eq(mailThread.isArchived, false));
        conditions.push(
          or(
            isNull(mailThread.snoozedUntil),
            lte(mailThread.snoozedUntil, sql`now()`),
          )!,
        );
        // Inbox = has inbound mail; outbound-only compose threads live in sent.
        conditions.push(
          exists(
            db
              .select({ one: sql`1` })
              .from(message)
              .where(
                and(
                  eq(message.threadId, mailThread.id),
                  eq(message.transportId, transportId),
                  eq(message.direction, 'inbound'),
                ),
              ),
          ),
        );
      } else if (input.folder === 'archived' || input.folder === 'archive') {
        conditions.push(eq(mailThread.isArchived, true));
      } else if (input.folder === 'starred') {
        conditions.push(eq(mailThread.isStarred, true));
      } else if (input.folder === 'snoozed') {
        conditions.push(isNotNull(mailThread.snoozedUntil));
      }

      if (input.folder === 'sent') {
        conditions.push(
          exists(
            db
              .select({ one: sql`1` })
              .from(message)
              .where(
                and(
                  eq(message.threadId, mailThread.id),
                  eq(message.transportId, transportId),
                  eq(message.direction, 'outbound'),
                ),
              ),
          ),
        );
      }

      if (input.labelIds && input.labelIds.length > 0) {
        conditions.push(
          sql`${mailThread.labelIds} ?| array[${sql.join(
            input.labelIds.map((id) => sql`${id}`),
            sql`, `,
          )}]`,
        );
      }

      const filterLabelIds = input.filters?.labelIds ?? [];
      if (filterLabelIds.length > 0) {
        conditions.push(
          sql`${mailThread.labelIds} ?| array[${sql.join(
            filterLabelIds.map((id) => sql`${id}`),
            sql`, `,
          )}]`,
        );
      }

      // Structured filters AND parsed q operators both apply (e.g. filters.unread + is:read).
      if (input.filters?.unread === true) {
        conditions.push(eq(mailThread.isRead, false));
      }

      if (input.filters?.starred === true) {
        conditions.push(eq(mailThread.isStarred, true));
      }

      if (input.filters?.important === true) {
        conditions.push(sql`${mailThread.labelIds} ? 'IMPORTANT'`);
      }

      const filterCategoryIds = input.filters?.categoryIds ?? [];
      if (filterCategoryIds.length > 0) {
        conditions.push(
          exists(
            db
              .select({ one: sql`1` })
              .from(mailThreadCategory)
              .where(
                and(
                  eq(mailThreadCategory.threadId, mailThread.id),
                  eq(mailThreadCategory.transportId, transportId),
                  inArray(mailThreadCategory.categoryId, filterCategoryIds),
                ),
              ),
          ),
        );
      }

      if (input.q && input.q.trim()) {
        const parsed = parseSearchQueryOrThrow(input.q);
        conditions.push(
          ...buildThreadSearchConditions(db, parsed, { transportId }),
        );
      }

      if (input.cursor) {
        const decoded = decodePageCursor(input.cursor);
        if (decoded) {
          conditions.push(
            keysetBefore(
              mailThread.latestMessageAt,
              mailThread.id,
              decoded.ts,
              decoded.id,
            ),
          );
        } else {
          const cursorThread = await db
            .select({
              latestMessageAt: mailThread.latestMessageAt,
              id: mailThread.id,
            })
            .from(mailThread)
            .where(
              and(eq(mailThread.id, input.cursor), eq(mailThread.transportId, transportId)),
            )
            .limit(1);
          if (cursorThread.length > 0) {
            const row = cursorThread[0]!;
            conditions.push(
              keysetBefore(
                mailThread.latestMessageAt,
                mailThread.id,
                row.latestMessageAt ?? new Date(0),
                row.id,
              ),
            );
          }
        }
      }

      let rows = await db
        .select({
          id: mailThread.id,
          transportId: mailThread.transportId,
          subject: mailThread.subject,
          snippet: mailThread.snippet,
          isArchived: mailThread.isArchived,
          isStarred: mailThread.isStarred,
          isRead: mailThread.isRead,
          labelIds: mailThread.labelIds,
          snoozedUntil: mailThread.snoozedUntil,
          trashedAt: mailThread.trashedAt,
          latestMessageAt: mailThread.latestMessageAt,
          updatedAt: mailThread.updatedAt,
        })
        .from(mailThread)
        .where(and(...conditions))
        .orderBy(descNullsLast(mailThread.latestMessageAt), desc(mailThread.id))
        .limit(limit + 1);

      let nextPageToken: string | null = null;
      if (rows.length > limit) {
        const last = rows[limit - 1]!;
        rows = rows.slice(0, limit);
        nextPageToken = encodePageCursor(last.latestMessageAt, last.id);
      }

      const threadIds = rows.map((row) => row.id);
      const categoryIdsByThread = await loadCategoryIdsByThreadIds(db, transportId, threadIds);

      const draftCountRows =
        threadIds.length > 0
          ? await db
              .select({
                threadId: mailDraft.threadId,
                count: sql<number>`count(*)::int`,
              })
              .from(mailDraft)
              .where(
                and(
                  eq(mailDraft.transportId, transportId),
                  inArray(mailDraft.threadId, threadIds),
                  eq(mailDraft.isSent, false),
                  inArray(mailDraft.status, ['active', 'candidate']),
                ),
              )
              .groupBy(mailDraft.threadId)
          : [];
      const draftCountByThread = new Map(
        draftCountRows
          .filter((row): row is { threadId: string; count: number } => Boolean(row.threadId))
          .map((row) => [row.threadId, row.count]),
      );

      return {
        threads: rows.map((r) => ({
          id: r.id,
          transportId: r.transportId,
          subject: r.subject,
          snippet: r.snippet,
          isArchived: r.isArchived,
          isStarred: r.isStarred,
          isRead: r.isRead,
          labelIds: r.labelIds,
          snoozedUntil: r.snoozedUntil,
          trashedAt: r.trashedAt,
          latestMessageAt: r.latestMessageAt,
          historyId: null as string | null,
          categoryIds: categoryIdsByThread.get(r.id) ?? [],
          hasDraft: (draftCountByThread.get(r.id) ?? 0) > 0,
          draftCount: draftCountByThread.get(r.id) ?? 0,
        })),
        nextPageToken,
      };
    }),

  /**
   * Fetch a single thread with its messages, scoped to the caller's mailbox.
   */
  get: mailboxProcedure
    .input(z.object({ id: z.string() }))
    .query(async ({ input, ctx }) => {
      const db = getDb();
      const transportId = ctx.activeTransportId;
      const thread = await requireThreadForTransport(db, input.id, transportId);
      const messages = await db
        .select()
        .from(message)
        .where(
          and(eq(message.threadId, thread.id), eq(message.transportId, transportId)),
        )
        .orderBy(asc(message.receivedAt));
      const messageIds = messages.map((m) => m.id);
      const attachmentRows =
        messageIds.length > 0
          ? await db
              .select({
                messageId: attachment.messageId,
                attachmentId: attachment.id,
                filename: attachment.filename,
                mimeType: attachment.mimeType,
                size: attachment.sizeBytes,
              })
              .from(attachment)
              .where(inArray(attachment.messageId, messageIds))
          : [];
      const attachmentsByMessage = new Map<string, typeof attachmentRows>();
      for (const row of attachmentRows) {
        const list = attachmentsByMessage.get(row.messageId) ?? [];
        list.push(row);
        attachmentsByMessage.set(row.messageId, list);
      }
      const parsedMessages = messages.map((m) => {
        const parsed = toParsedMessage(m, attachmentsByMessage.get(m.id) ?? []);
        if (transportId !== 'transport-nava') return parsed;
        return {
          ...parsed,
          debugHeaders: buildMetadataDebugHeaders(m, ctx.transportEmail),
        };
      });
      const hasUnread = parsedMessages.some((m) => m.unread);
      const labels = await db
        .select({ id: mailLabel.id, name: mailLabel.name })
        .from(mailLabel)
        .where(eq(mailLabel.transportId, transportId));
      const threadLabelIds = new Set(thread.labelIds ?? []);
      const threadLabels = labels.filter((l) => threadLabelIds.has(l.id));
      const latest = parsedMessages[parsedMessages.length - 1];

      const draftRows = await db
        .select()
        .from(mailDraft)
        .where(
          and(
            eq(mailDraft.threadId, input.id),
            eq(mailDraft.transportId, transportId),
            eq(mailDraft.isSent, false),
            inArray(mailDraft.status, ['active', 'candidate']),
          ),
        )
        .orderBy(
          sql`CASE ${mailDraft.status} WHEN 'active' THEN 0 WHEN 'candidate' THEN 1 ELSE 2 END`,
          desc(mailDraft.updatedAt),
          desc(mailDraft.id),
        );

      const messageById = new Map(messages.map((row) => [row.id, row]));
      const latestInbound = messages
        .filter((row) => row.direction === 'inbound')
        .toSorted((a, b) => {
          const aTime = (a.receivedAt ?? a.createdAt).getTime();
          const bTime = (b.receivedAt ?? b.createdAt).getTime();
          return bTime - aTime;
        })[0];
      const latestInboundTime = latestInbound?.receivedAt ?? latestInbound?.createdAt ?? null;

      const drafts = draftRows.map((draft) => {
        const parent = draft.replyToMessageId ? messageById.get(draft.replyToMessageId) : undefined;
        const parentTime = parent?.receivedAt ?? parent?.sentAt ?? parent?.createdAt ?? null;
        const isStale =
          parentTime !== null &&
          latestInboundTime !== null &&
          latestInboundTime.getTime() > parentTime.getTime();
        return toDraftWire(draft, isStale);
      });

      const { categoryIds, categories } = await loadThreadCategoriesForGet(
        db,
        transportId,
        thread.id,
      );

      return {
        id: thread.id,
        transportId: thread.transportId,
        subject: thread.subject,
        snippet: thread.snippet,
        isArchived: thread.isArchived,
        isStarred: thread.isStarred,
        isRead: thread.isRead,
        labelIds: thread.labelIds,
        snoozedUntil: thread.snoozedUntil,
        latestMessageAt: thread.latestMessageAt,
        messages: parsedMessages,
        latest,
        hasUnread,
        totalReplies: Math.max(0, parsedMessages.length - 1),
        labels: threadLabels,
        drafts,
        categoryIds,
        categories,
      };
    }),

  markAsRead: mailboxProcedure
    .input(bulkIdsInput)
    .mutation(async ({ input, ctx }) => {
      const db = getDb();
      const transportId = ctx.activeTransportId;
      const visibleIds = await resolveVisibleThreadIds(db, transportId, input.threadIds);
      if (visibleIds.length === 0) return { updated: 0 };
      for (const id of visibleIds) {
        await db
          .update(mailThread)
          .set({ isRead: true, updatedAt: new Date() })
          .where(and(eq(mailThread.id, id), eq(mailThread.transportId, transportId)));
        await db
          .update(message)
          .set({ isRead: true, updatedAt: new Date() })
          .where(
            and(eq(message.threadId, id), eq(message.transportId, transportId)),
          );
      }
      return { updated: visibleIds.length };
    }),

  markAsUnread: mailboxProcedure
    .input(bulkIdsInput)
    .mutation(async ({ input, ctx }) => {
      const db = getDb();
      const transportId = ctx.activeTransportId;
      const visibleIds = await resolveVisibleThreadIds(db, transportId, input.threadIds);
      if (visibleIds.length === 0) return { updated: 0 };
      for (const id of visibleIds) {
        await db
          .update(mailThread)
          .set({ isRead: false, updatedAt: new Date() })
          .where(and(eq(mailThread.id, id), eq(mailThread.transportId, transportId)));
        await db
          .update(message)
          .set({ isRead: false, updatedAt: new Date() })
          .where(
            and(eq(message.threadId, id), eq(message.transportId, transportId)),
          );
      }
      return { updated: visibleIds.length };
    }),

  toggleStar: mailboxProcedure
    .input(bulkIdsInput)
    .mutation(async ({ input, ctx }) => {
      const db = getDb();
      const transportId = ctx.activeTransportId;
      const visibleIds = await resolveVisibleThreadIds(db, transportId, input.threadIds);
      if (visibleIds.length === 0) return { updated: 0 };
      const rows = await db
        .select({ id: mailThread.id, isStarred: mailThread.isStarred })
        .from(mailThread)
        .where(
          and(eq(mailThread.transportId, transportId), inArray(mailThread.id, visibleIds)),
        );
      const targetStarred = rows.some((r) => !r.isStarred);
      for (const row of rows) {
        await db
          .update(mailThread)
          .set({ isStarred: targetStarred, updatedAt: new Date() })
          .where(and(eq(mailThread.id, row.id), eq(mailThread.transportId, transportId)));
      }
      return { updated: rows.length };
    }),

  toggleImportant: mailboxProcedure
    .input(bulkIdsInput)
    .mutation(async ({ input, ctx }) => {
      const db = getDb();
      const transportId = ctx.activeTransportId;
      const visibleIds = await resolveVisibleThreadIds(db, transportId, input.threadIds);
      if (visibleIds.length === 0) return { updated: 0 };
      const IMPORTANT = 'IMPORTANT';
      for (const id of visibleIds) {
        const row = await requireThreadForTransport(db, id, transportId);
        const current = new Set(row.labelIds ?? []);
        let next: string[];
        if (current.has(IMPORTANT)) {
          current.delete(IMPORTANT);
          next = [...current];
        } else {
          current.add(IMPORTANT);
          next = [...current];
        }
        await db
          .update(mailThread)
          .set({ labelIds: next, updatedAt: new Date() })
          .where(and(eq(mailThread.id, id), eq(mailThread.transportId, transportId)));
      }
      return { updated: visibleIds.length };
    }),

  modifyLabels: mailboxProcedure
    .input(modifyLabelsInput)
    .mutation(async ({ input, ctx }) => {
      const db = getDb();
      const transportId = ctx.activeTransportId;
      const visibleIds = await resolveVisibleThreadIds(db, transportId, input.threadIds);
      if (visibleIds.length === 0) return { updated: 0 };
      const addSet = new Set(input.addLabels);
      const removeSet = new Set(input.removeLabels);
      const trashAdded = addSet.delete('TRASH');
      const trashRemoved = removeSet.delete('TRASH');
      addSet.delete('INBOX');
      removeSet.delete('INBOX');
      removeSet.delete('SENT');
      removeSet.delete('SPAM');
      removeSet.delete('SNOOZED');
      addSet.delete('SENT');
      addSet.delete('SPAM');
      addSet.delete('SNOOZED');
      for (const id of visibleIds) {
        const row = await requireThreadForTransport(db, id, transportId);
        const current = new Set(row.labelIds ?? []);
        for (const a of addSet) current.add(a);
        for (const r of removeSet) current.delete(r);
        const patch: {
          labelIds: string[];
          updatedAt: Date;
          trashedAt?: Date | null;
        } = { labelIds: [...current], updatedAt: new Date() };
        if (trashAdded) patch.trashedAt = new Date();
        if (trashRemoved) patch.trashedAt = null;
        await db
          .update(mailThread)
          .set(patch)
          .where(and(eq(mailThread.id, id), eq(mailThread.transportId, transportId)));
      }
      return { updated: visibleIds.length };
    }),

  moveThreads: mailboxProcedure
    .input(moveThreadsInput)
    .mutation(async ({ input, ctx }) => {
      const db = getDb();
      const transportId = ctx.activeTransportId;
      const visibleIds = await resolveVisibleThreadIds(db, transportId, input.threadIds);
      if (visibleIds.length === 0) return { updated: 0 };

      const patch: Partial<typeof mailThread.$inferInsert> = { updatedAt: new Date() };
      if (input.destination === 'archive') {
        patch.isArchived = true;
        patch.trashedAt = null;
        patch.spamAt = null;
      }
      if (input.destination === 'bin') {
        patch.trashedAt = new Date();
        patch.spamAt = null;
        patch.isArchived = false;
      }
      if (input.destination === 'spam') {
        patch.spamAt = new Date();
        patch.trashedAt = null;
        patch.isArchived = false;
      }
      if (input.destination === 'inbox') {
        patch.isArchived = false;
        patch.trashedAt = null;
        patch.spamAt = null;
        patch.snoozedUntil = null;
      }

      await db
        .update(mailThread)
        .set(patch)
        .where(and(eq(mailThread.transportId, transportId), inArray(mailThread.id, visibleIds)));

      return { updated: visibleIds.length };
    }),

  bulkArchive: mailboxProcedure
    .input(bulkIdsInput)
    .mutation(async ({ input, ctx }) => {
      const db = getDb();
      const transportId = ctx.activeTransportId;
      const visibleIds = await resolveVisibleThreadIds(db, transportId, input.threadIds);
      if (visibleIds.length === 0) return { updated: 0 };
      for (const id of visibleIds) {
        await db
          .update(mailThread)
          .set({ isArchived: true, updatedAt: new Date() })
          .where(and(eq(mailThread.id, id), eq(mailThread.transportId, transportId)));
      }
      return { updated: visibleIds.length };
    }),

  bulkDelete: mailboxProcedure
    .input(
      z.union([
        z
          .object({
            ids: z.array(z.string()),
            permanent: z.boolean().optional(),
          })
          .transform(({ ids, permanent }) => ({
            threadIds: ids,
            permanent: permanent ?? false,
          })),
        z.object({
          threadIds: z.array(z.string()),
          permanent: z.boolean().optional(),
        }),
      ]),
    )
    .mutation(async ({ input, ctx }) => {
      const db = getDb();
      const transportId = ctx.activeTransportId;
      const permanent = input.permanent ?? false;
      const visibleIds = await resolveVisibleThreadIds(db, transportId, input.threadIds);
      if (visibleIds.length === 0) return { updated: 0 };
      for (const id of visibleIds) {
        const row = await requireThreadForTransport(db, id, transportId);
        if (permanent && row.trashedAt) {
          await db
            .delete(mailThread)
            .where(and(eq(mailThread.id, id), eq(mailThread.transportId, transportId)));
        } else if (!row.trashedAt) {
          await db
            .update(mailThread)
            .set({ trashedAt: new Date(), updatedAt: new Date() })
            .where(and(eq(mailThread.id, id), eq(mailThread.transportId, transportId)));
        }
      }
      return { updated: visibleIds.length };
    }),

  delete: mailboxProcedure
    .input(z.object({ id: z.string() }))
    .mutation(async ({ input, ctx }) => {
      const db = getDb();
      const transportId = ctx.activeTransportId;
      const row = await requireThreadForTransport(db, input.id, transportId);
      if (row.trashedAt) {
        await db
          .delete(mailThread)
          .where(
            and(eq(mailThread.id, input.id), eq(mailThread.transportId, transportId)),
          );
      } else {
        await db
          .update(mailThread)
          .set({ trashedAt: new Date(), updatedAt: new Date() })
          .where(
            and(eq(mailThread.id, input.id), eq(mailThread.transportId, transportId)),
          );
      }
      return { deleted: true };
    }),

  snoozeThreads: mailboxProcedure
    .input(snoozeThreadsInput)
    .mutation(async ({ input, ctx }) => {
      const db = getDb();
      const transportId = ctx.activeTransportId;
      const until = new Date(input.snoozedUntil);
      const visibleIds = await resolveVisibleThreadIds(db, transportId, input.threadIds);
      if (visibleIds.length === 0) return { updated: 0 };
      for (const id of visibleIds) {
        await db
          .update(mailThread)
          .set({ snoozedUntil: until, updatedAt: new Date() })
          .where(and(eq(mailThread.id, id), eq(mailThread.transportId, transportId)));
      }
      return { updated: visibleIds.length };
    }),

  unsnoozeThreads: mailboxProcedure
    .input(bulkIdsInput)
    .mutation(async ({ input, ctx }) => {
      const db = getDb();
      const transportId = ctx.activeTransportId;
      const visibleIds = await resolveVisibleThreadIds(db, transportId, input.threadIds);
      if (visibleIds.length === 0) return { updated: 0 };
      for (const id of visibleIds) {
        await db
          .update(mailThread)
          .set({ snoozedUntil: null, updatedAt: new Date() })
          .where(and(eq(mailThread.id, id), eq(mailThread.transportId, transportId)));
      }
      return { updated: visibleIds.length };
    }),

  /**
   * Send a reply or new outbound message from the active mailbox.
   *
   * Uses fake SMTP transport in pilot pass; production adapter interface is
   * ready for Exchange Send As / SMTP relay when real mail is enabled.
   */
  send: mailboxProcedure
    .input(sendInput)
    .mutation(async ({ input, ctx }) => {
      assertSafeOutboundFields({
        to: input.to,
        cc: input.cc,
        bcc: input.bcc,
        subject: input.subject,
      });
      if (input.fromEmail) {
        const bareFrom = parseFromEmail(input.fromEmail);
        if (bareFrom !== ctx.transportEmail) {
          throw new TRPCError({ code: 'FORBIDDEN', message: 'FORBIDDEN: spoofed from address' });
        }
      }
      const db = getDb();
      const transportId = ctx.activeTransportId;
      let threadId = input.threadId;
      let selectedMessage: {
        messageIdHeader: string | null;
        references: string[] | null;
      } | null = null;
      let latestThreadPrior: {
        messageIdHeader: string | null;
        references: string[] | null;
      } | null = null;

      if (threadId) {
        await requireThreadForTransport(db, threadId, transportId);
        if (input.replyToMessageId) {
          const selected = await db
            .select({
              messageIdHeader: message.messageIdHeader,
              references: message.references,
            })
            .from(message)
            .where(
              and(
                eq(message.id, input.replyToMessageId),
                eq(message.threadId, threadId),
                eq(message.transportId, transportId),
              ),
            )
            .limit(1);
          if (!selected[0]) {
            throw new TRPCError({ code: 'NOT_FOUND', message: 'REPLY_TO_MESSAGE_NOT_FOUND' });
          }
          selectedMessage = selected[0]!;
        } else if (!input.inReplyTo) {
          const prior = await db
            .select({
              messageIdHeader: message.messageIdHeader,
              references: message.references,
            })
            .from(message)
            .where(
              and(eq(message.threadId, threadId), eq(message.transportId, transportId)),
            )
            .orderBy(desc(message.receivedAt))
            .limit(1);
          latestThreadPrior = prior[0] ?? null;
        }
      } else {
        threadId = randomUUID();
        await db.insert(mailThread).values({
          id: threadId,
          transportId,
          threadRootId: `outbound-${threadId}`,
          subject: input.subject || null,
          snippet: input.text.slice(0, 200) || input.subject || '',
          isArchived: false,
          isStarred: false,
          isRead: true,
          labelIds: [],
          latestMessageAt: new Date(),
        });
      }

      let sendingDraft: typeof mailDraft.$inferSelect | null = null;
      if (input.draftId) {
        const draftRows = await db
          .select()
          .from(mailDraft)
          .where(
            and(
              eq(mailDraft.id, input.draftId),
              eq(mailDraft.transportId, transportId),
              eq(mailDraft.isSent, false),
              eq(mailDraft.status, 'active'),
            ),
          )
          .limit(1);
        sendingDraft = draftRows[0] ?? null;
        if (!sendingDraft) {
          throw new TRPCError({ code: 'NOT_FOUND', message: 'DRAFT_NOT_FOUND' });
        }
        if (threadId && sendingDraft.replyToMessageId) {
          const parentRows = await db
            .select({ receivedAt: message.receivedAt, sentAt: message.sentAt, createdAt: message.createdAt })
            .from(message)
            .where(
              and(
                eq(message.id, sendingDraft.replyToMessageId),
                eq(message.transportId, transportId),
                eq(message.threadId, threadId),
              ),
            )
            .limit(1);
          const parent = parentRows[0];
          const parentTime = parent?.receivedAt ?? parent?.sentAt ?? parent?.createdAt ?? null;
          let hasNewerInbound = false;
          if (parentTime) {
            const inboundRows = await db
              .select({ receivedAt: message.receivedAt, createdAt: message.createdAt })
              .from(message)
              .where(
                and(
                  eq(message.threadId, threadId),
                  eq(message.transportId, transportId),
                  eq(message.direction, 'inbound'),
                ),
              );
            hasNewerInbound = inboundRows.some((row) => {
              const rowTime = row.receivedAt ?? row.createdAt;
              return rowTime.getTime() > parentTime.getTime();
            });
          }
          if (hasNewerInbound && !input.confirmStaleDraft) {
            throw new TRPCError({ code: 'CONFLICT', message: 'STALE_DRAFT' });
          }
        }
      }

      const { inReplyTo, references } = resolveReplyHeaders({
        selectedMessage,
        explicitInReplyTo: input.inReplyTo,
        explicitReferences: input.references,
        latestThreadPrior,
      });

      const smtpAttachments = (input.attachments ?? []).map((a) => ({
        filename: a.name,
        content: Buffer.from(a.base64, 'base64'),
        contentType: a.type,
      }));

      const smtpPayload = {
        from: ctx.transportEmail,
        to: input.to,
        cc: input.cc,
        bcc: input.bcc,
        subject: input.subject,
        html: input.html,
        text: input.text,
        inReplyTo,
        references,
        extraHeaders: { 'X-Zero-Mailbox': ctx.transportEmail },
        attachments: smtpAttachments,
      };

      const undoSecs = getUndoSendSeconds();
      const now = new Date();
      const scheduleAtMs = input.scheduleAt ? Date.parse(input.scheduleAt) : NaN;
      const isUserScheduled = Boolean(input.scheduleAt) && Number.isFinite(scheduleAtMs);
      const sendAt = isUserScheduled
        ? new Date(scheduleAtMs)
        : new Date(now.getTime() + undoSecs * 1000);

      const messageId = randomUUID();
      await db.transaction(async (tx) => {
        await tx.insert(message).values({
          id: messageId,
          transportId,
          threadId,
          direction: 'outbound',
          fromAddress: ctx.transportEmail,
          toAddresses: input.to,
          ccAddresses: input.cc,
          bccAddresses: input.bcc,
          subject: input.subject || null,
          textBody: input.text || null,
          htmlBody: input.html || null,
          messageIdHeader: null,
          inReplyTo,
          references,
          isRead: true,
          isStarred: false,
          sentAt: null,
          receivedAt: now,
        });
        await tx
          .update(mailThread)
          .set({ latestMessageAt: now, updatedAt: now })
          .where(and(eq(mailThread.id, threadId), eq(mailThread.transportId, transportId)));
        await enqueueOutbound({
          transportId,
          messageId,
          sendAt,
          smtpPayload,
          db: tx as unknown as typeof db,
        });
        if (input.draftId) {
          await tx
            .update(mailDraft)
            .set({
              isSent: true,
              status: 'sent',
              sentMessageId: messageId,
              updatedAt: now,
            })
            .where(
              and(eq(mailDraft.id, input.draftId), eq(mailDraft.transportId, transportId)),
            );
          await tx.insert(mailDraftRevision).values({
            id: randomUUID(),
            draftId: input.draftId,
            sentMessageId: messageId,
            actorUserId: ctx.sessionUser.id,
            kind: 'sent',
            toAddresses: input.to,
            ccAddresses: input.cc,
            bccAddresses: input.bcc,
            subject: input.subject || null,
            textBody: input.text || null,
            htmlBody: input.html || null,
            attachments: (input.attachments ?? []).map((a) => ({
              filename: a.name,
              mimeType: a.type,
              sizeBytes: a.size,
              s3Key: '',
            })),
          });
          if (sendingDraft?.generationId) {
            await enqueueAiRun(
              {
                transportId,
                threadId,
                triggerMessageId: messageId,
                runKind: 'feedback_extraction',
                idempotencyKey: `feedback:${input.draftId}`,
                modelId: DEFAULT_AI_MODEL_ID,
                promptVersion: DEFAULT_FEEDBACK_PROMPT_VERSION,
              },
              tx as unknown as typeof db,
            );
          }
        }
      });

      if (isUserScheduled) {
        return {
          scheduled: true as const,
          messageId,
          sendAt: sendAt.getTime(),
        };
      }

      if (undoSecs === 0) {
        const smtpResult = await flushOne(messageId, transportId, db);
        return {
          sent: true as const,
          messageId,
          threadId,
          fromEmail: ctx.transportEmail,
          smtpMessageId: smtpResult.messageId,
        };
      }

      return {
        queued: true as const,
        messageId,
        sendAt: sendAt.getTime(),
      };
    }),

  /**
   * Undo send — cancel pending queue row if still before sendAt; delete message.
   */
  unsend: mailboxProcedure
    .input(z.object({ messageId: z.string() }))
    .mutation(async ({ input, ctx }) => {
      const db = getDb();
      const transportId = ctx.activeTransportId;
      const msg = await requireMessageForTransport(db, input.messageId, transportId);
      if (msg.direction !== 'outbound') {
        throw new TRPCError({ code: 'BAD_REQUEST', message: 'not outbound' });
      }
      // Atomic: cancel + delete + thread refresh, or roll back. Cancel fail → no delete.
      await db.transaction(async (tx) => {
        const cancelled = await cancelOutbound(
          input.messageId,
          transportId,
          tx as unknown as typeof db,
        );
        if (!cancelled) {
          throw new TRPCError({
            code: 'BAD_REQUEST',
            message: 'UNDO_WINDOW_CLOSED',
          });
        }
        await tx
          .delete(message)
          .where(
            and(eq(message.id, input.messageId), eq(message.transportId, transportId)),
          );
        await refreshThreadAfterMessageRemoved(
          tx as unknown as typeof db,
          msg.threadId,
          transportId,
        );
      });
      return { unsent: true };
    }),

  /**
   * Force-sync: one POP3 ingest cycle under a mailbox-scoped in-memory lock.
   * If the lock is held, wait up to 30s; on timeout return cycleError.
   */
  forceSync: mailboxProcedure.mutation(async ({ ctx }) => {
    const mailboxKey = ctx.activeTransportId;
    const locked = await withMailboxIngestLock(mailboxKey, async () => {
      if (forceSyncIngestOnceForTests) {
        return forceSyncIngestOnceForTests();
      }
      const { ingestOnce } = await import('../../mail/ingest/worker.js');
      let maxMessages: number | undefined;
      try {
        const { parseEnv } = await import('../../env.js');
        maxMessages = parseEnv(process.env).POP3_MAX_MESSAGES_PER_CYCLE;
      } catch {
        maxMessages = undefined;
      }
      return ingestOnce({
        pop3: forceSyncPop3ForTests,
        db: getDb(),
        maxMessages,
      });
    });

    if (!locked.ok) {
      return {
        triggered: true as const,
        processed: 0,
        listed: 0,
        cycleError: locked.cycleError,
      };
    }

    const cycle = locked.value;
    return {
      triggered: true as const,
      processed: cycle.processed,
      listed: cycle.listed,
      deled: cycle.deled,
      cycleError: cycle.cycleError,
    };
  }),

  /**
   * Process email HTML for safe rendering (images, theme).
   */
  processEmailContent: mailboxProcedure
    .input(
      z.object({
        html: z.string(),
        shouldLoadImages: z.boolean().default(false),
        theme: z.enum(['light', 'dark']).default('light'),
      }),
    )
    .mutation(async ({ input }) => {
      const sanitized = sanitizeEmailHtml(input.html, {
        shouldLoadImages: input.shouldLoadImages,
      });
      const processedHtml = processQuotedContent(sanitized.html, input.theme);
      return {
        processedHtml,
        hasBlockedImages: sanitized.hasBlockedImages,
      };
    }),

  /**
   * Email verification badge — stub. Returns unverified for pilot.
   */
  verifyEmail: mailboxProcedure
    .input(
      z.object({
        id: z.string().optional(),
        email: z.string().optional(),
      }),
    )
    .query(async () => {
      return { isVerified: false, messageId: null as string | null };
    }),

  /**
   * Recipient autosuggest — stub. Returns empty for pilot; future task wires
   * a real contacts source.
   */
  suggestRecipients: mailboxProcedure
    .input(
      z.object({
        q: z.string().optional(),
        query: z.string().optional(),
        limit: z.number().optional(),
      }),
    )
    .query(async ({ input }) => {
      const search = (input.query ?? input.q ?? '').trim();
      void search;
      return [] as { email: string; name?: string }[];
    }),

  /**
   * List attachments for a message, scoped to the caller's mailbox.
   */
  getMessageAttachments: mailboxProcedure
    .input(z.object({ messageId: z.string() }))
    .query(async ({ input, ctx }) => {
      const db = getDb();
      const transportId = ctx.activeTransportId;
      // Verify the message belongs to the caller's mailbox.
      await requireMessageForTransport(db, input.messageId, transportId);
      const rows = await db
        .select({
          attachmentId: attachment.id,
          filename: attachment.filename,
          mimeType: attachment.mimeType,
          size: attachment.sizeBytes,
          isInline: attachment.isInline,
          contentId: attachment.contentId,
        })
        .from(attachment)
        .where(eq(attachment.messageId, input.messageId));
      return rows.map((r) => ({
        attachmentId: r.attachmentId,
        filename: r.filename,
        mimeType: r.mimeType,
        size: r.size,
        body: '', // body is fetched via mail.getAttachment with a signed URL
        headers: [] as { name: string; value: string }[],
      }));
    }),

  /**
   * Fetch a single attachment's signed S3 URL, scoped to the caller's
   * mailbox. The frontend uses the signed URL to download the bytes directly
   * from S3; the route never streams bytes through the API server.
   *
   * Access guard: load the attachment's message, verify the message's
   * transportId == ctx.activeTransportId. A user without access to the
   * mailbox cannot fetch attachments for messages in that mailbox.
   */
  getAttachment: mailboxProcedure
    .input(
      z.object({ messageId: z.string(), attachmentId: z.string() }),
    )
    .query(async ({ input, ctx }) => {
      const db = getDb();
      const transportId = ctx.activeTransportId;
      // Verify the message belongs to the caller's mailbox.
      await requireMessageForTransport(db, input.messageId, transportId);
      const rows = await db
        .select({
          id: attachment.id,
          filename: attachment.filename,
          mimeType: attachment.mimeType,
          sizeBytes: attachment.sizeBytes,
          s3Key: attachment.s3Key,
        })
        .from(attachment)
        .where(
          and(
            eq(attachment.id, input.attachmentId),
            eq(attachment.messageId, input.messageId),
          ),
        )
        .limit(1);
      if (rows.length === 0) {
        throw new TRPCError({ code: 'NOT_FOUND', message: 'NOT_FOUND: attachment not found' });
      }
      const att = rows[0]!;
      // Build a signed S3 GET URL (or, for the fake S3 used in tests, a
      // synthetic inline URL). Defer to the storage layer so production and
      // test paths share code.
      const url = await getSignedAttachmentUrl(att.s3Key, att.filename, att.mimeType);
      return {
        attachmentId: att.id,
        filename: att.filename,
        mimeType: att.mimeType,
        size: att.sizeBytes,
        url,
      };
    }),

  listAttachments: mailboxProcedure
    .input(z.object({ messageId: z.string() }))
    .query(async ({ input, ctx }) => {
      const db = getDb();
      const transportId = ctx.activeTransportId;
      await requireMessageForTransport(db, input.messageId, transportId);
      const rows = await db
        .select({
          attachmentId: attachment.id,
          filename: attachment.filename,
          mimeType: attachment.mimeType,
          size: attachment.sizeBytes,
        })
        .from(attachment)
        .where(eq(attachment.messageId, input.messageId));
      return { attachments: rows };
    }),
});

/**
 * Build a signed S3 GET URL for an attachment key.
 *
 * Production: uses `@aws-sdk/s3-request-presigner` with the default AWS
 * credential chain (EC2 instance profile). Test/fake path: returns a
 * synthetic `zero-fake-s3://` URL so tests can assert the route returns a
 * URL without a real S3 round-trip.
 */
export async function getSignedAttachmentUrl(
  s3Key: string,
  filename: string,
  mimeType: string,
): Promise<string> {
  const bucket = process.env.S3_BUCKET;
  const region = process.env.AWS_REGION;
  if (!bucket || !region) {
    // Test/fake path — no real S3 configured.
    return `zero-fake-s3://${bucket ?? 'fake-mail-bucket'}/${encodeURIComponent(
      s3Key,
    )}?filename=${encodeURIComponent(filename)}&mime=${encodeURIComponent(mimeType)}`;
  }
  const { S3Client, GetObjectCommand } = await import('@aws-sdk/client-s3');
  const { getSignedUrl } = await import('@aws-sdk/s3-request-presigner');
  const client = new S3Client({ region });
  const cmd = new GetObjectCommand({
    Bucket: bucket,
    Key: s3Key,
    ResponseContentDisposition: formatContentDispositionFilename(filename),
    ResponseContentType: mimeType,
  });
  // 5-minute signed URL — short-lived so a leaked URL is bounded.
  return getSignedUrl(client, cmd, { expiresIn: 300 });
}

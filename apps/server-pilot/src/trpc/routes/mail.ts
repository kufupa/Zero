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
import { and, eq, desc, isNotNull, inArray } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import { mailboxProcedure, router as tRouter } from '../trpc.js';
import { getDb } from '../../db/client.js';
import {
  mailThread,
  message,
  attachment,
  mailLabel,
} from '../../db/schema/mail.js';
import {
  requireThreadForTransport,
  requireMessageForTransport,
} from './mail-helpers.js';
import {
  getSmtpTransport,
  buildReplyHeaders,
} from '../../mail/send/smtp.js';
import { sanitizeEmailHtml } from '../../mail/sanitize-email-html.js';

const FOLDER_VALUES = [
  'inbox',
  'sent',
  'drafts',
  'archived',
  'starred',
  'snoozed',
  'all',
] as const;

const listThreadsInput = z.object({
  folder: z.enum(FOLDER_VALUES).default('inbox'),
  q: z.string().optional(),
  labelIds: z.array(z.string()).optional(),
  cursor: z.string().optional(),
  limit: z.number().int().min(1).max(100).default(50),
});

export const mailRouter = tRouter({
  /**
   * List threads in the caller's active mailbox, filtered by folder/search.
   *
   * Folder semantics:
   *   inbox    -> isArchived=false (default view)
   *   archived -> isArchived=true
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

      // drafts folder is owned by drafts.list; return empty for compatibility.
      if (input.folder === 'drafts') {
        return { threads: [] as { id: string; transportId: string }[], nextPageToken: null };
      }

      const conditions = [eq(mailThread.transportId, transportId)];

      if (input.folder === 'inbox') {
        conditions.push(eq(mailThread.isArchived, false));
      } else if (input.folder === 'archived') {
        conditions.push(eq(mailThread.isArchived, true));
      } else if (input.folder === 'starred') {
        conditions.push(eq(mailThread.isStarred, true));
      } else if (input.folder === 'snoozed') {
        conditions.push(isNotNull(mailThread.snoozedUntil));
      }

      // sent: thread has at least one outbound message on this transport.
      let sentThreadIds: string[] | null = null;
      if (input.folder === 'sent') {
        const sentRows = await db
          .select({ threadId: message.threadId })
          .from(message)
          .where(
            and(
              eq(message.transportId, transportId),
              eq(message.direction, 'outbound'),
            ),
          )
          .groupBy(message.threadId);
        sentThreadIds = sentRows.map((r) => r.threadId);
        if (sentThreadIds.length === 0) {
          return { threads: [], nextPageToken: null };
        }
      }

      let query = db
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
          latestMessageAt: mailThread.latestMessageAt,
          updatedAt: mailThread.updatedAt,
        })
        .from(mailThread)
        .where(
          sentThreadIds
            ? and(eq(mailThread.transportId, transportId), inArray(mailThread.id, sentThreadIds))
            : and(...conditions),
        )
        .orderBy(desc(mailThread.latestMessageAt))
        .limit(limit + 1);

      let rows = await query;
      let nextPageToken: string | null = null;
      if (rows.length > limit) {
        rows = rows.slice(0, limit);
        nextPageToken = rows[rows.length - 1]?.id ?? null;
      }
      const cursor = input.cursor;
      if (cursor) {
        // Simple cursor: drop threads with latestMessageAt <= the cursor
        // thread's latestMessageAt. Caller passes the last id.
        const cursorThread = await db
          .select({ latestMessageAt: mailThread.latestMessageAt })
          .from(mailThread)
          .where(and(eq(mailThread.id, cursor), eq(mailThread.transportId, transportId)))
          .limit(1);
        if (cursorThread.length > 0 && cursorThread[0]!.latestMessageAt) {
          const cutoff = cursorThread[0]!.latestMessageAt!;
          rows = rows.filter(
            (r) => (r.latestMessageAt ? r.latestMessageAt < cutoff : false),
          );
        }
      }

      // Optional label filter: thread.labelIds jsonb overlaps input.labelIds.
      if (input.labelIds && input.labelIds.length > 0) {
        const wanted = new Set(input.labelIds);
        rows = rows.filter((r) => (r.labelIds ?? []).some((id) => wanted.has(id)));
      }

      // Optional text search across subject + snippet.
      if (input.q && input.q.trim()) {
        const q = input.q.trim().toLowerCase();
        rows = rows.filter(
          (r) =>
            (r.subject?.toLowerCase().includes(q) ?? false) ||
            (r.snippet?.toLowerCase().includes(q) ?? false),
        );
      }

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
          latestMessageAt: r.latestMessageAt,
          historyId: null as string | null,
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
        .orderBy(desc(message.receivedAt));
      const hasUnread = messages.some((m) => !m.isRead);
      const labels = await db
        .select({ id: mailLabel.id, name: mailLabel.name })
        .from(mailLabel)
        .where(eq(mailLabel.transportId, transportId));
      const threadLabelIds = new Set(thread.labelIds ?? []);
      const threadLabels = labels.filter((l) => threadLabelIds.has(l.id));
      const latest = messages[0] ?? undefined;
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
        messages: messages.map((m) => ({
          id: m.id,
          threadId: m.threadId,
          transportId: m.transportId,
          direction: m.direction,
          fromAddress: m.fromAddress,
          toAddresses: m.toAddresses,
          ccAddresses: m.ccAddresses,
          bccAddresses: m.bccAddresses,
          subject: m.subject,
          textBody: m.textBody,
          htmlBody: m.htmlBody,
          isRead: m.isRead,
          isStarred: m.isStarred,
          isDraft: false,
          receivedAt: m.receivedAt,
          sentAt: m.sentAt,
          messageId: m.messageIdHeader,
          inReplyTo: m.inReplyTo,
          references: m.references,
          attachments: [] as {
            attachmentId: string;
            filename: string;
            mimeType: string;
            size: number;
          }[],
        })),
        latest: latest
          ? {
              id: latest.id,
              threadId: latest.threadId,
              subject: latest.subject,
              fromAddress: latest.fromAddress,
              toAddresses: latest.toAddresses,
              receivedAt: latest.receivedAt,
              isRead: latest.isRead,
              isStarred: latest.isStarred,
            }
          : undefined,
        hasUnread,
        totalReplies: Math.max(0, messages.length - 1),
        labels: threadLabels,
      };
    }),

  markAsRead: mailboxProcedure
    .input(z.object({ threadIds: z.array(z.string()) }))
    .mutation(async ({ input, ctx }) => {
      const db = getDb();
      const transportId = ctx.activeTransportId;
      // Only operate on threads the caller can see.
      const visible = await db
        .select({ id: mailThread.id })
        .from(mailThread)
        .where(
          and(
            eq(mailThread.transportId, transportId),
            inArray(mailThread.id, input.threadIds),
          ),
        );
      const visibleIds = visible.map((v) => v.id);
      // Strict NOT_FOUND when a single id is requested and not visible —
      // matches the brief's isolation test. Bulk updates silently skip
      // unknown ids (user-friendly idempotent behavior).
      if (
        input.threadIds.length === 1 &&
        !visibleIds.includes(input.threadIds[0]!)
      ) {
        throw new TRPCError({ code: 'NOT_FOUND', message: 'NOT_FOUND: thread not found' });
      }
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
    .input(z.object({ threadIds: z.array(z.string()) }))
    .mutation(async ({ input, ctx }) => {
      const db = getDb();
      const transportId = ctx.activeTransportId;
      const visible = await db
        .select({ id: mailThread.id })
        .from(mailThread)
        .where(
          and(
            eq(mailThread.transportId, transportId),
            inArray(mailThread.id, input.threadIds),
          ),
        );
      const visibleIds = visible.map((v) => v.id);
      if (
        input.threadIds.length === 1 &&
        !visibleIds.includes(input.threadIds[0]!)
      ) {
        throw new TRPCError({ code: 'NOT_FOUND', message: 'NOT_FOUND: thread not found' });
      }
      for (const id of visibleIds) {
        await db
          .update(mailThread)
          .set({ isRead: false, updatedAt: new Date() })
          .where(and(eq(mailThread.id, id), eq(mailThread.transportId, transportId)));
      }
      return { updated: visibleIds.length };
    }),

  toggleStar: mailboxProcedure
    .input(z.object({ threadIds: z.array(z.string()) }))
    .mutation(async ({ input, ctx }) => {
      const db = getDb();
      const transportId = ctx.activeTransportId;
      for (const id of input.threadIds) {
        const row = await requireThreadForTransport(db, id, transportId);
        await db
          .update(mailThread)
          .set({ isStarred: !row.isStarred, updatedAt: new Date() })
          .where(and(eq(mailThread.id, id), eq(mailThread.transportId, transportId)));
      }
      return { updated: input.threadIds.length };
    }),

  toggleImportant: mailboxProcedure
    .input(z.object({ threadIds: z.array(z.string()) }))
    .mutation(async ({ input, ctx }) => {
      // No dedicated important column; treat as a label toggle for IMPORTANT.
      const db = getDb();
      const transportId = ctx.activeTransportId;
      const importantLabel = await db
        .select({ id: mailLabel.id })
        .from(mailLabel)
        .where(
          and(eq(mailLabel.transportId, transportId), eq(mailLabel.name, 'IMPORTANT')),
        )
        .limit(1);
      const importantId = importantLabel[0]?.id;
      if (!importantId) return { updated: 0 };
      for (const id of input.threadIds) {
        const row = await requireThreadForTransport(db, id, transportId);
        const current = new Set(row.labelIds ?? []);
        let next: string[];
        if (current.has(importantId)) {
          current.delete(importantId);
          next = [...current];
        } else {
          current.add(importantId);
          next = [...current];
        }
        await db
          .update(mailThread)
          .set({ labelIds: next, updatedAt: new Date() })
          .where(and(eq(mailThread.id, id), eq(mailThread.transportId, transportId)));
      }
      return { updated: input.threadIds.length };
    }),

  modifyLabels: mailboxProcedure
    .input(
      z.object({
        threadIds: z.array(z.string()),
        addLabels: z.array(z.string()).default([]),
        removeLabels: z.array(z.string()).default([]),
      }),
    )
    .mutation(async ({ input, ctx }) => {
      const db = getDb();
      const transportId = ctx.activeTransportId;
      const addSet = new Set(input.addLabels);
      const removeSet = new Set(input.removeLabels);
      for (const id of input.threadIds) {
        const row = await requireThreadForTransport(db, id, transportId);
        const current = new Set(row.labelIds ?? []);
        for (const a of addSet) current.add(a);
        for (const r of removeSet) current.delete(r);
        await db
          .update(mailThread)
          .set({ labelIds: [...current], updatedAt: new Date() })
          .where(and(eq(mailThread.id, id), eq(mailThread.transportId, transportId)));
      }
      return { updated: input.threadIds.length };
    }),

  bulkArchive: mailboxProcedure
    .input(z.object({ threadIds: z.array(z.string()) }))
    .mutation(async ({ input, ctx }) => {
      const db = getDb();
      const transportId = ctx.activeTransportId;
      for (const id of input.threadIds) {
        await requireThreadForTransport(db, id, transportId);
        await db
          .update(mailThread)
          .set({ isArchived: true, updatedAt: new Date() })
          .where(and(eq(mailThread.id, id), eq(mailThread.transportId, transportId)));
      }
      return { updated: input.threadIds.length };
    }),

  bulkDelete: mailboxProcedure
    .input(z.object({ threadIds: z.array(z.string()) }))
    .mutation(async ({ input, ctx }) => {
      // Hard-delete threads the caller can see. Cascades to messages +
      // attachments via FK ON DELETE CASCADE. Drafts on these threads also
      // cascade (Task 4 note: be aware; do not delete threads casually).
      const db = getDb();
      const transportId = ctx.activeTransportId;
      for (const id of input.threadIds) {
        await requireThreadForTransport(db, id, transportId);
        await db
          .delete(mailThread)
          .where(and(eq(mailThread.id, id), eq(mailThread.transportId, transportId)));
      }
      return { updated: input.threadIds.length };
    }),

  delete: mailboxProcedure
    .input(z.object({ id: z.string() }))
    .mutation(async ({ input, ctx }) => {
      const db = getDb();
      const transportId = ctx.activeTransportId;
      await requireThreadForTransport(db, input.id, transportId);
      await db
        .delete(mailThread)
        .where(
          and(eq(mailThread.id, input.id), eq(mailThread.transportId, transportId)),
        );
      return { deleted: true };
    }),

  snoozeThreads: mailboxProcedure
    .input(
      z.object({
        threadIds: z.array(z.string()),
        snoozedUntil: z.string().datetime(),
      }),
    )
    .mutation(async ({ input, ctx }) => {
      const db = getDb();
      const transportId = ctx.activeTransportId;
      const until = new Date(input.snoozedUntil);
      for (const id of input.threadIds) {
        await requireThreadForTransport(db, id, transportId);
        await db
          .update(mailThread)
          .set({ snoozedUntil: until, updatedAt: new Date() })
          .where(and(eq(mailThread.id, id), eq(mailThread.transportId, transportId)));
      }
      return { updated: input.threadIds.length };
    }),

  unsnoozeThreads: mailboxProcedure
    .input(z.object({ threadIds: z.array(z.string()) }))
    .mutation(async ({ input, ctx }) => {
      const db = getDb();
      const transportId = ctx.activeTransportId;
      for (const id of input.threadIds) {
        await requireThreadForTransport(db, id, transportId);
        await db
          .update(mailThread)
          .set({ snoozedUntil: null, updatedAt: new Date() })
          .where(and(eq(mailThread.id, id), eq(mailThread.transportId, transportId)));
      }
      return { updated: input.threadIds.length };
    }),

  /**
   * Send a reply or new outbound message from the active mailbox.
   *
   * Uses fake SMTP transport in pilot pass; production adapter interface is
   * ready for Exchange Send As / SMTP relay when real mail is enabled.
   */
  send: mailboxProcedure
    .input(
      z.object({
        threadId: z.string().optional(),
        to: z.array(z.string()),
        cc: z.array(z.string()).default([]),
        bcc: z.array(z.string()).default([]),
        subject: z.string().default(''),
        html: z.string().default(''),
        text: z.string().default(''),
        fromEmail: z.string().optional(),
        draftId: z.string().optional(),
      }),
    )
    .mutation(async ({ input, ctx }) => {
      assertSafeOutboundFields({
        to: input.to,
        cc: input.cc,
        bcc: input.bcc,
        subject: input.subject,
      });
      if (input.fromEmail && input.fromEmail !== ctx.transportEmail) {
        throw new TRPCError({ code: 'FORBIDDEN', message: 'FORBIDDEN: spoofed from address' });
      }
      const db = getDb();
      const transportId = ctx.activeTransportId;
      let threadId = input.threadId;
      let inReplyTo: string | null = null;
      let references: string[] = [];

      if (threadId) {
        await requireThreadForTransport(db, threadId, transportId);
        // Reply headers from latest inbound/outbound message on thread.
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
        if (prior[0]) {
          const headers = buildReplyHeaders(prior[0]!);
          inReplyTo = headers.inReplyTo;
          references = headers.references;
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

      const smtpResult = await getSmtpTransport().send({
        from: ctx.transportEmail,
        to: input.to,
        cc: input.cc,
        bcc: input.bcc,
        subject: input.subject,
        html: input.html,
        text: input.text,
        inReplyTo,
        references,
      });

      const messageId = randomUUID();
      const now = new Date();
      await db.insert(message).values({
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
        messageIdHeader: smtpResult.messageId,
        inReplyTo,
        references,
        isRead: true,
        isStarred: false,
        sentAt: now,
        receivedAt: now,
      });
      await db
        .update(mailThread)
        .set({ latestMessageAt: now, updatedAt: now })
        .where(and(eq(mailThread.id, threadId), eq(mailThread.transportId, transportId)));
      return {
        messageId,
        threadId,
        fromEmail: ctx.transportEmail,
        sent: true,
        smtpMessageId: smtpResult.messageId,
      };
    }),

  /**
   * Undo send — stub. Task 8 will implement by deleting the outbound row
   * before the SMTP send commits (undo window).
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
      // Stub: delete the outbound message row. Task 8 will gate this on the
      // undo window (e.g. message.sentAt within 30s).
      await db
        .delete(message)
        .where(
          and(eq(message.id, input.messageId), eq(message.transportId, transportId)),
        );
      return { unsent: true };
    }),

  /**
   * Force-sync trigger — stub. The pilot worker polls on its own schedule;
   * this is a no-op until a real sync trigger is wired.
   */
  forceSync: mailboxProcedure.mutation(async () => {
    return { triggered: true };
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
      const result = sanitizeEmailHtml(input.html, {
        shouldLoadImages: input.shouldLoadImages,
      });
      return {
        processedHtml: result.html,
        hasBlockedImages: result.hasBlockedImages,
      };
    }),

  /**
   * Email verification badge — stub. Returns unverified for pilot.
   */
  verifyEmail: mailboxProcedure
    .input(z.object({ id: z.string() }))
    .query(async () => {
      return { verified: false, messageId: null as string | null };
    }),

  /**
   * Recipient autosuggest — stub. Returns empty for pilot; future task wires
   * a real contacts source.
   */
  suggestRecipients: mailboxProcedure
    .input(z.object({ q: z.string() }))
    .query(async () => {
      return { recipients: [] as { email: string; name?: string }[] };
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
      return {
        attachments: rows.map((r) => ({
          attachmentId: r.attachmentId,
          filename: r.filename,
          mimeType: r.mimeType,
          size: r.size,
          body: '', // body is fetched via mail.getAttachment with a signed URL
          headers: [] as { name: string; value: string }[],
        })),
      };
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
    ResponseContentDisposition: `attachment; filename="${filename}"`,
    ResponseContentType: mimeType,
  });
  // 5-minute signed URL — short-lived so a leaked URL is bounded.
  return getSignedUrl(client, cmd, { expiresIn: 300 });
}

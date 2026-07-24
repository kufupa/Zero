/**
 * Drafts router: mailbox-scoped draft CRUD.
 *
 * Drafts are scoped to the caller's active transport. A draft may optionally
 * attach to a thread (`threadId`); the thread is verified to belong to the
 * same transport before linking.
 */
import { TRPCError } from '@trpc/server';
import { z } from 'zod';
import { and, eq, desc, inArray, sql } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import { mailboxProcedure, router as tRouter } from '../trpc.js';
import { getDb } from '../../db/client.js';
import { mailDraft, mailDraftRevision } from '../../db/schema/mail.js';
import {
  requireThreadForTransport,
  requireMessageForTransport,
  encodePageCursor,
  decodePageCursor,
  keysetBefore,
} from './mail-helpers.js';
import { createDraftInput } from '../wire-compat.js';
import { toDraftWire } from './draft-wire.js';
import { buildDraftSearchConditions } from '../../mail/search/query.js';
import { parseSearchQueryOrThrow } from '../../mail/search/trpc.js';

function isPostgresUniqueViolation(err: unknown): boolean {
  if (err && typeof err === 'object' && 'code' in err) {
    if ((err as { code: string }).code === '23505') return true;
  }
  if (err instanceof Error && err.cause !== undefined) {
    return isPostgresUniqueViolation(err.cause);
  }
  return false;
}

export const draftsRouter = tRouter({
  list: mailboxProcedure
    .input(
      z.object({
        q: z.string().max(512).optional(),
        cursor: z.string().optional(),
        limit: z.number().int().min(1).max(100).default(50),
        threadId: z.string().optional(),
      }),
    )
    .query(async ({ input, ctx }) => {
      const db = getDb();
      const transportId = ctx.activeTransportId;
      const limit = input.limit;

      const conditions = [
        eq(mailDraft.transportId, transportId),
        eq(mailDraft.isSent, false),
        inArray(mailDraft.status, ['active', 'candidate']),
      ];

      if (input.threadId) {
        await requireThreadForTransport(db, input.threadId, transportId);
        conditions.push(eq(mailDraft.threadId, input.threadId));
      }

      if (input.q && input.q.trim()) {
        const parsed = parseSearchQueryOrThrow(input.q);
        conditions.push(...buildDraftSearchConditions(parsed));
      }

      if (input.cursor) {
        const decoded = decodePageCursor(input.cursor);
        if (decoded) {
          conditions.push(
            keysetBefore(mailDraft.updatedAt, mailDraft.id, decoded.ts, decoded.id),
          );
        } else {
          const cursorDraft = await db
            .select({ updatedAt: mailDraft.updatedAt, id: mailDraft.id })
            .from(mailDraft)
            .where(
              and(eq(mailDraft.id, input.cursor), eq(mailDraft.transportId, transportId)),
            )
            .limit(1);
          if (cursorDraft.length > 0) {
            const row = cursorDraft[0]!;
            conditions.push(
              keysetBefore(
                mailDraft.updatedAt,
                mailDraft.id,
                row.updatedAt ?? new Date(0),
                row.id,
              ),
            );
          }
        }
      }

      let rows = await db
        .select()
        .from(mailDraft)
        .where(and(...conditions))
        .orderBy(desc(mailDraft.updatedAt), desc(mailDraft.id))
        .limit(limit + 1);

      let nextPageToken: string | null = null;
      if (rows.length > limit) {
        const last = rows[limit - 1]!;
        rows = rows.slice(0, limit);
        nextPageToken = encodePageCursor(last.updatedAt, last.id);
      }

      return {
        threads: rows.map((r) => toDraftWire(r)),
        nextPageToken,
      };
    }),

  get: mailboxProcedure
    .input(z.object({ id: z.string() }))
    .query(async ({ input, ctx }) => {
      const db = getDb();
      const transportId = ctx.activeTransportId;
      const rows = await db
        .select()
        .from(mailDraft)
        .where(
          and(eq(mailDraft.id, input.id), eq(mailDraft.transportId, transportId)),
        )
        .limit(1);
      if (rows.length === 0) {
        throw new TRPCError({ code: 'NOT_FOUND', message: 'NOT_FOUND: draft not found' });
      }
      const r = rows[0]!;
      return toDraftWire(r);
    }),

  ensureEditableForReply: mailboxProcedure
    .input(
      z.object({
        threadId: z.string(),
        replyToMessageId: z.string().nullable().optional(),
      }),
    )
    .mutation(async ({ input, ctx }) => {
      const db = getDb();
      const transportId = ctx.activeTransportId;
      const replyToMessageId = input.replyToMessageId;
      if (!replyToMessageId) {
        throw new TRPCError({ code: 'BAD_REQUEST', message: 'REPLY_PARENT_REQUIRED' });
      }
      await requireThreadForTransport(db, input.threadId, transportId);
      const replyParent = await requireMessageForTransport(db, replyToMessageId, transportId);
      if (replyParent.threadId !== input.threadId) {
        throw new TRPCError({ code: 'BAD_REQUEST', message: 'REPLY_PARENT_THREAD_MISMATCH' });
      }

      try {
        const promoted = await db.transaction(async (tx) => {
          const activeRows = await tx
            .select()
            .from(mailDraft)
            .where(
              and(
                eq(mailDraft.transportId, transportId),
                eq(mailDraft.threadId, input.threadId),
                eq(mailDraft.isSent, false),
                eq(mailDraft.status, 'active'),
              ),
            )
            .orderBy(desc(mailDraft.updatedAt), desc(mailDraft.id))
            .limit(1);

          const activeDraft = activeRows[0];
          if (activeDraft) return activeDraft;

          const candidateRows = await tx
            .select()
            .from(mailDraft)
            .where(
              and(
                eq(mailDraft.transportId, transportId),
                eq(mailDraft.threadId, input.threadId),
                eq(mailDraft.isSent, false),
                eq(mailDraft.status, 'candidate'),
                eq(mailDraft.origin, 'ai'),
                eq(mailDraft.replyToMessageId, replyToMessageId),
              ),
            )
            .orderBy(desc(mailDraft.updatedAt), desc(mailDraft.id))
            .limit(1);

          const candidate = candidateRows[0];
          if (!candidate) {
            throw new TRPCError({ code: 'NOT_FOUND', message: 'DRAFT_NOT_FOUND' });
          }

          await tx
            .update(mailDraft)
            .set({ status: 'discarded', updatedAt: new Date() })
            .where(
              and(
                eq(mailDraft.transportId, transportId),
                eq(mailDraft.threadId, input.threadId),
                eq(mailDraft.status, 'candidate'),
                eq(mailDraft.origin, 'ai'),
                eq(mailDraft.replyToMessageId, replyToMessageId),
                sql`${mailDraft.id} <> ${candidate.id}`,
              ),
            );

          await tx
            .update(mailDraft)
            .set({ status: 'active', updatedAt: new Date() })
            .where(and(eq(mailDraft.id, candidate.id), eq(mailDraft.transportId, transportId)));

          await tx.insert(mailDraftRevision).values({
            id: randomUUID(),
            draftId: candidate.id,
            generationId: candidate.generationId,
            actorUserId: ctx.sessionUser.id,
            kind: 'promoted',
            toAddresses: candidate.toAddresses,
            ccAddresses: candidate.ccAddresses,
            bccAddresses: candidate.bccAddresses,
            subject: candidate.subject,
            textBody: candidate.textBody,
            htmlBody: candidate.htmlBody,
            attachments: [],
          });
          return { ...candidate, status: 'active' as const, updatedAt: new Date() };
        });
        return toDraftWire(promoted);
      } catch (error) {
        if (!isPostgresUniqueViolation(error)) throw error;
        const activeRows = await db
          .select()
          .from(mailDraft)
          .where(
            and(
              eq(mailDraft.transportId, transportId),
              eq(mailDraft.threadId, input.threadId),
              eq(mailDraft.isSent, false),
              eq(mailDraft.status, 'active'),
            ),
          )
          .orderBy(desc(mailDraft.updatedAt), desc(mailDraft.id))
          .limit(1);
        if (activeRows[0]) return toDraftWire(activeRows[0]);
        throw error;
      }
    }),

  create: mailboxProcedure
    .input(createDraftInput)
    .mutation(async ({ input, ctx }) => {
      const db = getDb();
      const transportId = ctx.activeTransportId;
      if (input.threadId) {
        await requireThreadForTransport(db, input.threadId, transportId);
      }
      const draftId = input.id ?? randomUUID();
      const existing = await db
        .select({ id: mailDraft.id })
        .from(mailDraft)
        .where(
          and(eq(mailDraft.id, draftId), eq(mailDraft.transportId, transportId)),
        )
        .limit(1);
      const row = {
        threadId: input.threadId,
        replyToMessageId: input.replyToMessageId,
        status: 'active' as const,
        origin: 'manual' as const,
        toAddresses: input.to,
        ccAddresses: input.cc,
        bccAddresses: input.bcc,
        subject: input.subject || null,
        textBody: input.html || null,
        htmlBody: input.html || null,
        attachments: [] as { filename: string; mimeType: string; sizeBytes: number; s3Key: string }[],
        updatedAt: new Date(),
      };
      if (existing.length > 0) {
        await db
          .update(mailDraft)
          .set(row)
          .where(
            and(eq(mailDraft.id, draftId), eq(mailDraft.transportId, transportId)),
          );
        return { id: draftId };
      }

      try {
        await db.insert(mailDraft).values({
          id: draftId,
          transportId,
          createdByUserId: ctx.sessionUser.id,
          isSent: false,
          ...row,
        });
        await db.insert(mailDraftRevision).values({
          id: randomUUID(),
          draftId,
          actorUserId: ctx.sessionUser.id,
          kind: 'created',
          toAddresses: input.to,
          ccAddresses: input.cc,
          bccAddresses: input.bcc,
          subject: input.subject || null,
          textBody: input.html || null,
          htmlBody: input.html || null,
          attachments: [],
        });
        return { id: draftId };
      } catch (error) {
        // One active draft per thread — FE may omit draftId while latestDraft already exists.
        if (!isPostgresUniqueViolation(error) || !input.threadId) throw error;
        const activeRows = await db
          .select({ id: mailDraft.id })
          .from(mailDraft)
          .where(
            and(
              eq(mailDraft.transportId, transportId),
              eq(mailDraft.threadId, input.threadId),
              eq(mailDraft.isSent, false),
              eq(mailDraft.status, 'active'),
            ),
          )
          .orderBy(desc(mailDraft.updatedAt), desc(mailDraft.id))
          .limit(1);
        const activeId = activeRows[0]?.id;
        if (!activeId) throw error;
        await db
          .update(mailDraft)
          .set(row)
          .where(and(eq(mailDraft.id, activeId), eq(mailDraft.transportId, transportId)));
        return { id: activeId };
      }
    }),

  update: mailboxProcedure
    .input(
      z.object({
        id: z.string(),
        to: z.array(z.string()).optional(),
        cc: z.array(z.string()).optional(),
        bcc: z.array(z.string()).optional(),
        subject: z.string().optional(),
        content: z.string().optional(),
        html: z.string().optional(),
        threadId: z.string().optional(),
        replyToMessageId: z.string().nullable().optional(),
      }),
    )
    .mutation(async ({ input, ctx }) => {
      const db = getDb();
      const transportId = ctx.activeTransportId;
      // Verify ownership: draft must be on this transport.
      const existing = await db
        .select({ id: mailDraft.id })
        .from(mailDraft)
        .where(
          and(eq(mailDraft.id, input.id), eq(mailDraft.transportId, transportId)),
        )
        .limit(1);
      if (existing.length === 0) {
        throw new TRPCError({ code: 'NOT_FOUND', message: 'NOT_FOUND: draft not found' });
      }
      if (input.threadId) {
        await requireThreadForTransport(db, input.threadId, transportId);
      }
      const patch: Record<string, unknown> = { updatedAt: new Date() };
      if (input.to) patch.toAddresses = input.to;
      if (input.cc) patch.ccAddresses = input.cc;
      if (input.bcc) patch.bccAddresses = input.bcc;
      if (input.subject !== undefined) patch.subject = input.subject || null;
      if (input.content !== undefined) patch.textBody = input.content || null;
      if (input.html !== undefined) patch.htmlBody = input.html || null;
      if (input.threadId !== undefined) patch.threadId = input.threadId || null;
      if (input.replyToMessageId !== undefined) patch.replyToMessageId = input.replyToMessageId;
      await db
        .update(mailDraft)
        .set(patch)
        .where(
          and(eq(mailDraft.id, input.id), eq(mailDraft.transportId, transportId)),
        );

      const mergedRows = await db
        .select()
        .from(mailDraft)
        .where(
          and(eq(mailDraft.id, input.id), eq(mailDraft.transportId, transportId)),
        )
        .limit(1);
      const merged = mergedRows[0]!;
      const latestRevision = await db
        .select()
        .from(mailDraftRevision)
        .where(eq(mailDraftRevision.draftId, input.id))
        .orderBy(desc(mailDraftRevision.createdAt), desc(mailDraftRevision.id))
        .limit(1);

      const changed =
        latestRevision[0]?.subject !== merged.subject ||
        latestRevision[0]?.textBody !== merged.textBody ||
        latestRevision[0]?.htmlBody !== merged.htmlBody ||
        JSON.stringify(latestRevision[0]?.toAddresses ?? []) !== JSON.stringify(merged.toAddresses ?? []) ||
        JSON.stringify(latestRevision[0]?.ccAddresses ?? []) !== JSON.stringify(merged.ccAddresses ?? []) ||
        JSON.stringify(latestRevision[0]?.bccAddresses ?? []) !== JSON.stringify(merged.bccAddresses ?? []);

      if (changed) {
        await db.insert(mailDraftRevision).values({
          id: randomUUID(),
          draftId: input.id,
          generationId: merged.generationId,
          actorUserId: ctx.sessionUser.id,
          kind: 'edited',
          toAddresses: merged.toAddresses,
          ccAddresses: merged.ccAddresses,
          bccAddresses: merged.bccAddresses,
          subject: merged.subject,
          textBody: merged.textBody,
          htmlBody: merged.htmlBody,
          attachments: merged.attachments ?? [],
        });
      }
      return { id: input.id };
    }),

  delete: mailboxProcedure
    .input(z.object({ id: z.string() }))
    .mutation(async ({ input, ctx }) => {
      const db = getDb();
      const transportId = ctx.activeTransportId;
      const existing = await db
        .select({ id: mailDraft.id })
        .from(mailDraft)
        .where(
          and(eq(mailDraft.id, input.id), eq(mailDraft.transportId, transportId)),
        )
        .limit(1);
      if (existing.length === 0) {
        throw new TRPCError({ code: 'NOT_FOUND', message: 'NOT_FOUND: draft not found' });
      }
      await db
        .update(mailDraft)
        .set({ status: 'discarded', updatedAt: new Date() })
        .where(
          and(
            eq(mailDraft.id, input.id),
            eq(mailDraft.transportId, transportId),
            inArray(mailDraft.status, ['active', 'candidate']),
          ),
        );
      return { deleted: true };
    }),
});


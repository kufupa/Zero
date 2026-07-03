/**
 * Drafts router: mailbox-scoped draft CRUD.
 *
 * Drafts are scoped to the caller's active transport. A draft may optionally
 * attach to a thread (`threadId`); the thread is verified to belong to the
 * same transport before linking.
 */
import { TRPCError } from '@trpc/server';
import { z } from 'zod';
import { and, eq, desc, sql } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import { mailboxProcedure, router as tRouter } from '../trpc.js';
import { getDb } from '../../db/client.js';
import { mailDraft } from '../../db/schema/mail.js';
import {
  requireThreadForTransport,
  encodePageCursor,
  decodePageCursor,
  keysetBefore,
} from './mail-helpers.js';
import { createDraftInput } from '../wire-compat.js';

export const draftsRouter = tRouter({
  list: mailboxProcedure
    .input(
      z.object({
        q: z.string().optional(),
        cursor: z.string().optional(),
        limit: z.number().int().min(1).max(100).default(50),
      }),
    )
    .query(async ({ input, ctx }) => {
      const db = getDb();
      const transportId = ctx.activeTransportId;
      const limit = input.limit;

      const conditions = [
        eq(mailDraft.transportId, transportId),
        eq(mailDraft.isSent, false),
      ];

      if (input.q && input.q.trim()) {
        const pattern = `%${input.q.trim().toLowerCase()}%`;
        conditions.push(
          sql`(lower(${mailDraft.subject}) LIKE ${pattern} OR lower(${mailDraft.textBody}) LIKE ${pattern})`,
        );
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
        threads: rows.map((r) => ({
          id: r.id,
          historyId: null as string | null,
          subject: r.subject,
          to: r.toAddresses,
          cc: r.ccAddresses,
          bcc: r.bccAddresses,
          body: r.textBody ?? r.htmlBody,
          updatedAt: r.updatedAt,
        })),
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
      return {
        id: r.id,
        to: r.toAddresses,
        cc: r.ccAddresses,
        bcc: r.bccAddresses,
        subject: r.subject,
        content: r.textBody ?? r.htmlBody,
        rawMessage: { internalDate: String(r.updatedAt.getTime()) },
      };
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
      } else {
        await db.insert(mailDraft).values({
          id: draftId,
          transportId,
          createdByUserId: ctx.sessionUser.id,
          isSent: false,
          ...row,
        });
      }
      return { id: draftId };
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
      await db
        .update(mailDraft)
        .set(patch)
        .where(
          and(eq(mailDraft.id, input.id), eq(mailDraft.transportId, transportId)),
        );
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
        .delete(mailDraft)
        .where(
          and(eq(mailDraft.id, input.id), eq(mailDraft.transportId, transportId)),
        );
      return { deleted: true };
    }),
});


/**
 * Drafts router: mailbox-scoped draft CRUD.
 *
 * Drafts are scoped to the caller's active transport. A draft may optionally
 * attach to a thread (`threadId`); the thread is verified to belong to the
 * same transport before linking.
 */
import { TRPCError } from '@trpc/server';
import { z } from 'zod';
import { and, eq, desc, inArray } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import { mailboxProcedure, router as tRouter } from '../trpc.js';
import { getDb } from '../../db/client.js';
import { mailDraft } from '../../db/schema/mail.js';
import { requireThreadForTransport } from './mail-helpers.js';

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
      let rows = await db
        .select()
        .from(mailDraft)
        .where(eq(mailDraft.transportId, transportId))
        .orderBy(desc(mailDraft.updatedAt))
        .limit(input.limit + 1);
      if (rows.length > input.limit) {
        rows = rows.slice(0, input.limit);
      }
      if (input.q && input.q.trim()) {
        const q = input.q.trim().toLowerCase();
        rows = rows.filter(
          (r) =>
            (r.subject?.toLowerCase().includes(q) ?? false) ||
            (r.textBody?.toLowerCase().includes(q) ?? false),
        );
      }
      return {
        threads: rows.map((r) => ({
          id: r.id,
          historyId: null as string | null,
          subject: r.subject,
          to: r.toAddresses,
          cc: r.ccAddresses,
          bcc: r.bccAddresses,
          body: r.textBody,
          updatedAt: r.updatedAt,
        })),
        nextPageToken: null as string | null,
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
        throw new TRPCError({ code: 'NOT_FOUND', message: 'draft not found' });
      }
      const r = rows[0]!;
      return {
        id: r.id,
        to: r.toAddresses,
        cc: r.ccAddresses,
        bcc: r.bccAddresses,
        subject: r.subject,
        content: r.textBody,
        rawMessage: { internalDate: String(r.updatedAt.getTime()) },
      };
    }),

  create: mailboxProcedure
    .input(
      z.object({
        to: z.array(z.string()).default([]),
        cc: z.array(z.string()).default([]),
        bcc: z.array(z.string()).default([]),
        subject: z.string().default(''),
        content: z.string().default(''),
        html: z.string().default(''),
        threadId: z.string().optional(),
      }),
    )
    .mutation(async ({ input, ctx }) => {
      const db = getDb();
      const transportId = ctx.activeTransportId;
      let threadId = input.threadId;
      if (threadId) {
        await requireThreadForTransport(db, threadId, transportId);
      }
      const id = randomUUID();
      await db.insert(mailDraft).values({
        id,
        transportId,
        threadId: threadId ?? null,
        createdByUserId: ctx.sessionUser.id,
        toAddresses: input.to,
        ccAddresses: input.cc,
        bccAddresses: input.bcc,
        subject: input.subject || null,
        textBody: input.content || null,
        htmlBody: input.html || null,
        attachments: [],
        isSent: false,
      });
      return { id };
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
        throw new TRPCError({ code: 'NOT_FOUND', message: 'draft not found' });
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
        throw new TRPCError({ code: 'NOT_FOUND', message: 'draft not found' });
      }
      await db
        .delete(mailDraft)
        .where(
          and(eq(mailDraft.id, input.id), eq(mailDraft.transportId, transportId)),
        );
      return { deleted: true };
    }),
});

// Silence unused-import warnings for helpers reserved for future bulk ops.
void inArray;

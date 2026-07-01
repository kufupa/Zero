/**
 * Labels router: mailbox-scoped label CRUD.
 *
 * Labels are scoped to the caller's active transport. The frontend's
 * `useLabels` hook expects `{ id, name, type: 'system' | 'user', color? }`.
 * System labels (IMPORTANT, UNREAD, STARRED, etc.) are synthesized and merged
 * with user labels from the `mailLabel` table.
 */
import { TRPCError } from '@trpc/server';
import { z } from 'zod';
import { and, eq } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import { mailboxProcedure, router as tRouter } from '../trpc.js';
import { getDb } from '../../db/client.js';
import { mailLabel } from '../../db/schema/mail.js';

const SYSTEM_LABELS = [
  { id: 'IMPORTANT', name: 'IMPORTANT', type: 'system' as const },
  { id: 'UNREAD', name: 'UNREAD', type: 'system' as const },
  { id: 'STARRED', name: 'STARRED', type: 'system' as const },
  { id: 'FORUMS', name: 'FORUMS', type: 'system' as const },
  { id: 'PROMOTIONS', name: 'PROMOTIONS', type: 'system' as const },
  { id: 'SOCIAL', name: 'SOCIAL', type: 'system' as const },
  { id: 'UPDATES', name: 'UPDATES', type: 'system' as const },
];

export const labelsRouter = tRouter({
  list: mailboxProcedure.query(async ({ ctx }) => {
    const db = getDb();
    const transportId = ctx.activeTransportId;
    const userRows = await db
      .select({
        id: mailLabel.id,
        name: mailLabel.name,
        color: mailLabel.color,
      })
      .from(mailLabel)
      .where(eq(mailLabel.transportId, transportId));
    const userLabels = userRows.map((r) => ({
      id: r.id,
      name: r.name,
      type: 'user' as const,
      color: r.color,
    }));
    return [...SYSTEM_LABELS, ...userLabels];
  }),

  create: mailboxProcedure
    .input(
      z.object({
        name: z.string().min(1).max(80),
        color: z.string().optional(),
      }),
    )
    .mutation(async ({ input, ctx }) => {
      const db = getDb();
      const transportId = ctx.activeTransportId;
      const id = randomUUID();
      try {
        await db.insert(mailLabel).values({
          id,
          transportId,
          name: input.name,
          color: input.color ?? null,
        });
      } catch {
        // unique(mail_label_transport_name_uidx) violation
        throw new TRPCError({
          code: 'CONFLICT',
          message: 'label name already exists on this mailbox',
        });
      }
      return { id, name: input.name, type: 'user' as const, color: input.color };
    }),

  update: mailboxProcedure
    .input(
      z.object({
        id: z.string(),
        name: z.string().min(1).max(80).optional(),
        color: z.string().optional(),
      }),
    )
    .mutation(async ({ input, ctx }) => {
      const db = getDb();
      const transportId = ctx.activeTransportId;
      const existing = await db
        .select({ id: mailLabel.id })
        .from(mailLabel)
        .where(
          and(eq(mailLabel.id, input.id), eq(mailLabel.transportId, transportId)),
        )
        .limit(1);
      if (existing.length === 0) {
        throw new TRPCError({ code: 'NOT_FOUND', message: 'label not found' });
      }
      const patch: Record<string, unknown> = {};
      if (input.name !== undefined) patch.name = input.name;
      if (input.color !== undefined) patch.color = input.color;
      if (Object.keys(patch).length === 0) return { id: input.id };
      await db
        .update(mailLabel)
        .set(patch)
        .where(
          and(eq(mailLabel.id, input.id), eq(mailLabel.transportId, transportId)),
        );
      return { id: input.id };
    }),

  delete: mailboxProcedure
    .input(z.object({ id: z.string() }))
    .mutation(async ({ input, ctx }) => {
      const db = getDb();
      const transportId = ctx.activeTransportId;
      const existing = await db
        .select({ id: mailLabel.id })
        .from(mailLabel)
        .where(
          and(eq(mailLabel.id, input.id), eq(mailLabel.transportId, transportId)),
        )
        .limit(1);
      if (existing.length === 0) {
        throw new TRPCError({ code: 'NOT_FOUND', message: 'label not found' });
      }
      await db
        .delete(mailLabel)
        .where(
          and(eq(mailLabel.id, input.id), eq(mailLabel.transportId, transportId)),
        );
      return { deleted: true };
    }),
});

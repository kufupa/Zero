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
import { and, eq, sql } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import { mailboxProcedure, router as tRouter } from '../trpc.js';
import { getDb } from '../../db/client.js';
import { mailLabel, mailThread } from '../../db/schema/mail.js';

/** Case-insensitive reserved folder + system label names for create. */
const RESERVED_LABEL_NAMES = new Set(
  [
    'inbox',
    'spam',
    'archive',
    'archived',
    'bin',
    'trash',
    'junk',
    'sent',
    'draft',
    'drafts',
    'snoozed',
    'starred',
    'all',
    'IMPORTANT',
    'UNREAD',
    'STARRED',
    'FORUMS',
    'PROMOTIONS',
    'SOCIAL',
    'UPDATES',
    'SPAM',
  ].map((n) => n.toLowerCase()),
);

function assertLabelNameNotReserved(name: string): void {
  if (RESERVED_LABEL_NAMES.has(name.trim().toLowerCase())) {
    throw new TRPCError({
      code: 'BAD_REQUEST',
      message: 'label name is reserved',
    });
  }
}

function isPostgresUniqueViolation(err: unknown): boolean {
  if (err && typeof err === 'object' && 'code' in err) {
    if ((err as { code: string }).code === '23505') return true;
  }
  if (err instanceof Error && err.cause !== undefined) {
    return isPostgresUniqueViolation(err.cause);
  }
  return false;
}

function throwIfUniqueViolation(err: unknown): never {
  if (isPostgresUniqueViolation(err)) {
    throw new TRPCError({
      code: 'CONFLICT',
      message: 'label name already exists on this mailbox',
    });
  }
  throw err;
}

const SYSTEM_LABELS = [
  { id: 'IMPORTANT', name: 'IMPORTANT', type: 'system' as const, color: null },
  { id: 'UNREAD', name: 'UNREAD', type: 'system' as const, color: null },
  { id: 'STARRED', name: 'STARRED', type: 'system' as const, color: null },
  { id: 'FORUMS', name: 'FORUMS', type: 'system' as const, color: null },
  { id: 'PROMOTIONS', name: 'PROMOTIONS', type: 'system' as const, color: null },
  { id: 'SOCIAL', name: 'SOCIAL', type: 'system' as const, color: null },
  { id: 'UPDATES', name: 'UPDATES', type: 'system' as const, color: null },
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
    const userLabels = userRows
      .filter((r) => r.name.toUpperCase() !== 'SPAM')
      .map((r) => ({
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
      assertLabelNameNotReserved(input.name);
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
      } catch (err) {
        throwIfUniqueViolation(err);
      }
      return { id, name: input.name, type: 'user' as const, color: input.color ?? null };
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
      if (input.name !== undefined) assertLabelNameNotReserved(input.name);
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
        throw new TRPCError({ code: 'NOT_FOUND', message: 'NOT_FOUND: label not found' });
      }
      const patch: Record<string, unknown> = {};
      if (input.name !== undefined) patch.name = input.name;
      if (input.color !== undefined) patch.color = input.color;
      if (Object.keys(patch).length === 0) return { id: input.id };
      try {
        await db
          .update(mailLabel)
          .set(patch)
          .where(
            and(eq(mailLabel.id, input.id), eq(mailLabel.transportId, transportId)),
          );
      } catch (err) {
        throwIfUniqueViolation(err);
      }
      return { id: input.id };
    }),

  delete: mailboxProcedure
    .input(z.object({ id: z.string() }))
    .mutation(async ({ input, ctx }) => {
      const db = getDb();
      const transportId = ctx.activeTransportId;
      await db.transaction(async (tx) => {
        const existing = await tx
          .select({ id: mailLabel.id })
          .from(mailLabel)
          .where(
            and(eq(mailLabel.id, input.id), eq(mailLabel.transportId, transportId)),
          )
          .limit(1);
        if (existing.length === 0) {
          throw new TRPCError({ code: 'NOT_FOUND', message: 'NOT_FOUND: label not found' });
        }
        await tx
          .delete(mailLabel)
          .where(
            and(eq(mailLabel.id, input.id), eq(mailLabel.transportId, transportId)),
          );

        const remainingUserRows = await tx
          .select({ id: mailLabel.id })
          .from(mailLabel)
          .where(eq(mailLabel.transportId, transportId));
        const remainingUserIds = new Set(remainingUserRows.map((r) => r.id));

        const threads = await tx
          .select({
            id: mailThread.id,
            labelIds: mailThread.labelIds,
            isArchived: mailThread.isArchived,
          })
          .from(mailThread)
          .where(
            and(
              eq(mailThread.transportId, transportId),
              sql`${mailThread.labelIds} ? ${input.id}`,
            ),
          );

        for (const thread of threads) {
          const next = (thread.labelIds ?? []).filter((lid) => lid !== input.id);
          const hasUserLabel = next.some((lid) => remainingUserIds.has(lid));
          const patch: Partial<typeof mailThread.$inferInsert> = {
            labelIds: next,
            updatedAt: new Date(),
          };
          if (thread.isArchived && !hasUserLabel) {
            patch.isArchived = false;
          }
          await tx
            .update(mailThread)
            .set(patch)
            .where(and(eq(mailThread.id, thread.id), eq(mailThread.transportId, transportId)));
        }
      });

      return { deleted: true };
    }),
});

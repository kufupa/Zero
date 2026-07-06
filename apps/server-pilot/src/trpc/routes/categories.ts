import { TRPCError } from '@trpc/server';
import { and, asc, eq, inArray } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { getDb } from '../../db/client.js';
import { mailCategory, mailThread, mailThreadCategory } from '../../db/schema/mail.js';
import { mailboxProcedure, router as tRouter } from '../trpc.js';

const RESERVED_CATEGORY_SLUGS = new Set([
  'inbox',
  'sent',
  'spam',
  'draft',
  'drafts',
  'archive',
  'archived',
  'bin',
  'starred',
  'snoozed',
  'all',
]);

const slugSchema = z
  .string()
  .min(1)
  .max(80)
  .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/);

function assertCategorySlug(slug: string) {
  if (RESERVED_CATEGORY_SLUGS.has(slug)) {
    throw new TRPCError({
      code: 'BAD_REQUEST',
      message: 'CATEGORY_SLUG_RESERVED',
    });
  }
}

function isUniqueViolation(err: unknown): boolean {
  if (err && typeof err === 'object' && 'code' in err) {
    return (err as { code?: string }).code === '23505';
  }
  if (err instanceof Error && err.cause) return isUniqueViolation(err.cause);
  return false;
}

function throwConflictForUnique(err: unknown): never {
  if (isUniqueViolation(err)) {
    throw new TRPCError({
      code: 'CONFLICT',
      message: 'CATEGORY_SLUG_EXISTS',
    });
  }
  throw err;
}

export const categoriesRouter = tRouter({
  list: mailboxProcedure.query(async ({ ctx }) => {
    const db = getDb();
    const rows = await db
      .select()
      .from(mailCategory)
      .where(and(eq(mailCategory.transportId, ctx.activeTransportId), eq(mailCategory.isActive, true)))
      .orderBy(asc(mailCategory.sortOrder), asc(mailCategory.name));

    return rows.map((row) => ({
      id: row.id,
      slug: row.slug,
      name: row.name,
      color: row.color,
      sortOrder: row.sortOrder,
    }));
  }),

  create: mailboxProcedure
    .input(
      z.object({
        slug: slugSchema,
        name: z.string().min(1).max(120),
        color: z.string().nullable().optional(),
        sortOrder: z.number().int().default(0),
      }),
    )
    .mutation(async ({ input, ctx }) => {
      assertCategorySlug(input.slug);
      const db = getDb();
      const id = randomUUID();
      try {
        await db.insert(mailCategory).values({
          id,
          transportId: ctx.activeTransportId,
          slug: input.slug,
          name: input.name,
          color: input.color ?? null,
          sortOrder: input.sortOrder,
        });
      } catch (err) {
        throwConflictForUnique(err);
      }
      return { id, slug: input.slug, name: input.name, color: input.color ?? null, sortOrder: input.sortOrder };
    }),

  update: mailboxProcedure
    .input(
      z.object({
        id: z.string(),
        slug: slugSchema.optional(),
        name: z.string().min(1).max(120).optional(),
        color: z.string().nullable().optional(),
        sortOrder: z.number().int().optional(),
        isActive: z.boolean().optional(),
      }),
    )
    .mutation(async ({ input, ctx }) => {
      if (input.slug) assertCategorySlug(input.slug);
      const db = getDb();
      const patch: Partial<typeof mailCategory.$inferInsert> = { updatedAt: new Date() };
      if (input.slug !== undefined) patch.slug = input.slug;
      if (input.name !== undefined) patch.name = input.name;
      if (input.color !== undefined) patch.color = input.color;
      if (input.sortOrder !== undefined) patch.sortOrder = input.sortOrder;
      if (input.isActive !== undefined) patch.isActive = input.isActive;
      try {
        const updated = await db
          .update(mailCategory)
          .set(patch)
          .where(and(eq(mailCategory.id, input.id), eq(mailCategory.transportId, ctx.activeTransportId)))
          .returning({ id: mailCategory.id });
        if (updated.length === 0) {
          throw new TRPCError({ code: 'NOT_FOUND', message: 'CATEGORY_NOT_FOUND' });
        }
      } catch (err) {
        if (err instanceof TRPCError) throw err;
        throwConflictForUnique(err);
      }
      return { id: input.id };
    }),

  delete: mailboxProcedure
    .input(z.object({ id: z.string() }))
    .mutation(async ({ input, ctx }) => {
      const db = getDb();
      const deleted = await db
        .update(mailCategory)
        .set({ isActive: false, updatedAt: new Date() })
        .where(and(eq(mailCategory.id, input.id), eq(mailCategory.transportId, ctx.activeTransportId)))
        .returning({ id: mailCategory.id });
      if (deleted.length === 0) {
        throw new TRPCError({ code: 'NOT_FOUND', message: 'CATEGORY_NOT_FOUND' });
      }
      return { deleted: true };
    }),

  setThreadCategories: mailboxProcedure
    .input(z.object({ threadId: z.string(), categoryIds: z.array(z.string()) }))
    .mutation(async ({ input, ctx }) => {
      const db = getDb();
      const thread = await db
        .select({ id: mailThread.id })
        .from(mailThread)
        .where(and(eq(mailThread.id, input.threadId), eq(mailThread.transportId, ctx.activeTransportId)))
        .limit(1);
      if (thread.length === 0) {
        throw new TRPCError({ code: 'NOT_FOUND', message: 'THREAD_NOT_FOUND' });
      }

      const categoryIds = [...new Set(input.categoryIds)];
      if (categoryIds.length > 0) {
        const categories = await db
          .select({ id: mailCategory.id })
          .from(mailCategory)
          .where(
            and(
              eq(mailCategory.transportId, ctx.activeTransportId),
              eq(mailCategory.isActive, true),
              inArray(mailCategory.id, categoryIds),
            ),
          );
        if (categories.length !== categoryIds.length) {
          throw new TRPCError({ code: 'BAD_REQUEST', message: 'CATEGORY_NOT_IN_MAILBOX' });
        }
      }

      await db
        .delete(mailThreadCategory)
        .where(and(eq(mailThreadCategory.threadId, input.threadId), eq(mailThreadCategory.transportId, ctx.activeTransportId)));

      if (categoryIds.length > 0) {
        await db.insert(mailThreadCategory).values(
          categoryIds.map((categoryId) => ({
            threadId: input.threadId,
            categoryId,
            transportId: ctx.activeTransportId,
          })),
        );
      }

      return { threadId: input.threadId, categoryIds };
    }),
});

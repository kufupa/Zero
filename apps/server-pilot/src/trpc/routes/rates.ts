/**
 * Saved rates: a named nightly rate per transport (R7). Archive rather than delete, so an old quote that used a rate keeps
 * its snapshot. Only one active rate may carry a name. Every query is scoped to the active transport.
 */
import { TRPCError } from '@trpc/server';
import { and, asc, eq, inArray, isNull, sql } from 'drizzle-orm';
import { z } from 'zod';
import { getDb, type DB } from '../../db/client.js';
import { customRate } from '../../db/schema/work.js';
import { MAX_EXTRA_AMOUNT_MINOR, type StaffRowPriceInput } from '../../ai/staff-quote-workflow.js';
import type { RowPrice } from '../../quote-proposal/quote-lines.js';
import { mailboxProcedure, router } from '../trpc.js';

const rateName = z.string().trim().min(1).max(120);
const rateAmountMinor = z.number().int().positive().max(MAX_EXTRA_AMOUNT_MINOR);
const rateId = z.string().uuid();

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
    throw new TRPCError({ code: 'CONFLICT', message: 'A saved rate with this name already exists' });
  }
  throw err;
}

/**
 * The price each row of a quote takes, read from this transport's saved rates. A saved rate must still be active, so a
 * new approval never reuses a retired rate. The name and amount are copied onto the row, so the quote keeps them.
 */
export async function snapshotRowPrices(
  db: DB,
  transportId: string,
  input: { groups: { id: string }[]; rowPrices?: StaffRowPriceInput[] },
): Promise<RowPrice[]> {
  const rows = input.rowPrices ?? [];
  const groupIds = new Set(input.groups.map((group) => group.id));
  if (new Set(rows.map((row) => row.groupId)).size !== rows.length) {
    throw new TRPCError({ code: 'BAD_REQUEST', message: 'Each row takes one price' });
  }
  if (rows.some((row) => !groupIds.has(row.groupId))) {
    throw new TRPCError({ code: 'BAD_REQUEST', message: 'A priced row is not on this quote' });
  }
  const savedIds = rows.flatMap((row) => (row.source === 'saved' ? [row.customRateId] : []));
  const saved = savedIds.length
    ? await db
        .select()
        .from(customRate)
        .where(
          and(
            eq(customRate.transportId, transportId),
            inArray(customRate.id, savedIds),
            isNull(customRate.archivedAt),
          ),
        )
    : [];
  return rows.map((row): RowPrice => {
    if (row.source === 'one_off') return { groupId: row.groupId, source: 'one_off', amountMinor: row.oneOffRate };
    if (row.source === 'override') {
      return {
        groupId: row.groupId,
        source: 'override',
        rateCode: row.rateCode,
        amountMinor: row.overrideRate,
        note: row.note,
      };
    }
    const rate = saved.find((candidate) => candidate.id === row.customRateId);
    if (!rate) {
      throw new TRPCError({
        code: 'PRECONDITION_FAILED',
        message: 'That saved rate is archived or no longer exists. Pick another rate.',
      });
    }
    return {
      groupId: row.groupId,
      source: 'saved',
      customRateId: rate.id,
      name: rate.name,
      amountMinor: rate.amountMinor,
    };
  });
}

export const ratesRouter = router({
  list: mailboxProcedure.query(async ({ ctx }) =>
    getDb()
      .select({
        id: customRate.id,
        name: customRate.name,
        amountMinor: customRate.amountMinor,
        currency: customRate.currency,
      })
      .from(customRate)
      .where(and(eq(customRate.transportId, ctx.activeTransportId), isNull(customRate.archivedAt)))
      .orderBy(asc(customRate.name)),
  ),

  create: mailboxProcedure
    .input(z.object({ name: rateName, amountMinor: rateAmountMinor }).strict())
    .mutation(async ({ input, ctx }) => {
      try {
        const [row] = await getDb()
          .insert(customRate)
          .values({
            transportId: ctx.activeTransportId,
            name: input.name,
            amountMinor: input.amountMinor,
            // Rand only: the proposal Excel prices in rand, so no other currency can be saved.
            currency: 'ZAR',
            createdBy: ctx.sessionUser.id,
          })
          .returning({
            id: customRate.id,
            name: customRate.name,
            amountMinor: customRate.amountMinor,
            currency: customRate.currency,
          });
        return row!;
      } catch (err) {
        throwIfUniqueViolation(err);
      }
    }),

  update: mailboxProcedure
    .input(z.object({ id: rateId, name: rateName, amountMinor: rateAmountMinor }).strict())
    .mutation(async ({ input, ctx }) => {
      try {
        const [row] = await getDb()
          .update(customRate)
          .set({ name: input.name, amountMinor: input.amountMinor, updatedAt: sql`now()` })
          .where(
            and(
              eq(customRate.id, input.id),
              eq(customRate.transportId, ctx.activeTransportId),
              isNull(customRate.archivedAt),
            ),
          )
          .returning({
            id: customRate.id,
            name: customRate.name,
            amountMinor: customRate.amountMinor,
            currency: customRate.currency,
          });
        if (!row) throw new TRPCError({ code: 'NOT_FOUND', message: 'Saved rate not found' });
        return row;
      } catch (err) {
        throwIfUniqueViolation(err);
      }
    }),

  archive: mailboxProcedure
    .input(z.object({ id: rateId }).strict())
    .mutation(async ({ input, ctx }) => {
      const [row] = await getDb()
        .update(customRate)
        .set({ archivedAt: sql`now()`, updatedAt: sql`now()` })
        .where(
          and(
            eq(customRate.id, input.id),
            eq(customRate.transportId, ctx.activeTransportId),
            isNull(customRate.archivedAt),
          ),
        )
        .returning({ id: customRate.id });
      if (!row) throw new TRPCError({ code: 'NOT_FOUND', message: 'Saved rate not found' });
      return { id: row.id };
    }),
});

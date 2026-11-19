import { TRPCError } from '@trpc/server';
import { and, eq, inArray, isNull } from 'drizzle-orm';
import type { DB } from '../db/client.js';
import { customRate } from '../db/schema/work.js';
import type { StaffRowPriceInput } from './staff-quote-workflow.js';
import type { RowPrice } from '../quote-proposal/quote-lines.js';

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
            // Quotes price in rand only (U12), so a rate in any other currency is never applied.
            eq(customRate.currency, 'ZAR'),
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

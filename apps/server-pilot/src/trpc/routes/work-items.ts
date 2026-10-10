import { TRPCError } from '@trpc/server';
import { z } from 'zod';
import { getDb } from '../../db/client.js';
import { WORK_ITEM_STATUSES } from '../../db/schema/work.js';
import { retryInboundTranslation } from '../../ai/extraction/inbound-run.js';
import {
  dismissWorkItem,
  listWorkItems,
  recordFieldEvent,
  storedTranslation,
  storedWorkFor,
} from '../../ai/work-items.js';
import { mailboxProcedure, router } from '../trpc.js';

const internetMessageId = z.string().min(1).max(998);

// Field edits and accept/reject only. approve and review have their own procedures (U25, U18), so they are not here.
const fieldEventInput = z
  .object({
    workItemId: z.string().uuid(),
    type: z.enum(['field.edit', 'field.accept', 'field.reject']),
    fieldPath: z.string().min(1).max(200),
    value: z
      .union([
        z.string().max(200),
        z.number(),
        z.null(),
        z.literal(true),
        z.array(z.number().int().min(0).max(17)).max(9),
      ])
      .optional(),
    msSinceOpen: z.number().int().min(0).max(86_400_000).optional(),
  })
  .strict();

export const workItemsRouter = router({
  getByMessage: mailboxProcedure
    .input(z.object({ internetMessageId }).strict())
    .query(({ input, ctx }) =>
      storedWorkFor(getDb(), {
        transportId: ctx.activeTransportId,
        internetMessageId: input.internetMessageId,
      }),
    ),
  list: mailboxProcedure
    .input(
      z
        .object({
          statuses: z.array(z.enum(WORK_ITEM_STATUSES)).min(1).max(4).optional(),
          limit: z.number().int().min(1).max(200).optional(),
        })
        .strict(),
    )
    .query(({ input, ctx }) =>
      listWorkItems(getDb(), {
        transportId: ctx.activeTransportId,
        statuses: input.statuses ?? ['needs_you', 'review'],
        limit: input.limit ?? 50,
      }),
    ),
  recordEvent: mailboxProcedure.input(fieldEventInput).mutation(async ({ input, ctx }) => {
    const result = await recordFieldEvent(getDb(), {
      transportId: ctx.activeTransportId,
      workItemId: input.workItemId,
      userId: ctx.sessionUser.id,
      type: input.type,
      fieldPath: input.fieldPath,
      value: input.value,
      msSinceOpen: input.msSinceOpen,
    });
    if (result.status === 'not_found') {
      throw new TRPCError({ code: 'NOT_FOUND', message: 'Work item not found.' });
    }
    if (result.status === 'invalid_path') {
      throw new TRPCError({ code: 'BAD_REQUEST', message: 'Unknown field path.' });
    }
    if (result.status === 'invalid_value') {
      throw new TRPCError({ code: 'BAD_REQUEST', message: 'Value does not fit this field.' });
    }
    return { aiValue: result.aiValue, value: result.value };
  }),
  /** Translates the read again (U16 Retry). Returns the translation the pane shows, or why it could not run. */
  retryTranslation: mailboxProcedure
    .input(z.object({ workItemId: z.string().uuid() }).strict())
    .mutation(async ({ input, ctx }) => {
      const result = await retryInboundTranslation({
        transportId: ctx.activeTransportId,
        workItemId: input.workItemId,
      });
      if (result.status === 'not_found') {
        throw new TRPCError({ code: 'NOT_FOUND', message: 'Work item not found.' });
      }
      if (result.status !== 'done') return { status: result.status, translation: null };
      return { status: 'done' as const, translation: storedTranslation(result.translation) };
    }),
  dismiss: mailboxProcedure
    .input(z.object({ workItemId: z.string().uuid() }).strict())
    .mutation(async ({ input, ctx }) => {
      const result = await dismissWorkItem(getDb(), {
        transportId: ctx.activeTransportId,
        workItemId: input.workItemId,
        userId: ctx.sessionUser.id,
      });
      if (!result) throw new TRPCError({ code: 'NOT_FOUND', message: 'Work item not found.' });
      return result;
    }),
});

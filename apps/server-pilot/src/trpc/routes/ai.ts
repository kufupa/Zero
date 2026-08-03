import { TRPCError } from '@trpc/server';
import { z } from 'zod';
import { and, desc, eq } from 'drizzle-orm';
import { router as tRouter, privateProcedure, mailboxProcedure } from '../trpc.js';
import { getDb } from '../../db/client.js';
import { message } from '../../db/schema/mail.js';
import { requireThreadForTransport } from './mail-helpers.js';
import {
  enqueueHmsCandidateRefresh,
  loadHmsCandidateState,
} from './drafts.js';

export const aiRouter = tRouter({
  generateSearchQuery: privateProcedure
    .input(z.object({ prompt: z.string().optional() }).optional())
    .query(() => ({ query: '', disabled: true })),

  webSearch: privateProcedure
    .input(z.object({ query: z.string().optional() }).optional())
    .query(() => ({ results: [], disabled: true })),

  compose: privateProcedure
    .input(z.unknown().optional())
    .mutation(() => ({ text: '', disabled: true })),

  generateEmailSubject: privateProcedure
    .input(z.unknown().optional())
    .mutation(() => ({ subject: '', disabled: true })),

  /**
   * Newest successful HMS candidate + independent active Refresh run.
   * Prior candidate stays visible while Refresh is queued/running/failed.
   */
  hmsCandidateState: mailboxProcedure
    .input(z.object({ threadId: z.string() }))
    .query(async ({ input, ctx }) => {
      const db = getDb();
      const transportId = ctx.activeTransportId;
      await requireThreadForTransport(db, input.threadId, transportId);
      return loadHmsCandidateState({
        db,
        transportId,
        threadId: input.threadId,
      });
    }),

  /**
   * Full-agent Refresh. Idempotent on threadStateVersion + toolsetVersion.
   * Does not discard the prior candidate.
   */
  refreshHmsCandidate: mailboxProcedure
    .input(z.object({ threadId: z.string() }))
    .mutation(async ({ input, ctx }) => {
      // Shadow: fixed block before any DB write (enqueue helper also gates).
      const { parseEnv } = await import('../../env.js');
      const { HMS_MANUAL_OPS_REQUIRED } = await import('../../ai/hms-shadow.js');
      if (
        parseEnv(process.env as Record<string, string | undefined>)
          .HMS_DRAFT_ENRICHMENT_MODE === 'shadow'
      ) {
        throw new TRPCError({
          code: 'FORBIDDEN',
          message: HMS_MANUAL_OPS_REQUIRED,
        });
      }

      const db = getDb();
      const transportId = ctx.activeTransportId;
      await requireThreadForTransport(db, input.threadId, transportId);

      const [latestInbound] = await db
        .select({ id: message.id })
        .from(message)
        .where(
          and(
            eq(message.transportId, transportId),
            eq(message.threadId, input.threadId),
            eq(message.direction, 'inbound'),
          ),
        )
        .orderBy(desc(message.receivedAt), desc(message.id))
        .limit(1);
      if (!latestInbound) {
        throw new TRPCError({ code: 'NOT_FOUND', message: 'INBOUND_MESSAGE_NOT_FOUND' });
      }

      const result = await enqueueHmsCandidateRefresh({
        db,
        transportId,
        threadId: input.threadId,
        triggerMessageId: latestInbound.id,
        requestedByUserId: ctx.sessionUser.id,
      });

      return {
        runId: result.runId,
        runState: result.runState,
        triggerMessageId: latestInbound.id,
        threadStateVersion: result.threadStateVersion,
        idempotencyKey: result.idempotencyKey,
      };
    }),
});

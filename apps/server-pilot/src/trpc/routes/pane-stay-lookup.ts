import {
  cancelHmsBatch,
  enqueueHmsBatch,
  HmsBatchInputError,
  HmsPartyQueueLimitError,
  hmsJobQueueEnabled,
  confirmationPrefetchIdempotencyKey,
  guestSearchPrefetchIdempotencyKey,
  queueUserPartyHmsJob,
  queueUserHmsJob,
  readHmsBatchView,
  readHmsJobView,
  registerJobScreenshotRun,
} from '../../ai/hms-jobs.js';
import {
  PANE_RUN_ID_PATTERN,
  PANE_SCREENSHOT_NAME_PATTERN,
  paneStayPropertyLock,
  readPaneStayScreenshot,
  registerPaneRun,
} from '../../ai/pane-stay-save.js';
import {
  findStay,
  GUEST_SURNAME_PATTERN,
  paneStayLookupLoaders,
  searchGuest,
} from '../../ai/pane-stay-lookup.js';
import {
  classifyFind,
  classifySearch,
  recordToolOutcome,
  toolInputDigest,
} from '../../ai/hitl-tool-run.js';
import { availabilityRequestSchema } from '../../ai/hms-availability.js';
import {
  assertHmsReadOriginAllowed,
  hmsReadTargetJobMetrics,
} from '../../hms/hms-read-target.js';
import {
  guardCenturionHmsMailboxOrigin,
  loadWorkItemMailboxHmsOriginAnchors,
} from '../../hms/mailbox-hms-origin-bind.js';
import { mailboxProcedure, router } from '../trpc.js';
import { TRPCError } from '@trpc/server';
import { z } from 'zod';

const confirmation = z.string().regex(/^\d+-\d+$/);
const arrival = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const threadIdInput = z.string().min(1);
const messageIdInput = z.string().min(1);

function originGuardInput(input: { threadId: string; messageId?: string }, transportId: string) {
  return {
    transportId,
    threadId: input.threadId,
    ...(input.messageId ? { messageId: input.messageId } : {}),
  };
}

// Read-only find. strict(): no propertyCode or other key reaches the module. The lock is always the session hotel.
// threadId is optional: pane/thread callers send it so Da Vinci origin is refused before HMS.
// messageId is the pane-selected mail; origin is checked on that row and on every inbound.
const findStayInput = z
  .object({
    confirmation,
    arrival: arrival.optional(),
    threadId: threadIdInput.optional(),
    messageId: messageIdInput.optional(),
  })
  .strict();

// Surname search over one arrival day, optionally narrowed to one departure. Same strict() and session-hotel lock.
const searchGuestInput = z
  .object({
    lastName: z.string().min(2).max(40).regex(GUEST_SURNAME_PATTERN),
    arrival,
    departure: arrival.optional(),
    threadId: threadIdInput.optional(),
    messageId: messageIdInput.optional(),
  })
  .strict();

// Queued variants: the same lookups as read_tool jobs on the hms lane. The thread anchors the job to mail.
const queueFindInput = z
  .object({
    threadId: threadIdInput,
    messageId: messageIdInput.optional(),
    confirmation,
    arrival: arrival.optional(),
    autoStart: z.literal(true).optional(),
  })
  .strict();
const queueSearchGuestInput = z
  .object({
    threadId: threadIdInput,
    messageId: messageIdInput.optional(),
    lastName: searchGuestInput.shape.lastName,
    arrival,
    departure: arrival.optional(),
    autoStart: z.literal(true).optional(),
  })
  .strict()
  .refine((input) => !input.autoStart || !input.departure, {
    message: 'Auto-started guest searches must not include departure',
  });
const queuePartyInput = z
  .object({
    threadId: threadIdInput,
    messageId: messageIdInput.optional(),
    name: z.string().min(1).max(256),
    partyKind: z.enum(['company', 'agency']).optional(),
    retry: z.literal(true).optional(),
  })
  .strict();
const hmsBatchIdInput = z.object({ batchId: z.string().uuid() }).strict();
const hmsBatchQueueInput = z
  .object({
    batchId: z.string().uuid(),
    workItemIds: z.array(z.string().uuid()).min(1),
  })
  .strict()
  .refine((input) => new Set(input.workItemIds).size === input.workItemIds.length, {
    message: 'workItemIds must be unique',
    path: ['workItemIds'],
  });
// Poll by run id, or resume the latest job of one kind on a thread after a remount.
const jobStatusInput = z.union([
  z.object({ runId: z.string().uuid() }).strict(),
  z
    .object({
      threadId: threadIdInput,
      kind: z.enum(['find', 'search_guest', 'party', 'availability']),
      confirmation: confirmation.optional(),
      // A guest search is picked by its surname too: one thread can carry vouchers for different guests.
      lastName: searchGuestInput.shape.lastName.optional(),
      name: z.string().min(1).max(256).optional(),
      partyKind: z.enum(['company', 'agency']).optional(),
      // An availability snapshot is picked by its stay's dates, and by its rooms when two stays share the dates.
      arrival: arrival.optional(),
      departure: arrival.nullable().optional(),
      rooms: availabilityRequestSchema.shape.rooms.optional(),
    })
    .strict(),
]);

// Screenshot of a lookup run: only a run id this server issued to this owner, and a PNG name from the run.
const paneStayLookupScreenshotInput = z
  .object({
    runId: z.string().regex(PANE_RUN_ID_PATTERN),
    name: z.string().regex(PANE_SCREENSHOT_NAME_PATTERN),
  })
  .strict();

export const paneStayLookupRouter = router({
  jobQueueEnabled: mailboxProcedure.query(() => hmsJobQueueEnabled()),
  findStay: mailboxProcedure
    .input(findStayInput)
    .use(({ input, ctx, next }) =>
      recordToolOutcome(
        () => ({
          kind: 'stay_lookup',
          transportId: ctx.activeTransportId,
          messageId: null,
          userId: ctx.sessionUser.id,
          inputDigest: toolInputDigest(input),
        }),
        classifyFind,
        next,
      ),
    )
    .mutation(async ({ input, ctx }) => {
      const owner = `${ctx.sessionUser.id}:${ctx.activeTransportId}`;
      const target = input.threadId
        ? await assertHmsReadOriginAllowed(
            originGuardInput(
              { threadId: input.threadId, messageId: input.messageId },
              ctx.activeTransportId,
            ),
          )
        : undefined;
      return findStay(
        input.arrival
          ? { confirmation: input.confirmation, arrival: input.arrival }
          : { confirmation: input.confirmation },
        {
          lock: () => paneStayLookupLoaders.lock ?? paneStayPropertyLock(target?.propertyCode),
          onRun: ({ runId, dir }) => registerPaneRun({ runId, dir, owner, now: Date.now() }),
          ...(target ? { target } : {}),
        },
      );
    }),
  searchGuest: mailboxProcedure
    .input(searchGuestInput)
    .use(({ input, ctx, next }) =>
      recordToolOutcome(
        () => ({
          kind: 'guest_search',
          transportId: ctx.activeTransportId,
          messageId: null,
          userId: ctx.sessionUser.id,
          inputDigest: toolInputDigest(input),
        }),
        classifySearch,
        next,
      ),
    )
    .mutation(async ({ input, ctx }) => {
      const owner = `${ctx.sessionUser.id}:${ctx.activeTransportId}`;
      const target = input.threadId
        ? await assertHmsReadOriginAllowed(
            originGuardInput(
              { threadId: input.threadId, messageId: input.messageId },
              ctx.activeTransportId,
            ),
          )
        : undefined;
      return searchGuest(
        input.departure
          ? { lastName: input.lastName, arrival: input.arrival, departure: input.departure }
          : { lastName: input.lastName, arrival: input.arrival },
        {
          lock: () => paneStayLookupLoaders.lock ?? paneStayPropertyLock(target?.propertyCode),
          onRun: ({ runId, dir }) => registerPaneRun({ runId, dir, owner, now: Date.now() }),
          ...(target ? { target } : {}),
        },
      );
    }),
  // HMS_JOB_QUEUE off (the default): nothing is queued. runId null tells the pane to run findStay or searchGuest above.
  queueFind: mailboxProcedure.input(queueFindInput).mutation(async ({ input, ctx }) => {
    const target = await assertHmsReadOriginAllowed(originGuardInput(input, ctx.activeTransportId));
    if (!hmsJobQueueEnabled()) return { runId: null };
    const run = await queueUserHmsJob({
      transportId: ctx.activeTransportId,
      userId: ctx.sessionUser.id,
      threadId: input.threadId,
      request: { kind: 'find', confirmation: input.confirmation, arrival: input.arrival },
      target,
      ...(input.autoStart
        ? { idempotencyKey: confirmationPrefetchIdempotencyKey(ctx.activeTransportId, input.confirmation) }
        : {}),
    });
    if (!run) throw new TRPCError({ code: 'NOT_FOUND', message: 'thread has no inbound mail' });
    return { runId: run.id };
  }),
  queueSearchGuest: mailboxProcedure
    .input(queueSearchGuestInput)
    .mutation(async ({ input, ctx }) => {
      const target = await assertHmsReadOriginAllowed(originGuardInput(input, ctx.activeTransportId));
      if (!hmsJobQueueEnabled()) return { runId: null };
      const run = await queueUserHmsJob({
        transportId: ctx.activeTransportId,
        userId: ctx.sessionUser.id,
        threadId: input.threadId,
        request: {
          kind: 'search_guest',
          lastName: input.lastName,
          arrival: input.arrival,
          departure: input.departure,
        },
        target,
        ...(input.autoStart
          ? {
              idempotencyKey: guestSearchPrefetchIdempotencyKey(
                ctx.activeTransportId,
                input.threadId,
                input.lastName,
                input.arrival,
              ),
            }
          : {}),
      });
      if (!run) throw new TRPCError({ code: 'NOT_FOUND', message: 'thread has no inbound mail' });
      return { runId: run.id };
    }),
  queueParty: mailboxProcedure.input(queuePartyInput).mutation(async ({ input, ctx }) => {
    const target = await assertHmsReadOriginAllowed(originGuardInput(input, ctx.activeTransportId));
    if (!hmsJobQueueEnabled()) return { runId: null };
    const davinciMetrics = hmsReadTargetJobMetrics(target);
    try {
      const run = await queueUserPartyHmsJob({
        transportId: ctx.activeTransportId,
        userId: ctx.sessionUser.id,
        threadId: input.threadId,
        request: {
          kind: 'party',
          name: input.name,
          ...(input.partyKind ? { partyKind: input.partyKind } : {}),
        },
        propertyCode: target.propertyCode,
        ...(davinciMetrics ? { extraMetrics: davinciMetrics } : {}),
        ...(input.retry ? { retry: true } : {}),
      });
      if (!run) throw new TRPCError({ code: 'NOT_FOUND', message: 'thread has no inbound mail' });
      return { runId: run.id };
    } catch (error) {
      if (error instanceof HmsPartyQueueLimitError) {
        throw new TRPCError({ code: 'TOO_MANY_REQUESTS', message: error.message });
      }
      throw error;
    }
  }),
  // Work-item IDs are validated as one batch; disabled queue remains a no-op like queueFind.
  queueBatch: mailboxProcedure.input(hmsBatchQueueInput).mutation(async ({ input, ctx }) => {
    if (!hmsJobQueueEnabled()) return null;
    try {
      const anchors = await loadWorkItemMailboxHmsOriginAnchors({
        transportId: ctx.activeTransportId,
        workItemIds: input.workItemIds,
      });
      const byId = new Map(anchors.map((anchor) => [anchor.workItemId, anchor]));
      const originRefusedWorkItemIds: string[] = [];
      for (const workItemId of input.workItemIds) {
        const anchor = byId.get(workItemId);
        if (!anchor) {
          throw new HmsBatchInputError('one or more work items are unavailable', 'NOT_FOUND');
        }
        const guard = await guardCenturionHmsMailboxOrigin({
          transportId: ctx.activeTransportId,
          threadId: anchor.threadId,
          ...(anchor.messageId ? { messageId: anchor.messageId } : {}),
        });
        if (!guard.ok) originRefusedWorkItemIds.push(workItemId);
      }
      return await enqueueHmsBatch({
        batchId: input.batchId,
        transportId: ctx.activeTransportId,
        userId: ctx.sessionUser.id,
        workItemIds: input.workItemIds,
        originRefusedWorkItemIds,
      });
    } catch (error) {
      if (error instanceof HmsBatchInputError) {
        throw new TRPCError({ code: error.trpcCode, message: error.message });
      }
      throw error;
    }
  }),
  batchStatus: mailboxProcedure
    .input(hmsBatchIdInput)
    .query(({ input, ctx }) =>
      hmsJobQueueEnabled()
        ? readHmsBatchView({ batchId: input.batchId, transportId: ctx.activeTransportId })
        : null,
    ),
  cancelBatch: mailboxProcedure
    .input(hmsBatchIdInput)
    .mutation(({ input, ctx }) =>
      hmsJobQueueEnabled()
        ? cancelHmsBatch({ batchId: input.batchId, transportId: ctx.activeTransportId })
        : null,
    ),
  jobStatus: mailboxProcedure.input(jobStatusInput).query(({ input, ctx }) => {
    if (!hmsJobQueueEnabled()) return null;
    const jobInput =
      'runId' in input
        ? {
            transportId: ctx.activeTransportId,
            runId: input.runId,
            staffQuoteOwnerId: ctx.sessionUser.id,
          }
        : { transportId: ctx.activeTransportId, ...input };
    return readHmsJobView(jobInput);
  }),
  // Same reader as paneStayCancel.paneStayScreenshot. A lookup the hms worker ran is not in this process's registry,
  // so on a miss its job record registers the directory, and the read is tried once more.
  screenshot: mailboxProcedure
    .input(paneStayLookupScreenshotInput)
    .query(async ({ input, ctx }) => {
      const owner = `${ctx.sessionUser.id}:${ctx.activeTransportId}`;
      const read = () => readPaneStayScreenshot({ runId: input.runId, name: input.name, owner });
      const first = await read();
      if (first.status === 'ok') return first;
      await registerJobScreenshotRun({
        transportId: ctx.activeTransportId,
        owner,
        cliRunId: input.runId,
      }).catch(() => undefined);
      return read();
    }),
});

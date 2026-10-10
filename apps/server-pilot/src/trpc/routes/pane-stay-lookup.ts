import { TRPCError } from '@trpc/server';
import {
  findStay,
  GUEST_SURNAME_PATTERN,
  paneStayLookupLoaders,
  searchGuest,
} from '../../ai/pane-stay-lookup.js';
import {
  hmsJobQueueEnabled,
  queueUserHmsJob,
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
  classifyFind,
  classifySearch,
  recordToolOutcome,
  toolInputDigest,
} from '../../ai/hitl-tool-run.js';
import { mailboxProcedure, router } from '../trpc.js';
import { z } from 'zod';

const confirmation = z.string().regex(/^\d+-\d+$/);
const arrival = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);

// Read-only find. strict(): no propertyCode or other key reaches the module. The lock is always the session hotel.
const findStayInput = z.object({ confirmation, arrival: arrival.optional() }).strict();

// Surname search over one arrival day, optionally narrowed to one departure. Same strict() and session-hotel lock.
const searchGuestInput = z
  .object({
    lastName: z.string().min(2).max(40).regex(GUEST_SURNAME_PATTERN),
    arrival,
    departure: arrival.optional(),
  })
  .strict();

// Queued variants: the same lookups as read_tool jobs on the hms lane. The thread anchors the job to mail.
const threadIdInput = z.string().min(1);
const queueFindInput = z
  .object({ threadId: threadIdInput, confirmation, arrival: arrival.optional() })
  .strict();
const queueSearchGuestInput = z
  .object({
    threadId: threadIdInput,
    lastName: searchGuestInput.shape.lastName,
    arrival,
    departure: arrival.optional(),
  })
  .strict();
// Poll by run id, or resume the latest job of one kind on a thread after a remount.
const jobStatusInput = z.union([
  z.object({ runId: z.string().uuid() }).strict(),
  z
    .object({
      threadId: threadIdInput,
      kind: z.enum(['find', 'search_guest']),
      confirmation: confirmation.optional(),
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
    return findStay(input, {
      lock: () => paneStayLookupLoaders.lock ?? paneStayPropertyLock(),
      onRun: ({ runId, dir }) => registerPaneRun({ runId, dir, owner, now: Date.now() }),
    });
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
    return searchGuest(input, {
      lock: () => paneStayLookupLoaders.lock ?? paneStayPropertyLock(),
      onRun: ({ runId, dir }) => registerPaneRun({ runId, dir, owner, now: Date.now() }),
    });
  }),
  // HMS_JOB_QUEUE off (the default): nothing is queued. runId null tells the pane to run findStay or searchGuest above.
  queueFind: mailboxProcedure.input(queueFindInput).mutation(async ({ input, ctx }) => {
    if (!hmsJobQueueEnabled()) return { runId: null };
    const run = await queueUserHmsJob({
      transportId: ctx.activeTransportId,
      userId: ctx.sessionUser.id,
      threadId: input.threadId,
      request: { kind: 'find', confirmation: input.confirmation, arrival: input.arrival },
    });
    if (!run) throw new TRPCError({ code: 'NOT_FOUND', message: 'thread has no inbound mail' });
    return { runId: run.id };
  }),
  queueSearchGuest: mailboxProcedure
    .input(queueSearchGuestInput)
    .mutation(async ({ input, ctx }) => {
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
      });
      if (!run) throw new TRPCError({ code: 'NOT_FOUND', message: 'thread has no inbound mail' });
      return { runId: run.id };
    }),
  jobStatus: mailboxProcedure.input(jobStatusInput).query(({ input, ctx }) =>
    hmsJobQueueEnabled() ? readHmsJobView({ transportId: ctx.activeTransportId, ...input }) : null,
  ),
  // Same reader as paneStayCancel.paneStayScreenshot. A lookup the hms worker ran is not in this process's registry,
  // so on a miss its job record registers the directory, and the read is tried once more.
  screenshot: mailboxProcedure.input(paneStayLookupScreenshotInput).query(async ({ input, ctx }) => {
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

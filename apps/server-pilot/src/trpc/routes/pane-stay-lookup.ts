import {
  findStay,
  GUEST_SURNAME_PATTERN,
  paneStayLookupLoaders,
  searchGuest,
} from '../../ai/pane-stay-lookup.js';
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
  // Same reader as paneStayCancel.paneStayScreenshot: the run is registered above, under the same owner.
  screenshot: mailboxProcedure.input(paneStayLookupScreenshotInput).query(async ({ input, ctx }) =>
    readPaneStayScreenshot({
      runId: input.runId,
      name: input.name,
      owner: `${ctx.sessionUser.id}:${ctx.activeTransportId}`,
    }),
  ),
});

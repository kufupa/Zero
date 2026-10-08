import { commitCancel, previewCancel } from '../../ai/pane-stay-cancel.js';
import {
  PANE_RUN_ID_PATTERN,
  PANE_SCREENSHOT_NAME_PATTERN,
  readPaneStayScreenshot,
} from '../../ai/pane-stay-save.js';
import { mailboxProcedure, router } from '../trpc.js';
import { z } from 'zod';

const confirmation = z.string().regex(/^\d+-\d+$/);
const arrival = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);

// strict(): no propertyCode or other key reaches the module. The lock is always the session hotel.
const previewCancelInput = z.object({ confirmation, arrival }).strict();

const commitCancelInput = z
  .object({
    confirmation,
    arrival,
    reason: z
      .string()
      .trim()
      .min(1)
      .max(120)
      .refine((value) => !value.startsWith('-'), 'reason must not start with -'),
  })
  .strict();

// Screenshot of a save run: only a run id this server issued to this owner, and a PNG name from the run.
const paneStayScreenshotInput = z
  .object({
    runId: z.string().regex(PANE_RUN_ID_PATTERN),
    name: z.string().regex(PANE_SCREENSHOT_NAME_PATTERN),
  })
  .strict();

export const paneStayCancelRouter = router({
  previewCancel: mailboxProcedure
    .input(previewCancelInput)
    .mutation(async ({ input }) => previewCancel(input)),
  commitCancel: mailboxProcedure
    .input(commitCancelInput)
    .mutation(async ({ input }) => commitCancel(input)),
  paneStayScreenshot: mailboxProcedure
    .input(paneStayScreenshotInput)
    .query(async ({ input, ctx }) =>
      readPaneStayScreenshot({
        runId: input.runId,
        name: input.name,
        owner: `${ctx.sessionUser.id}:${ctx.activeTransportId}`,
      }),
    ),
});

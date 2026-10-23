import { commitCancel, paneCancelDigest, previewCancel } from '../../ai/pane-stay-cancel.js';
import {
  classifyCancelCommit,
  classifyCancelPreview,
  recordedToolRun,
} from '../../ai/hitl-tool-run.js';
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

// previewDigest is the digest the preview returned for this same stay. Required, as on the save path.
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
    previewDigest: z.string().regex(/^[0-9a-f]{64}$/),
  })
  .strict();

// Screenshot of a run: only a run id this server issued to this owner, and a PNG name from the run.
const paneStayScreenshotInput = z
  .object({
    runId: z.string().regex(PANE_RUN_ID_PATTERN),
    name: z.string().regex(PANE_SCREENSHOT_NAME_PATTERN),
  })
  .strict();

// Owner of every run and grant. The same string the save path and the screenshot reader use.
function paneOwner(ctx: { sessionUser: { id: string }; activeTransportId: string }): string {
  return `${ctx.sessionUser.id}:${ctx.activeTransportId}`;
}

export const paneStayCancelRouter = router({
  previewCancel: mailboxProcedure
    .input(previewCancelInput)
    .mutation(({ input, ctx }) =>
      recordedToolRun(
        { kind: 'cancel_preview', transportId: ctx.activeTransportId, messageId: null, userId: ctx.sessionUser.id, inputDigest: paneCancelDigest(input) },
        () => previewCancel({ ...input, owner: paneOwner(ctx), transportId: ctx.activeTransportId }),
        (value) => classifyCancelPreview(value, paneCancelDigest(input)),
      ),
    ),
  commitCancel: mailboxProcedure
    .input(commitCancelInput)
    .mutation(({ input, ctx }) =>
      recordedToolRun(
        { kind: 'cancel_commit', transportId: ctx.activeTransportId, messageId: null, userId: ctx.sessionUser.id, inputDigest: paneCancelDigest(input) },
        () => commitCancel({ ...input, owner: paneOwner(ctx), transportId: ctx.activeTransportId }),
        (value) => classifyCancelCommit(value, input.confirmation, paneCancelDigest(input)),
      ),
    ),
  paneStayScreenshot: mailboxProcedure
    .input(paneStayScreenshotInput)
    .query(async ({ input, ctx }) =>
      readPaneStayScreenshot({
        runId: input.runId,
        name: input.name,
        owner: paneOwner(ctx),
      }),
    ),
});

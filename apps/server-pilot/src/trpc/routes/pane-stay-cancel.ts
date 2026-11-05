import { commitCancel, paneCancelDigest, previewCancel } from '../../ai/pane-stay-cancel.js';
import { approveCloudCancelCharge, cancelRequestBindingFields, completeCancelRequestBinding,
  pendingCloudCancelCharge } from '../../ai/pane-cloud-cancel.js';
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
const source = z.object({ threadId: z.string().trim().min(1).max(200), messageId: z.string().trim().min(1).max(200),
  sourceHash: z.string().regex(/^[a-f0-9]{64}$/) }).strict();

// strict(): no propertyCode or other key reaches the module. The lock is always the session hotel.
const previewCancelInput = z.object({ confirmation, arrival, workItemId: z.string().uuid().optional(),
  source: source.optional(), ...cancelRequestBindingFields }).strict().refine(completeCancelRequestBinding);
const chargeInput = z.object({ workItemId: z.string().uuid(), runId: z.string().uuid(), source, confirmation, arrival,
  internetMessageId: z.string().min(1).max(998).optional() }).strict();
const acceptChargeInput = chargeInput.extend({ challengeId: z.string().uuid(),
  dialogDigest: z.string().regex(/^[0-9a-f]{64}$/) }).strict();

// previewDigest is the digest the preview returned for this same stay. Required, as on the save path.
const commitCancelInput = z
  .object({
    confirmation,
    arrival,
    workItemId: z.string().uuid().optional(),
    source: source.optional(),
    ...cancelRequestBindingFields,
    reason: z
      .string()
      .trim()
      .min(1)
      .max(120)
      .refine((value) => !value.startsWith('-'), 'reason must not start with -'),
    previewDigest: z.string().regex(/^[0-9a-f]{64}$/),
    cancellationNote: z.string().max(200).optional(),
  })
  .strict().refine(completeCancelRequestBinding);

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
  pendingCharge: mailboxProcedure.input(chargeInput).query(({ input, ctx }) =>
    pendingCloudCancelCharge({ ...input, selectedInternetMessageId: input.internetMessageId,
      transportId: ctx.activeTransportId, actorUserId: ctx.sessionUser.id,
      sessionId: ctx.sessionUser.sessionId, sessionProfile: ctx.sessionUser.sessionProfile })),
  acceptCharge: mailboxProcedure.input(acceptChargeInput).mutation(({ input, ctx }) =>
    approveCloudCancelCharge({ ...input, selectedInternetMessageId: input.internetMessageId,
      transportId: ctx.activeTransportId, actorUserId: ctx.sessionUser.id,
      sessionId: ctx.sessionUser.sessionId, sessionProfile: ctx.sessionUser.sessionProfile })),
  previewCancel: mailboxProcedure
    .input(previewCancelInput)
    .mutation(({ input, ctx }) =>
      recordedToolRun(
        { kind: 'cancel_preview', transportId: ctx.activeTransportId, messageId: null, userId: ctx.sessionUser.id, inputDigest: paneCancelDigest(input) },
        () => previewCancel({ ...input, owner: paneOwner(ctx), transportId: ctx.activeTransportId,
          actorUserId: ctx.sessionUser.id, sessionId: ctx.sessionUser.sessionId, sessionProfile: ctx.sessionUser.sessionProfile }),
        (value) => classifyCancelPreview(value, paneCancelDigest(input)),
      ),
    ),
  commitCancel: mailboxProcedure
    .input(commitCancelInput)
    .mutation(({ input, ctx }) =>
      recordedToolRun(
        { kind: 'cancel_commit', transportId: ctx.activeTransportId, messageId: null, userId: ctx.sessionUser.id, inputDigest: paneCancelDigest(input) },
        () => commitCancel({ ...input, owner: paneOwner(ctx), transportId: ctx.activeTransportId,
          actorUserId: ctx.sessionUser.id, sessionId: ctx.sessionUser.sessionId, sessionProfile: ctx.sessionUser.sessionProfile }),
        (value) => value.outcome === 'cancel_queued'
          ? { status: 'ok', inputDigest: paneCancelDigest(input), result: { outcome: 'cancel_queued' } }
          : classifyCancelCommit(value, input.confirmation, paneCancelDigest(input)),
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

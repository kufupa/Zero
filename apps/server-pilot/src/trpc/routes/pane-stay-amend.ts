import { amendFieldsSchema, commitAmend, previewAmend } from '../../ai/pane-hms-write.js';
import { PANE_RUN_ID_PATTERN, PANE_SCREENSHOT_NAME_PATTERN, readPaneStayScreenshot } from '../../ai/pane-stay-save.js';
import { mailboxProcedure, router } from '../trpc.js';
import { z } from 'zod';

const confirmation = z.string().regex(/^\d+-\d+$/);
const arrival = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const previewAmendInput = z
  .object({ confirmation, arrival, lastName: z.string().trim().min(1).max(100), fields: amendFieldsSchema })
  .strict();
const paneOwner = (ctx: { sessionUser: { id: string }; activeTransportId: string }) =>
  `${ctx.sessionUser.id}:${ctx.activeTransportId}`;

export const paneStayAmendRouter = router({
  previewAmend: mailboxProcedure.input(previewAmendInput).mutation(({ input, ctx }) => previewAmend({ ...input, owner: paneOwner(ctx) })),
  commitAmend: mailboxProcedure
    .input(previewAmendInput.extend({ previewDigest: z.string().regex(/^[0-9a-f]{64}$/) }).strict())
    .mutation(({ input, ctx }) => commitAmend({ ...input, owner: paneOwner(ctx) })),
  paneStayScreenshot: mailboxProcedure
    .input(z.object({ runId: z.string().regex(PANE_RUN_ID_PATTERN), name: z.string().regex(PANE_SCREENSHOT_NAME_PATTERN) }).strict())
    .query(async ({ input, ctx }) => readPaneStayScreenshot({ ...input, owner: paneOwner(ctx) })),
});

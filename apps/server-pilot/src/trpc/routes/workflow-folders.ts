import { TRPCError } from '@trpc/server';
import { z } from 'zod';
import { getDb } from '../../db/client.js';
import {
  getWorkflowFolderSummary,
  getWorkflowFolderThread,
  listWorkflowFolderRows,
  WORKFLOW_FOLDER_IDS,
} from '../../mail/workflow-folders.js';
import { mailboxProcedure, router } from '../trpc.js';

const folderId = z.enum(WORKFLOW_FOLDER_IDS);
export const workflowFolderListInputSchema = z
  .object({
    folder: folderId,
    limit: z.number().int().min(1).max(200).default(100),
    // React Query sends the initial cursor as an empty string; both forms mean offset zero.
    cursor: z.string().regex(/^\d*$/).optional(),
  })
  .strict();

export function workflowFolderOffset(cursor?: string): number {
  return Number(cursor || 0);
}

export const workflowFoldersRouter = router({
  summary: mailboxProcedure.query(async ({ ctx }) => {
    return getWorkflowFolderSummary(getDb(), ctx.activeTransportId);
  }),
  list: mailboxProcedure
    .input(workflowFolderListInputSchema)
    .query(async ({ input, ctx }) => {
      const db = getDb();
      const offset = workflowFolderOffset(input.cursor);
      const page = await listWorkflowFolderRows(
        db,
        ctx.activeTransportId,
        input.folder,
        offset,
        input.limit,
      );
      return {
        rows: page.rows,
        nextCursor: page.nextOffset === null ? null : String(page.nextOffset),
      };
    }),
  thread: mailboxProcedure
    .input(z.object({ folder: folderId, threadId: z.string().min(1).max(998) }).strict())
    .query(async ({ input, ctx }) => {
      const result = await getWorkflowFolderThread(getDb(), {
        transportId: ctx.activeTransportId,
        folder: input.folder,
        threadId: input.threadId,
      });
      if (!result) throw new TRPCError({ code: 'NOT_FOUND', message: 'Workflow thread not found.' });
      return result;
    }),
});

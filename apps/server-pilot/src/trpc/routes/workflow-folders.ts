import { TRPCError } from '@trpc/server';
import { and, eq } from 'drizzle-orm';
import { z } from 'zod';
import { getDb } from '../../db/client.js';
import { mailActionLabel, message } from '../../db/schema/mail.js';
import { MAIL_ACTIONS } from '../../mail/action-labels.js';
import {
  getWorkflowFolderSummary,
  getWorkflowFolderThread,
  goldRemainingInFolder as writeGoldRemainingInFolder,
  listWorkflowFolderRows,
  WORKFLOW_FOLDER_IDS,
} from '../../mail/workflow-folders.js';
import { mailboxProcedure, router } from '../trpc.js';

const folderId = z.enum(WORKFLOW_FOLDER_IDS);
const reviewSetOptions = {
  set: z.literal('eval').optional(),
  version: z.string().min(1).max(200).optional(),
};
export const workflowFolderListInputSchema = z
  .object({
    folder: folderId,
    limit: z.number().int().min(1).max(200).default(100),
    // React Query sends the initial cursor as an empty string; both forms mean offset zero.
    cursor: z.string().regex(/^\d*$/).optional(),
    // tRPC infinite queries add the page direction; paging here is forward offsets only.
    direction: z.enum(['forward', 'backward']).optional(),
    ...reviewSetOptions,
  })
  .strict();

export function workflowFolderOffset(cursor?: string): number {
  return Number(cursor || 0);
}

export const workflowFoldersRouter = router({
  summary: mailboxProcedure
    .input(z.object(reviewSetOptions).strict().optional())
    .query(async ({ input, ctx }) => {
      const db = getDb();
      if (input?.set === 'eval') {
        return getWorkflowFolderSummary(db, ctx.activeTransportId, {
          set: 'eval',
          version: input.version,
        });
      }
      return getWorkflowFolderSummary(db, ctx.activeTransportId);
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
        { set: input.set, version: input.version },
      );
      return {
        rows: page.rows,
        nextCursor: page.nextOffset === null ? null : String(page.nextOffset),
      };
    }),
  thread: mailboxProcedure
    .input(
      z
        .object({
          folder: folderId,
          threadId: z.string().min(1).max(998),
          messageId: z.string().min(1).max(998).optional(),
          ...reviewSetOptions,
        })
        .strict(),
    )
    .query(async ({ input, ctx }) => {
      const result = await getWorkflowFolderThread(getDb(), {
        transportId: ctx.activeTransportId,
        folder: input.folder,
        threadId: input.threadId,
        set: input.set,
        version: input.version,
        messageId: input.messageId,
      });
      if (!result) throw new TRPCError({ code: 'NOT_FOUND', message: 'Workflow thread not found.' });
      return result;
    }),
  getOwnerActionLabel: mailboxProcedure
    .input(z.object({ messageId: z.string().min(1).max(998) }).strict())
    .query(async ({ input, ctx }) => {
      if (ctx.accessRole === 'member') {
        throw new TRPCError({ code: 'FORBIDDEN', message: 'Owner access required' });
      }
      const [label] = await getDb()
        .select({ action: mailActionLabel.action })
        .from(mailActionLabel)
        .where(
          and(
            eq(mailActionLabel.messageId, input.messageId),
            eq(mailActionLabel.transportId, ctx.activeTransportId),
            eq(mailActionLabel.source, 'owner'),
            eq(mailActionLabel.version, 'owner'),
          ),
        )
        .limit(1);
      return label?.action ?? null;
    }),
  setActionLabel: mailboxProcedure
    .input(
      z
        .object({
          messageId: z.string().min(1).max(998),
          action: z.enum(MAIL_ACTIONS),
        })
        .strict(),
    )
    .mutation(async ({ input, ctx }) => {
      if (ctx.accessRole === 'member') {
        throw new TRPCError({ code: 'FORBIDDEN', message: 'Owner access required' });
      }
      const db = getDb();
      const [source] = await db
        .select({ id: message.id })
        .from(message)
        .where(and(eq(message.id, input.messageId), eq(message.transportId, ctx.activeTransportId)))
        .limit(1);
      if (!source) throw new TRPCError({ code: 'NOT_FOUND', message: 'Workflow email not found.' });

      const [label] = await db
        .insert(mailActionLabel)
        .values({
          transportId: ctx.activeTransportId,
          messageId: input.messageId,
          source: 'owner',
          version: 'owner',
          action: input.action,
          needsAction: input.action !== 'no_action',
          labelledBy: ctx.sessionUser.id,
        })
        .onConflictDoUpdate({
          target: [mailActionLabel.messageId, mailActionLabel.source, mailActionLabel.version],
          set: {
            action: input.action,
            needsAction: input.action !== 'no_action',
            labelledBy: ctx.sessionUser.id,
            updatedAt: new Date(),
          },
        })
        .returning({ action: mailActionLabel.action, markedAt: mailActionLabel.updatedAt });
      return { action: label!.action, markedAt: label!.markedAt.toISOString() };
    }),
  goldRemainingInFolder: mailboxProcedure
    .input(z.object({ folder: folderId }).strict())
    .mutation(async ({ input, ctx }) => {
      if (ctx.accessRole === 'member') {
        throw new TRPCError({ code: 'FORBIDDEN', message: 'Owner access required' });
      }
      return writeGoldRemainingInFolder(getDb(), {
        transportId: ctx.activeTransportId,
        folder: input.folder,
        labelledBy: ctx.sessionUser.id,
      });
    }),
});

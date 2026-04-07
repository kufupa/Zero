import type { MailManager } from '../../lib/driver/types';
import { activeDriverProcedure, router } from '../trpc';
import { getZeroAgent } from '../../lib/server-utils';
import { createDraftData } from '../../lib/schemas';
import { shouldSkipDriverMailMutation } from '../../lib/demo-mail/demo-mail-guard';
import { z } from 'zod';

export const draftsRouter = router({
  create: activeDriverProcedure.input(createDraftData).mutation(async ({ input, ctx }) => {
    const { activeConnection } = ctx;
    if (shouldSkipDriverMailMutation()) {
      return { id: crypto.randomUUID(), success: true };
    }
    const { stub: agent } = await getZeroAgent(activeConnection.id);
    return agent.createDraft(input);
  }),
  get: activeDriverProcedure.input(z.object({ id: z.string() })).query(async ({ input, ctx }) => {
    const { activeConnection } = ctx;
    if (shouldSkipDriverMailMutation()) {
      return {
        id: input.id,
        to: [],
        subject: '',
        content: '',
        cc: [],
        bcc: [],
      };
    }
    const { stub: agent } = await getZeroAgent(activeConnection.id);
    const { id } = input;
    return agent.getDraft(id) as ReturnType<MailManager['getDraft']>;
  }),
  list: activeDriverProcedure
    .input(
      z.object({
        q: z.string().optional(),
        maxResults: z.number().optional(),
        pageToken: z.string().optional(),
      }),
    )
    .query(async ({ input, ctx }) => {
      const { activeConnection } = ctx;
      if (shouldSkipDriverMailMutation()) {
        return { threads: [], nextPageToken: null };
      }
      const { stub: agent } = await getZeroAgent(activeConnection.id);
      const { q, maxResults, pageToken } = input;
      return agent.listDrafts({ q, maxResults, pageToken }) as Awaited<
        ReturnType<MailManager['listDrafts']>
      >;
    }),
  delete: activeDriverProcedure
    .input(
      z.object({
        id: z.string().min(1, 'id is required'),
      }),
    )
    .mutation(async ({ input, ctx }) => {
      const { activeConnection } = ctx;
      if (shouldSkipDriverMailMutation()) {
        return true;
      }
      const { stub: agent } = await getZeroAgent(activeConnection.id);
      await agent.deleteDraft(input.id);
      return true;
    }),
});

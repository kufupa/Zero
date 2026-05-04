import type { FrontendApi } from './contract';
import type { MailApiMode } from '../runtime/mail-mode';
import type { ListThreadsInput, ThreadIdInput } from './types';
import { apiQueryKeys } from './query-keys';

export type ApiQueryContext = {
  mode: MailApiMode;
  /** Active mailbox connection id when in legacy mode; demo may use synthetic id */
  accountId: string | null;
};

export function mailSettingsQueryKey(ctx: ApiQueryContext) {
  return apiQueryKeys.settings.get(ctx.mode, ctx.accountId);
}

export function settingsGetQueryOptions(api: FrontendApi, ctx: ApiQueryContext) {
  return {
    queryKey: mailSettingsQueryKey(ctx),
    queryFn: () => api.settings.get(),
  };
}

export function aiGetPromptsQueryKey(ctx: ApiQueryContext) {
  return apiQueryKeys.ai.getPrompts(ctx.mode, ctx.accountId);
}

export function aiGetPromptsQueryOptions(api: FrontendApi, ctx: ApiQueryContext) {
  return {
    queryKey: aiGetPromptsQueryKey(ctx),
    queryFn: () => api.ai.getPrompts(),
  };
}

export function aiGenerateSummaryQueryKey(ctx: ApiQueryContext, threadId: string) {
  return apiQueryKeys.ai.generateSummary(ctx.mode, ctx.accountId, threadId);
}

export function aiGenerateSummaryQueryOptions(api: FrontendApi, ctx: ApiQueryContext, threadId: string) {
  return {
    queryKey: aiGenerateSummaryQueryKey(ctx, threadId),
    queryFn: () => api.ai.generateSummary({ threadId }),
  };
}

export function aiBrainStateQueryKey(ctx: ApiQueryContext) {
  return apiQueryKeys.ai.getBrainState(ctx.mode, ctx.accountId);
}

export function aiBrainStateQueryOptions(api: FrontendApi, ctx: ApiQueryContext) {
  return {
    queryKey: aiBrainStateQueryKey(ctx),
    queryFn: () => api.ai.getBrainState(),
  };
}

export function labelsListQueryKey(ctx: ApiQueryContext) {
  return apiQueryKeys.labels.list(ctx.mode, ctx.accountId);
}

export function labelsListQueryOptions(api: FrontendApi, ctx: ApiQueryContext) {
  return {
    queryKey: labelsListQueryKey(ctx),
    queryFn: () => api.labels.list(),
  };
}

/** Filters for cache key + queryFn (cursor comes from infinite `pageParam`). */
export type MailListThreadsFilterKeyInput = Omit<ListThreadsInput, 'cursor'>;

export function mailListThreadsInfiniteQueryKey(ctx: ApiQueryContext, filters: MailListThreadsFilterKeyInput) {
  return apiQueryKeys.mail.listThreads(ctx.mode, ctx.accountId, filters);
}

export function mailGetThreadQueryKey(ctx: ApiQueryContext, input: ThreadIdInput) {
  return apiQueryKeys.mail.getThread(ctx.mode, ctx.accountId, input);
}

export function mailGetThreadQueryOptions(api: FrontendApi, ctx: ApiQueryContext, input: ThreadIdInput) {
  return {
    queryKey: mailGetThreadQueryKey(ctx, input),
    queryFn: () => api.mail.getThread(input),
  };
}

export function mailListThreadsPrefixKey(ctx: ApiQueryContext) {
  return [...apiQueryKeys.root(ctx.mode, ctx.accountId), 'mail', 'listThreads'] as const;
}

export function mailGetThreadPrefixKey(ctx: ApiQueryContext) {
  return [...apiQueryKeys.root(ctx.mode, ctx.accountId), 'mail', 'getThread'] as const;
}

export function mailMessageAttachmentsQueryKey(ctx: ApiQueryContext, messageId: string) {
  return apiQueryKeys.mail.messageAttachments(ctx.mode, ctx.accountId, { messageId });
}

export function mailMessageAttachmentsQueryOptions(api: FrontendApi, ctx: ApiQueryContext, messageId: string) {
  return {
    queryKey: mailMessageAttachmentsQueryKey(ctx, messageId),
    queryFn: () => api.mail.getMessageAttachments({ messageId }),
  };
}

export function mailListThreadsQueryOptions(
  api: FrontendApi,
  ctx: ApiQueryContext,
  input: ListThreadsInput,
) {
  return {
    queryKey: apiQueryKeys.mail.listThreads(ctx.mode, ctx.accountId, input),
    queryFn: () => api.mail.listThreads(input),
  };
}

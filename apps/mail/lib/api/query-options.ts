import type { FrontendApi } from './contract';
import type { MailApiMode } from '../runtime/mail-mode';
import type { ListThreadsInput } from './types';
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

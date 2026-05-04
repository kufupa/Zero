import { useQuery } from '@tanstack/react-query';
import { useMemo } from 'react';
import { useSession } from '@/lib/auth-client';
import { isFrontendOnlyDemo } from '@/lib/demo/runtime';
import { getFrontendApi } from '@/lib/api/client';
import { resolveMailMode } from '@/lib/runtime/mail-mode';
import { mailMessageAttachmentsQueryOptions, type ApiQueryContext } from '@/lib/api/query-options';

export const useAttachments = (messageId: string) => {
  const { data: session } = useSession();
  const frontendOnlyDemo = isFrontendOnlyDemo();
  const queryCtx = useMemo<ApiQueryContext>(
    () => ({ mode: resolveMailMode(), accountId: null }),
    [],
  );

  return useQuery({
    ...mailMessageAttachmentsQueryOptions(getFrontendApi(), queryCtx, messageId),
    enabled:
      Boolean(session?.user?.id) &&
      Boolean(messageId) &&
      !frontendOnlyDemo &&
      queryCtx.mode === 'legacy',
    staleTime: 1000 * 60 * 60,
  });
};

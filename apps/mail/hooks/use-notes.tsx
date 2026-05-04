import { useMemo } from 'react';
import { useActiveConnection } from './use-connections';
import { useQuery } from '@tanstack/react-query';
import { isFrontendOnlyDemo } from '@/lib/demo/runtime';
import { listDemoNotes } from '@/lib/demo/local-store';
import { getFrontendApi } from '@/lib/api/client';
import { resolveMailMode } from '@/lib/runtime/mail-mode';
import { notesListQueryKey, type ApiQueryContext } from '@/lib/api/query-options';

import { m } from '@/paraglide/messages';
import type { Note } from '@/types';

export const useThreadNotes = (threadId: string) => {
  const { data: activeConnection } = useActiveConnection();
  const demoMode = isFrontendOnlyDemo();
  const queryCtx = useMemo<ApiQueryContext>(
    () => ({ mode: resolveMailMode(), accountId: null }),
    [],
  );

  return useQuery({
    queryKey: demoMode
      ? (['demo', 'notes', threadId] as const)
      : notesListQueryKey(queryCtx, { threadId }),
    queryFn: () =>
      demoMode
        ? Promise.resolve({
            notes: listDemoNotes().filter((note) => note.threadId === threadId),
          })
        : getFrontendApi().notes.list({ threadId }),
    enabled: demoMode
      ? !!threadId
      : !!activeConnection?.id && !!threadId && queryCtx.mode === 'legacy',
    staleTime: 1000 * 60 * 5, // 5 minutes
    refetchOnMount: false,
    refetchOnWindowFocus: false,
    refetchOnReconnect: false,
    initialData: { notes: [] as Note[] },
    meta: demoMode
      ? undefined
      : { customError: m['common.notes.errors.failedToLoadNotes']() },
  });
};

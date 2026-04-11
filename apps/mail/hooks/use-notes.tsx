import { useActiveConnection } from './use-connections';
import { useTRPC } from '@/providers/query-provider';
import { useQuery } from '@tanstack/react-query';
import { isFrontendOnlyDemo } from '@/lib/demo/runtime';
import { listDemoNotes } from '@/lib/demo/local-store';

import { m } from '@/paraglide/messages';
import type { Note } from '@/types';

export const useThreadNotes = (threadId: string) => {
  
  const trpc = useTRPC();
  const { data: activeConnection } = useActiveConnection();
  const demoMode = isFrontendOnlyDemo();

  if (demoMode) {
    return useQuery({
      queryKey: ['demo', 'notes', threadId],
      queryFn: async () => {
        const notes = listDemoNotes();
        return {
          notes: notes.filter((note) => note.threadId === threadId),
        };
      },
      enabled: !!threadId,
      staleTime: 1000 * 60 * 5, // 5 minutes
      refetchOnMount: false,
      refetchOnWindowFocus: false,
      refetchOnReconnect: false,
      initialData: { notes: [] as Note[] },
    });
  }

  const noteQuery = useQuery(
    trpc.notes.list.queryOptions(
      { threadId },
      {
        enabled: !!activeConnection?.id && !!threadId,
        staleTime: 1000 * 60 * 5, // 5 minutes
        refetchOnMount: false,
        refetchOnWindowFocus: false,
        refetchOnReconnect: false,
        initialData: { notes: [] as Note[] },
        meta: {
          customError: m['common.notes.errors.failedToLoadNotes'](),
        },
      },
    ),
  );

  return noteQuery;
};

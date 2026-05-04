import { backgroundQueueAtom, isThreadInBackgroundQueueAtom } from '@/store/backgroundQueue';
import { useInfiniteQuery, useQuery, useMutation } from '@tanstack/react-query';
import type { IGetThreadResponse } from '@/lib/domain/mail-thread';
import { useSearchValue } from '@/hooks/use-search-value';
import useSearchLabels from './use-labels-search';
import { useSession } from '@/lib/auth-client';
import { getFrontendApi } from '@/lib/api/client';
import {
  mailGetThreadQueryOptions,
  mailListThreadsInfiniteQueryKey,
  type ApiQueryContext,
} from '@/lib/api/query-options';
import { listDemoThreads, getDemoThread } from '@/lib/demo-data/adapter';
import { demoMailListDraftsQueryKey } from '@/lib/demo/demo-mail-query-keys';
import { normalizeDemoMailFolderSlug } from '@/lib/demo/folder-map';
import { isFrontendOnlyDemo, resolveMailMode } from '@/lib/runtime/mail-mode';
import { listDemoDrafts } from '@/lib/demo/local-store';
import { useAtom, useAtomValue } from 'jotai';
import { useSettings } from './use-settings';
import { useParams } from 'react-router';
import { useTheme } from 'next-themes';
import { useQueryState } from 'nuqs';
import { useMemo } from 'react';
import { computeThreadListEnabled } from '@/lib/mail/thread-list-query-enabled';

const resolveThreadId = (threadData: IGetThreadResponse | undefined) => {
  if (!threadData) return undefined;

  if (threadData.latest) {
    return threadData.latest.threadId ?? threadData.latest.id;
  }

  const firstMessage = threadData.messages?.[0];
  return firstMessage?.threadId ?? firstMessage?.id;
};

export type UseThreadsOptions = {
  commandPaletteOpen?: string | null;
};

export const useThreads = (options?: UseThreadsOptions) => {
  const { folder: routeFolder } = useParams<{ folder: string }>();
  const canonicalRouteFolder = routeFolder?.toLowerCase();
  const [searchValue] = useSearchValue();
  const [backgroundQueue] = useAtom(backgroundQueueAtom);
  const isInQueue = useAtomValue(isThreadInBackgroundQueueAtom);
  const { data: session } = useSession();
  const queryCtx = useMemo<ApiQueryContext>(
    () => ({ mode: resolveMailMode(), accountId: null }),
    [],
  );
  const { labels } = useSearchLabels();
  const demoMode = isFrontendOnlyDemo();
  const isPaletteMode = options != null && 'commandPaletteOpen' in options;
  const paletteOpen = isPaletteMode ? options?.commandPaletteOpen === 'true' : false;
  const folderForQuery = isPaletteMode ? canonicalRouteFolder ?? 'inbox' : canonicalRouteFolder;
  const baseEnabled = computeThreadListEnabled({
    demoMode,
    sessionUserId: session?.user?.id,
    routeFolder: canonicalRouteFolder,
  });
  const demoListFolder = normalizeDemoMailFolderSlug(folderForQuery);
  // Palette needs thread hints on non-mail routes (e.g. /settings): still require demo or session, never open live API unauthenticated.
  const listEnabled = isPaletteMode
    ? paletteOpen && (demoMode || Boolean(session?.user?.id))
    : baseEnabled;

  const demoDraftFolder =
    demoMode && listEnabled && canonicalRouteFolder === 'draft';

  const demoDraftsQuery = useInfiniteQuery({
    queryKey: demoMailListDraftsQueryKey(searchValue.value),
    initialPageParam: '',
    queryFn: async () => {
      const q = searchValue.value.trim().toLowerCase();
      let drafts = listDemoDrafts();
      if (q) {
        drafts = drafts.filter(
          (d) =>
            d.subject.toLowerCase().includes(q) ||
            d.to.toLowerCase().includes(q) ||
            d.body.toLowerCase().includes(q) ||
            d.cc.toLowerCase().includes(q) ||
            d.bcc.toLowerCase().includes(q),
        );
      }
      drafts.sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt));
      return {
        threads: drafts.map((d) => ({ id: d.id, historyId: null as const })),
        nextPageToken: null,
      };
    },
    getNextPageParam: () => null,
    staleTime: 60 * 1000,
    refetchOnMount: false,
    refetchIntervalInBackground: true,
    enabled: demoDraftFolder,
  });

  const demoThreadsQuery = useInfiniteQuery({
    queryKey: [
      'demo',
      'mail',
      'listThreads',
      demoListFolder,
      searchValue.value,
      labels.join(','),
    ],
    initialPageParam: '',
    queryFn: async ({ pageParam }) =>
      listDemoThreads({
        folder: demoListFolder,
        q: searchValue.value,
        labelIds: labels,
        cursor: typeof pageParam === 'string' ? pageParam : '',
      }),
    getNextPageParam: (lastPage) => lastPage?.nextPageToken ?? null,
    staleTime: 60 * 1000,
    refetchOnMount: false,
    refetchIntervalInBackground: true,
    enabled: demoMode && listEnabled && !demoDraftFolder,
  });

  const listFilters = useMemo(
    () => ({
      q: searchValue.value,
      folder: folderForQuery,
      labelIds: labels,
    }),
    [searchValue.value, folderForQuery, labels],
  );

  const threadsQuery = useInfiniteQuery({
    queryKey: mailListThreadsInfiniteQueryKey(queryCtx, listFilters),
    queryFn: ({ pageParam }) =>
      getFrontendApi().mail.listThreads({
        ...listFilters,
        cursor: typeof pageParam === 'string' ? pageParam : '',
      }),
    initialPageParam: '',
    getNextPageParam: (lastPage) => lastPage?.nextPageToken ?? null,
    enabled: !demoMode && listEnabled && queryCtx.mode === 'legacy',
    staleTime: 60 * 1000,
    refetchOnMount: false,
    refetchIntervalInBackground: true,
  });
  const activeThreadsQuery = demoMode
    ? demoDraftFolder
      ? demoDraftsQuery
      : demoThreadsQuery
    : threadsQuery;

  // Flatten threads from all pages and sort by receivedOn date (newest first)

  const threads = useMemo(() => {
    return activeThreadsQuery.data
      ? activeThreadsQuery.data.pages
          .flatMap((e) => e.threads)
          .filter(Boolean)
          .filter((e) => !isInQueue(`thread:${e.id}`))
      : [];
  }, [activeThreadsQuery.data, activeThreadsQuery.dataUpdatedAt, isInQueue, backgroundQueue]);

  const isEmpty = useMemo(() => threads.length === 0, [threads]);
  const isReachingEnd =
    isEmpty ||
    (activeThreadsQuery.data &&
      !activeThreadsQuery.data.pages[activeThreadsQuery.data.pages.length - 1]?.nextPageToken);

  const loadMore = async () => {
    if (activeThreadsQuery.isLoading || activeThreadsQuery.isFetching) return;
    await activeThreadsQuery.fetchNextPage();
  };

  return [activeThreadsQuery, threads, isReachingEnd, loadMore] as const;
};

export const useThread = (threadId: string | null) => {
  const { data: session } = useSession();
  const [_threadId] = useQueryState('threadId');
  const id = threadId ? threadId : _threadId;
  const [mode] = useQueryState('mode');
  const [isComposeOpen] = useQueryState('isComposeOpen');
  const queryCtx = useMemo<ApiQueryContext>(
    () => ({ mode: resolveMailMode(), accountId: null }),
    [],
  );
  const { data: settings } = useSettings();
  const { theme: systemTheme } = useTheme();
  const demoMode = isFrontendOnlyDemo();

  const demoThreadQuery = useQuery({
    queryKey: ['demo', 'mail', 'thread', id],
    queryFn: async () => getDemoThread(id!),
    enabled: demoMode && !!id,
    staleTime: 1000 * 60 * 60,
    placeholderData: undefined,
  });

  const threadQuery = useQuery({
    ...mailGetThreadQueryOptions(getFrontendApi(), queryCtx, { id: id! }),
    enabled: !demoMode && !!id && !!session?.user?.id && queryCtx.mode === 'legacy',
    staleTime: 1000 * 60 * 60,
    placeholderData: undefined,
  });
  const activeThreadQuery = demoMode ? demoThreadQuery : threadQuery;
  const activeThreadData = activeThreadQuery.data as IGetThreadResponse | undefined;
  const activeThreadId = useMemo(
    () => resolveThreadId(activeThreadData),
    [activeThreadData],
  );
  const isThreadDataMismatch = Boolean(id && activeThreadId && activeThreadId !== id);

  const { latestDraft, isGroupThread, finalData, latestMessage } = useMemo(() => {
    const threadData = isThreadDataMismatch ? undefined : activeThreadData;

    if (!threadData) {
      return {
        latestDraft: undefined,
        isGroupThread: false,
        finalData: undefined,
        latestMessage: undefined,
      };
    }

    const latestDraft = threadData.latest?.id
      ? threadData.messages.findLast((message: IGetThreadResponse['messages'][number]) => message.isDraft)
      : undefined;

    const isGroupThread = threadData.latest?.id
      ? (() => {
          const totalRecipients = [
            ...(threadData.latest.to || []),
            ...(threadData.latest.cc || []),
            ...(threadData.latest.bcc || []),
          ].length;
          return totalRecipients > 1;
        })()
      : false;

    const nonDraftMessages = threadData.messages.filter(
      (message: IGetThreadResponse['messages'][number]) => !message.isDraft,
    );
    const latestMessage = nonDraftMessages[nonDraftMessages.length - 1];

    const finalData: IGetThreadResponse = {
      ...threadData,
      messages: nonDraftMessages,
    };

    return { latestDraft, isGroupThread, finalData, latestMessage };
  }, [activeThreadData, isThreadDataMismatch]);

  const { mutateAsync: processEmailContent } = useMutation({
    mutationFn: (input: unknown) => getFrontendApi().mail.processEmailContent(input),
  });

  // Extract image loading condition to avoid duplication
  const shouldLoadImages = useMemo(() => {
    if (!settings?.settings || !latestMessage?.sender?.email) return false;

    return settings.settings.externalImages ||
      settings.settings.trustedSenders?.includes(latestMessage.sender.email) ||
      false;
  }, [settings?.settings, latestMessage?.sender?.email]);

  const isActiveThread = !!id && id === _threadId;
  const isComposeMode = isComposeOpen === 'true' || !!mode;

  // Prefetch query - intentionally unused, just for caching
  useQuery({
    queryKey: [
      'email-content',
      latestMessage?.id,
      shouldLoadImages,
      systemTheme,
    ],
    queryFn: async () => {
      if (!latestMessage?.decodedBody || !settings?.settings) return null;

      const userTheme =
        settings.settings.colorTheme === 'system' ? systemTheme : settings.settings.colorTheme;
      const theme = userTheme === 'dark' ? 'dark' : 'light';

      const result = await processEmailContent({
        html: latestMessage.decodedBody,
        shouldLoadImages,
        theme,
      });

      return {
        html: result.processedHtml,
        hasBlockedImages: result.hasBlockedImages,
      };
    },
    enabled:
      !demoMode &&
      !!latestMessage?.decodedBody &&
      !!settings?.settings &&
      isActiveThread &&
      !isComposeMode,
    staleTime: 30 * 60 * 1000, // 30 minutes
    gcTime: 60 * 60 * 1000, // 1 hour
    refetchOnWindowFocus: false,
    refetchOnMount: false,
  });

  return { ...activeThreadQuery, data: finalData, isGroupThread, latestDraft, isThreadDataMismatch };
};

import { backgroundQueueAtom, isThreadInBackgroundQueueAtom } from '@/store/backgroundQueue';
import { useInfiniteQuery, useQuery, useMutation } from '@tanstack/react-query';
import type { IGetThreadResponse, ThreadListItem } from '@zero/server/driver/types';
import { useSearchValue } from '@/hooks/use-search-value';
import { useTRPC } from '@/providers/query-provider';
import useSearchLabels from './use-labels-search';
import useCategoryIds from './use-category-ids';
import { useSession } from '@/lib/auth-client';
import { listDemoThreads, getDemoThread } from '@/lib/demo-data/adapter';
import { demoMailListDraftsQueryKey } from '@/lib/demo/demo-mail-query-keys';
import { normalizeDemoMailFolderSlug } from '@/lib/demo/folder-map';
import { isFrontendOnlyDemo } from '@/lib/demo/runtime';
import { listDemoDrafts } from '@/lib/demo/local-store';
import { useAtom, useAtomValue } from 'jotai';
import { useSettings } from './use-settings';
import { useParams } from 'react-router';
import { useTheme } from 'next-themes';
import { useQueryState } from 'nuqs';
import { useMemo } from 'react';
import useDebouncedValue from '@/hooks/use-debounce';
import { computeThreadListEnabled } from '@/lib/mail/thread-list-query-enabled';
import { selectLiveThreadListQuery } from '@/lib/mail/thread-list-query-policy';
import {
  openThreadQueryPollingOptions,
  resolveThreadPollingMs,
} from '@/lib/mail/thread-polling-policy';
import { mergeCategoryIds, mergeLabelIds, resolveMailRouteFilter } from '@/lib/mail/route-filter';
import { resolveMailListSearch } from '@/lib/mail/search-filters';
import { useCategorySettings } from './use-categories';
import { isImageTrustedSender } from '@/lib/mail/trust-sender';
import { useLabels } from './use-labels';

const threadPollingMs = resolveThreadPollingMs(import.meta.env.VITE_MAIL_POLL_MS);
const openThreadPolling = openThreadQueryPollingOptions(import.meta.env.VITE_MAIL_POLL_MS);

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
  const trpc = useTRPC();
  const { labels } = useSearchLabels();
  const { categoryIds: queryCategoryIds } = useCategoryIds();
  const categories = useCategorySettings();
  const { userLabels } = useLabels();
  const demoMode = isFrontendOnlyDemo();
  const debouncedSearchQ = useDebouncedValue(searchValue.value);
  const liveSearchQ = demoMode ? searchValue.value : debouncedSearchQ;
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
        threads: drafts.map((d) => ({ id: d.id, historyId: null as string | null })),
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

  const categoryBySlug = useMemo(
    () =>
      new Map(
        categories
          .filter((category): category is typeof category & { slug: string } => Boolean(category.slug))
          .map((category) => [category.slug, category.id]),
      ),
    [categories],
  );
  const labelIdSet = useMemo(() => {
    const ids = new Set<string>();
    for (const label of userLabels ?? []) {
      if (label.id) ids.add(label.id.toLowerCase());
    }
    return ids;
  }, [userLabels]);
  const routeFilter = resolveMailRouteFilter(folderForQuery, categoryBySlug, labelIdSet);

  const baseListFilters = useMemo(
    () => ({
      categoryIds: mergeCategoryIds(routeFilter.filters.categoryIds, queryCategoryIds),
      labelIds: mergeLabelIds(routeFilter.filters.labelIds, labels),
    }),
    [routeFilter.filters.categoryIds, routeFilter.filters.labelIds, queryCategoryIds, labels],
  );

  const resolvedLiveSearch = useMemo(
    () => resolveMailListSearch(liveSearchQ, baseListFilters),
    [liveSearchQ, baseListFilters],
  );

  const liveThreadListQuery = selectLiveThreadListQuery({
    folder: canonicalRouteFolder,
    demoMode,
    listEnabled,
  });
  const liveDraftFolder = liveThreadListQuery.useDraftsList;

  const liveDraftsQuery = useInfiniteQuery(
    trpc.drafts.list.infiniteQueryOptions(
      {
        q: liveSearchQ,
        limit: 50,
      },
      {
        initialCursor: '',
        getNextPageParam: (lastPage) => lastPage?.nextPageToken ?? null,
        enabled: liveDraftFolder,
        staleTime: 60 * 1000,
        refetchOnMount: false,
      },
    ),
  );

  const threadsQuery = useInfiniteQuery(
    trpc.mail.listThreads.infiniteQueryOptions(
      {
        q: resolvedLiveSearch.q,
        folder: routeFilter.folder,
        filters: resolvedLiveSearch.filters,
      },
      {
        initialCursor: '',
        getNextPageParam: (lastPage) => lastPage?.nextPageToken ?? null,
        enabled: liveThreadListQuery.useMailListThreads,
        staleTime: 60 * 1000 * 1, // 1 minute
        refetchOnMount: false,
        refetchInterval: threadPollingMs ?? false,
        refetchIntervalInBackground: false,
        refetchOnWindowFocus: true,
      },
    ),
  );
  const activeThreadsQuery = demoMode
    ? demoDraftFolder
      ? demoDraftsQuery
      : demoThreadsQuery
    : liveDraftFolder
      ? liveDraftsQuery
      : threadsQuery;

  // Flatten threads from all pages and sort by receivedOn date (newest first)

  const threads = useMemo<ThreadListItem[]>(() => {
    if (!activeThreadsQuery.data) return [];
    const pages = activeThreadsQuery.data.pages as Array<{ threads: ThreadListItem[] }>;
    return pages
      .flatMap((page) => page.threads)
      .filter((thread): thread is ThreadListItem => Boolean(thread))
      .filter((thread) => !isInQueue(`thread:${thread.id}`));
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
  const trpc = useTRPC();
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

  const threadQuery = useQuery(
    trpc.mail.get.queryOptions(
      {
        id: id!,
      },
      {
        enabled: !demoMode && !!id && !!session?.user?.id,
        staleTime: 1000 * 60 * 60,
        placeholderData: undefined,
        refetchInterval: openThreadPolling.refetchInterval,
        refetchIntervalInBackground: openThreadPolling.refetchIntervalInBackground,
        refetchOnWindowFocus: openThreadPolling.refetchOnWindowFocus,
      },
    ),
  );
  const activeThreadQuery = demoMode ? demoThreadQuery : threadQuery;
  const activeThreadData = activeThreadQuery.data as IGetThreadResponse | undefined;
  const activeThreadId = useMemo(
    () => resolveThreadId(activeThreadData),
    [activeThreadData],
  );
  const isThreadDataMismatch = Boolean(id && activeThreadId && activeThreadId !== id);

  const { latestDraft, drafts, aiDraftCandidates, isGroupThread, finalData, latestMessage } =
    useMemo(() => {
    const threadData = isThreadDataMismatch ? undefined : activeThreadData;

    if (!threadData) {
      return {
        latestDraft: undefined,
        drafts: [],
        aiDraftCandidates: [],
        isGroupThread: false,
        finalData: undefined,
        latestMessage: undefined,
      };
    }

    const drafts = threadData.drafts ?? [];
    const activeDraft = drafts.find((draft) => draft.status === 'active');
    const aiDraftCandidates = drafts.filter(
      (draft) => draft.origin === 'ai' && draft.status === 'candidate',
    );
    const latestDraft = activeDraft;

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

    return { latestDraft, drafts, aiDraftCandidates, isGroupThread, finalData, latestMessage };
  }, [activeThreadData, isThreadDataMismatch]);

  const { mutateAsync: processEmailContent } = useMutation(
    trpc.mail.processEmailContent.mutationOptions(),
  );

  // Extract image loading condition to avoid duplication
  const shouldLoadImages = useMemo(() => {
    if (!settings?.settings || !latestMessage?.sender?.email) return false;

    return isImageTrustedSender({
      senderEmail: latestMessage.sender.email,
      externalImages: settings.settings.externalImages,
      trustedSenders: settings.settings.trustedSenders,
    });
  }, [settings?.settings, latestMessage?.sender?.email]);

  const isActiveThread = !!id && id === _threadId;
  const isComposeMode = isComposeOpen === 'true' || !!mode;

  // Prefetch query - intentionally unused, just for caching
  useQuery({
    queryKey: [
      'email-content-v2',
      latestMessage?.id,
      shouldLoadImages,
      systemTheme,
    ],
    queryFn: async () => {
      if (!latestMessage?.decodedBody || !settings?.settings || !latestMessage?.id) return null;

      const userTheme =
        settings.settings.colorTheme === 'system' ? systemTheme : settings.settings.colorTheme;
      const theme = userTheme === 'dark' ? 'dark' : 'light';

      const result = await processEmailContent({
        html: latestMessage.decodedBody,
        messageId: latestMessage.id,
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

  return {
    ...activeThreadQuery,
    data: finalData,
    isGroupThread,
    latestDraft,
    drafts,
    aiDraftCandidates,
    isThreadDataMismatch,
  };
};

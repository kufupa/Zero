import { backgroundQueueAtom, isThreadInBackgroundQueueAtom } from '@/store/backgroundQueue';
import { keepPreviousData, useInfiniteQuery, useQuery } from '@tanstack/react-query';
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
import { useParams } from 'react-router';
import { useQueryState } from 'nuqs';
import { useMemo } from 'react';
import { computeThreadListEnabled } from '@/lib/mail/thread-list-query-enabled';
import { selectLiveThreadListQuery } from '@/lib/mail/thread-list-query-policy';
import {
  openThreadQueryPollingOptions,
  resolveThreadPollingMs,
} from '@/lib/mail/thread-polling-policy';
import {
  resolveOpenThreadId,
  shouldBlankOpenThreadData,
} from '@/lib/mail/thread-open-stability';
import { mergeCategoryIds, mergeLabelIds, buildReservedSpamLabelIdSet, resolveMailRouteFilter } from '@/lib/mail/route-filter';
import { resolveSearchListRequest } from '@/lib/mail/search-list';
import { buildConversationPrimaryListRows } from '@/lib/mail/conversation-list';
import { useCategorySettings } from './use-categories';
import { useLabels } from './use-labels';
import { isWorkflowFolderNavId } from '@/config/workflow-folders';

const threadPollingMs = resolveThreadPollingMs(import.meta.env.VITE_MAIL_POLL_MS);
const openThreadPolling = openThreadQueryPollingOptions(import.meta.env.VITE_MAIL_POLL_MS);
const invalidListQueryFn = async () => ({ threads: [], nextPageToken: null });

export const useThreads = () => {
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
  const baseEnabled = computeThreadListEnabled({
    demoMode,
    sessionUserId: session?.user?.id,
    routeFolder: canonicalRouteFolder,
  });
  const listEnabled = baseEnabled;

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
  const reservedSpamLabelIdSet = useMemo(
    () => buildReservedSpamLabelIdSet(userLabels ?? []),
    [userLabels],
  );
  const routeFilter = resolveMailRouteFilter(
    canonicalRouteFolder,
    categoryBySlug,
    labelIdSet,
    reservedSpamLabelIdSet,
  );

  const baseListFilters = useMemo(
    () => ({
      categoryIds: mergeCategoryIds(routeFilter.filters.categoryIds, queryCategoryIds),
      labelIds: mergeLabelIds(routeFilter.filters.labelIds, labels),
    }),
    [routeFilter.filters.categoryIds, routeFilter.filters.labelIds, queryCategoryIds, labels],
  );
  const userListFilters = useMemo(
    () => ({
      categoryIds: queryCategoryIds,
      labelIds: [...labels],
    }),
    [queryCategoryIds, labels],
  );

  const searchList = useMemo(
    () =>
      resolveSearchListRequest({
        scope: searchValue.scope ?? 'folder',
        query: searchValue.value,
        filters: searchValue.filters ?? [],
        routeResolved: routeFilter,
        baseFilters: baseListFilters,
        userFilters: userListFilters,
      }),
    [
      searchValue.scope,
      searchValue.value,
      searchValue.filters,
      routeFilter,
      baseListFilters,
      userListFilters,
    ],
  );

  const validSearchList = searchList.isValid ? searchList : undefined;
  const workflowFolder =
    isWorkflowFolderNavId(canonicalRouteFolder) && validSearchList?.folder !== 'all'
      ? canonicalRouteFolder
      : undefined;
  const demoListFolder =
    validSearchList?.folder === 'all'
      ? validSearchList.folder
      : validSearchList
        ? normalizeDemoMailFolderSlug(canonicalRouteFolder ?? validSearchList.folder)
        : undefined;
  const liveThreadListQuery = validSearchList
    ? selectLiveThreadListQuery({
        folder: validSearchList.folder,
        demoMode,
        listEnabled,
        useDraftsList: validSearchList.useDraftsList && listEnabled && !demoMode,
      })
    : { useDraftsList: false, useMailListThreads: false };
  const demoDraftFolder =
    demoMode && listEnabled && validSearchList?.useDraftsList === true;
  const demoDraftQuery = validSearchList?.useDraftsList
    ? validSearchList.q ?? ''
    : undefined;

  const demoDraftsQuery = useInfiniteQuery({
    queryKey:
      demoDraftQuery === undefined
        ? ['demo', 'mail', 'listDrafts', 'disabled']
        : demoMailListDraftsQueryKey(demoDraftQuery),
    initialPageParam: '',
    queryFn: async () => {
      if (demoDraftQuery === undefined) {
        return { threads: [], nextPageToken: null };
      }

      const q = demoDraftQuery.trim().toLowerCase();
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
    queryKey: validSearchList
      ? [
          'demo',
          'mail',
          'listThreads',
          validSearchList.folder,
          demoListFolder,
          validSearchList.q ?? '',
          validSearchList.filters.labelIds?.join(',') ?? '',
        ]
      : ['demo', 'mail', 'listThreads', 'disabled'],
    initialPageParam: '',
    queryFn: async ({ pageParam }) => {
      if (!validSearchList || !demoListFolder) {
        return { threads: [], nextPageToken: null };
      }

      return listDemoThreads({
        folder: demoListFolder,
        q: validSearchList.q ?? '',
        labelIds: validSearchList.filters.labelIds ?? [],
        cursor: typeof pageParam === 'string' ? pageParam : '',
      });
    },
    getNextPageParam: (lastPage) => lastPage?.nextPageToken ?? null,
    staleTime: 60 * 1000,
    refetchOnMount: false,
    refetchIntervalInBackground: true,
    enabled: demoMode && listEnabled && Boolean(demoListFolder) && !demoDraftFolder,
  });

  const liveDraftsQueryOptions = trpc.drafts.list.infiniteQueryOptions(
    validSearchList?.useDraftsList
      ? { q: validSearchList.q ?? '', limit: 50 }
      : { limit: 50 },
    {
      initialCursor: '',
      getNextPageParam: (lastPage) => lastPage?.nextPageToken ?? null,
      enabled: liveThreadListQuery.useDraftsList,
      staleTime: 60 * 1000,
      refetchOnMount: false,
    },
  );
  const liveDraftsQuery = useInfiniteQuery(
    validSearchList
      ? liveDraftsQueryOptions
      : { ...liveDraftsQueryOptions, queryFn: invalidListQueryFn },
  );

  const liveThreadsQueryOptions = trpc.mail.listThreads.infiniteQueryOptions(
    validSearchList
      ? {
          q: validSearchList.q,
          folder: validSearchList.folder,
          filters: validSearchList.filters,
          ...(workflowFolder ? { workflowFolder } : {}),
        }
      : {},
    {
      initialCursor: '',
      getNextPageParam: (lastPage) => lastPage?.nextPageToken ?? null,
      enabled: liveThreadListQuery.useMailListThreads,
      staleTime: 60 * 1000 * 1, // 1 minute
      refetchOnMount: false,
      refetchInterval: threadPollingMs ?? false,
      refetchIntervalInBackground: false,
      refetchOnWindowFocus: true,
      placeholderData: keepPreviousData,
    },
  );
  const threadsQuery = useInfiniteQuery(
    validSearchList
      ? liveThreadsQueryOptions
      : { ...liveThreadsQueryOptions, queryFn: invalidListQueryFn },
  );

  const activeThreadsQuery = demoMode
    ? demoDraftFolder
      ? demoDraftsQuery
      : demoThreadsQuery
    : liveThreadListQuery.useDraftsList
      ? liveDraftsQuery
      : threadsQuery;

  // Flatten threads from all pages and sort by receivedOn date (newest first)

  const threads = useMemo<ThreadListItem[]>(() => {
    if (!activeThreadsQuery.data) return [];
    const pages = activeThreadsQuery.data.pages as Array<{ threads: ThreadListItem[] }>;
    const flattened = pages
      .flatMap((page) => page.threads)
      .filter((thread): thread is ThreadListItem => Boolean(thread))
      .filter((thread) => !isInQueue(`thread:${thread.id}`));

    const primaryRows = buildConversationPrimaryListRows(flattened);
    // Safe: the builder spreads each input row and only adds linkedStubs; its return type erases ThreadListItem fields.
    return primaryRows as unknown as ThreadListItem[];
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

  return [activeThreadsQuery, threads, isReachingEnd, loadMore, searchList] as const;
};

export const useThread = (threadId: string | null) => {
  const { data: session } = useSession();
  const [_threadId] = useQueryState('threadId');
  const id = threadId ? threadId : _threadId;
  const trpc = useTRPC();
  const demoMode = isFrontendOnlyDemo();

  const demoThreadQuery = useQuery({
    queryKey: ['demo', 'mail', 'thread', id],
    queryFn: async () => getDemoThread(id!),
    enabled: demoMode && !!id,
    staleTime: 1000 * 60 * 60,
    placeholderData: (previousData) => previousData,
  });

  const threadQuery = useQuery(
    trpc.mail.get.queryOptions(
      {
        id: id!,
        mergeLinked: true,
      },
      {
        enabled: !demoMode && !!id && !!session?.user?.id,
        staleTime: 1000 * 60 * 60,
        // Keep prior open-thread payload during key transitions / refetch so
        // ReplyCompose is not unmounted mid-type (typing kick-out).
        placeholderData: (previousData) => previousData,
        refetchInterval: openThreadPolling.refetchInterval,
        refetchIntervalInBackground: openThreadPolling.refetchIntervalInBackground,
        refetchOnWindowFocus: openThreadPolling.refetchOnWindowFocus,
      },
    ),
  );
  const activeThreadQuery = demoMode ? demoThreadQuery : threadQuery;
  const activeThreadData = activeThreadQuery.data as (IGetThreadResponse & { id?: string }) | undefined;
  const activeThreadId = useMemo(
    () => resolveOpenThreadId(activeThreadData),
    [activeThreadData],
  );
  const isThreadDataMismatch = shouldBlankOpenThreadData({
    requestedThreadId: id,
    resolvedThreadId: activeThreadId,
  });

  const { latestDraft, drafts, aiDraftCandidates, isGroupThread, finalData } =
    useMemo(() => {
    const threadData = isThreadDataMismatch ? undefined : activeThreadData;

    if (!threadData) {
      return {
        latestDraft: undefined,
        drafts: [],
        aiDraftCandidates: [],
        isGroupThread: false,
        finalData: undefined,
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
    const finalData: IGetThreadResponse = {
      ...threadData,
      messages: nonDraftMessages,
    };

    return { latestDraft, drafts, aiDraftCandidates, isGroupThread, finalData };
  }, [activeThreadData, isThreadDataMismatch]);

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

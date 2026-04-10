import { backgroundQueueAtom, isThreadInBackgroundQueueAtom } from '@/store/backgroundQueue';
import { useInfiniteQuery, useQuery, useMutation } from '@tanstack/react-query';
import type { IGetThreadResponse } from '../../server/src/lib/driver/types';
import { useSearchValue } from '@/hooks/use-search-value';
import { useTRPC } from '@/providers/query-provider';
import useSearchLabels from './use-labels-search';
import { useSession } from '@/lib/auth-client';
import { listDemoThreads, getDemoThread } from '@/lib/demo-data/adapter';
import { resolveDemoThreadQueryContext } from '@/lib/demo-data/client';
import { isFrontendOnlyDemo } from '@/lib/demo/runtime';
import { useAtom, useAtomValue } from 'jotai';
import { useSettings } from './use-settings';
import { useParams } from 'react-router';
import { useTheme } from 'next-themes';
import { useQueryState } from 'nuqs';
import { useMemo } from 'react';

export const useThreads = () => {
  const { folder } = useParams<{ folder: string }>();
  const [searchValue] = useSearchValue();
  const [backgroundQueue] = useAtom(backgroundQueueAtom);
  const isInQueue = useAtomValue(isThreadInBackgroundQueueAtom);
  const trpc = useTRPC();
  const { labels } = useSearchLabels();
  const demoMode = isFrontendOnlyDemo();
  const demoContext = resolveDemoThreadQueryContext(folder);

  const demoThreadsQuery = useInfiniteQuery({
    queryKey: [
      'demo',
      'mail',
      'listThreads',
      demoContext.folder,
      demoContext.workQueue,
      searchValue.value,
      labels.join(','),
    ],
    initialPageParam: '',
    queryFn: async ({ pageParam }) =>
      listDemoThreads({
        folder: demoContext.folder,
        workQueue: demoContext.workQueue ?? undefined,
        q: searchValue.value,
        labelIds: labels,
        cursor: typeof pageParam === 'string' ? pageParam : '',
      }),
    getNextPageParam: (lastPage) => lastPage?.nextPageToken ?? null,
    staleTime: 60 * 1000,
    refetchOnMount: true,
    refetchIntervalInBackground: true,
    enabled: demoMode,
  });

  const threadsQuery = useInfiniteQuery(
    trpc.mail.listThreads.infiniteQueryOptions(
      {
        q: searchValue.value,
        folder,
        labelIds: labels,
      },
      {
        initialCursor: '',
        getNextPageParam: (lastPage) => lastPage?.nextPageToken ?? null,
        enabled: !demoMode,
        staleTime: 60 * 1000 * 1, // 1 minute
        refetchOnMount: true,
        refetchIntervalInBackground: true,
      },
    ),
  );
  const activeThreadsQuery = demoMode ? demoThreadsQuery : threadsQuery;

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
  const trpc = useTRPC();
  const { data: settings } = useSettings();
  const { theme: systemTheme } = useTheme();
  const demoMode = isFrontendOnlyDemo();

  const demoThreadQuery = useQuery({
    queryKey: ['demo', 'mail', 'thread', id],
    queryFn: async () => getDemoThread(id!),
    enabled: demoMode && !!id,
    staleTime: 1000 * 60 * 60,
  });

  const threadQuery = useQuery(
    trpc.mail.get.queryOptions(
      {
        id: id!,
      },
      {
        enabled: !demoMode && !!id && !!session?.user.id,
        staleTime: 1000 * 60 * 60, // 1 minute
      },
    ),
  );
  const activeThreadQuery = demoMode ? demoThreadQuery : threadQuery;

  const { latestDraft, isGroupThread, finalData, latestMessage } = useMemo(() => {
    const threadData = activeThreadQuery.data as IGetThreadResponse | undefined;
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
  }, [activeThreadQuery.data]);

  const { mutateAsync: processEmailContent } = useMutation(
    trpc.mail.processEmailContent.mutationOptions(),
  );

  // Extract image loading condition to avoid duplication
  const shouldLoadImages = useMemo(() => {
    if (!settings?.settings || !latestMessage?.sender?.email) return false;

    return settings.settings.externalImages ||
      settings.settings.trustedSenders?.includes(latestMessage.sender.email) ||
      false;
  }, [settings?.settings, latestMessage?.sender?.email]);

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
    enabled: !demoMode && !!latestMessage?.decodedBody && !!settings?.settings,
    staleTime: 30 * 60 * 1000, // 30 minutes
    gcTime: 60 * 60 * 1000, // 1 hour
    refetchOnWindowFocus: false,
    refetchOnMount: false,
  });

  return { ...activeThreadQuery, data: finalData, isGroupThread, latestDraft };
};

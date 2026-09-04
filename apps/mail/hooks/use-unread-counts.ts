import { useMemo, useRef } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useTRPC } from '@/providers/query-provider';
import { useActiveConnection } from '@/hooks/use-connections';
import { useStats } from '@/hooks/use-stats';
import { isFrontendOnlyDemo } from '@/lib/demo/runtime';
import { resolveThreadPollingMs } from '@/lib/mail/thread-polling-policy';
import {
  toSidebarUnreadCountSnapshot,
  type SidebarUnreadCountSnapshot,
} from '@/lib/mail/sidebar-unread-counts';

export function useUnreadCounts(): {
  data: SidebarUnreadCountSnapshot | undefined;
  isLoading: boolean;
  isError: boolean;
} {
  const trpc = useTRPC();
  const demoMode = isFrontendOnlyDemo();
  const { data: activeConnection } = useActiveConnection();
  const { data: legacyStats } = useStats();

  const isPilot = !demoMode && activeConnection?.providerId === 'mailbox';
  const scopeKey = activeConnection?.id ?? null;
  const pollingMs = resolveThreadPollingMs(import.meta.env.VITE_MAIL_POLL_MS);

  const query = useQuery(
    trpc.mail.unreadCounts.queryOptions(void 0, {
      enabled: isPilot,
      refetchInterval: pollingMs ?? false,
      refetchIntervalInBackground: false,
      refetchOnWindowFocus: true,
      refetchOnReconnect: true,
    }),
  );

  const lastSuccessfulRef = useRef<{
    scopeKey: string;
    data: SidebarUnreadCountSnapshot;
  } | null>(null);

  // Clear stale cached snapshot if transport scope changes
  if (lastSuccessfulRef.current && lastSuccessfulRef.current.scopeKey !== scopeKey) {
    lastSuccessfulRef.current = null;
  }

  const snapshot = useMemo(() => {
    if (!isPilot) {
      return toSidebarUnreadCountSnapshot(
        undefined,
        legacyStats,
        activeConnection?.providerId,
        null,
      );
    }

    if (query.data) {
      const liveSnapshot = toSidebarUnreadCountSnapshot(
        query.data,
        legacyStats,
        activeConnection?.providerId,
        scopeKey,
      );
      if (scopeKey) {
        lastSuccessfulRef.current = { scopeKey, data: liveSnapshot };
      }
      return liveSnapshot;
    }

    if (query.isError && lastSuccessfulRef.current?.scopeKey === scopeKey) {
      return lastSuccessfulRef.current.data;
    }

    return undefined;
  }, [isPilot, query.data, query.isError, legacyStats, activeConnection?.providerId, scopeKey]);

  return {
    data: snapshot,
    isLoading: isPilot ? query.isLoading : false,
    isError: isPilot ? query.isError && !snapshot : false,
  };
}

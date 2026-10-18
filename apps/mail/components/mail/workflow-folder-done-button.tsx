import { useInfiniteQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useEffect, useMemo, useState } from 'react';
import { Button } from '@/components/ui/button';
import { isWorkflowFolderNavId, type WorkflowFolderNavId } from '@/config/workflow-folders';
import { FOLDER_ACTIONS, MAIL_ACTION_LABELS } from '@/lib/workflow-action-labels';
import { useTRPC } from '@/providers/query-provider';

export function WorkflowFolderDoneButton({ folder }: { folder: string }) {
  const workflowFolder = isWorkflowFolderNavId(folder) ? (folder.toLowerCase() as WorkflowFolderNavId) : null;
  const trpc = useTRPC();
  const queryClient = useQueryClient();
  const [confirmOpen, setConfirmOpen] = useState(false);
  const listQuery = useInfiniteQuery(
    trpc.workflowFolders.list.infiniteQueryOptions(
      { folder: workflowFolder ?? 'quotes', limit: 200 },
      {
        initialCursor: '',
        getNextPageParam: (lastPage) => lastPage.nextCursor ?? undefined,
        enabled: Boolean(workflowFolder),
      },
    ),
  );
  const remaining = useMemo(
    () =>
      (listQuery.data?.pages.flatMap((page) => page.rows) ?? []).filter((row) => !row.ownerAction)
        .length,
    [listQuery.data?.pages],
  );
  useEffect(() => {
    if (listQuery.hasNextPage && !listQuery.isFetchingNextPage) {
      void listQuery.fetchNextPage();
    }
  }, [listQuery.hasNextPage, listQuery.isFetchingNextPage, listQuery.fetchNextPage]);
  const goldMutation = useMutation(
    trpc.workflowFolders.goldRemainingInFolder.mutationOptions({
      onSuccess: async () => {
        await Promise.all([
          queryClient.invalidateQueries({ queryKey: trpc.workflowFolders.summary.queryKey() }),
          queryClient.invalidateQueries({ queryKey: trpc.workflowFolders.list.infiniteQueryKey() }),
          queryClient.invalidateQueries({ queryKey: trpc.mail.listThreads.infiniteQueryKey() }),
          queryClient.invalidateQueries({ queryKey: trpc.workflowFolders.thread.queryKey() }),
          queryClient.invalidateQueries({ queryKey: trpc.workflowFolders.getOwnerActionLabel.queryKey() }),
        ]);
      },
    }),
  );

  if (!workflowFolder) return null;

  const actionLabel = MAIL_ACTION_LABELS[FOLDER_ACTIONS[workflowFolder]];
  const disabled =
    remaining === 0 ||
    goldMutation.isPending ||
    listQuery.isLoading ||
    Boolean(listQuery.hasNextPage) ||
    listQuery.isFetchingNextPage;
  const confirmLabel = `Mark ${remaining} as gold as ${actionLabel}`;

  return (
    <div className="flex shrink-0 items-center gap-2">
      <Button
        type="button"
        variant="secondary"
        size="sm"
        className="h-8 whitespace-nowrap"
        disabled={disabled}
        onClick={() => {
          if (disabled) return;
          setConfirmOpen(true);
        }}
      >
        {goldMutation.isPending ? 'Saving…' : 'Done — rest are fine'}
      </Button>
      {confirmOpen ? (
        <div role="dialog" aria-label={confirmLabel} className="flex items-center gap-2">
          <p className="text-muted-foreground text-xs font-medium whitespace-nowrap">{confirmLabel}</p>
          <Button
            type="button"
            size="sm"
            className="h-8"
            disabled={goldMutation.isPending}
            onClick={() => {
              if (goldMutation.isPending) return;
              goldMutation.mutate({ folder: workflowFolder }, { onSettled: () => setConfirmOpen(false) });
            }}
          >
            Confirm
          </Button>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="h-8"
            disabled={goldMutation.isPending}
            onClick={() => setConfirmOpen(false)}
          >
            Cancel
          </Button>
        </div>
      ) : null}
    </div>
  );
}

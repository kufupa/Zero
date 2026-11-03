import { addOptimisticActionAtom, removeOptimisticActionAtom } from '@/store/optimistic-updates';
import { optimisticActionsManager, type PendingAction } from '@/lib/optimistic-actions-manager';
import { useMutation, useQueryClient } from '@tanstack/react-query';

import { backgroundQueueAtom } from '@/store/backgroundQueue';
import type { ThreadDestination } from '@/lib/thread-actions';
import {
  buildThreadFilingSnapshots,
  collectCachedThreadLabelSources,
  fileThreadsTo,
  moveThreadsTo,
} from '@/lib/thread-actions';
import { buildReservedSpamLabelIdSet } from '@/lib/mail/route-filter';
import { useLabels } from '@/hooks/use-labels';
import { useTRPC } from '@/providers/query-provider';
import { useMail } from '@/components/mail/use-mail';
import { m } from '@/paraglide/messages';
import { useQueryState } from 'nuqs';
import { useCallback, useMemo } from 'react';
import posthog from 'posthog-js';
import { useAtom } from 'jotai';
import { toast } from 'sonner';
import { formatFileSuccessMessage } from '@/lib/mail/file-drag';
import { beginThreadMove, cancelThreadMove, finishThreadMove, hasThreadMove, isCurrentThreadMove } from '@/lib/mail/thread-move-intent';
import { DEMO_MAIL_LIST_DRAFTS_QUERY_PREFIX } from '@/lib/demo/demo-mail-query-keys';
import { isFrontendOnlyDemo } from '@/lib/demo/runtime';
import {
  showSpamUndoToast,
  type SenderPreference,
} from '@/lib/mail/spam-undo-toast';
import {
  demoBulkDeleteThreads,
  demoMarkAsRead,
  demoMarkAsUnread,
  demoModifyLabels,
  demoMoveThreadsTo,
  demoSnoozeThreads,
  demoToggleImportant,
  demoToggleStar,
  demoUnsnoozeThreads,
  demoDeleteDraft as demoDeleteDraftAction,
} from '@/lib/demo/local-actions';

enum ActionType {
  MOVE = 'MOVE',
  STAR = 'STAR',
  READ = 'READ',
  LABEL = 'LABEL',
  IMPORTANT = 'IMPORTANT',
  SNOOZE = 'SNOOZE',
  UNSNOOZE = 'UNSNOOZE',
  DELETE_DRAFT = 'DELETE_DRAFT',
}

// Update the params interface
interface ActionParams {
  starred?: boolean;
  read?: boolean;
  important?: boolean;
  labelId?: string;
  add?: boolean;
  currentFolder?: string;
  destination?: ThreadDestination;
  wakeAt?: string;
}

const actionEventNames: Record<ActionType, (params: ActionParams) => string> = {
  [ActionType.MOVE]: () => 'email_moved',
  [ActionType.STAR]: (params) => (params.starred ? 'email_starred' : 'email_unstarred'),
  [ActionType.READ]: (params) => (params.read ? 'email_marked_read' : 'email_marked_unread'),
  [ActionType.IMPORTANT]: (params) =>
    params.important ? 'email_marked_important' : 'email_unmarked_important',
  [ActionType.LABEL]: (params) => (params.add ? 'email_label_added' : 'email_label_removed'),
  [ActionType.SNOOZE]: () => 'email_snoozed',
  [ActionType.UNSNOOZE]: () => 'email_unsnoozed',
  [ActionType.DELETE_DRAFT]: () => 'draft_deleted',
};

export function useOptimisticActions() {
  const trpc = useTRPC();
  const queryClient = useQueryClient();
  const [, setBackgroundQueue] = useAtom(backgroundQueueAtom);
  const [, addOptimisticAction] = useAtom(addOptimisticActionAtom);
  const [, removeOptimisticAction] = useAtom(removeOptimisticActionAtom);
  const [threadId, setThreadId] = useQueryState('threadId');
  const [, setActiveReplyId] = useQueryState('activeReplyId');
  const [mail, setMail] = useMail();
  const { userLabels } = useLabels();
  const reservedSpamLabelIds = useMemo(
    () => buildReservedSpamLabelIdSet(userLabels ?? []),
    [userLabels],
  );
  const frontendOnlyDemo = isFrontendOnlyDemo();
  const { mutateAsync: markAsRead } = useMutation(trpc.mail.markAsRead.mutationOptions());
  const { mutateAsync: markAsUnread } = useMutation(trpc.mail.markAsUnread.mutationOptions());

  const { mutateAsync: toggleStar } = useMutation(trpc.mail.toggleStar.mutationOptions());
  const { mutateAsync: toggleImportant } = useMutation(trpc.mail.toggleImportant.mutationOptions());

  const { mutateAsync: bulkDeleteThread } = useMutation(trpc.mail.bulkDelete.mutationOptions());
  const { mutateAsync: snoozeThreads } = useMutation(trpc.mail.snoozeThreads.mutationOptions());
  const { mutateAsync: unsnoozeThreads } = useMutation(trpc.mail.unsnoozeThreads.mutationOptions());
  const { mutateAsync: modifyLabels } = useMutation(trpc.mail.modifyLabels.mutationOptions());

  const { mutateAsync: deleteDraft } = useMutation(trpc.drafts.delete.mutationOptions());

  const generatePendingActionId = () =>
    `pending_${Date.now()}_${Math.random().toString(36).substring(2, 9)}`;

  const { mutateAsync: setThreadCategories } = useMutation(
    trpc.categories.setThreadCategories.mutationOptions(),
  );

  const refreshData = useCallback(async () => {
    return await Promise.all([
      queryClient.refetchQueries({ queryKey: trpc.labels.list.queryKey() }),
      queryClient.refetchQueries({ queryKey: trpc.mail.unreadCounts.queryKey() }),
    ]);
  }, [queryClient, trpc]);

  const setCategoriesForThread = useCallback(
    async (threadId: string, categoryIds: string[]) => {
      const res = await setThreadCategories({ threadId, categoryIds });
      await refreshData();
      return res;
    },
    [setThreadCategories, refreshData],
  );

  function createPendingAction({
    type,
    threadIds,
    params,
    optimisticId,
    execute,
    undo,
    toastMessage,
  }: {
    type: keyof typeof ActionType;
    threadIds: string[];
    params: PendingAction['params'];
    optimisticId: string;
    execute: () => Promise<void>;
    undo: () => void;
    toastMessage: string;
    folders?: string[];
  }) {
    const pendingActionId = generatePendingActionId();
    optimisticActionsManager.lastActionId = pendingActionId;
    console.log('here Generated pending action ID:', pendingActionId);

    if (!optimisticActionsManager.pendingActionsByType.has(type)) {
      console.log('here Creating new Set for action type:', type);
      optimisticActionsManager.pendingActionsByType.set(type, new Set());
    }
    optimisticActionsManager.pendingActionsByType.get(type)?.add(pendingActionId);
    console.log(
      'here',
      'Added pending action to type:',
      type,
      'Current size:',
      optimisticActionsManager.pendingActionsByType.get(type)?.size,
    );

    const pendingAction = {
      id: pendingActionId,
      type,
      threadIds,
      params,
      optimisticId,
      execute,
      undo,
    };

    optimisticActionsManager.pendingActions.set(pendingActionId, pendingAction as PendingAction);

    const itemCount = threadIds.length;
    const bulkActionMessage = itemCount > 1 ? `${toastMessage} (${itemCount} items)` : toastMessage;

    async function doAction() {
      try {
        await execute();
        const typeActions = optimisticActionsManager.pendingActionsByType.get(type);
        console.log('here', {
          pendingActionsByTypeRef: optimisticActionsManager.pendingActionsByType.get(type)?.size,
          pendingActionsRef: optimisticActionsManager.pendingActions.size,
          typeActions: typeActions?.size,
        });

        const eventName = actionEventNames[type]?.(params);
        if (eventName) {
          posthog.capture(eventName);
        }

        optimisticActionsManager.pendingActions.delete(pendingActionId);
        optimisticActionsManager.pendingActionsByType.get(type)?.delete(pendingActionId);
        const remaining = optimisticActionsManager.pendingActionsByType.get(type)?.size ?? 0;
        if (remaining === 0 || typeActions?.size === 1) {
          await refreshData();
          removeOptimisticAction(optimisticId);
        } else {
          removeOptimisticAction(optimisticId);
        }
      } catch (error) {
        console.error('Action failed:', error);
        removeOptimisticAction(optimisticId);
        optimisticActionsManager.pendingActions.delete(pendingActionId);
        optimisticActionsManager.pendingActionsByType.get(type)?.delete(pendingActionId);
        toast.error('Action failed');
      }
    }

    if (toastMessage.trim().length) {
      toast(bulkActionMessage, {
        onAutoClose: () => {
          doAction();
        },
        onDismiss: () => {
          doAction();
        },
        action: {
          label: 'Undo',
          onClick: () => {
            undo();
            optimisticActionsManager.pendingActions.delete(pendingActionId);
            optimisticActionsManager.pendingActionsByType.get(type)?.delete(pendingActionId);
          },
        },
        duration: 5000,
      });
    } else {
      doAction();
    }

    return pendingActionId;
  }

  const optimisticMarkAsRead = useCallback(
    (threadIds: string[], silent = false) => {
      if (!threadIds.length) return;

      const optimisticId = addOptimisticAction({
        type: 'READ',
        threadIds,
        read: true,
      });

      createPendingAction({
        type: 'READ',
        threadIds,
        params: { read: true },
        optimisticId,
        execute: async () => {
          if (frontendOnlyDemo) {
            await demoMarkAsRead(threadIds);
          } else {
            await markAsRead({ ids: threadIds });
          }

          if (mail.bulkSelected.length > 0) {
            setMail((prev) => ({ ...prev, bulkSelected: [] }));
          }
        },
        undo: () => {
          removeOptimisticAction(optimisticId);
        },
        toastMessage: silent ? '' : 'Marked as read',
      });
    },
    [queryClient, addOptimisticAction, removeOptimisticAction, markAsRead, setMail],
  );

  function optimisticMarkAsUnread(threadIds: string[]) {
    if (!threadIds.length) return;

    const optimisticId = addOptimisticAction({
      type: 'READ',
      threadIds,
      read: false,
    });

    createPendingAction({
      type: 'READ',
      threadIds,
      params: { read: false },
      optimisticId,
      execute: async () => {
          if (frontendOnlyDemo) {
            await demoMarkAsUnread(threadIds);
          } else {
            await markAsUnread({ ids: threadIds });
          }

        if (mail.bulkSelected.length > 0) {
          setMail({ ...mail, bulkSelected: [] });
        }
      },
      undo: () => {
        removeOptimisticAction(optimisticId);
      },
      toastMessage: 'Marked as unread',
    });
  }

  const optimisticToggleStar = useCallback(
    (threadIds: string[], starred: boolean) => {
      if (!threadIds.length) return;

      const optimisticId = addOptimisticAction({
        type: 'STAR',
        threadIds,
        starred,
      });

      createPendingAction({
        type: 'STAR',
        threadIds,
        params: { starred },
        optimisticId,
        execute: async () => {
          if (frontendOnlyDemo) {
            await demoToggleStar(threadIds);
          } else {
            await toggleStar({ ids: threadIds });
          }
        },
        undo: () => {
          removeOptimisticAction(optimisticId);
        },
        toastMessage: starred
          ? m['common.actions.addedToFavorites']()
          : m['common.actions.removedFromFavorites'](),
      });
    },
    [queryClient, addOptimisticAction, removeOptimisticAction, toggleStar, setMail],
  );

  async function executeSpamMoveWithUndoToast(
    threadIds: string[],
    currentFolder: string,
    optimisticId: string,
  ) {
    try {
      let preferences: SenderPreference[] = [];

      if (frontendOnlyDemo) {
        await demoMoveThreadsTo({ threadIds, currentFolder, destination: 'spam' });
      } else {
        const result = await moveThreadsTo({
          threadIds,
          currentFolder,
          destination: 'spam',
        });
        preferences = result?.preferences ?? [];
      }
      posthog.capture(actionEventNames[ActionType.MOVE]({ destination: 'spam' }));

      if (mail.bulkSelected.length > 0) {
        setMail({ ...mail, bulkSelected: [] });
      }

      await refreshData();
      removeOptimisticAction(optimisticId);

      showSpamUndoToast({
        threadIds,
        preferences,
        onUndo: async () => {
          const undoOptimisticId = addOptimisticAction({
            type: 'MOVE',
            threadIds,
            destination: 'inbox',
          });

          try {
            if (frontendOnlyDemo) {
              await demoMoveThreadsTo({
                threadIds,
                currentFolder: 'spam',
                destination: 'inbox',
              });
            } else {
              await moveThreadsTo({
                threadIds,
                currentFolder: 'spam',
                destination: 'inbox',
              });
            }

            await refreshData();
            removeOptimisticAction(undoOptimisticId);
          } catch (error) {
            removeOptimisticAction(undoOptimisticId);
            throw error;
          }
        },
      });
    } catch (error) {
      console.error('Action failed:', error);
      removeOptimisticAction(optimisticId);
      toast.error('Action failed');
    }
  }

  function optimisticMoveThreadsTo(
    threadIds: string[],
    currentFolder: string,
    destination: ThreadDestination,
    options?: { preserveSelection?: boolean; moveIntent?: number },
  ) {
    if (!threadIds.length || !destination) return;
    if (options?.moveIntent !== undefined &&
        (threadIds.length !== 1 || !hasThreadMove(threadIds[0]!, options.moveIntent))) return;
    const moveIntents = new Map(threadIds.map((id) => [id, options?.moveIntent ?? beginThreadMove(id)]));
    const currentThreads = () => threadIds.filter((id) => isCurrentThreadMove(id, moveIntents.get(id)!));
    const finishMoves = (ids: string[]) => ids.forEach((id) => finishThreadMove(id, moveIntents.get(id)!));
    const cancelMoves = (ids: string[]) => ids.forEach((id) => cancelThreadMove(id, moveIntents.get(id)!));
    const clearFinished = (ids: string[]) => ids.filter((id) => !hasThreadMove(id)).forEach((id) => {
      setBackgroundQueue({ type: 'delete', threadId: `thread:${id}` });
    });

    const optimisticId = addOptimisticAction({
      type: 'MOVE',
      threadIds,
      destination,
    });

    threadIds.forEach((id) => {
      setBackgroundQueue({ type: 'add', threadId: `thread:${id}` });
    });

    if (!options?.preserveSelection && threadId && threadIds.includes(threadId)) {
      setThreadId(null);
      setActiveReplyId(null);
    }

    if (destination === 'spam') {
      // A rejected request can have saved already. Never revive an older move once dispatch starts.
      finishMoves(threadIds);
      void executeSpamMoveWithUndoToast(threadIds, currentFolder, optimisticId).then(() => {
        clearFinished(threadIds);
      });
      return;
    }

    const successMessage =
      destination === 'inbox'
        ? m['common.actions.movedToInbox']()
        : destination === 'bin'
          ? m['common.actions.movedToBin']()
          : m['common.actions.archived']();

    createPendingAction({
      type: 'MOVE',
      threadIds,
      params: { currentFolder, destination },
      optimisticId,
      execute: async () => {
        const activeIds = currentThreads();
        cancelMoves(threadIds.filter((id) => !activeIds.includes(id)));
        if (!activeIds.length) { clearFinished(threadIds); return; }
        finishMoves(activeIds);
        try {
          if (frontendOnlyDemo) {
            await demoMoveThreadsTo({ threadIds: activeIds, currentFolder, destination });
          } else {
            await moveThreadsTo({
              threadIds: activeIds,
              currentFolder,
              destination,
            });
          }
          if (mail.bulkSelected.length > 0) {
            setMail({ ...mail, bulkSelected: [] });
          }
        } finally {
          clearFinished(activeIds);
        }
      },
      undo: () => {
        removeOptimisticAction(optimisticId);
        cancelMoves(threadIds);
        clearFinished(threadIds);
      },
      toastMessage: successMessage,
      folders: [currentFolder, destination],
    });
  }

  function optimisticFileThreads(threadIds: string[], currentFolder: string, labelId: string) {
    if (!threadIds.length || !labelId) return;

    const cachedThreads = collectCachedThreadLabelSources(queryClient.getQueriesData({}));
    // Snapshot prior labelIds + archive/spam/trash flags for undo/error restore.
    const priorSnapshots = buildThreadFilingSnapshots(
      threadIds,
      currentFolder,
      cachedThreads,
      reservedSpamLabelIds,
    );

    const moveOptimisticId = addOptimisticAction({
      type: 'MOVE',
      threadIds,
      destination: 'archive',
    });
    const labelOptimisticId = addOptimisticAction({
      type: 'LABEL',
      threadIds,
      labelIds: [labelId],
      add: true,
    });

    threadIds.forEach((id) => {
      setBackgroundQueue({ type: 'add', threadId: `thread:${id}` });
    });

    if (threadId && threadIds.includes(threadId)) {
      setThreadId(null);
      setActiveReplyId(null);
    }

    const clearOptimistic = () => {
      removeOptimisticAction(moveOptimisticId);
      removeOptimisticAction(labelOptimisticId);
    };

    const targetLabel = userLabels?.find((l) => l.id === labelId);
    const successToastMessage = formatFileSuccessMessage(targetLabel?.name);

    createPendingAction({
      type: 'MOVE',
      threadIds,
      params: { currentFolder, destination: 'archive' },
      optimisticId: moveOptimisticId,
      execute: async () => {
        try {
          if (frontendOnlyDemo) {
            await demoMoveThreadsTo({
              threadIds,
              currentFolder,
              destination: 'archive',
            });
            await demoModifyLabels({
              threadId: threadIds,
              addLabels: [labelId],
              removeLabels: [],
            });
          } else {
            await fileThreadsTo({ threadIds, labelId });
          }

          if (mail.bulkSelected.length > 0) {
            setMail({ ...mail, bulkSelected: [] });
          }

          threadIds.forEach((id) => {
            setBackgroundQueue({ type: 'delete', threadId: `thread:${id}` });
          });
        } catch (error) {
          clearOptimistic();
          threadIds.forEach((id) => {
            setBackgroundQueue({ type: 'delete', threadId: `thread:${id}` });
          });
          // priorSnapshots available if we later rehydrate cache from prior flags/labelIds
          void priorSnapshots;
          throw error;
        }
        removeOptimisticAction(labelOptimisticId);
      },
      undo: () => {
        // Undo before mutate runs: restore list visibility + prior label chrome.
        clearOptimistic();
        threadIds.forEach((id) => {
          setBackgroundQueue({ type: 'delete', threadId: `thread:${id}` });
        });
        void priorSnapshots;
      },
      toastMessage: successToastMessage,
      folders: [currentFolder, 'archive'],
    });
  }

  function optimisticDeleteThreads(threadIds: string[], currentFolder: string) {
    if (!threadIds.length) return;

    // setFocusedIndex(null);

    const optimisticId = addOptimisticAction({
      type: 'MOVE',
      threadIds,
      destination: 'bin',
    });

    threadIds.forEach((id) => {
      setBackgroundQueue({ type: 'add', threadId: `thread:${id}` });
    });

    if (threadId && threadIds.includes(threadId)) {
      setThreadId(null);
      setActiveReplyId(null);
    }
    createPendingAction({
      type: 'MOVE',
      threadIds,
      params: { currentFolder, destination: 'bin' },
      optimisticId,
      execute: async () => {
          if (frontendOnlyDemo) {
            await demoBulkDeleteThreads({ ids: threadIds });
          } else {
            await bulkDeleteThread({ ids: threadIds });
          }

        if (mail.bulkSelected.length > 0) {
          setMail({ ...mail, bulkSelected: [] });
        }

        threadIds.forEach((id) => {
          setBackgroundQueue({ type: 'delete', threadId: `thread:${id}` });
        });
      },
      undo: () => {
        removeOptimisticAction(optimisticId);

        threadIds.forEach((id) => {
          setBackgroundQueue({ type: 'delete', threadId: `thread:${id}` });
        });
      },
      toastMessage: m['common.actions.movedToBin'](),
    });
  }

  const optimisticToggleImportant = useCallback(
    (threadIds: string[], isImportant: boolean) => {
      if (!threadIds.length) return;

      const optimisticId = addOptimisticAction({
        type: 'IMPORTANT',
        threadIds,
        important: isImportant,
      });

      createPendingAction({
        type: 'IMPORTANT',
        threadIds,
        params: { important: isImportant },
        optimisticId,
        execute: async () => {
          if (frontendOnlyDemo) {
            await demoToggleImportant(threadIds);
          } else {
            await toggleImportant({ ids: threadIds });
          }

          if (mail.bulkSelected.length > 0) {
            setMail((prev) => ({ ...prev, bulkSelected: [] }));
          }
        },
        undo: () => {
          removeOptimisticAction(optimisticId);
        },
        toastMessage: isImportant ? 'Marked as important' : 'Unmarked as important',
      });
    },
    [queryClient, addOptimisticAction, removeOptimisticAction, toggleImportant, setMail],
  );

  function optimisticToggleLabel(threadIds: string[], labelId: string, add: boolean) {
    if (!threadIds.length || !labelId) return;

    const optimisticId = addOptimisticAction({
      type: 'LABEL',
      threadIds,
      labelIds: [labelId],
      add,
    });

    createPendingAction({
      type: 'LABEL',
      threadIds,
      params: { labelId, add },
      optimisticId,
      execute: async () => {
          if (frontendOnlyDemo) {
            await demoModifyLabels({
              threadId: threadIds,
              addLabels: add ? [labelId] : [],
              removeLabels: add ? [] : [labelId],
            });
          } else {
            await modifyLabels({
              threadId: threadIds,
              addLabels: add ? [labelId] : [],
              removeLabels: add ? [] : [labelId],
            });
          }

        if (mail.bulkSelected.length > 0) {
          setMail({ ...mail, bulkSelected: [] });
        }
      },
      undo: () => {
        removeOptimisticAction(optimisticId);
      },
      toastMessage: add
        ? `Label added${threadIds.length > 1 ? ` to ${threadIds.length} threads` : ''}`
        : `Label removed${threadIds.length > 1 ? ` from ${threadIds.length} threads` : ''}`,
    });
  }

  function optimisticSnooze(threadIds: string[], currentFolder: string, wakeAt: Date) {
    if (!threadIds.length) return;

    const optimisticId = addOptimisticAction({
      type: 'SNOOZE',
      threadIds,
      wakeAt: wakeAt.toISOString(),
    });

    createPendingAction({
      type: 'SNOOZE',
      threadIds,
      params: { currentFolder, wakeAt: wakeAt.toISOString() },
      optimisticId,
      execute: async () => {
          if (frontendOnlyDemo) {
            await demoSnoozeThreads({ ids: threadIds, wakeAt: wakeAt.toISOString() });
          } else {
            await snoozeThreads({ ids: threadIds, wakeAt: wakeAt.toISOString() });
          }

        if (mail.bulkSelected.length > 0) {
          setMail({ ...mail, bulkSelected: [] });
        }
      },
      undo: () => {
        removeOptimisticAction(optimisticId);
      },
      toastMessage: `Snoozed until ${wakeAt.toLocaleString()}`,
      folders: [currentFolder, 'snoozed'],
    });
  }

  function optimisticUnsnooze(threadIds: string[], currentFolder: string) {
    if (!threadIds.length) return;

    const optimisticId = addOptimisticAction({
      type: 'UNSNOOZE',
      threadIds,
    });

    createPendingAction({
      type: 'UNSNOOZE',
      threadIds,
      params: { currentFolder },
      optimisticId,
      execute: async () => {
          if (frontendOnlyDemo) {
            await demoUnsnoozeThreads({ ids: threadIds });
          } else {
            await unsnoozeThreads({ ids: threadIds });
          }
      },
      undo: () => {
        removeOptimisticAction(optimisticId);
      },
      toastMessage: 'Moved to Inbox',
      folders: [currentFolder, 'inbox'],
    });
  }

  function optimisticDeleteDraft(draftId: string) {
    if (!draftId) return;

    const optimisticId = addOptimisticAction({
      type: 'DELETE_DRAFT',
      threadIds: [draftId],
    });

    createPendingAction({
      type: 'DELETE_DRAFT',
      threadIds: [draftId],
      params: {},
      optimisticId,
      execute: async () => {
          if (frontendOnlyDemo) {
            await demoDeleteDraftAction(draftId);
            void queryClient.invalidateQueries({ queryKey: [...DEMO_MAIL_LIST_DRAFTS_QUERY_PREFIX] });
            void queryClient.invalidateQueries({ queryKey: ['demo', 'mail', 'thread'] });
          } else {
            await deleteDraft({ id: draftId });
          }
        await Promise.all([
          queryClient.invalidateQueries({ queryKey: trpc.drafts.list.queryKey() }),
          // Thread view hydrates latestDraft from mail.get — must drop discarded body.
          queryClient.invalidateQueries({ queryKey: trpc.mail.get.queryKey() }),
          queryClient.invalidateQueries({ queryKey: trpc.drafts.get.queryKey({ id: draftId }) }),
        ]);
      },
      undo: () => {
        removeOptimisticAction(optimisticId);
      },
      toastMessage: 'Draft deleted',
    });
  }

  function undoLastAction() {
    if (!optimisticActionsManager.lastActionId) return;

    const lastAction = optimisticActionsManager.pendingActions.get(
      optimisticActionsManager.lastActionId,
    );
    if (!lastAction) return;

    lastAction.undo();

    optimisticActionsManager.pendingActions.delete(optimisticActionsManager.lastActionId);
    optimisticActionsManager.pendingActionsByType
      .get(lastAction.type)
      ?.delete(optimisticActionsManager.lastActionId);

    if (lastAction.toastId) {
      toast.dismiss(lastAction.toastId);
    }

    optimisticActionsManager.lastActionId = null;
  }

  return {
    optimisticMarkAsRead,
    optimisticMarkAsUnread,
    optimisticToggleStar,
    optimisticMoveThreadsTo,
    optimisticFileThreads,
    optimisticDeleteThreads,
    optimisticToggleImportant,
    optimisticToggleLabel,
    optimisticSnooze,
    optimisticUnsnooze,
    optimisticDeleteDraft,
    setCategoriesForThread,
    undoLastAction,
  };
}

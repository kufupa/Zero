import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuShortcut,
  ContextMenuSub,
  ContextMenuSubContent,
  ContextMenuSubTrigger,
  ContextMenuTrigger,
} from '../ui/context-menu';
import {
  Archive,
  ArchiveX,
  ExternalLink,
  Forward,
  Inbox,
  MailOpen,
  Reply,
  ReplyAll,
  Star,
  StarOff,
  Tag,
  Plus,
  Trash,
} from 'lucide-react';
import { useOptimisticThreadState } from '@/components/mail/optimistic-thread-state';
import { LabelDialog } from '@/components/labels/label-dialog';
import { useOptimisticActions } from '@/hooks/use-optimistic-actions';
import { ExclamationCircle, Mail, Clock } from '../icons/icons';
import { SnoozeDialog } from '@/components/mail/snooze-dialog';
import { type ThreadDestination } from '@/lib/thread-actions';
import { useThread, useThreads } from '@/hooks/use-threads';
import { useMemo, type ReactNode, useState, useCallback } from 'react';
import { getFrontendApi } from '@/lib/api/client';
import { useMutation } from '@tanstack/react-query';
import { useLabels } from '@/hooks/use-labels';
import { FOLDERS, LABELS } from '@/lib/utils';
import { useMail } from '../mail/use-mail';
import { Checkbox } from '../ui/checkbox';
import { m } from '@/paraglide/messages';
import { useParams } from 'react-router';
import { parseAsString, useQueryState, useQueryStates } from 'nuqs';
import { toast } from 'sonner';
import type { Label as LabelType } from '@/types';
import { openReplyComposeContext } from '@/lib/mail/reply-compose-context';
import { isFrontendOnlyDemo } from '@/lib/demo/runtime';
import { demoCreateLabel } from '@/lib/demo/local-actions';

interface EmailAction {
  id: string;
  label: string | ReactNode;
  icon?: ReactNode;
  shortcut?: string;
  action: () => void;
  disabled?: boolean;
  condition?: () => boolean;
}

export type ThreadLabelCreateContextInput = {
  data: LabelType;
  isFrontendOnlyDemoMode: boolean;
  setCreateLabelOpen: (value: boolean) => void;
  createLabel: (input: {
    name: string;
    color: {
      backgroundColor: string;
      textColor: string;
    };
    type: 'user';
  }) => Promise<unknown>;
  refetchLabels: () => Promise<unknown> | unknown;
  labelsSuccessMessage: string;
  labelsSavingMessage: string;
  labelsSaveErrorMessage: string;
  onError: (error: unknown) => void;
};

export async function createLabelInThreadContext(input: ThreadLabelCreateContextInput): Promise<void> {
  const labelData = {
    name: input.data.name,
    color: {
      backgroundColor: input.data.color?.backgroundColor || '#202020',
      textColor: input.data.color?.textColor || '#FFFFFF',
    },
    type: 'user' as const,
  };

  try {
    if (input.isFrontendOnlyDemoMode) {
      await input.createLabel(labelData);
      await Promise.resolve(input.refetchLabels());
      toast.success(input.labelsSuccessMessage);
      return;
    }

    const promise = input.createLabel(labelData).then(async (result) => {
      await Promise.resolve(input.refetchLabels());
      return result;
    });

    toast.promise(promise, {
      loading: input.labelsSavingMessage,
      success: input.labelsSuccessMessage,
      error: input.labelsSaveErrorMessage,
    });

    await promise;
  } catch (error) {
    input.onError(error);
  } finally {
    input.setCreateLabelOpen(false);
  }
}

interface EmailContextMenuProps {
  children: ReactNode;
  threadId: string;
  isInbox?: boolean;
  isSpam?: boolean;
  isSent?: boolean;
  isBin?: boolean;
  refreshCallback?: () => void;
}

const LabelsList = ({ threadId, bulkSelected, onCreateLabel }: { threadId: string; bulkSelected: string[]; onCreateLabel: () => void }) => {
  const { userLabels: labels } = useLabels();
  const { optimisticToggleLabel } = useOptimisticActions();
  const targetThreadIds = bulkSelected.length > 0 ? bulkSelected : [threadId];

  const { data: thread } = useThread(threadId);
  const rightClickedThreadOptimisticState = useOptimisticThreadState(threadId);

  if (!labels || !thread) return null;

  const handleToggleLabel = (labelId: string) => {
    if (!labelId) return;

    // Determine current label state considering optimistic updates
    let hasLabel = thread!.labels?.some((l) => l.id === labelId) ?? false;

    if (rightClickedThreadOptimisticState.optimisticLabels) {
      if (rightClickedThreadOptimisticState.optimisticLabels.addedLabelIds.includes(labelId)) {
        hasLabel = true;
      } else if (
        rightClickedThreadOptimisticState.optimisticLabels.removedLabelIds.includes(labelId)
      ) {
        hasLabel = false;
      }
    }

    optimisticToggleLabel(targetThreadIds, labelId, !hasLabel);
  };

  // If no labels exist, show create label button
  if (!labels || labels.length === 0) {
    return (
      <ContextMenuItem 
        onClick={onCreateLabel}
        className="font-normal"
      >
        <Plus className="mr-2 h-4 w-4 opacity-60" />
        {m['common.mail.createNewLabel']()}
      </ContextMenuItem>
    );
  }

  return (
    <>
      {labels
        .filter((label) => label.id)
        .map((label) => {
          let isChecked = label.id
            ? (thread!.labels?.some((l) => l.id === label.id) ?? false)
            : false;

          if (rightClickedThreadOptimisticState.optimisticLabels) {
            if (
              rightClickedThreadOptimisticState.optimisticLabels.addedLabelIds.includes(label.id)
            ) {
              isChecked = true;
            } else if (
              rightClickedThreadOptimisticState.optimisticLabels.removedLabelIds.includes(label.id)
            ) {
              isChecked = false;
            }
          }

          return (
            <ContextMenuItem
              key={label.id}
              onClick={() => label.id && handleToggleLabel(label.id)}
              className="font-normal"
            >
              <div className="flex items-center">
                <Checkbox checked={isChecked} className="mr-2 h-4 w-4" />
                {label.name}
              </div>
            </ContextMenuItem>
          );
        })}
    </>
  );
};

export function ThreadContextMenu({
  children,
  threadId,
  isInbox = true,
  isSpam = false,
  isSent = false,
  isBin = false,
}: EmailContextMenuProps) {
  const { folder } = useParams<{ folder: string }>();
  const [mail, setMail] = useMail();
  const [{ isLoading, isFetching, refetch: refetchThreads }] = useThreads();
  const currentFolder = folder ?? '';
  const isArchiveFolder = currentFolder === FOLDERS.ARCHIVE;
  const isSnoozedFolder = currentFolder === FOLDERS.SNOOZED;
  const [, setMode] = useQueryState('mode');
  const [, setThreadId] = useQueryState('threadId');
  const { data: threadData } = useThread(threadId);
  const [, setActiveReplyId] = useQueryState('activeReplyId');
  const [, setDraftId] = useQueryState('draftId');
  const [, setComposeState] = useQueryStates({
    mode: parseAsString,
    activeReplyId: parseAsString,
    draftId: parseAsString,
  });
  const optimisticState = useOptimisticThreadState(threadId);
  const { refetch: refetchLabels } = useLabels();
  const {
    optimisticMoveThreadsTo,
    optimisticToggleStar,
    optimisticToggleImportant,
    optimisticMarkAsRead,
    optimisticMarkAsUnread,
    optimisticDeleteThreads,
    optimisticSnooze,
    optimisticUnsnooze,
  } = useOptimisticActions();
  const { mutateAsync: deleteThread } = useMutation({
    mutationFn: (input: unknown) => getFrontendApi().mail.deleteThread(input),
  });
  const { mutateAsync: createLabel } = useMutation({
    mutationFn: (input: unknown) => getFrontendApi().labels.create(input),
  });

  const { isUnread, isStarred, isImportant } = useMemo(() => {
    const unread = threadData?.hasUnread ?? false;

    let starred;
    if (optimisticState.optimisticStarred !== null) {
      starred = optimisticState.optimisticStarred;
    } else {
      starred = threadData?.messages.some((message) =>
        message.tags?.some((tag) => tag.name.toLowerCase() === 'starred'),
      );
    }

    let important;
    if (optimisticState.optimisticImportant !== null) {
      important = optimisticState.optimisticImportant;
    } else {
      important = threadData?.messages.some((message) =>
        message.tags?.some((tag) => tag.name.toLowerCase() === 'important'),
      );
    }

    return { isUnread: unread, isStarred: starred, isImportant: important };
  }, [threadData, optimisticState.optimisticStarred, optimisticState.optimisticImportant]);

  const handleMove = (from: string, to: string) => () => {
    try {
      let targets = [];
      if (mail.bulkSelected.length) {
        targets = mail.bulkSelected;
      } else {
        targets = [threadId];
      }

      let destination: ThreadDestination = null;
      if (to === LABELS.INBOX) destination = FOLDERS.INBOX;
      else if (to === LABELS.SPAM) destination = FOLDERS.SPAM;
      else if (to === LABELS.TRASH) destination = FOLDERS.BIN;
      else if (from && !to) destination = FOLDERS.ARCHIVE;

      optimisticMoveThreadsTo(targets, currentFolder, destination);

      if (mail.bulkSelected.length) {
        setMail({ ...mail, bulkSelected: [] });
      }
    } catch (error) {
      console.error(`Error moving ${threadId ? 'email' : 'thread'}:`, error);
      toast.error(m['common.actions.failedToMove']());
    }
  };

  const handleFavorites = () => {
    const targets = mail.bulkSelected.length ? mail.bulkSelected : [threadId];

    const newStarredState = !isStarred;

    optimisticToggleStar(targets, newStarredState);

    if (mail.bulkSelected.length) {
      setMail((prev) => ({ ...prev, bulkSelected: [] }));
    }
  };

  const handleToggleImportant = () => {
    const targets = mail.bulkSelected.length ? mail.bulkSelected : [threadId];
    const newImportantState = !isImportant;

    // Use optimistic update with undo functionality
    optimisticToggleImportant(targets, newImportantState);

    // Clear bulk selection after action
    if (mail.bulkSelected.length) {
      setMail((prev) => ({ ...prev, bulkSelected: [] }));
    }
  };

  const handleReadUnread = () => {
    const targets = mail.bulkSelected.length ? mail.bulkSelected : [threadId];
    const newReadState = isUnread; // If currently unread, mark as read (true)

    // Use optimistic update with undo functionality
    if (newReadState) {
      optimisticMarkAsRead(targets);
    } else if (!newReadState) {
      optimisticMarkAsUnread(targets);
    } else {
      toast.error('Failed to mark as read');
    }

    // Clear bulk selection after action
    if (mail.bulkSelected.length) {
      setMail((prev) => ({ ...prev, bulkSelected: [] }));
    }
  };

  const handleThreadReply = () => {
    setThreadId(threadId);
    void openReplyComposeContext({
      mode: 'reply',
      messageId: threadData?.latest?.id ?? null,
      setMode,
      setActiveReplyId,
      setDraftId,
      setComposeState,
    });
  };

  const handleThreadReplyAll = () => {
    setThreadId(threadId);
    void openReplyComposeContext({
      mode: 'replyAll',
      messageId: threadData?.latest?.id ?? null,
      setMode,
      setActiveReplyId,
      setDraftId,
      setComposeState,
    });
  };

  const handleThreadForward = () => {
    setThreadId(threadId);
    void openReplyComposeContext({
      mode: 'forward',
      messageId: threadData?.latest?.id ?? null,
      setMode,
      setActiveReplyId,
      setDraftId,
      setComposeState,
    });
  };

  const handleOpenInNewTab = () => {
    window.open(`/mail/${folder}?threadId=${threadId}`, '_blank');
  };

  const primaryActions: EmailAction[] = useMemo(
    () => [
      {
        id: 'open-in-new-tab',
        label: m['common.mail.openInNewTab'](),
        icon: <ExternalLink className="mr-2.5 h-4 w-4" />,
        action: handleOpenInNewTab,
        disabled: false,
      },
      {
        id: 'reply',
        label: m['common.mail.reply'](),
        icon: <Reply className="mr-2.5 h-4 w-4 opacity-60" />,
        action: handleThreadReply,
        disabled: false,
      },
      {
        id: 'reply-all',
        label: m['common.mail.replyAll'](),
        icon: <ReplyAll className="mr-2.5 h-4 w-4 opacity-60" />,
        action: handleThreadReplyAll,
        disabled: false,
      },
      {
        id: 'forward',
        label: m['common.mail.forward'](),
        icon: <Forward className="mr-2.5 h-4 w-4 opacity-60" />,
        action: handleThreadForward,
        disabled: false,
      },
    ],
    [m, handleThreadReply, handleThreadReplyAll, handleThreadForward],
  );

  const handleDelete = () => () => {
    const targets = mail.bulkSelected.length ? mail.bulkSelected : [threadId];

    if (isFrontendOnlyDemo()) {
      optimisticDeleteThreads(targets, currentFolder);
      if (mail.bulkSelected.length) {
        setMail({ ...mail, bulkSelected: [] });
      }
      toast.success('Deleted');
      return;
    }

    const hadBulkSelectionForAction = mail.bulkSelected.length > 0;
    const targetSet = new Set(targets);
    const deletePromise = Promise.all(
      targets.map(async (id) => {
        return deleteThread({ id });
      }),
    )
      .then((result) => {
        if (hadBulkSelectionForAction) {
          setMail((prev) => {
            const prevBulkSelected = prev.bulkSelected;
            const matchesOriginalTargets =
              prevBulkSelected.length === targetSet.size &&
              prevBulkSelected.every((id) => targetSet.has(id));

            if (!matchesOriginalTargets) {
              return prev;
            }

            return { ...prev, bulkSelected: [] };
          });
        }

        return result;
      })
      .finally(async () => {
        await Promise.resolve(refetchThreads()).catch((error) => {
          console.error('Failed to refetch threads after delete:', error);
        });
      });

    toast.promise(
      deletePromise,
      {
        loading: 'Deleting...',
        success: 'Deleted',
        error: 'Failed to delete',
      },
    );
  };

  const getActions = useMemo(() => {
    if (isSpam) {
      return [
        {
          id: 'move-to-inbox',
          label: m['common.mail.moveToInbox'](),
          icon: <Inbox className="mr-2.5 h-4 w-4 opacity-60" />,
          action: handleMove(LABELS.SPAM, LABELS.INBOX),
          disabled: false,
        },
        {
          id: 'move-to-bin',
          label: m['common.mail.moveToBin'](),
          icon: <Trash className="mr-2.5 h-4 w-4 opacity-60" />,
          action: handleMove(LABELS.SPAM, LABELS.TRASH),
          disabled: false,
        },
      ];
    }

    if (isBin) {
      return [
        {
          id: 'restore-from-bin',
          label: m['common.mail.restoreFromBin'](),
          icon: <Inbox className="mr-2.5 h-4 w-4 opacity-60" />,
          action: handleMove(LABELS.TRASH, LABELS.INBOX),
          disabled: false,
        },
        {
          id: 'delete-from-bin',
          label: m['common.mail.deleteFromBin'](),
          icon: <Trash className="mr-2.5 h-4 w-4 opacity-60" />,
          action: handleDelete(),
        },
      ];
    }

    if (isSnoozedFolder) {
      return [
        {
          id: 'unsnooze',
          label: 'Unsnooze',
          icon: <Inbox className="mr-2.5 h-4 w-4 opacity-60" />,
          action: () => {
            const targets = mail.bulkSelected.length ? mail.bulkSelected : [threadId];
            optimisticUnsnooze(targets, currentFolder);
            if (mail.bulkSelected.length) {
              setMail({ ...mail, bulkSelected: [] });
            }
          },
          disabled: false,
        },
        {
          id: 'move-to-bin',
          label: m['common.mail.moveToBin'](),
          icon: <Trash className="mr-2.5 h-4 w-4 opacity-60" />,
          action: handleMove(LABELS.SNOOZED, LABELS.TRASH),
          disabled: false,
        },
      ];
    }

    if (isSent) {
      return [
        {
          id: 'archive',
          label: m['common.mail.archive'](),
          icon: <Archive className="mr-2.5 h-4 w-4 opacity-60" />,
          action: handleMove(LABELS.SENT, ''),
          disabled: false,
        },
        {
          id: 'move-to-bin',
          label: m['common.mail.moveToBin'](),
          icon: <Trash className="mr-2.5 h-4 w-4 opacity-60" />,
          action: handleMove(LABELS.SENT, LABELS.TRASH),
          disabled: false,
        },
      ];
    }

    if (isArchiveFolder || !isInbox) {
      return [
        {
          id: 'move-to-inbox',
          label: m['common.mail.unarchive'](),
          icon: <Inbox className="mr-2.5 h-4 w-4 opacity-60" />,
          action: handleMove('', LABELS.INBOX),
          disabled: false,
        },
        {
          id: 'move-to-bin',
          label: m['common.mail.moveToBin'](),
          icon: <Trash className="mr-2.5 h-4 w-4 opacity-60" />,
          action: handleMove('', LABELS.TRASH),
          disabled: false,
        },
      ];
    }

    return [
      {
        id: 'archive',
        label: m['common.mail.archive'](),
        icon: <Archive className="mr-2.5 h-4 w-4 opacity-60" />,
        action: handleMove(LABELS.INBOX, ''),
        disabled: false,
      },
      {
        id: 'move-to-spam',
        label: m['common.mail.moveToSpam'](),
        icon: <ArchiveX className="mr-2.5 h-4 w-4 opacity-60" />,
        action: handleMove(LABELS.INBOX, LABELS.SPAM),
        disabled: !isInbox,
      },
      {
        id: 'move-to-bin',
        label: m['common.mail.moveToBin'](),
        icon: <Trash className="mr-2.5 h-4 w-4 opacity-60" />,
        action: handleMove(LABELS.INBOX, LABELS.TRASH),
        disabled: false,
      },
    ];
  }, [isSpam, isBin, isArchiveFolder, isInbox, isSent, handleMove, handleDelete]);

  const [snoozeOpen, setSnoozeOpen] = useState(false);
  const [createLabelOpen, setCreateLabelOpen] = useState(false);

  const handleOpenCreateLabel = useCallback(() => {
    setCreateLabelOpen(true);
  }, []);

  const handleSnoozeConfirm = (wakeAt: Date) => {
    const targets = mail.bulkSelected.length ? mail.bulkSelected : [threadId];
    optimisticSnooze(targets, currentFolder, wakeAt);
    setSnoozeOpen(false);
  };

  const handleCreateLabel = async (data: LabelType) => {
    await createLabelInThreadContext({
      data,
      isFrontendOnlyDemoMode: isFrontendOnlyDemo(),
      setCreateLabelOpen,
      createLabel: isFrontendOnlyDemo() ? demoCreateLabel : createLabel,
      refetchLabels,
      labelsSuccessMessage: m['common.labels.saveLabelSuccess'](),
      labelsSavingMessage: m['common.labels.savingLabel'](),
      labelsSaveErrorMessage: m['common.labels.failedToSavingLabel'](),
      onError: (error) => console.error('Failed to create label:', error),
    });
  };

  const otherActions: EmailAction[] = useMemo(
    () => [
      {
        id: 'toggle-read',
        label: isUnread ? m['common.mail.markAsRead']() : m['common.mail.markAsUnread'](),
        icon: !isUnread ? (
          <Mail className="mr-2.5 h-4 w-4 fill-[#9D9D9D] dark:fill-[#9D9D9D]" />
        ) : (
          <MailOpen className="mr-2.5 h-4 w-4 opacity-60" />
        ),
        action: handleReadUnread,
        disabled: false,
      },
      {
        id: 'toggle-important',
        label: isImportant
          ? m['common.mail.removeFromImportant']()
          : m['common.mail.markAsImportant'](),
        icon: <ExclamationCircle className="mr-2.5 h-4 w-4 fill-[#9D9D9D] dark:fill-[#9D9D9D]" />,
        action: handleToggleImportant,
      },
      {
        id: 'favorite',
        label: isStarred ? m['common.mail.removeFavorite']() : m['common.mail.addFavorite'](),
        icon: isStarred ? (
          <StarOff className="mr-2.5 h-4 w-4 opacity-60" />
        ) : (
          <Star className="mr-2.5 h-4 w-4 opacity-60" />
        ),
        action: handleFavorites,
      },
      {
        id: 'snooze',
        label: 'Snooze',
        icon: <Clock className="mr-2.5 h-4 w-4 opacity-60" />,
        action: () => setSnoozeOpen(true),
        disabled: false,
      },
    ],
    [isUnread, isImportant, isStarred, m, handleReadUnread, handleToggleImportant, handleFavorites],
  );

  const renderAction = (action: EmailAction) => {
    return (
      <ContextMenuItem
        key={action.id}
        onClick={action.action}
        disabled={action.disabled}
        className="font-normal"
      >
        {action.icon}
        {action.label}
        {action.shortcut && <ContextMenuShortcut>{action.shortcut}</ContextMenuShortcut>}
      </ContextMenuItem>
    );
  };

  return (
    <>
      <LabelDialog
        open={createLabelOpen}
        onOpenChange={setCreateLabelOpen}
        onSubmit={handleCreateLabel}
      />
      <ContextMenu>
        <ContextMenuTrigger disabled={isLoading || isFetching} className="w-full">
          {children}
        </ContextMenuTrigger>
        <ContextMenuContent
          className="dark:bg-panelDark w-56 overflow-y-auto bg-white"
          onContextMenu={(e) => e.preventDefault()}
        >
          {primaryActions.map(renderAction)}

          <ContextMenuSeparator className="bg-[#E7E7E7] dark:bg-[#252525]" />

          <ContextMenuSub>
            <ContextMenuSubTrigger className="font-normal">
              <Tag className="mr-2.5 h-4 w-4 opacity-60" />
              {m['common.mail.labels']()}
            </ContextMenuSubTrigger>
            <ContextMenuSubContent className="dark:bg-panelDark max-h-[520px] w-48 overflow-y-auto bg-white">
              <LabelsList threadId={threadId} bulkSelected={mail.bulkSelected} onCreateLabel={handleOpenCreateLabel} />
            </ContextMenuSubContent>
          </ContextMenuSub>

          <ContextMenuSeparator className="bg-[#E7E7E7] dark:bg-[#252525]" />

          {getActions.map(renderAction)}

          <ContextMenuSeparator className="bg-[#E7E7E7] dark:bg-[#252525]" />

          {otherActions.map(renderAction)}
        </ContextMenuContent>
      </ContextMenu>
      <SnoozeDialog
        open={snoozeOpen}
        onOpenChange={setSnoozeOpen}
        onConfirm={handleSnoozeConfirm}
      />
    </>
  );
}

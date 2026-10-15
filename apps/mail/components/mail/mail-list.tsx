import {
  Archive2,
  ExclamationCircle,
  GroupPeople,
  Star2,
  Trash,
  PencilCompose,
} from '../icons/icons';
import {
  memo,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  type ComponentProps,
  useState,
} from 'react';
import { useOptimisticThreadState } from '@/components/mail/optimistic-thread-state';
import { focusedIndexAtom, useMailNavigation } from '@/hooks/use-mail-navigation';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { useSidebar } from '@/components/ui/sidebar';
import { useIsFetching, type UseQueryResult } from '@tanstack/react-query';
import type { MailSelectMode, ParsedMessage, ThreadProps } from '@/types';
import type { ParsedDraft } from '@zero/server/driver/types';
import { ThreadContextMenu } from '@/components/context/thread-context';
import { useOptimisticActions } from '@/hooks/use-optimistic-actions';
import { useMail, type Config } from '@/components/mail/use-mail';
import { type ThreadDestination } from '@/lib/thread-actions';
import { useThread, useThreads } from '@/hooks/use-threads';
import { useSetAtom } from 'jotai';
import {
  searchResultCountAtom,
  useResetSearchValue,
  useSearchValue,
} from '@/hooks/use-search-value';
import { EmptyStateIcon } from '../icons/empty-state-svg';
import { highlightText } from '@/lib/email-utils.client';
import { mailListPlainPreview } from '@/lib/mail/mail-list-preview';
import { buildMailListVirtualRows } from '@/lib/mail/build-mail-list-virtual-rows';
import { NATIVE_VISIBLE_SCROLLBAR_CLASSES } from '@/lib/scrollbar-chrome';
import type { MailDateBucket } from '@/lib/mail/thread-date-bucket';
import { MailListSectionHeader } from '@/components/mail/mail-list-section-header';
import { cn, FOLDERS, formatThreadListDate } from '@/lib/utils';
import { useTimezone } from '@/hooks/use-timezone';
import type { FileDragData } from '@/lib/mail/file-drag';
import { useTRPC } from '@/providers/query-provider';
import { useLabels, useThreadLabels } from '@/hooks/use-labels';
import { useSettings } from '@/hooks/use-settings';
import { buildReservedSpamLabelIdSet, isReservedSpamScopedLabelId } from '@/lib/mail/route-filter';
import { useKeyState } from '@/hooks/use-hot-key';
import { useDraggable } from '@dnd-kit/core';
import { VList, type VListHandle } from 'virtua';
import { BimiAvatar } from '../ui/bimi-avatar';
import { RenderLabels } from './render-labels';
import { CenturionCategoryPill } from './centurion-category-pill';
import { LinkedThreadStubRow } from '@/components/mail/linked-thread-stub-row';
import { buildCategoryIdToSlugMap } from '@/lib/mail/hotel-folder-presentation';
import { useCategorySettings } from '@/hooks/use-categories';
import { Badge } from '@/components/ui/badge';
import { useDraft } from '@/hooks/use-drafts';
import { Check, Reply, Star } from 'lucide-react';
import { Skeleton } from '../ui/skeleton';
import { m } from '@/paraglide/messages';
import { useParams } from 'react-router';
import { Button } from '../ui/button';
import { Avatar } from '../ui/avatar';
import { useQueryState } from 'nuqs';
import { useAtom } from 'jotai';
import { resolveImportantState } from '@/lib/mail/important-ui';
import { focusThreadElement } from '@/lib/mail/mail-row-focus';
import { getMailRowSelectionClasses } from '@/lib/mail/mail-row-selection';
import { flushComposeBeforeLeave } from '@/lib/mail/compose-flush-registry';
import { runComposeLeaveFlush } from '@/lib/mail/draft-persistence';
import {
  isUnsupportedSearchOperatorError,
  mergeSearchQuery,
} from '@/lib/mail/search-list';
import { toast } from 'sonner';

function mailListSectionLabel(bucket: MailDateBucket): string {
  switch (bucket) {
    case 'pinned':
      return m['common.mail.listSection.pinned']();
    case 'today':
      return m['common.mail.listSection.today']();
    case 'yesterday':
      return m['common.mail.listSection.yesterday']();
    case 'lastWeek':
      return m['common.mail.listSection.lastWeek']();
    case 'thisMonth':
      return m['common.mail.listSection.thisMonth']();
    case 'lastMonth':
      return m['common.mail.listSection.lastMonth']();
    case 'older':
      return m['common.mail.listSection.older']();
    default: {
      const _exhaustive: never = bucket;
      return _exhaustive;
    }
  }
}

type LabelForMemo = Readonly<{
  id: string;
  name: string;
}>;

export const areMailLabelsEqual = (
  prevLabels?: readonly LabelForMemo[] | null,
  nextLabels?: readonly LabelForMemo[] | null,
) => {
  if (prevLabels === nextLabels) return true;
  if (!prevLabels || !nextLabels) {
    return (prevLabels?.length ?? 0) === (nextLabels?.length ?? 0);
  }

  if (prevLabels.length !== nextLabels.length) return false;

  for (let i = 0; i < prevLabels.length; i++) {
    const prevLabel = prevLabels[i];
    const nextLabel = nextLabels[i];

    if (prevLabel.id !== nextLabel.id || prevLabel.name !== nextLabel.name) {
      return false;
    }
  }

  return true;
};

const Thread = memo(
  function Thread({
    message,
    onClick,
    isKeyboardFocused,
    isKeyboardNavigationActive,
    index,
  }: ThreadProps & { index?: number }) {
    const [searchValue] = useSearchValue();
    const timezone = useTimezone();
    const { folder } = useParams<{ folder: string }>();
    const [, threads] = useThreads();
    const { userLabels } = useLabels();
    const reservedSpamLabelIds = useMemo(
      () => buildReservedSpamLabelIdSet(userLabels ?? []),
      [userLabels],
    );
    const [threadId] = useQueryState('threadId');
    const { data: getThreadData, isGroupThread, latestDraft } = useThread(message.id);
    const categorySettings = useCategorySettings();
    const idToSlug = useMemo(
      () => buildCategoryIdToSlugMap(categorySettings),
      [categorySettings],
    );
    const [id, setThreadId] = useQueryState('threadId');
    const [focusedIndex, setFocusedIndex] = useAtom(focusedIndexAtom);

    const { latestMessage, idToUse, cleanName } = useMemo(() => {
      const latestMessage = getThreadData?.latest;
      const idToUse = latestMessage?.threadId ?? latestMessage?.id;
      const cleanName = latestMessage?.sender?.name
        ? latestMessage.sender.name.trim().replace(/^['"]|['"]$/g, '')
        : '';

      return { latestMessage, idToUse, cleanName };
    }, [getThreadData?.latest]);

    const optimisticState = useOptimisticThreadState(idToUse ?? '');
    const { isMobile } = useSidebar();

    const {
      attributes: dragAttributes,
      listeners: dragListeners,
      setNodeRef: setDragNodeRef,
      isDragging,
    } = useDraggable({
      id: idToUse ?? message.id,
      disabled: !idToUse || isMobile,
      data: {
        type: 'mail-thread',
        threadId: idToUse ?? message.id,
        subject: latestMessage?.subject ?? null,
      } satisfies FileDragData,
    });

    const setThreadElementRef = useCallback(
      (element: HTMLDivElement | null) => {
        if (element && isKeyboardFocused) {
          focusThreadElement(element);
        }
      },
      [isKeyboardFocused],
    );

    const { displayStarred, displayImportant, displayUnread, optimisticLabels, emailContent } =
      useMemo(() => {
        const source = getThreadData?.latest?.decodedBody || getThreadData?.latest?.body || '';
        const emailContent = mailListPlainPreview(source);
        const displayStarred =
          optimisticState.optimisticStarred !== null
            ? optimisticState.optimisticStarred
            : (getThreadData?.latest?.tags?.some((tag) => tag.name === 'STARRED') ?? false);

        const displayImportant = resolveImportantState({
          optimisticImportant: optimisticState.optimisticImportant,
          latestTags: getThreadData?.latest?.tags,
          messages: getThreadData?.messages,
        });

        const displayUnread =
          optimisticState.optimisticRead !== null
            ? !optimisticState.optimisticRead
            : (getThreadData?.hasUnread ?? false);

        let labels: { id: string; name: string }[] = [];
        if (getThreadData?.labels) {
          labels = [...getThreadData.labels];
          const hasStarredLabel = labels.some((label) => label.name === 'STARRED');

          if (optimisticState.optimisticStarred !== null) {
            if (optimisticState.optimisticStarred && !hasStarredLabel) {
              labels.push({ id: 'starred-optimistic', name: 'STARRED' });
            } else if (!optimisticState.optimisticStarred && hasStarredLabel) {
              labels = labels.filter((label) => label.name !== 'STARRED');
            }
          }

          if (optimisticState.optimisticLabels) {
            labels = labels.filter(
              (label) => !optimisticState.optimisticLabels.removedLabelIds.includes(label.id),
            );

            optimisticState.optimisticLabels.addedLabelIds.forEach((labelId) => {
              if (!labels.some((label) => label.id === labelId)) {
                labels.push({ id: labelId, name: labelId });
              }
            });
          }
        }

        return {
          displayStarred,
          displayImportant,
          displayUnread,
          optimisticLabels: labels,
          emailContent,
        };
      }, [
        optimisticState.optimisticStarred,
        optimisticState.optimisticImportant,
        optimisticState.optimisticRead,
        getThreadData?.latest?.body,
        getThreadData?.latest?.decodedBody,
        getThreadData?.latest?.tags,
        getThreadData?.messages,
        getThreadData?.hasUnread,
        getThreadData?.labels,
        optimisticState.optimisticLabels,
      ]);

    const { optimisticToggleStar, optimisticToggleImportant, optimisticMoveThreadsTo } =
      useOptimisticActions();

    const handleToggleStar = useCallback(
      async (e: React.MouseEvent) => {
        e.stopPropagation();
        if (!getThreadData || !idToUse) return;

        const newStarredState = !displayStarred;
        optimisticToggleStar([idToUse], newStarredState);
      },
      [getThreadData, idToUse, displayStarred, optimisticToggleStar],
    );

    const handleToggleImportant = useCallback(
      async (e: React.MouseEvent) => {
        e.stopPropagation();
        if (!getThreadData || !idToUse) return;

        const newImportantState = !displayImportant;
        optimisticToggleImportant([idToUse], newImportantState);
      },
      [getThreadData, idToUse, displayImportant, optimisticToggleImportant],
    );

    const handleNext = useCallback(
      (id: string) => {
        if (!id || !threads.length || focusedIndex === null) return setThreadId(null);
        if (focusedIndex < threads.length - 1) {
          const nextThread = threads[focusedIndex];
          if (nextThread) {
            setThreadId(nextThread.id);
            // Don't clear activeReplyId - let ThreadDisplay handle Reply All auto-opening
            setFocusedIndex(focusedIndex);
          }
        }
      },
      [threads, id, focusedIndex],
    );

    const moveThreadTo = useCallback(
      async (destination: ThreadDestination) => {
        if (!idToUse) return;
        handleNext(idToUse);
        optimisticMoveThreadsTo([idToUse], folder ?? '', destination);
      },
      [idToUse, folder, optimisticMoveThreadsTo, handleNext],
    );

    const { labels: threadLabels } = useThreadLabels(
      optimisticLabels ? optimisticLabels.map((l) => l.id) : [],
    );

    const [mailState, setMail] = useMail();
    const { isMailSelected, isMailBulkSelected } = useMemo(() => {
      const isSelected =
        !threadId || !idToUse ? false : idToUse === threadId || threadId === mailState.selected;
      const isBulkSelected = idToUse ? mailState.bulkSelected.includes(idToUse) : false;

      return { isMailSelected: isSelected, isMailBulkSelected: isBulkSelected };
    }, [threadId, idToUse, mailState.selected, mailState.bulkSelected]);

    const { isFolderInbox, isFolderSpam, isFolderSent, isFolderBin } = useMemo(
      () => ({
        isFolderInbox: folder === FOLDERS.INBOX || !folder,
        isFolderSpam:
          folder === FOLDERS.SPAM || isReservedSpamScopedLabelId(folder, reservedSpamLabelIds),
        isFolderSent: folder === FOLDERS.SENT,
        isFolderBin: folder === FOLDERS.BIN,
      }),
      [folder, reservedSpamLabelIds],
    );

    // Check if thread has a draft
    const hasDraft = useMemo(() => {
      return !!latestDraft;
    }, [latestDraft]);

    const content = useMemo(() => {
      if (!latestMessage || !getThreadData) return null;

      return (
        <div
          ref={setDragNodeRef}
          className={cn(
            'select-none border-b md:my-1 md:border-none focus:outline-none',
            !isKeyboardNavigationActive &&
              'focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-primary/60',
            isDragging && 'opacity-40',
          )}
          onClick={onClick ? onClick(latestMessage) : undefined}
          {...dragListeners}
          {...dragAttributes}
        >
          <div
            ref={setThreadElementRef}
            data-thread-id={idToUse}
            key={idToUse}
            className={cn(
              'hover:bg-offsetLight dark:hover:bg-primary/5 group relative mx-1 flex cursor-pointer flex-col items-start rounded-lg py-2 text-left text-sm hover:opacity-100',
              getMailRowSelectionClasses({
                isMailSelected,
                isMailBulkSelected,
                isKeyboardFocused: Boolean(isKeyboardFocused),
                isKeyboardNavigationActive: Boolean(isKeyboardNavigationActive),
              }),
              'relative',
              'group',
            )}
          >
            {displayImportant ? (
              <div className="pointer-events-none absolute inset-y-2 right-0 w-1 rounded-l-sm bg-red-500/90" />
            ) : null}
            <div
              className={cn(
                'dark:bg-panelDark z-25 absolute right-2 flex -translate-y-1/2 items-center gap-1 rounded-xl border bg-white p-1 opacity-0 shadow-sm group-hover:opacity-100',
                index === 0 ? 'top-4' : 'top-[-1px]',
              )}
            >
              <Tooltip>
                <TooltipTrigger asChild>
                  <Button
                    variant="ghost"
                    size="icon"
                    className="h-6 w-6 overflow-visible [&_svg]:size-3.5"
                    onClick={handleToggleStar}
                  >
                    <Star2
                      className={cn(
                        'h-4 w-4',
                        displayStarred
                          ? 'fill-yellow-400 stroke-yellow-400'
                          : 'fill-transparent stroke-[#9D9D9D] dark:stroke-[#9D9D9D]',
                      )}
                    />
                  </Button>
                </TooltipTrigger>
                <TooltipContent
                  side={index === 0 ? 'bottom' : 'top'}
                  className="mb-1 bg-white dark:bg-[#1A1A1A]"
                >
                  {displayStarred
                    ? m['common.threadDisplay.unstar']()
                    : m['common.threadDisplay.star']()}
                </TooltipContent>
              </Tooltip>
              <Tooltip>
                <TooltipTrigger asChild>
                  <Button
                    variant="ghost"
                    size="icon"
                    className={cn(
                      'h-6 w-6 [&_svg]:size-3.5',
                      displayImportant ? 'hover:bg-orange-200/70 dark:hover:bg-orange-800/40' : '',
                    )}
                    onClick={handleToggleImportant}
                  >
                    <ExclamationCircle
                      className={cn(displayImportant ? 'fill-orange-400' : 'fill-[#9D9D9D]')}
                    />
                  </Button>
                </TooltipTrigger>
                <TooltipContent
                  side={index === 0 ? 'bottom' : 'top'}
                  className="dark:bg-panelDark mb-1 bg-white"
                >
                  {m['common.mail.toggleImportant']()}
                </TooltipContent>
              </Tooltip>
              <Tooltip>
                <TooltipTrigger asChild>
                  <Button
                    variant="ghost"
                    size="icon"
                    className="h-6 w-6 [&_svg]:size-3.5"
                    onClick={(e) => {
                      e.stopPropagation();
                      moveThreadTo('archive');
                    }}
                  >
                    <Archive2 className="fill-[#9D9D9D]" />
                  </Button>
                </TooltipTrigger>
                <TooltipContent
                  side={index === 0 ? 'bottom' : 'top'}
                  className="dark:bg-panelDark mb-1 bg-white"
                >
                  {m['common.threadDisplay.archive']()}
                </TooltipContent>
              </Tooltip>
              {!isFolderBin ? (
                <Tooltip>
                  <TooltipTrigger asChild>
                    <Button
                      variant="ghost"
                      size="icon"
                      className="h-6 w-6 hover:bg-[#FDE4E9] dark:hover:bg-[#411D23] [&_svg]:size-3.5"
                      onClick={(e: React.MouseEvent) => {
                        e.stopPropagation();
                        moveThreadTo('bin');
                      }}
                    >
                      <Trash className="fill-[#F43F5E]" />
                    </Button>
                  </TooltipTrigger>
                  <TooltipContent
                    side={index === 0 ? 'bottom' : 'top'}
                    className="dark:bg-panelDark mb-1 bg-white"
                  >
                    {m['common.actions.Bin']()}
                  </TooltipContent>
                </Tooltip>
              ) : null}
            </div>

            <div
              className={`relative flex w-full items-center justify-between gap-4 px-4 ${displayUnread ? '' : 'opacity-60'}`}
            >
              <div>
                {isMailBulkSelected ? (
                  <Avatar
                    className={cn(
                      'h-8 w-8 rounded-full',
                      displayUnread && !isMailSelected && !isFolderSent ? '' : 'border',
                    )}
                  >
                    <div
                      className="flex h-full w-full items-center justify-center rounded-full bg-[#006FFE] p-2 dark:bg-[#006FFE]"
                      onClick={(e: React.MouseEvent) => {
                        e.stopPropagation();
                        setMail((prev: Config) => ({
                          ...prev,
                          bulkSelected: prev.bulkSelected.filter((id: string) => id !== idToUse),
                        }));
                      }}
                    >
                      <Check className="h-4 w-4 text-white" />
                    </div>
                  </Avatar>
                ) : isGroupThread ? (
                  <Avatar
                    className={cn(
                      'h-8 w-8 rounded-full',
                      displayUnread && !isMailSelected && !isFolderSent ? '' : 'border',
                    )}
                  >
                    <div className="flex h-full w-full items-center justify-center rounded-full bg-[#FFFFFF] p-2 dark:bg-[#373737]">
                      <GroupPeople className="h-4 w-4" />
                    </div>
                  </Avatar>
                ) : (
                  <BimiAvatar
                    email={latestMessage.sender.email}
                    name={cleanName || latestMessage.sender.email}
                    className={cn(
                      'h-8 w-8 rounded-full',
                      displayUnread && !isMailSelected && !isFolderSent ? '' : 'border',
                    )}
                  />
                )}
                {/* {displayUnread && !isMailSelected && !isFolderSent ? (
                  <>
                    <span className="absolute left-2 top-2 size-1.5 rounded bg-[#006FFE]" />
                    <span className="absolute left-[11px] top-4 size-1 rounded bg-[#006FFE]" />
                  </>
                ) : null} */}
              </div>

              <div className="flex w-full justify-between">
                <div className="w-full">
                  <div className="flex w-full flex-row items-center justify-between">
                    <div className="flex flex-row items-center gap-[4px]">
                      <span
                        className={cn(
                          displayUnread && !isMailSelected ? 'font-bold' : 'font-medium',
                          'text-md flex items-baseline gap-1 group-hover:opacity-100',
                        )}
                      >
                        {isFolderSent ? (
                          <span
                            className={cn(
                              'overflow-hidden truncate text-sm md:max-w-[15ch] xl:max-w-[25ch]',
                            )}
                          >
                            {highlightText(latestMessage.subject, searchValue.highlight)}
                          </span>
                        ) : (
                          <div className="flex items-center gap-1">
                            <span className={cn('line-clamp-1 overflow-hidden text-sm')}>
                              {highlightText(
                                cleanNameDisplay(latestMessage.sender.name) || '',
                                searchValue.highlight,
                              )}
                            </span>
                            {displayUnread && !isMailSelected && !isFolderSent ? (
                              <>
                                <span className="ml-0.5 size-2 rounded-full bg-[#006FFE]" />
                              </>
                            ) : null}
                          </div>
                        )}{' '}
                        {/* {!isFolderSent ? (
                          <span className="hidden items-center space-x-2 md:flex">
                            <RenderLabels labels={threadLabels} />
                          </span>
                        ) : null} */}
                      </span>
                      {message.conversationMessageCount && (message.linkedThreadIds?.length ?? 0) > 0 ? (
                        <Tooltip>
                          <TooltipTrigger asChild>
                            <span className="rounded-md text-xs opacity-70">
                              [{message.conversationMessageCount}]
                            </span>
                          </TooltipTrigger>
                          <TooltipContent className="p-1 text-xs">
                            {message.conversationMessageCount} messages across{' '}
                            {(message.linkedThreadIds?.length ?? 0) + 1} linked threads
                          </TooltipContent>
                        </Tooltip>
                      ) : null}
                      {getThreadData.totalReplies > 1 &&
                      !(message.linkedThreadIds && message.linkedThreadIds.length > 0) ? (
                        <Tooltip>
                          <TooltipTrigger asChild>
                            <span className="rounded-md text-xs opacity-70">
                              [{getThreadData.totalReplies}]
                            </span>
                          </TooltipTrigger>
                          <TooltipContent className="p-1 text-xs">
                            {m['common.mail.replies']({ count: getThreadData.totalReplies })}
                          </TooltipContent>
                        </Tooltip>
                      ) : null}
                      {hasDraft ? (
                        <Tooltip>
                          <TooltipTrigger asChild>
                            <span className="inline-flex items-center">
                              <PencilCompose className="h-3 w-3 fill-blue-500 dark:fill-blue-400" />
                            </span>
                          </TooltipTrigger>
                          <TooltipContent className="p-1 text-xs">
                            {m['common.threadDisplay.draftTooltip']()}
                          </TooltipContent>
                        </Tooltip>
                      ) : null}
                      {!isFolderSent && (message.conversationResponded ?? getThreadData?.hasReplied) ? (
                        <Tooltip>
                          <TooltipTrigger asChild>
                            <span className="text-muted-foreground inline-flex items-center">
                              <Reply className="h-3 w-3" aria-hidden />
                            </span>
                          </TooltipTrigger>
                          <TooltipContent className="p-1 text-xs">
                            {m['common.threadDisplay.repliedTooltip']()}
                          </TooltipContent>
                        </Tooltip>
                      ) : null}
                      {/* {hasNotes ? (
                        <span className="inline-flex items-center">
                          <StickyNote className="h-3 w-3 fill-amber-500 stroke-amber-500 dark:fill-amber-400 dark:stroke-amber-400" />
                        </span>
                      ) : null} */}
                      <MailLabels labels={optimisticLabels} />
                    </div>
                    {latestMessage.receivedOn ? (
                      <p
                        className={cn(
                          'text-muted-foreground text-nowrap text-xs font-normal opacity-70 transition-opacity group-hover:opacity-100 dark:text-[#8C8C8C]',
                          isMailSelected && 'opacity-100',
                        )}
                      >
                        {formatThreadListDate(latestMessage.receivedOn, timezone)}
                      </p>
                    ) : null}
                  </div>
                  <div className="flex justify-between">
                    {isFolderSent ? (
                      <p
                        className={cn(
                          'mt-1 line-clamp-1 max-w-[50ch] overflow-hidden text-sm text-[#8C8C8C] md:max-w-[25ch]',
                        )}
                      >
                        {latestMessage.to.map((e) => e.email).join(', ')}
                      </p>
                    ) : (
                      <p
                        className={cn(
                          'mt-1 line-clamp-1 w-[95%] min-w-0 overflow-hidden text-sm text-[#8C8C8C]',
                        )}
                      >
                        {highlightText(latestMessage.subject, searchValue.highlight)}
                      </p>
                    )}
                    {/* <div className="hidden md:flex">
                      {getThreadData.labels ? <MailLabels labels={getThreadData.labels} /> : null}
                    </div> */}
                    {!isFolderSent ? (
                      <div className="mr-0 flex w-fit max-w-[min(100%,18rem)] shrink-0 flex-wrap items-center justify-end gap-1">
                        <CenturionCategoryPill
                          routeFolder={folder}
                          category={message.centurionCategory}
                          categoryIds={message.categoryIds}
                          idToSlug={idToSlug}
                        />
                        <RenderLabels labels={threadLabels} />
                      </div>
                    ) : null}
                  </div>
                  {emailContent && (
                    <div className="text-muted-foreground mt-2 line-clamp-2 text-xs">
                      {highlightText(emailContent, searchValue.highlight)}
                    </div>
                  )}
                  {/* {mainSearchTerm && (
                    <div className="text-muted-foreground mt-1 flex items-center gap-1 text-xs">
                      <span className="bg-primary/10 text-primary rounded px-1.5 py-0.5">
                        {mainSearchTerm}
                      </span>
                    </div>
                  )} */}
                </div>
              </div>
            </div>
          </div>
        </div>
      );
    }, [
      latestMessage,
      getThreadData,
      optimisticState,
      idToUse,
      folder,
      isFolderBin,
      isFolderSent,
      isFolderSpam,
      isFolderInbox,
      onClick,
      searchValue,
      displayUnread,
      isMailSelected,
      isMailBulkSelected,
      threadLabels,
      optimisticLabels,
      emailContent,
      message.centurionCategory,
      message.categoryIds,
      idToSlug,
      setDragNodeRef,
      dragListeners,
      dragAttributes,
      isDragging,
      isKeyboardFocused,
      isKeyboardNavigationActive,
      setThreadElementRef,
      index,
      cleanName,
      displayStarred,
      displayImportant,
      hasDraft,
      handleToggleStar,
      handleToggleImportant,
      moveThreadTo,
      setMail,
    ]);

    return latestMessage ? (
      !optimisticState.shouldHide && idToUse ? (
        <ThreadContextMenu
          threadId={idToUse}
          isInbox={isFolderInbox}
          isSpam={isFolderSpam}
          isSent={isFolderSent}
          isBin={isFolderBin}
        >
          {content}
        </ThreadContextMenu>
      ) : null
    ) : null;
  },
  (prev, next) => {
    const prevCategoryIds = prev.message.categoryIds ?? [];
    const nextCategoryIds = next.message.categoryIds ?? [];
    const isSameCategoryIds =
      prevCategoryIds.length === nextCategoryIds.length &&
      prevCategoryIds.every((id, index) => id === nextCategoryIds[index]);
    const isSameMessage =
      prev.message.id === next.message.id &&
      prev.message.centurionCategory === next.message.centurionCategory &&
      prev.message.conversationResponded === next.message.conversationResponded &&
      (prev.message.linkedThreadIds ?? []).join(',') === (next.message.linkedThreadIds ?? []).join(',') &&
      (prev.message.linkedStubs ?? []).length === (next.message.linkedStubs ?? []).length &&
      isSameCategoryIds &&
      prev.isKeyboardFocused === next.isKeyboardFocused &&
      prev.isKeyboardNavigationActive === next.isKeyboardNavigationActive &&
      prev.index === next.index &&
      Object.is(prev.onClick, next.onClick);
    return isSameMessage;
  },
);

const Draft = memo(({ message, index }: { message: { id: string }; index: number }) => {
  const draftQuery = useDraft(message.id) as UseQueryResult<ParsedDraft>;
  const draft = draftQuery.data;
  const [, setComposeOpen] = useQueryState('isComposeOpen');
  const [, setMode] = useQueryState('mode');
  const [, setActiveReplyId] = useQueryState('activeReplyId');
  const [, setDraftId] = useQueryState('draftId');
  const { optimisticDeleteDraft } = useOptimisticActions();
  const optimisticState = useOptimisticThreadState(message.id);
  const timezone = useTimezone();

  const handleMailClick = useCallback(() => {
    if (draft?.threadId) {
      setMode('reply');
      setActiveReplyId(draft.replyToMessageId ?? null);
    } else {
      setMode(null);
      setActiveReplyId(null);
    }
    setComposeOpen('true');
    setDraftId(message.id);
  }, [draft?.replyToMessageId, draft?.threadId, message.id, setMode, setActiveReplyId, setComposeOpen, setDraftId]);

  const handleDeleteDraft = useCallback(
    (e: React.MouseEvent) => {
      e.stopPropagation();
      optimisticDeleteDraft(message.id);
    },
    [message.id, optimisticDeleteDraft],
  );

  if (optimisticState.shouldHide) {
    return null;
  }

  if (!draft) {
    return (
      <div className="select-none py-1">
        <div
          key={message.id}
          className={cn(
            'group relative mx-[8px] flex cursor-pointer flex-col items-start overflow-clip rounded-[10px] border-transparent py-3 text-left text-sm',
          )}
        >
          <div
            className={cn(
              'bg-primary absolute inset-y-0 left-0 w-1 -translate-x-2 transition-transform ease-out',
            )}
          />
          <div className="flex w-full items-center justify-between gap-4 px-4">
            <div className="flex w-full justify-between">
              <div className="w-full">
                <div className="flex w-full flex-row items-center justify-between">
                  <div className="flex flex-row items-center gap-[4px]">
                    <Skeleton className="bg-muted h-4 w-32 rounded" />
                  </div>
                </div>
                <div className="flex justify-between">
                  <Skeleton className="bg-muted mt-1 h-4 w-48 rounded" />
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="select-none py-1" onClick={handleMailClick}>
      <div
        key={message.id}
        className={cn(
          'hover:bg-offsetLight dark:hover:bg-primary/5 group relative mx-[8px] flex cursor-pointer flex-col items-start overflow-visible rounded-[10px] border-transparent py-3 text-left text-sm hover:opacity-100',
        )}
      >
        <div
          className={cn(
            'dark:bg-panelDark shadow-xs absolute right-2 z-20 flex -translate-y-1/2 items-center gap-1 rounded-xl border bg-white p-1 opacity-0 group-hover:opacity-100',
            index === 0 ? 'top-4' : 'top-[-1px]',
          )}
          aria-busy={optimisticState.isRemoving}
        >
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                variant="ghost"
                size="icon"
                className="h-6 w-6 hover:bg-[#FDE4E9] dark:hover:bg-[#411D23] [&_svg]:size-3.5"
                aria-label="Delete draft"
                disabled={optimisticState.isRemoving}
                onClick={handleDeleteDraft}
              >
                <Trash className="fill-[#F43F5E]" />
              </Button>
            </TooltipTrigger>
            <TooltipContent
              side={index === 0 ? 'bottom' : 'top'}
              className="dark:bg-panelDark mb-1 bg-white"
            >
              {m['common.actions.Bin']()}
            </TooltipContent>
          </Tooltip>
        </div>
        <div className="flex w-full items-center justify-between gap-4 px-4">
          <div className="flex w-full justify-between">
            <div className="w-full">
              <div className="flex w-full flex-row items-center justify-between">
                <div className="flex flex-row items-center gap-[4px]">
                  <span
                    className={cn(
                      'font-medium',
                      'text-md flex items-baseline gap-1 group-hover:opacity-100',
                    )}
                  >
                    <span className={cn('max-w-[25ch] truncate text-sm')}>
                      {cleanNameDisplay(draft?.to?.[0] || 'No Recipient') || ''}
                    </span>
                  </span>
                </div>
                {draft?.updatedAt && (
                  <p
                    className={cn(
                      'text-muted-foreground text-nowrap text-xs font-normal opacity-70 transition-opacity group-hover:opacity-100 dark:text-[#8C8C8C]',
                    )}
                  >
                    {formatThreadListDate(draft.updatedAt, timezone)}
                  </p>
                )}
              </div>
              <div className="flex justify-between">
                <p
                  className={cn(
                    'mt-1 line-clamp-1 max-w-[50ch] text-sm text-[#8C8C8C] md:max-w-[30ch]',
                  )}
                >
                  {draft?.subject}
                </p>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
});

Draft.displayName = 'Draft';

export const MailList = memo(function MailList() {
    const { folder } = useParams<{ folder: string }>();
    const { data: settingsData } = useSettings();
    const autoReadEnabled = settingsData?.settings?.autoRead ?? true;
    const [, setThreadId] = useQueryState('threadId');
    const [, setMode] = useQueryState('mode');
    const [, setDraftId] = useQueryState('draftId');
    const [, setActiveReplyId] = useQueryState('activeReplyId');
    const [searchValue, setSearchValue] = useSearchValue();
    const resetSearchValue = useResetSearchValue();
    const [anchorIndex, setAnchorIndex] = useState<number | null>(null);
    const [collapsedSections, setCollapsedSections] = useState<Set<MailDateBucket>>(() => new Set());

    useEffect(() => {
      setCollapsedSections(new Set());
    }, [folder]);

    useEffect(() => {
      const handleKeyDown = (event: KeyboardEvent) => {
        if (event.key === 'Escape') {
          setAnchorIndex(null);
        }
      };

      window.addEventListener('keydown', handleKeyDown);

      return () => {
        window.removeEventListener('keydown', handleKeyDown);
      };
    }, [setAnchorIndex]);

    const [threadsQuery, items, , loadMore, searchList] = useThreads();
    const { refetch, isLoading, isFetching, isFetchingNextPage, hasNextPage } = threadsQuery;
    const trpc = useTRPC();
    const isFetchingMail = useIsFetching({ queryKey: trpc.mail.get.queryKey() }) > 0;
    const itemsRef = useRef(items);
    const parentRef = useRef<HTMLDivElement>(null);
    const vListRef = useRef<VListHandle>(null);

    useEffect(() => {
      itemsRef.current = items;
    }, [items]);

    // Add event listener for refresh
    useEffect(() => {
      const handleRefresh = () => {
        void refetch();
      };

      window.addEventListener('refreshMailList', handleRefresh);
      return () => window.removeEventListener('refreshMailList', handleRefresh);
    }, [refetch]);

    const handleNavigateToThread = useCallback(
      (threadId: string | null) => {
        void runComposeLeaveFlush(flushComposeBeforeLeave, async () => {
          setMode(null);
          setActiveReplyId(null);
          setDraftId(null);
        }).then(() => setThreadId(threadId));
      },
      [setMode, setActiveReplyId, setDraftId, setThreadId],
    );

    const { focusedIndex, handleMouseEnter, keyboardActive } = useMailNavigation({
      items,
      containerRef: parentRef,
      onNavigate: handleNavigateToThread,
    });

    const isKeyPressed = useKeyState();

    const getSelectMode = useCallback((): MailSelectMode => {
      const isAltPressed =
        isKeyPressed('Alt') || isKeyPressed('AltLeft') || isKeyPressed('AltRight');
      const isShiftPressed =
        isKeyPressed('Shift') || isKeyPressed('ShiftLeft') || isKeyPressed('ShiftRight');
      const isCtrlPressed = isKeyPressed('Control') || isKeyPressed('Meta');

      if (isShiftPressed && !isCtrlPressed) {
        return 'range';
      }
      if (isCtrlPressed) {
        return 'mass';
      }
      if (isAltPressed && isShiftPressed) {
        return 'selectAllBelow';
      }
      return 'single';
    }, [isKeyPressed]);

    const [, setMail] = useMail();

    const handleSelectMail = useCallback(
      (message: ParsedMessage) => {
        const itemId = message.threadId ?? message.id;
        const currentMode = getSelectMode();

        setMail((prevMail) => {
          const mail = prevMail;
          const clickedIndex = itemsRef.current.findIndex((item) => item.id === itemId);
          if (clickedIndex === -1) return mail;

          switch (currentMode) {
            case 'mass': {
              const newSelected = mail.bulkSelected.includes(itemId)
                ? mail.bulkSelected.filter((id) => id !== itemId)
                : [...mail.bulkSelected, itemId];
              return { ...mail, bulkSelected: newSelected };
            }
            case 'selectAllBelow': {
              const clickedIndex = itemsRef.current.findIndex((item) => item.id === itemId);

              if (clickedIndex !== -1) {
                const itemsBelow = itemsRef.current.slice(clickedIndex);
                const idsBelow = itemsBelow.map((item) => item.id);
                return { ...mail, bulkSelected: idsBelow };
              }
              return { ...mail, bulkSelected: [itemId] };
            }
            case 'range': {
              if (anchorIndex === null) {
                return { ...mail, bulkSelected: [itemId] };
              }
              const start = Math.min(anchorIndex, clickedIndex);
              const end = Math.max(anchorIndex, clickedIndex);
              const rangeIds = itemsRef.current.slice(start, end + 1).map((item) => item.id);
              const newSelected = [...new Set([...mail.bulkSelected, ...rangeIds])];

              return { ...mail, bulkSelected: newSelected };
            }
            default: {
              return { ...mail, bulkSelected: [itemId] };
            }
          }
        });
      },
      [getSelectMode, setMail, anchorIndex],
    );

    const [, setFocusedIndex] = useAtom(focusedIndexAtom);

    const { optimisticMarkAsRead } = useOptimisticActions();
    const handleMailClick = useCallback(
      (message: ParsedMessage) => async () => {
        const mode = getSelectMode();

        if (mode !== 'single') {
          handleMouseEnter(message.id);
          const messageThreadId = message.threadId ?? message.id;
          const clickedIndex = itemsRef.current.findIndex((item) => item.id === messageThreadId);
          if (clickedIndex !== -1 && mode !== 'range') {
            setAnchorIndex(clickedIndex);
          }
          return handleSelectMail(message);
        }

        handleMouseEnter(message.id);

        const messageThreadId = message.threadId ?? message.id;
        const clickedIndex = itemsRef.current.findIndex((item) => item.id === messageThreadId);
        setFocusedIndex(clickedIndex);
        if (message.unread && autoReadEnabled) optimisticMarkAsRead([messageThreadId], true);
        await runComposeLeaveFlush(flushComposeBeforeLeave, async () => {
          setMode(null);
          setActiveReplyId(null);
          setDraftId(null);
        });
        setThreadId(messageThreadId);
      },
      [
        getSelectMode,
        handleSelectMail,
        handleMouseEnter,
        setFocusedIndex,
        optimisticMarkAsRead,
        setThreadId,
        setDraftId,
        setMode,
        setActiveReplyId,
        autoReadEnabled,
      ],
    );

    const activeSearch = mergeSearchQuery(searchValue.value, searchValue.filters ?? []);
    const isFiltering = activeSearch.length > 0;

    const lastUnsupportedSearchErrorRef = useRef<string | null>(null);
    useEffect(() => {
      if (!activeSearch) {
        lastUnsupportedSearchErrorRef.current = null;
        return;
      }
      if (!threadsQuery.isError || !threadsQuery.error) {
        if (!threadsQuery.isError) lastUnsupportedSearchErrorRef.current = null;
        return;
      }
      if (!isUnsupportedSearchOperatorError(threadsQuery.error)) return;

      const errorKey = `${activeSearch}:${threadsQuery.error.message}`;
      if (lastUnsupportedSearchErrorRef.current === errorKey) return;

      lastUnsupportedSearchErrorRef.current = errorKey;
      toast.error(threadsQuery.error.message);
    }, [activeSearch, threadsQuery.error, threadsQuery.isError]);

    const clearFilters = () => {
      resetSearchValue();
    };

    const tryAllFolders = () => {
      setSearchValue({ ...searchValue, scope: 'all' });
    };

    const filteredItems = useMemo(() => items.filter((item) => item.id), [items]);
    const setSearchResultCount = useSetAtom(searchResultCountAtom);

    useEffect(() => {
      if (isFiltering) {
        setSearchResultCount(filteredItems.length);
      } else {
        setSearchResultCount(undefined);
      }
    }, [isFiltering, filteredItems.length, setSearchResultCount]);

    useEffect(() => {
      return () => {
        setSearchResultCount(undefined);
      };
    }, [setSearchResultCount]);

    const useDraftsList = searchList?.isValid && searchList.useDraftsList;
    const Comp = useMemo(() => (useDraftsList ? Draft : Thread), [useDraftsList]);

    const groupByDate = !isFiltering;

    const toggleSection = useCallback((bucket: MailDateBucket) => {
      setCollapsedSections((prev) => {
        const next = new Set(prev);
        if (next.has(bucket)) next.delete(bucket);
        else next.add(bucket);
        return next;
      });
    }, []);

    const virtualRows = useMemo(
      () =>
        buildMailListVirtualRows(filteredItems, new Date(), collapsedSections, {
          groupByDate,
        }),
      [filteredItems, collapsedSections, groupByDate],
    );

    const handleNavigateToLinkedThread = useCallback(
      (threadId: string) => {
        void runComposeLeaveFlush(flushComposeBeforeLeave, async () => {
          setMode(null);
          setActiveReplyId(null);
          setDraftId(null);
        }).then(() => setThreadId(threadId));
      },
      [setMode, setActiveReplyId, setDraftId, setThreadId],
    );

    const vListRenderer = useCallback(
      (index: number) => {
        const row = virtualRows[index];
        if (!row) return <></>;

        if (row.type === 'header') {
          return (
            <div key={row.key} data-mail-list-section={row.bucket}>
              <MailListSectionHeader
                label={mailListSectionLabel(row.bucket)}
                expanded={!collapsedSections.has(row.bucket)}
                onToggle={() => toggleSection(row.bucket)}
              />
            </div>
          );
        }

        if (row.type === 'linked-stub') {
          return (
            <div key={row.key}>
              <LinkedThreadStubRow
                stub={row.stub}
                onNavigate={handleNavigateToLinkedThread}
                isKeyboardFocused={focusedIndex === row.parentThreadIndex && keyboardActive}
                isKeyboardNavigationActive={keyboardActive}
              />
            </div>
          );
        }

        const isLastThread = row.threadIndex === filteredItems.length - 1;

        return (
          <div key={row.key}>
            <Comp
              message={row.message}
              isKeyboardFocused={focusedIndex === row.threadIndex && keyboardActive}
              isKeyboardNavigationActive={keyboardActive}
              index={row.threadIndex}
              onClick={handleMailClick}
            />
            {isLastThread && (isFetchingNextPage || isFetchingMail) ? (
              <div className="flex w-full justify-center py-4">
                <div className="h-4 w-4 animate-spin rounded-full border-2 border-neutral-900 border-t-transparent dark:border-white dark:border-t-transparent" />
              </div>
            ) : null}
          </div>
        );
      },
      [
        Comp,
        collapsedSections,
        filteredItems.length,
        focusedIndex,
        keyboardActive,
        handleMailClick,
        handleNavigateToLinkedThread,
        isFetchingMail,
        isFetchingNextPage,
        toggleSection,
        virtualRows,
      ],
    );

    return (
      <>
        <div
          ref={parentRef}
          className={cn(
            'hide-link-indicator flex h-full w-full',
            getSelectMode() === 'range' && 'select-none',
          )}
        >
          <>
            {isLoading ? (
              <div className="flex h-32 w-full items-center justify-center">
                <div className="h-4 w-4 animate-spin rounded-full border-2 border-neutral-900 border-t-transparent dark:border-white dark:border-t-transparent" />
              </div>
            ) : threadsQuery.isError ? (
              <div className="flex w-full items-center justify-center">
                <div className="flex flex-col items-center justify-center gap-2 text-center" role="alert">
                  <p className="text-lg">
                    {isUnsupportedSearchOperatorError(threadsQuery.error)
                      ? threadsQuery.error.message
                      : 'Unable to load search results. Please retry.'}
                  </p>
                  <Button type="button" size="sm" variant="secondary" onClick={() => void refetch()}>
                    Retry search
                  </Button>
                </div>
              </div>
            ) : !items || items.length === 0 ? (
              <div className="flex w-full items-center justify-center">
                <div className="flex flex-col items-center justify-center gap-2 text-center">
                  <EmptyStateIcon width={200} height={200} />
                  <div className="mt-5">
                    {activeSearch ? (
                      <>
                        <p className="text-lg">No emails match “{activeSearch}”</p>
                        <div className="mt-3 flex flex-wrap justify-center gap-2">
                          <Button type="button" size="sm" variant="secondary" onClick={clearFilters}>
                            Clear
                          </Button>
                          {searchValue.scope !== 'all' ? (
                            <Button type="button" size="sm" variant="outline" onClick={tryAllFolders}>
                              Try All folders
                            </Button>
                          ) : null}
                        </div>
                      </>
                    ) : (
                      <>
                        <p className="text-lg">It&apos;s empty here</p>
                        <p className="text-md text-muted-foreground dark:text-white/50">
                          Search for another email or{' '}
                          <button type="button" className="underline cursor-pointer" onClick={clearFilters}>
                            clear filters
                          </button>
                        </p>
                      </>
                    )}
                  </div>
                </div>
              </div>
            ) : (
              <div className="flex flex-1 flex-col" id="mail-list-scroll">
                <VList
                  ref={vListRef}
                  count={virtualRows.length}
                  overscan={5}
                  className={cn(
                    NATIVE_VISIBLE_SCROLLBAR_CLASSES,
                    'flex-1 overflow-x-hidden',
                  )}
                  onScroll={() => {
                    if (!vListRef.current) return;
                    const endIndex = vListRef.current.findEndIndex();
                    if (
                      virtualRows.length > 0 &&
                      endIndex >= virtualRows.length - 8 &&
                      !isLoading &&
                      !isFetchingNextPage &&
                      !isFetchingMail &&
                      hasNextPage
                    ) {
                      void loadMore();
                    }
                  }}
                >
                  {vListRenderer}
                </VList>
              </div>
            )}
          </>
        </div>
        <div className="w-full pt-2 text-center">
          {isFetching ? (
            <div className="text-center">
              <div className="mx-auto h-4 w-4 animate-spin rounded-full border-2 border-neutral-900 border-t-transparent dark:border-white dark:border-t-transparent" />
            </div>
          ) : (
            <div className="h-2" />
          )}
        </div>
      </>
    );
});

export const MailLabels = memo(
  function MailListLabels({ labels }: { labels: { id: string; name: string }[] }) {
    if (!labels?.length) return null;

    const visibleLabels = labels.filter(
      (label) => !['unread', 'inbox'].includes(label.name.toLowerCase()),
    );

    if (!visibleLabels.length) return null;

    return (
      <div className={cn('flex select-none items-center')}>
        {visibleLabels.map((label) => {
          const style = getDefaultBadgeStyle(label.name);
          if (label.name.toLowerCase() === 'notes') {
            return (
              <Tooltip key={label.id}>
                <TooltipTrigger asChild>
                  <Badge className="rounded-md bg-amber-100 p-1 text-amber-700 hover:bg-amber-200 dark:bg-amber-900/30 dark:text-amber-400">
                    {getLabelIcon(label.name)}
                  </Badge>
                </TooltipTrigger>
                <TooltipContent className="hidden px-1 py-0 text-xs">
                  {m['common.notes.title']()}
                </TooltipContent>
              </Tooltip>
            );
          }

          // Skip rendering if style is "secondary" (default case)
          if (style === 'secondary') return null;
          const content = getLabelIcon(label.name);

          return content ? (
            <Badge key={label.id} className="rounded-md p-1" variant={style}>
              {content}
            </Badge>
          ) : null;
        })}
      </div>
    );
  },
  (prev, next) => {
    return areMailLabelsEqual(prev.labels, next.labels);
  },
);

function getLabelIcon(label: string) {
  const normalizedLabel = label.toLowerCase().replace(/^category_/i, '');

  switch (normalizedLabel) {
    case 'starred':
      return <Star className="h-[12px] w-[12px] fill-yellow-400 stroke-yellow-400" />;
    default:
      return null;
  }
}

function getDefaultBadgeStyle(label: string): ComponentProps<typeof Badge>['variant'] {
  const normalizedLabel = label.toLowerCase().replace(/^category_/i, '');

  switch (normalizedLabel) {
    case 'starred':
    case 'important':
      return 'important';
    case 'promotions':
      return 'promotions';
    case 'personal':
      return 'personal';
    case 'updates':
      return 'updates';
    case 'work':
      return 'default';
    case 'forums':
      return 'forums';
    case 'notes':
      return 'secondary';
    default:
      return 'secondary';
  }
}

// Helper function to clean name display
const cleanNameDisplay = (name?: string) => {
  if (!name) return '';
  const match = name.match(/^[^\p{L}\p{N}.]*(.*?)[^\p{L}\p{N}.]*$/u);
  return match ? match[1] : name;
};

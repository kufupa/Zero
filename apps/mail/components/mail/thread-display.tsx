import {
  Archive,
  ArchiveX,
  Folders,
  Forward,
  Lightning,
  Mail,
  Printer,
  Reply,
  ReplyAll,
  Star,
  ThreeDots,
  Trash,
  X,
} from '../icons/icons';
import {
  clearReplyComposeContext,
  openReplyComposeContext,
  type ReplyComposeMode,
} from '@/lib/mail/reply-compose-context';
import {
  buildReservedSpamLabelIdSet,
  isArchiveLikeMailFolder,
  isReservedSpamScopedLabelId,
} from '@/lib/mail/route-filter';
import {
  buildThreadDraftViewModel,
  canRefreshHmsCandidate,
  hmsCandidateNotice,
} from '@/lib/mail/thread-draft-view-model';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip';
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { useOptimisticThreadState } from '@/components/mail/optimistic-thread-state';
import { ThreadAiMailsSection } from '@/components/mail/thread-ai-mails-section';
import { shouldShowOpenThreadSkeleton } from '@/lib/mail/thread-open-stability';
import { flushComposeBeforeLeave } from '@/lib/mail/compose-flush-registry';
import { orderMessagesNewestFirst } from '@/lib/mail/thread-display-order';
import { cn, FOLDERS, formatDateWithWeekdayAndTime } from '@/lib/utils';
import { ThreadDraftCard } from '@/components/mail/thread-draft-card';
import { useOptimisticActions } from '@/hooks/use-optimistic-actions';
import { sortAttachmentsForDisplay } from '@/lib/attachment-priority';
import { runComposeLeaveFlush } from '@/lib/mail/draft-persistence';
import { parseAsString, useQueryState, useQueryStates } from 'nuqs';
import type { ParsedMessage, Attachment, Sender } from '@/types';
import { resolveImportantState } from '@/lib/mail/important-ui';
import { focusedIndexAtom } from '@/hooks/use-mail-navigation';
import { navaSidePanelAtom } from '@/store/navaSidePanel';
import { formatMailboxPlain } from '@/lib/mail/mailbox-format';
import { useMutation, useQuery } from '@tanstack/react-query';
import { type ThreadDestination } from '@/lib/thread-actions';
import { handleUnsubscribe } from '@/lib/email-utils.client';
import { useThread, useThreads } from '@/hooks/use-threads';
import { EmptyStateIcon } from '../icons/empty-state-svg';
import { ScrollArea } from '@/components/ui/scroll-area';
import { isFrontendOnlyDemo } from '@/lib/demo/runtime';
import { useAnimations } from '@/hooks/use-animations';
import { AnimatePresence, motion } from 'motion/react';
import { MailDisplaySkeleton } from './mail-skeleton';
import { useTRPC } from '@/providers/query-provider';
import { useIsMobile } from '@/hooks/use-mobile';
import { Button } from '@/components/ui/button';
import { useLabels } from '@/hooks/use-labels';
import { useSession } from '@/lib/auth-client';
import { cleanHtml } from '@/lib/email-utils';
import ReplyCompose from './reply-composer';
import { NotesPanel } from './note-panel';
import { useTimezone } from '@/hooks/use-timezone';
import { m } from '@/paraglide/messages';
import MailDisplay, { ThreadAttachments } from './mail-display';
import { useParams } from 'react-router';
import { Inbox } from 'lucide-react';
import { format } from 'date-fns';
import { useAtom } from 'jotai';
import { toast } from 'sonner';

const formatFileSize = (size: number) => {
  const sizeInMB = (size / (1024 * 1024)).toFixed(2);
  return sizeInMB === '0.00' ? '' : `${sizeInMB} MB`;
};

const escapePrintHtml = (value: string) =>
  value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

const formatMailboxListForPrint = (mailboxes?: Sender[] | null) =>
  (mailboxes || []).map(formatMailboxPlain).filter(Boolean).map(escapePrintHtml).join('; ');

interface ThreadDisplayProps {
  threadParam?: any;
  onClose?: () => void;
  isMobile?: boolean;
  messages?: ParsedMessage[];
  id?: string;
}

export function ThreadDemo({ messages, isMobile }: ThreadDisplayProps) {
  const isFullscreen = false;
  return (
    <div
      className={cn(
        'flex flex-col',
        isFullscreen ? 'h-screen' : isMobile ? 'h-full' : 'h-[calc(100dvh-2rem)]',
      )}
    >
      <div
        className={cn(
          'bg-offsetLight dark:bg-offsetDark relative flex flex-col overflow-hidden duration-300',
          isMobile ? 'h-full' : 'h-full',
          !isMobile && !isFullscreen && 'rounded-r-lg',
          isFullscreen ? 'fixed inset-0 z-50' : '',
        )}
      >
        <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
          <ScrollArea className="flex-1" type="scroll">
            <div className="pb-4">
              {[...(messages || [])].reverse().map((message, index) => (
                <div
                  key={message.id}
                  className={cn('duration-200', index > 0 && 'border-border border-t')}
                >
                  <MailDisplay
                    demo
                    emailData={message}
                    isFullscreen={isFullscreen}
                    isMuted={false}
                    isLoading={false}
                    index={index}
                  />
                </div>
              ))}
            </div>
          </ScrollArea>
        </div>
      </div>
    </div>
  );
}

function ThreadActionButton({
  icon: Icon,
  label,
  onClick,
  disabled = false,
  className,
}: {
  icon: React.ComponentType<React.ComponentPropsWithRef<any>> & {
    startAnimation?: () => void;
    stopAnimation?: () => void;
  };
  label: string;
  onClick?: () => void;
  disabled?: boolean;
  className?: string;
}) {
  const iconRef = useRef<any>(null);

  return (
    <TooltipProvider delayDuration={0}>
      <Tooltip>
        <TooltipTrigger asChild>
          <Button
            disabled={disabled}
            onClick={onClick}
            variant="ghost"
            className={cn('md:h-fit md:px-2', className)}
            onMouseEnter={() => iconRef.current?.startAnimation?.()}
            onMouseLeave={() => iconRef.current?.stopAnimation?.()}
          >
            <Icon ref={iconRef} className="dark:fill-iconDark fill-iconLight" />
            <span className="sr-only">{label}</span>
          </Button>
        </TooltipTrigger>
        {/* <TooltipContent>{label}</TooltipContent> */}
      </Tooltip>
    </TooltipProvider>
  );
}
const isFullscreen = false;
export function ThreadDisplay() {
  const isMobile = useIsMobile();
  const timezone = useTimezone();
  const params = useParams<{ folder: string }>();

  const folder = params?.folder ?? 'inbox';
  const { userLabels } = useLabels();
  const reservedSpamLabelIds = useMemo(
    () => buildReservedSpamLabelIdSet(userLabels ?? []),
    [userLabels],
  );
  const [{ threadId: id, sourceMessageId }, setThreadSelection] = useQueryStates({
    threadId: parseAsString,
    sourceMessageId: parseAsString,
  });
  const {
    data: emailData,
    isLoading,
    isFetching,
    isThreadDataMismatch,
    refetch: refetchThread,
    latestDraft,
    aiDraftCandidates,
  } = useThread(id ?? null);
  const [, items] = useThreads();
  const [isStarred, setIsStarred] = useState(false);
  const [navaSidePanelOpen, setNavaSidePanelOpen] = useAtom(navaSidePanelAtom);
  const { data: session } = useSession();
  const trpc = useTRPC();
  const frontendOnlyDemo = isFrontendOnlyDemo();
  const hmsCandidateQuery = useQuery(
    trpc.ai.hmsCandidateState.queryOptions(
      { threadId: id! },
      {
        enabled: Boolean(id) && Boolean(session?.user?.id) && !frontendOnlyDemo,
        refetchInterval: (query) => {
          const state = query.state.data?.activeRun?.state;
          return state === 'queued' ||
            state === 'claimed' ||
            state === 'running' ||
            state === 'retry_wait'
            ? 1500
            : false;
        },
      },
    ),
  );
  const refreshHmsCandidate = useMutation(trpc.ai.refreshHmsCandidate.mutationOptions());

  const [navigationDirection, setNavigationDirection] = useState<'previous' | 'next' | null>(null);

  const animationsEnabled = useAnimations();

  // Collect all attachments from all messages in the thread
  const allThreadAttachments = useMemo(() => {
    if (!emailData?.messages) return [];
    const flat = emailData.messages.reduce<Attachment[]>((acc, message) => {
      if (message.attachments && message.attachments.length > 0) {
        acc.push(
          ...message.attachments.map((attachment) => ({
            ...attachment,
            messageId: message.id,
          })),
        );
      }
      return acc;
    }, []);
    return sortAttachmentsForDisplay(flat);
  }, [emailData?.messages]);

  const [mode, setMode] = useQueryState('mode');
  const [activeReplyId, setActiveReplyId] = useQueryState('activeReplyId');
  const [, setDraftId] = useQueryState('draftId');
  const [, setComposeState] = useQueryStates({
    mode: parseAsString,
    activeReplyId: parseAsString,
    draftId: parseAsString,
  });

  const clearComposeContext = useCallback(async () => {
    await runComposeLeaveFlush(flushComposeBeforeLeave, async () => {
      await clearReplyComposeContext({
        setMode,
        setActiveReplyId,
        setDraftId,
        setComposeState,
      });
    });
  }, [setMode, setActiveReplyId, setDraftId, setComposeState]);

  const openComposeForLatestMessage = useCallback(
    (nextMode: ReplyComposeMode) => {
      void openReplyComposeContext({
        mode: nextMode,
        messageId: emailData?.latest?.id ?? null,
        setMode,
        setActiveReplyId,
        setDraftId,
        setComposeState,
      });
    },
    [emailData?.latest?.id, setMode, setActiveReplyId, setDraftId, setComposeState],
  );

  const [focusedIndex, setFocusedIndex] = useAtom(focusedIndexAtom);
  const {
    optimisticMoveThreadsTo,
    optimisticToggleStar,
    optimisticToggleImportant,
    optimisticDeleteDraft,
  } = useOptimisticActions();
  const [, setIsComposeOpen] = useQueryState('isComposeOpen');
  const draftRowOptimistic = useOptimisticThreadState(
    latestDraft?.id ? latestDraft.id : '__thread_draft_none__',
  );
  const hmsState = hmsCandidateQuery.data;
  const draftVm = useMemo(() => {
    if (draftRowOptimistic.shouldHide) return null;
    // Hide draft preview while any thread composer is open (reply / reply all / forward / continue draft).
    if (mode) return null;
    return buildThreadDraftViewModel(latestDraft);
  }, [latestDraft, draftRowOptimistic.shouldHide, mode]);

  const aiDraftCandidateVms = useMemo(() => {
    if (mode) return [];
    const hmsInput = hmsState
      ? {
          outcome: hmsState.outcome,
          freshness: hmsState.freshness,
          activeRun: hmsState.activeRun,
          unresolvedFields: hmsState.unresolvedFields,
        }
      : null;
    // Prefer server HMS visible candidate when present; keep list continuity otherwise.
    if (hmsState?.visibleCandidate) {
      const vm = buildThreadDraftViewModel(hmsState.visibleCandidate as never, hmsInput);
      return vm ? [vm] : [];
    }
    return aiDraftCandidates
      .map((candidate) => buildThreadDraftViewModel(candidate, hmsInput))
      .filter((vm): vm is NonNullable<typeof vm> => vm != null);
  }, [aiDraftCandidates, mode, hmsState]);

  const handleRefreshHmsCandidate = useCallback(() => {
    if (!id) return;
    void refreshHmsCandidate
      .mutateAsync({ threadId: id })
      .then(() => {
        void hmsCandidateQuery.refetch();
        void refetchThread();
      })
      .catch(() => {
        toast.error('Failed to refresh AI draft');
      });
  }, [id, refreshHmsCandidate, hmsCandidateQuery, refetchThread]);

  const openDraftForEdit = useCallback(() => {
    if (!latestDraft?.id || !emailData?.latest?.id) return;
    void setComposeState({
      mode: 'reply',
      activeReplyId: emailData.latest.id,
      draftId: latestDraft.id,
    });
  }, [latestDraft?.id, emailData?.latest?.id, setComposeState]);

  const handleDeleteThreadDraft = useCallback(() => {
    if (!latestDraft?.id) return;
    optimisticDeleteDraft(latestDraft.id);
  }, [latestDraft?.id, optimisticDeleteDraft]);

  // Get optimistic state for this thread
  const optimisticState = useOptimisticThreadState(id ?? '');
  const isImportant = useMemo(
    () =>
      resolveImportantState({
        optimisticImportant: optimisticState.optimisticImportant,
        latestTags: emailData?.latest?.tags,
        messages: emailData?.messages,
      }),
    [optimisticState.optimisticImportant, emailData?.latest?.tags, emailData?.messages],
  );

  const handleNext = useCallback(async () => {
    if (!id || !items.length || focusedIndex === null) {
      return setThreadSelection({ threadId: null, sourceMessageId: null });
    }
    if (focusedIndex < items.length - 1) {
      const nextIndex = Math.max(1, focusedIndex + 1);
      //   console.log('nextIndex', nextIndex);

      const nextThread = items[nextIndex];
      if (nextThread) {
        await clearComposeContext();
        setThreadSelection({ threadId: nextThread.id, sourceMessageId: null });
        setFocusedIndex(focusedIndex + 1);
        if (animationsEnabled) {
          setNavigationDirection('next');
        }
      }
    }
  }, [
    items,
    id,
    focusedIndex,
    setThreadSelection,
    setFocusedIndex,
    clearComposeContext,
    animationsEnabled,
  ]);

  const handleUnsubscribeProcess = () => {
    if (!emailData?.latest) return;
    toast.promise(handleUnsubscribe({ emailData: emailData.latest }), {
      success: 'Unsubscribed successfully!',
      error: 'Failed to unsubscribe',
    });
  };

  const isInArchive = isArchiveLikeMailFolder(folder, reservedSpamLabelIds);
  const isInSpam =
    folder === FOLDERS.SPAM || isReservedSpamScopedLabelId(folder, reservedSpamLabelIds);
  const isInBin = folder === FOLDERS.BIN;
  const handleClose = useCallback(async () => {
    await clearComposeContext();
    setThreadSelection({ threadId: null, sourceMessageId: null });
  }, [setThreadSelection, clearComposeContext]);

  const moveThreadTo = useCallback(
    async (destination: ThreadDestination) => {
      if (!id) return;

      await clearComposeContext();

      optimisticMoveThreadsTo([id], folder, destination);
      await handleNext();
    },
    [id, folder, optimisticMoveThreadsTo, handleNext, clearComposeContext],
  );

  const handleToggleStar = useCallback(async () => {
    if (!emailData || !id) return;

    const newStarredState = !isStarred;
    optimisticToggleStar([id], newStarredState);
    setIsStarred(newStarredState);
  }, [emailData, id, isStarred, optimisticToggleStar]);

  const printThread = () => {
    try {
      // Create a hidden iframe for printing
      const printFrame = document.createElement('iframe');
      printFrame.style.position = 'absolute';
      printFrame.style.top = '-9999px';
      printFrame.style.left = '-9999px';
      printFrame.style.width = '0px';
      printFrame.style.height = '0px';
      printFrame.style.border = 'none';

      document.body.appendChild(printFrame);

      // Generate clean, simple HTML content for printing
      const printContent = `
      <!DOCTYPE html>
      <html>
        <head>
          <meta charset="utf-8">
          <title>Print Thread - ${escapePrintHtml(emailData?.latest?.subject || 'No Subject')}</title>
          <style>
            * {
              margin: 0;
              padding: 0;
              box-sizing: border-box;
            }

            body {
              font-family: Arial, sans-serif;
              line-height: 1.5;
              color: #333;
              background: white;
              padding: 20px;
              font-size: 12px;
            }

            .email-container {
              max-width: 100%;
              margin: 0 auto;
              background: white;
            }

            .email-header {
              margin-bottom: 25px;
            }

            .email-title {
              font-size: 18px;
              font-weight: bold;
              color: #000;
              margin-bottom: 15px;
              word-wrap: break-word;
            }

            .email-meta {
              margin-bottom: 20px;
            }

            .meta-row {
              margin-bottom: 5px;
              display: flex;
              align-items: flex-start;
            }

            .meta-label {
              font-weight: bold;
              min-width: 60px;
              color: #333;
              margin-right: 10px;
            }

            .meta-value {
              flex: 1;
              word-wrap: break-word;
              color: #333;
            }

            .separator {
              width: 100%;
              height: 1px;
              background: #ddd;
              margin: 20px 0;
            }

            .email-body {
              margin: 20px 0;
              background: white;
            }

            .email-content {
              word-wrap: break-word;
              overflow-wrap: break-word;
              font-size: 12px;
              line-height: 1.6;
            }

            .email-content img {
              max-width: 100% !important;
              height: auto !important;
              display: block;
              margin: 10px 0;
            }

            .email-content table {
              width: 100%;
              border-collapse: collapse;
              margin: 10px 0;
            }

            .email-content td, .email-content th {
              padding: 6px;
              text-align: left;
              font-size: 11px;
            }

            .email-content a {
              color: #0066cc;
              text-decoration: underline;
            }

            .attachments-section {
              margin-top: 25px;
              background: white;
            }

            .attachments-title {
              font-size: 14px;
              font-weight: bold;
              color: #000;
              margin-bottom: 10px;
            }

            .attachment-item {
              margin-bottom: 5px;
              font-size: 11px;
              padding: 3px 0;
            }

            .attachment-name {
              font-weight: 500;
              color: #333;
            }

            .attachment-size {
              color: #666;
              font-size: 10px;
            }

            .labels-section {
              margin: 10px 0;
            }

            .label-badge {
              display: inline-block;
              padding: 2px 6px;
              background: #f5f5f5;
              color: #333;
              font-size: 10px;
              margin-right: 5px;
              margin-bottom: 3px;
            }

            @media print {
              body {
                margin: 0;
                padding: 15px;
                font-size: 11px;
                -webkit-print-color-adjust: exact;
                print-color-adjust: exact;
              }

              .email-container {
                max-width: none;
                width: 100%;
              }

              .separator {
                background: #000 !important;
              }

              .email-content a {
                color: #000 !important;
              }

              .label-badge {
                background: #f0f0f0 !important;
                border: 1px solid #ccc;
              }

              .no-print {
                display: none !important;
              }

              * {
                border: none !important;
                box-shadow: none !important;
              }

              .email-header {
                page-break-after: avoid;
              }

              .attachments-section {
                page-break-inside: avoid;
              }
            }

            @page {
              margin: 0.5in;
              size: A4;
            }
          </style>
        </head>
        <body>
          ${emailData?.messages
            ?.map(
              (message, index) => `
            <div class="email-container">
              <div class="email-header">
                ${index === 0 ? `<h1 class="email-title">${escapePrintHtml(message.subject || 'No Subject')}</h1>` : ''}


                ${
                  message?.tags && message.tags.length > 0
                    ? `
                  <div class="labels-section">
                    ${message.tags
                      .map((tag) => `<span class="label-badge">${tag.name}</span>`)
                      .join('')}
                  </div>
                `
                    : ''
                }


                <div class="email-meta">
                  <div class="meta-row">
                    <span class="meta-label">From:</span>
                    <span class="meta-value">
                      ${escapePrintHtml(formatMailboxPlain(message.sender))}
                    </span>
                  </div>


                  ${
                    message.to && message.to.length > 0
                      ? `
                    <div class="meta-row">
                      <span class="meta-label">To:</span>
                      <span class="meta-value">
                        ${formatMailboxListForPrint(message.to)}
                      </span>
                    </div>
                  `
                      : ''
                  }


                  ${
                    message.cc && message.cc.length > 0
                      ? `
                    <div class="meta-row">
                      <span class="meta-label">CC:</span>
                      <span class="meta-value">
                        ${formatMailboxListForPrint(message.cc)}
                      </span>
                    </div>
                  `
                      : ''
                  }


                  ${
                    message.bcc && message.bcc.length > 0
                      ? `
                    <div class="meta-row">
                      <span class="meta-label">BCC:</span>
                      <span class="meta-value">
                        ${formatMailboxListForPrint(message.bcc)}
                      </span>
                    </div>
                  `
                      : ''
                  }


                  <div class="meta-row">
                    <span class="meta-label">Date:</span>
                    <span class="meta-value">${format(new Date(message.receivedOn), 'PPpp')}</span>
                  </div>
                </div>
              </div>

              <div class="separator"></div>

              <div class="email-body">
                <div class="email-content">
                  ${cleanHtml(message.decodedBody ?? '<p><em>No email content available</em></p>')}
                </div>
              </div>


              ${
                message.attachments && message.attachments.length > 0
                  ? `
                <div class="attachments-section">
                  <h2 class="attachments-title">Attachments (${message.attachments.length})</h2>
                  ${message.attachments
                    .map(
                      (attachment) => `
                    <div class="attachment-item">
                      <span class="attachment-name">${attachment.filename}</span>
                      ${formatFileSize(attachment.size) ? ` - <span class="attachment-size">${formatFileSize(attachment.size)}</span>` : ''}
                    </div>
                  `,
                    )
                    .join('')}
                </div>
              `
                  : ''
              }
            </div>
            ${index < emailData.messages.length - 1 ? '<div class="separator"></div>' : ''}
          `,
            )
            .join('')}
        </body>
      </html>
    `;

      // Write content to the iframe
      const iframeDoc = printFrame.contentDocument || printFrame.contentWindow?.document;
      if (!iframeDoc) {
        throw new Error('Could not access iframe document');
      }
      iframeDoc.open();
      iframeDoc.write(printContent);
      iframeDoc.close();

      // Wait for content to load, then print
      printFrame.onload = function () {
        setTimeout(() => {
          try {
            // Focus the iframe and print
            printFrame.contentWindow?.focus();
            printFrame.contentWindow?.print();

            // Clean up - remove the iframe after a delay
            setTimeout(() => {
              if (printFrame && printFrame.parentNode) {
                document.body.removeChild(printFrame);
              }
            }, 1000);
          } catch (error) {
            console.error('Error during print:', error);
            // Clean up on error
            if (printFrame && printFrame.parentNode) {
              document.body.removeChild(printFrame);
            }
          }
        }, 500);
      };
    } catch (error) {
      console.error('Error printing thread:', error);
      toast.error('Failed to print thread. Please try again.');
    }
  };

  const handleToggleImportant = useCallback(async () => {
    if (!emailData || !id || isImportant) return;
    optimisticToggleImportant([id], true);
    if (!frontendOnlyDemo) {
      await refetchThread();
    }
  }, [emailData, id, isImportant, optimisticToggleImportant, frontendOnlyDemo, refetchThread]);

  // Set initial star state based on email data
  useEffect(() => {
    if (emailData?.latest?.tags) {
      // Check if any tag has the name 'STARRED'
      setIsStarred(emailData.latest.tags.some((tag) => tag.name === 'STARRED'));
    }
  }, [emailData?.latest?.tags]);

  useEffect(() => {
    if (optimisticState.optimisticStarred !== null) {
      setIsStarred(optimisticState.optimisticStarred);
    }
  }, [optimisticState.optimisticStarred]);

  //   // Automatically open Reply All composer when email thread is loaded
  //   useEffect(() => {
  //     if (emailData?.latest?.id) {
  //       // Small delay to ensure other effects have completed
  //       const timer = setTimeout(() => {
  //         setMode('replyAll');
  //         setActiveReplyId(emailData.latest!.id);
  //       }, 50);

  //       return () => clearTimeout(timer);
  //     }
  //   }, [emailData?.latest?.id, setMode, setActiveReplyId]);

  // Removed conflicting useEffect that was clearing activeReplyId

  const handleAnimationComplete = useCallback(() => {
    setNavigationDirection(null);
  }, [setNavigationDirection]);

  const shouldShowSkeleton = shouldShowOpenThreadSkeleton({
    hasEmailData: Boolean(emailData),
    isLoading,
    isFetching,
    isThreadDataMismatch,
  });

  const threadDraftSection =
    draftVm || aiDraftCandidateVms.length > 0 ? (
      <ThreadAiMailsSection>
        {draftVm ? (
          <ThreadDraftCard
            subject={draftVm.subject}
            bodyPreview={draftVm.bodyPreview}
            savedAtLabel={
              m['common.threadDisplay.draftSavedPrefix']() +
              formatDateWithWeekdayAndTime(draftVm.savedAtIso, timezone)
            }
            draftBadge={m['common.threadDisplay.draftBadge']()}
            unsentNotice={m['common.threadDisplay.draftUnsentNotice']()}
            emptyPreviewLabel={m['common.threadDisplay.draftEmptyPreview']()}
            editLabel={m['common.threadDisplay.continueDraft']()}
            deleteLabel={m['common.actions.Bin']()}
            moreLabel={m['common.threadDisplay.draftMoreOptions']()}
            onEdit={openDraftForEdit}
            onDelete={handleDeleteThreadDraft}
          />
        ) : null}
        {aiDraftCandidateVms.map((candidateVm) => {
          const notice =
            hmsCandidateNotice(candidateVm) ??
            'AI candidate — human review required. Open the reply editor to review before sending.';
          const refreshPending =
            candidateVm.refreshState === 'queued' ||
            candidateVm.refreshState === 'claimed' ||
            candidateVm.refreshState === 'running' ||
            candidateVm.refreshState === 'retry_wait';
          return (
            <div
              key={candidateVm.id}
              data-ai-draft-card
              data-ai-draft-id={candidateVm.id}
              data-ai-freshness={candidateVm.freshness ?? 'unknown'}
              data-ai-refresh-state={candidateVm.refreshState ?? 'idle'}
            >
              <ThreadDraftCard
                subject={candidateVm.subject}
                bodyPreview={candidateVm.bodyPreview}
                savedAtLabel={
                  m['common.threadDisplay.draftSavedPrefix']() +
                  formatDateWithWeekdayAndTime(candidateVm.savedAtIso, timezone)
                }
                draftBadge="AI draft"
                unsentNotice={notice}
                emptyPreviewLabel={m['common.threadDisplay.draftEmptyPreview']()}
                editLabel={m['common.threadDisplay.continueDraft']()}
                deleteLabel={m['common.actions.Bin']()}
                moreLabel={m['common.threadDisplay.draftMoreOptions']()}
                isReadOnly
                refreshLabel="Refresh AI draft"
                onRefresh={handleRefreshHmsCandidate}
                canRefresh={canRefreshHmsCandidate(candidateVm)}
                refreshPending={refreshPending || refreshHmsCandidate.isPending}
                reviewRequired
              />
            </div>
          );
        })}
      </ThreadAiMailsSection>
    ) : null;

  return (
    <div
      className={cn(
        'flex flex-col',
        isFullscreen ? 'h-screen' : isMobile ? 'h-full' : 'h-[calc(100dvh-19px)] rounded-xl',
      )}
    >
      <div
        className={cn(
          'bg-panelLight dark:bg-panelDark relative flex flex-col overflow-hidden rounded-xl duration-300',
          isMobile ? 'h-full' : 'h-full',
          !isMobile && !isFullscreen && 'rounded-r-lg',
          isFullscreen ? 'fixed inset-0 z-50' : '',
        )}
      >
        {!id ? (
          <div className="flex h-full items-center justify-center">
            <div className="flex flex-col items-center justify-center gap-2 text-center">
              <EmptyStateIcon width={200} height={200} />
              <div className="mt-4">
                <p className="text-lg">It's empty here</p>
                <p className="text-md text-muted-foreground dark:text-white/50">
                  Choose an email to view details
                </p>
                <div className="mt-4">
                  <button
                    onClick={() => setIsComposeOpen('true')}
                    className="inline-flex h-7 cursor-pointer items-center justify-center gap-0.5 overflow-hidden rounded-lg border bg-white px-2 transition-colors hover:bg-gray-100 dark:border-none dark:bg-[#313131] dark:hover:bg-[#404040]"
                  >
                    <Mail className="mr-1 h-3.5 w-3.5 fill-[#959595]" />
                    <div className="flex items-center justify-center gap-2.5 px-0.5">
                      <div className="dark:text-base-gray-950 justify-start text-sm leading-none">
                        Send email
                      </div>
                    </div>
                  </button>
                </div>
              </div>
            </div>
          </div>
        ) : shouldShowSkeleton ? (
          <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
            <ScrollArea className="h-full flex-1" type="auto">
              <div className="pb-4">
                <MailDisplaySkeleton isFullscreen={isFullscreen} />
              </div>
            </ScrollArea>
          </div>
        ) : (
          <>
            <div
              className={cn(
                'flex min-w-0 shrink-0 flex-wrap items-center px-1 pb-[10px] md:px-3 md:pb-[11px] md:pt-[12px]',
                isMobile && 'bg-panelLight dark:bg-panelDark sticky top-0 z-10 mt-2',
              )}
            >
              <div className="flex min-w-0 flex-1 items-center gap-2">
                <TooltipProvider delayDuration={0}>
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <button
                        onClick={handleClose}
                        className="inline-flex h-7 w-7 items-center justify-center gap-1 overflow-hidden rounded-md hover:bg-white md:hidden dark:hover:bg-[#313131]"
                      >
                        <X className="fill-iconLight dark:fill-iconDark h-3.5 w-3.5" />
                      </button>
                    </TooltipTrigger>
                    <TooltipContent side="bottom" className="bg-white dark:bg-[#313131]">
                      {m['common.actions.close']()}
                    </TooltipContent>
                  </Tooltip>
                </TooltipProvider>
                <ThreadActionButton
                  icon={X}
                  label={m['common.actions.close']()}
                  onClick={handleClose}
                  className="hidden md:flex"
                />
              </div>
              <div className="flex w-full min-w-0 flex-wrap items-center justify-end gap-2">
                <div
                  role="group"
                  aria-label="Thread reply actions"
                  className="flex min-w-0 flex-wrap items-center gap-1"
                >
                  <button
                    type="button"
                    aria-label={m['common.mail.reply']()}
                    onClick={(e) => {
                      e.stopPropagation();
                      openComposeForLatestMessage('reply');
                    }}
                    className="inline-flex h-7 cursor-pointer items-center justify-center gap-1 overflow-hidden rounded-lg border bg-white px-1.5 transition-colors hover:bg-gray-100 dark:border-none dark:bg-[#313131] dark:hover:bg-[#404040]"
                  >
                    <Reply className="fill-muted-foreground dark:fill-[#9B9B9B]" />
                    <span className="hidden whitespace-nowrap text-sm leading-none text-black md:inline dark:text-white">
                      {m['common.mail.reply']()}
                    </span>
                  </button>
                  <button
                    type="button"
                    aria-label={m['common.threadDisplay.replyAll']()}
                    onClick={(e) => {
                      e.stopPropagation();
                      openComposeForLatestMessage('replyAll');
                    }}
                    className="inline-flex h-7 cursor-pointer items-center justify-center gap-1 overflow-hidden rounded-lg border bg-white px-1.5 transition-colors hover:bg-gray-100 dark:border-none dark:bg-[#313131] dark:hover:bg-[#404040]"
                  >
                    <ReplyAll className="fill-muted-foreground dark:fill-[#9B9B9B]" />
                    <span className="hidden whitespace-nowrap text-sm leading-none text-black md:inline dark:text-white">
                      {m['common.threadDisplay.replyAll']()}
                    </span>
                  </button>
                  <button
                    type="button"
                    aria-label={m['common.mail.forward']()}
                    onClick={(e) => {
                      e.stopPropagation();
                      openComposeForLatestMessage('forward');
                    }}
                    className="inline-flex h-7 cursor-pointer items-center justify-center gap-1 overflow-hidden rounded-lg border bg-white px-1.5 transition-colors hover:bg-gray-100 dark:border-none dark:bg-[#313131] dark:hover:bg-[#404040]"
                  >
                    <Forward className="fill-muted-foreground dark:fill-[#9B9B9B]" />
                    <span className="hidden whitespace-nowrap text-sm leading-none text-black md:inline dark:text-white">
                      {m['common.mail.forward']()}
                    </span>
                  </button>
                </div>
                <button
                  type="button"
                  aria-pressed={navaSidePanelOpen}
                  title={navaSidePanelOpen ? 'Hide the Nava panel' : 'Show the Nava panel'}
                  onClick={() => setNavaSidePanelOpen(!navaSidePanelOpen)}
                  className="hidden h-7 cursor-pointer items-center justify-center overflow-hidden rounded-lg border bg-white px-2 text-sm leading-none text-black transition-colors hover:bg-gray-100 aria-pressed:bg-gray-100 lg:inline-flex dark:border-none dark:bg-[#313131] dark:text-white dark:hover:bg-[#404040] dark:aria-pressed:bg-[#404040]"
                >
                  Nava
                </button>
                <NotesPanel threadId={id} />
                <TooltipProvider delayDuration={0}>
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <button
                        onClick={handleToggleStar}
                        className="inline-flex h-7 w-7 cursor-pointer items-center justify-center gap-1 overflow-hidden rounded-lg bg-white transition-colors hover:bg-gray-100 dark:bg-[#313131] dark:hover:bg-[#404040]"
                      >
                        <Star
                          className={cn(
                            'ml-[2px] mt-[2.4px] h-5 w-5',
                            isStarred
                              ? 'fill-yellow-400 stroke-yellow-400'
                              : 'fill-transparent stroke-[#9D9D9D] dark:stroke-[#9D9D9D]',
                          )}
                        />
                      </button>
                    </TooltipTrigger>
                    <TooltipContent side="bottom" className="bg-white dark:bg-[#313131]">
                      {isStarred
                        ? m['common.threadDisplay.unstar']()
                        : m['common.threadDisplay.star']()}
                    </TooltipContent>
                  </Tooltip>
                </TooltipProvider>

                <TooltipProvider delayDuration={0}>
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <button
                        onClick={() => moveThreadTo('archive')}
                        className="inline-flex h-7 w-7 cursor-pointer items-center justify-center gap-1 overflow-hidden rounded-lg bg-white transition-colors hover:bg-gray-100 dark:bg-[#313131] dark:hover:bg-[#404040]"
                      >
                        <Archive className="fill-iconLight dark:fill-iconDark" />
                      </button>
                    </TooltipTrigger>
                    <TooltipContent side="bottom" className="bg-white dark:bg-[#313131]">
                      {m['common.threadDisplay.archive']()}
                    </TooltipContent>
                  </Tooltip>
                </TooltipProvider>

                {!isInBin && (
                  <TooltipProvider delayDuration={0}>
                    <Tooltip>
                      <TooltipTrigger asChild>
                        <button
                          onClick={() => moveThreadTo('bin')}
                          className="inline-flex h-7 w-7 cursor-pointer items-center justify-center gap-1 overflow-hidden rounded-lg border border-[#FCCDD5] bg-[#FDE4E9] transition-colors hover:bg-[#fccdd5]/70 dark:border-[#6E2532] dark:bg-[#411D23] dark:hover:bg-[#6E2532]/70"
                        >
                          <Trash className="fill-[#F43F5E]" />
                        </button>
                      </TooltipTrigger>
                      <TooltipContent side="bottom" className="bg-white dark:bg-[#313131]">
                        {m['common.mail.moveToBin']()}
                      </TooltipContent>
                    </Tooltip>
                  </TooltipProvider>
                )}

                <DropdownMenu>
                  <DropdownMenuTrigger asChild>
                    <button
                      type="button"
                      aria-label="Thread actions"
                      aria-haspopup="menu"
                      className="focus:outline-hidden inline-flex h-7 w-7 cursor-pointer items-center justify-center gap-1 overflow-hidden rounded-lg bg-white transition-colors focus:ring-0 dark:bg-[#313131]"
                    >
                      <ThreeDots className="fill-iconLight dark:fill-iconDark" />
                    </button>
                  </DropdownMenuTrigger>
                  <DropdownMenuContent align="end" className="bg-white dark:bg-[#313131]">
                    {/* <DropdownMenuItem onClick={() => setIsFullscreen(!isFullscreen)}>
                      <Expand className="fill-iconLight dark:fill-iconDark mr-2" />
                      <span>
                        {isFullscreen
                          ? t('common.threadDisplay.exitFullscreen')
                          : t('common.threadDisplay.enterFullscreen')}
                      </span>
                    </DropdownMenuItem> */}

                    {isInSpam || isInArchive || isInBin ? (
                      <DropdownMenuItem onClick={() => moveThreadTo('inbox')}>
                        <Inbox className="mr-2 h-4 w-4" />
                        <span>{m['common.mail.moveToInbox']()}</span>
                      </DropdownMenuItem>
                    ) : (
                      <>
                        <DropdownMenuItem
                          onClick={(e) => {
                            e.stopPropagation();
                            printThread();
                          }}
                        >
                          <Printer className="fill-iconLight dark:fill-iconDark mr-2 h-4 w-4" />
                          <span>{m['common.threadDisplay.printThread']()}</span>
                        </DropdownMenuItem>
                        <DropdownMenuItem onClick={() => moveThreadTo('spam')}>
                          <ArchiveX className="fill-iconLight dark:fill-iconDark mr-2" />
                          <span>{m['common.threadDisplay.moveToSpam']()}</span>
                        </DropdownMenuItem>
                        {emailData?.latest?.listUnsubscribe ||
                        emailData?.latest?.listUnsubscribePost ? (
                          <DropdownMenuItem onClick={handleUnsubscribeProcess}>
                            <Folders className="fill-iconLight dark:fill-iconDark mr-2" />
                            <span>{m['common.mailDisplay.unsubscribe']()}</span>
                          </DropdownMenuItem>
                        ) : null}
                      </>
                    )}
                    {!isImportant && (
                      <DropdownMenuItem onClick={handleToggleImportant}>
                        <Lightning className="fill-iconLight dark:fill-iconDark mr-2" />
                        {m['common.mail.markAsImportant']()}
                      </DropdownMenuItem>
                    )}
                  </DropdownMenuContent>
                </DropdownMenu>
              </div>
            </div>
            <div className={cn('flex min-h-0 flex-1 flex-col', isMobile && 'h-full')}>
              {animationsEnabled ? (
                <AnimatePresence mode="wait" initial={false}>
                  <motion.div
                    key={id}
                    initial={{
                      opacity: 0,
                      x:
                        navigationDirection === 'previous'
                          ? -25
                          : navigationDirection === 'next'
                            ? 25
                            : 0,
                    }}
                    animate={{
                      opacity: 1,
                      x: 0,
                    }}
                    exit={{
                      opacity: 0,
                      x:
                        navigationDirection === 'previous'
                          ? 25
                          : navigationDirection === 'next'
                            ? -25
                            : 0,
                    }}
                    transition={{
                      duration: 0.08,
                      ease: [0.4, 0, 0.2, 1],
                    }}
                    onAnimationComplete={handleAnimationComplete}
                    className="h-full w-full"
                  >
                    <MessageList
                      messages={emailData?.messages ?? []}
                      sourceMessageId={sourceMessageId}
                      isFullscreen={isFullscreen}
                      totalReplies={emailData?.totalReplies}
                      allThreadAttachments={allThreadAttachments}
                      mode={mode || undefined}
                      activeReplyId={activeReplyId || undefined}
                      isMobile={isMobile}
                      leading={threadDraftSection}
                      linkedThreadIds={emailData?.linkedThreadIds}
                      conversationMessageCount={emailData?.conversationMessageCount}
                      onOpenLinkedThread={(threadId) => {
                        void clearComposeContext().then(() =>
                          setThreadSelection({ threadId, sourceMessageId: null }),
                        );
                      }}
                    />
                  </motion.div>
                </AnimatePresence>
              ) : (
                <MessageList
                  messages={emailData?.messages ?? []}
                  sourceMessageId={sourceMessageId}
                  isFullscreen={isFullscreen}
                  totalReplies={emailData?.totalReplies}
                  allThreadAttachments={allThreadAttachments}
                  mode={mode || undefined}
                  activeReplyId={activeReplyId || undefined}
                  isMobile={isMobile}
                  leading={threadDraftSection}
                  linkedThreadIds={emailData?.linkedThreadIds}
                  conversationMessageCount={emailData?.conversationMessageCount}
                  onOpenLinkedThread={(threadId) => {
                    void clearComposeContext().then(() =>
                      setThreadSelection({ threadId, sourceMessageId: null }),
                    );
                  }}
                />
              )}
            </div>
          </>
        )}
      </div>
    </div>
  );
}

interface MessageListProps {
  messages: ParsedMessage[];
  sourceMessageId?: string | null;
  isFullscreen: boolean;
  totalReplies?: number;
  allThreadAttachments?: Attachment[];
  mode?: string;
  activeReplyId?: string;
  isMobile: boolean;
  leading?: ReactNode;
  linkedThreadIds?: readonly string[];
  conversationMessageCount?: number;
  onOpenLinkedThread?: (threadId: string) => void;
}

const MessageList = ({
  messages,
  sourceMessageId,
  isFullscreen,
  totalReplies,
  allThreadAttachments,
  mode,
  activeReplyId,
  isMobile,
  leading,
  linkedThreadIds,
  conversationMessageCount,
  onOpenLinkedThread,
}: MessageListProps) => {
  const timezone = useTimezone();
  const displayMessages = orderMessagesNewestFirst(messages || []);
  const sourceMessageRef = useRef<HTMLDivElement>(null);
  const linkedThreadCount = (linkedThreadIds?.length ?? 0) + 1;

  useEffect(() => {
    if (!sourceMessageId || !messages.some((message) => message.id === sourceMessageId)) return;
    const selectedMessage = sourceMessageRef.current;
    if (!selectedMessage) return;
    selectedMessage.focus({ preventScroll: true });
    selectedMessage.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }, [messages, sourceMessageId]);

  return (
    <ScrollArea
      className={cn('min-w-0 flex-1', isMobile ? 'h-[calc(100%-1px)]' : 'h-full')}
      type="auto"
    >
      <div className="min-w-0 pb-4">
        {linkedThreadIds && linkedThreadIds.length > 0 ? (
          <div className="border-border bg-muted/30 text-muted-foreground mx-4 mb-3 rounded-lg border px-3 py-2 text-sm">
            <p className="text-foreground font-medium">
              Linked conversation ({linkedThreadCount} threads)
            </p>
            {conversationMessageCount ? (
              <p className="mt-1 text-xs">
                {conversationMessageCount} messages across linked threads
              </p>
            ) : null}
            {onOpenLinkedThread ? (
              <div className="mt-2 flex flex-wrap gap-2">
                {[
                  ...new Set([
                    ...(linkedThreadIds ?? []),
                    ...displayMessages.map((m) => m.threadId).filter(Boolean),
                  ]),
                ].map((threadId) =>
                  threadId ? (
                    <button
                      key={threadId}
                      type="button"
                      className="text-primary text-xs hover:underline"
                      onClick={() => onOpenLinkedThread(threadId)}
                    >
                      Open thread {threadId.slice(0, 8)}
                    </button>
                  ) : null,
                )}
              </div>
            ) : null}
          </div>
        ) : null}
        {allThreadAttachments && allThreadAttachments.length > 0 ? (
          <div className="min-w-0 w-full max-w-full px-4">
            <ThreadAttachments attachments={allThreadAttachments} />
          </div>
        ) : null}
        {leading ? (
          <div className={cn('duration-200', displayMessages.length > 0 && 'border-border border-b')}>
            {leading}
          </div>
        ) : null}
        {displayMessages.map((message, index) => {
          const isReplyingToThisMessage = Boolean(mode && activeReplyId === message.id);
          const isSelectedSourceMessage = message.id === sourceMessageId;
          const previousMessage = displayMessages[index - 1];
          const showThreadDivider =
            index > 0 &&
            Boolean(message.threadId) &&
            message.threadId !== previousMessage?.threadId;

          return (
            <div
              key={message.id}
              ref={isSelectedSourceMessage ? sourceMessageRef : undefined}
              tabIndex={isSelectedSourceMessage ? -1 : undefined}
              aria-current={isSelectedSourceMessage || undefined}
              data-selected-source-message={isSelectedSourceMessage ? '' : undefined}
              className={cn(
                'min-w-0 scroll-mt-4',
                isSelectedSourceMessage && 'rounded-md bg-primary/5 ring-1 ring-inset ring-primary/30',
              )}
            >
              {showThreadDivider ? (
                <div className="border-border text-muted-foreground border-t px-4 py-2 text-xs">
                  Earlier thread
                  {message.receivedOn
                    ? ` · ${formatDateWithWeekdayAndTime(message.receivedOn, timezone)}`
                    : ''}
                </div>
              ) : null}
              <div
                className={cn(
                  'min-w-0 duration-200',
                  index > 0 && !showThreadDivider && 'border-border border-t',
                )}
              >
                {isReplyingToThisMessage ? (
                  <div
                    className="border-border border-b px-4 py-3"
                    id={`reply-composer-${message.id}`}
                  >
                    <ReplyCompose messageId={message.id} />
                  </div>
                ) : null}
                <MailDisplay
                  emailData={message}
                  isFullscreen={isFullscreen}
                  isMuted={false}
                  isLoading={false}
                  index={index}
                  totalEmails={totalReplies}
                />
              </div>
            </div>
          );
        })}
      </div>
    </ScrollArea>
  );
};

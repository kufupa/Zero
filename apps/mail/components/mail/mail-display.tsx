import {
  Bell,
  Docx,
  Figma,
  Forward,
  ImageFile,
  Lightning,
  PDF,
  Reply,
  ReplyAll,
  ThreeDots,
  Tag,
  User,
  Printer,
} from '../icons/icons';
import {
  Briefcase,
  Star,
  StickyNote,
  Users,
  Lock,
  HardDriveDownload,
  CopyIcon,
  FileDown,
} from 'lucide-react';
import { triggerEmlDownload } from '@/lib/eml-download';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '../ui/dropdown-menu';
import { cn, formatDate, formatTime, shouldShowSeparateTime } from '@/lib/utils';
import { memo, useEffect, useMemo, useState, useRef, useCallback, type MouseEvent } from 'react';
import { Tooltip, TooltipContent, TooltipTrigger } from '../ui/tooltip';
import { Popover, PopoverContent, PopoverTrigger } from '../ui/popover';
import { EmailVerificationBadge } from './email-verification-badge';
import type { Sender, ParsedMessage, Attachment } from '@/types';
import { useActiveConnection } from '@/hooks/use-connections';
import { useAttachments } from '@/hooks/use-attachments';
import { useThreadLabels } from '@/hooks/use-labels';
import { useThread } from '@/hooks/use-threads';
import { BimiAvatar } from '../ui/bimi-avatar';
import { RenderLabels } from './render-labels';
import { CenturionCategoryPill } from './centurion-category-pill';
import { buildCategoryIdToSlugMap } from '@/lib/mail/hotel-folder-presentation';
import { useCategorySettings } from '@/hooks/use-categories';
import { cleanHtml } from '@/lib/email-utils';
import {
  cleanEmailDisplay,
  MailboxInline,
  formatMailboxEntries,
  formatMailboxPlain,
} from '@/lib/mail/mailbox-format';
import {
  MAIL_RECIPIENT_FIELDS_CLASS,
  MAIL_RECIPIENT_HEADER_CLASS,
  MAIL_RECIPIENT_ITEM_CLASS,
  MAIL_RECIPIENT_LINE_CLASS,
} from '@/lib/mail/mail-recipient-line';
import { shouldCollapseRecipientToYou } from '@/lib/mail/recipient-you-label';
import {
  canShowHeaderDebug,
  isHeaderDebugEnabled,
  setHeaderDebugEnabled,
} from '@/lib/mail/header-debug';
import { MailContent } from './mail-content';
import { m } from '@/paraglide/messages';
import { useParams } from 'react-router';
import { FileText } from 'lucide-react';
import { parseAsString, useQueryState, useQueryStates } from 'nuqs';
import { Badge } from '../ui/badge';
import { format } from 'date-fns';
import { toast } from 'sonner';
import { copySenderEmail } from '@/lib/mail/copy-sender-email';
import { openReplyComposeContext, type ReplyComposeMode } from '@/lib/mail/reply-compose-context';
import { sortAttachmentsForDisplay } from '@/lib/attachment-priority';
import {
  ATTACHMENT_CHIP_SCROLLPORT_CLASS,
  ATTACHMENT_CHIP_TRACK_CLASS,
  MAIL_DISPLAY_BODY_SHELL_CLASS,
  MAIL_DISPLAY_ROOT_CLASS,
} from '@/lib/attachment-chip-scroll';
import {
  downloadAttachmentViaBlob,
  fetchAttachmentBlob,
  openAttachmentViaBlob,
} from '@/lib/attachment-access';

// Add formatFileSize utility function
const formatFileSize = (size: number) => {
  const sizeInMB = (size / (1024 * 1024)).toFixed(2);
  return sizeInMB === '0.00' ? '' : `${sizeInMB} MB`;
};

// Add getFileIcon utility function
const getFileIcon = (filename: string) => {
  const extension = filename.split('.').pop()?.toLowerCase();

  switch (extension) {
    case 'pdf':
      return <PDF className="fill-[#F43F5E]" />;
    case 'jpg':
      return <ImageFile />;
    case 'jpeg':
      return <ImageFile />;
    case 'png':
      return <ImageFile />;
    case 'gif':
      return <ImageFile />;
    case 'docx':
      return <Docx />;
    case 'fig':
      return <Figma />;
    case 'webp':
      return <ImageFile />;
    default:
      return <FileText className="h-4 w-4 text-[#8B5CF6]" />;
  }
};

type Props = {
  emailData: ParsedMessage;
  isFullscreen: boolean;
  isMuted: boolean;
  isLoading: boolean;
  index: number;
  totalEmails?: number;
  demo?: boolean;
  subject?: string;
  onReply?: () => void;
  onReplyAll?: () => void;
  onForward?: () => void;
};

const MailDisplayLabels = ({ labels }: { labels: string[] }) => {
  const visibleLabels = labels.filter(
    (label) => !['unread', 'inbox'].includes(label.toLowerCase()),
  );

  if (!visibleLabels.length) return null;

  return (
    <div className="flex">
      {visibleLabels.map((label) => {
        const normalizedLabel = label.toLowerCase().replace(/^category_/i, '');

        let icon = null;
        let bgColor = '';
        let labelText = '';

        switch (normalizedLabel) {
          case 'important':
            icon = <Lightning className="h-3.5 w-3.5 fill-white" />;
            bgColor = 'bg-[#F59E0D]';
            labelText = m['common.mailCategories.important']();
            break;
          case 'promotions':
            icon = <Tag className="h-3.5 w-3.5 fill-white" />;
            bgColor = 'bg-[#F43F5E]';
            labelText = m['common.mailCategories.promotions']();
            break;
          case 'personal':
            icon = <User className="h-3.5 w-3.5 fill-white" />;
            bgColor = 'bg-[#39AE4A]';
            labelText = m['common.mailCategories.personal']();
            break;
          case 'updates':
            icon = <Bell className="h-3.5 w-3.5 fill-white" />;
            bgColor = 'bg-[#8B5CF6]';
            labelText = m['common.mailCategories.updates']();
            break;
          case 'work':
            icon = <Briefcase className="h-3.5 w-3.5 text-white" />;
            bgColor = '';
            labelText = m['common.mailCategories.work']();
            break;
          case 'forums':
            icon = <Users className="h-3.5 w-3.5 text-white" />;
            bgColor = 'bg-blue-600';
            labelText = m['common.mailCategories.forums']();
            break;
          case 'notes':
            icon = <StickyNote className="h-3.5 w-3.5 text-white" />;
            bgColor = 'bg-amber-500';
            labelText = m['common.mailCategories.notes']();
            break;
          case 'starred':
            icon = <Star className="h-3.5 w-3.5 fill-white text-white" />;
            bgColor = 'bg-yellow-500';
            labelText = m['common.mailCategories.starred']();
            break;
          default:
            return null;
        }

        return (
          <Tooltip key={`${label}-${labelText}`}>
            <TooltipTrigger>
              <Badge
                key={`${label}-${bgColor}`}
                className={`rounded-md p-1 ${bgColor} dark:border-panelDark -ml-1.5 border-2 border-white transition-transform first:ml-0`}
              >
                {icon}
              </Badge>
            </TooltipTrigger>
            <TooltipContent>
              <p className="text-xs">{labelText}</p>
            </TooltipContent>
          </Tooltip>
        );
      })}
    </div>
  );
};

const escapePrintHtml = (value: string) =>
  value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

const getFormattedMailboxes = (mailboxes?: Sender[] | null) =>
  (mailboxes || [])
    .map(formatMailboxPlain)
    .filter(Boolean);

const formatMailboxList = (mailboxes?: Sender[] | null) =>
  getFormattedMailboxes(mailboxes).join('; ');

const formatMailboxListForPrint = (mailboxes?: Sender[] | null) =>
  getFormattedMailboxes(mailboxes).map(escapePrintHtml).join('; ');

const renderMailboxSummary = (mailboxes: Sender[]) => {
  const recipients = formatMailboxEntries(mailboxes);
  const visibleRecipients = recipients.slice(0, 3);
  const hiddenRecipients = recipients.slice(3);

  return (
    <>
      {visibleRecipients.map(({ key, value }, index) => (
        <span key={key} className={MAIL_RECIPIENT_ITEM_CLASS}>
          {value}
          {index < visibleRecipients.length - 1 ? ';' : ''}
        </span>
      ))}
      {hiddenRecipients.length > 0 && (
        <Tooltip>
          <TooltipTrigger asChild>
            <span className="cursor-pointer">
              {visibleRecipients.length > 0 ? '; ' : ''}+{hiddenRecipients.length} others
            </span>
          </TooltipTrigger>
          <TooltipContent className="flex flex-col gap-1">
            {hiddenRecipients.map(({ key, value }) => (
              <span key={key}>{value}</span>
            ))}
          </TooltipContent>
        </Tooltip>
      )}
    </>
  );
};

export const ThreadAttachments = ({ attachments }: { attachments: Attachment[] }) => {
  if (!attachments || attachments.length === 0) return null;

  const ordered = sortAttachmentsForDisplay(attachments);

  const handleDownload = async (attachment: Attachment) => {
    try {
      await downloadAttachmentViaBlob({
        messageId: attachment.messageId ?? '',
        attachmentId: attachment.attachmentId,
        filename: attachment.filename,
        mimeType: attachment.mimeType,
        body: attachment.body,
        size: attachment.size,
      });
    } catch (error) {
      console.error('Error downloading attachment:', error);
      toast.error('Failed to download attachment');
    }
  };

  return (
    <div className="mt-2 w-full min-w-0 max-w-full">
      <div className="flex items-center gap-2">
        <span className="text-sm font-medium">
          Thread Attachments <span className="text-[#8D8D8D]">[{attachments.length}]</span>
        </span>
      </div>
      {/* ponytail: outer scrollport + inner w-max — flex+overflow on same node won't shrink */}
      <div className={cn('mt-2 pb-2', ATTACHMENT_CHIP_SCROLLPORT_CLASS)}>
        <div className={ATTACHMENT_CHIP_TRACK_CLASS}>
          {ordered.map((attachment) => (
            <button
              key={`${attachment.attachmentId}-${attachment.filename}`}
              onClick={() => handleDownload(attachment)}
              className="flex shrink-0 cursor-pointer items-center gap-2 rounded-md px-2 py-1 text-sm hover:bg-[#F0F0F0] dark:bg-[#262626] dark:hover:bg-[#303030]"
            >
              <span className="text-muted-foreground">{getFileIcon(attachment.filename)}</span>
              <span className="max-w-[200px] truncate" title={attachment.filename}>
                {attachment.filename}
              </span>
              <span className="text-muted-foreground">{formatFileSize(attachment.size)}</span>
            </button>
          ))}
        </div>
      </div>
    </div>
  );
};

export type ActionButtonProps = {
  onClick: (e: React.MouseEvent) => void;
  icon: React.ReactNode;
  text: string;
  ariaLabel?: string;
  'aria-label'?: string;
};

export const ActionButton = ({
  onClick,
  icon,
  text,
  ariaLabel,
  'aria-label': ariaLabelProp,
}: ActionButtonProps) => {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-label={ariaLabelProp ?? ariaLabel ?? text}
      className="inline-flex h-7 items-center justify-center gap-1 overflow-hidden rounded-md border bg-white px-1.5 dark:border-none dark:bg-[#313131] cursor-pointer hover:bg-gray-100 dark:hover:bg-[#3d3d3d] transition-colors"
    >
      {icon}
      <span className="hidden whitespace-nowrap pl-0.5 pr-1 text-sm leading-none text-black md:inline dark:text-white">
        {text}
      </span>
    </button>
  );
};

const downloadAttachment = async (
  attachment: {
    body?: string;
    mimeType: string;
    filename: string;
    attachmentId: string;
    size?: number;
  },
  messageId: string,
) => {
  try {
    await downloadAttachmentViaBlob({
      messageId,
      attachmentId: attachment.attachmentId,
      filename: attachment.filename,
      mimeType: attachment.mimeType,
      body: attachment.body,
      size: attachment.size,
    });
  } catch (error) {
    console.error('Error downloading attachment:', error);
    toast.error('Failed to download attachment');
  }
};

const handleDownloadAllAttachments =
  (
    subject: string,
    messageId: string,
    attachments: {
      body?: string;
      mimeType: string;
      filename: string;
      attachmentId: string;
      size?: number;
    }[],
  ) =>
  async () => {
    if (!attachments.length) return;

    try {
      const JSZip = (await import('jszip')).default;
      const zip = new JSZip();
      let failed = 0;

      await Promise.all(
        attachments.map(async (attachment) => {
          try {
            const blob = await fetchAttachmentBlob({
              messageId,
              attachmentId: attachment.attachmentId,
              mimeType: attachment.mimeType,
              body: attachment.body,
              size: attachment.size,
            });
            zip.file(attachment.filename, blob, {
              binary: true,
              date: new Date(),
              unixPermissions: 0o644,
            });
          } catch (error) {
            failed += 1;
            console.error(`Error adding ${attachment.filename} to zip:`, error);
          }
        }),
      );

      if (failed === attachments.length) {
        toast.error('Failed to download attachments');
        return;
      }
      if (failed > 0) {
        toast.error(`${failed} of ${attachments.length} attachments failed`);
      }

      const content = await zip.generateAsync({
        type: 'blob',
        compression: 'DEFLATE',
        compressionOptions: {
          level: 9,
        },
      });
      const url = window.URL.createObjectURL(content);
      const link = document.createElement('a');
      link.href = url;
      link.download = `attachments-${subject || 'email'}.zip`;
      document.body.appendChild(link);
      link.click();
      document.body.removeChild(link);
      window.URL.revokeObjectURL(url);
    } catch (error) {
      console.error('Error generating zip file:', error);
      toast.error('Failed to download attachments');
    }
  };

const openAttachment = async (
  attachment: {
    body?: string;
    mimeType: string;
    filename: string;
    attachmentId: string;
    size?: number;
  },
  messageId: string,
) => {
  try {
    await openAttachmentViaBlob({
      messageId,
      attachmentId: attachment.attachmentId,
      filename: attachment.filename,
      mimeType: attachment.mimeType,
      body: attachment.body,
      size: attachment.size,
    });
  } catch (error) {
    console.error('Error opening attachment:', error);
    toast.error(
      error instanceof Error && error.message === 'Popup blocked'
        ? 'Popup blocked — allow popups to open attachments'
        : 'Failed to open attachment',
    );
  }
};

const MailDisplay = ({ emailData, index, totalEmails, demo }: Props) => {
  const [isCollapsed, setIsCollapsed] = useState<boolean>(false);
  const { data: threadData } = useThread(emailData.threadId ?? null);
  const { data: messageAttachments } = useAttachments(emailData.id);
  //   const [unsubscribed, setUnsubscribed] = useState(false);
  //   const [isUnsubscribing, setIsUnsubscribing] = useState(false);
  const [preventCollapse, setPreventCollapse] = useState(false);
  const [isDownloadingEml, setIsDownloadingEml] = useState(false);
  const { folder } = useParams<{ folder: string }>();
  const categorySettings = useCategorySettings();
  const idToSlug = useMemo(
    () => buildCategoryIdToSlugMap(categorySettings),
    [categorySettings],
  );
  //   const [selectedAttachment, setSelectedAttachment] = useState<null | {
  //     id: string;
  //     name: string;
  //     type: string;
  //     url: string;
  //   }>(null);
  const [openDetailsPopover, setOpenDetailsPopover] = useState<boolean>(false);
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const collapseTimeoutRef = useRef<NodeJS.Timeout | null>(null);

  const [activeReplyId, setActiveReplyId] = useQueryState('activeReplyId');
  const { labels: threadLabels } = useThreadLabels(
    emailData.tags ? emailData.tags.map((l) => l.id) : [],
  );
  const { data: activeConnection } = useActiveConnection();
  const canDebugHeaders = canShowHeaderDebug(activeConnection?.id);
  const [headerDebugEnabled, setHeaderDebugEnabledState] = useState(false);

  useEffect(() => {
    setHeaderDebugEnabledState(isHeaderDebugEnabled());
  }, []);

  const toggleHeaderDebug = useCallback((e: MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    const next = !headerDebugEnabled;
    setHeaderDebugEnabled(next);
    setHeaderDebugEnabledState(next);
  }, [headerDebugEnabled]);

  //   const trpc = useTRPC();

  const isLastEmail = useMemo(
    () => emailData.id === threadData?.latest?.id,
    [emailData.id, threadData?.latest?.id],
  );

  const [, setMode] = useQueryState('mode');
  const [, setDraftId] = useQueryState('draftId');
  const [, setComposeState] = useQueryStates({
    mode: parseAsString,
    activeReplyId: parseAsString,
    draftId: parseAsString,
  });

  const openComposeForMessage = useCallback(
    (mode: ReplyComposeMode) => {
      setIsCollapsed(false);
      void openReplyComposeContext({
        mode,
        messageId: emailData.id,
        setMode,
        setActiveReplyId,
        setDraftId,
        setComposeState,
      });
    },
    [emailData.id, setMode, setActiveReplyId, setDraftId, setComposeState],
  );

  const handleDownloadEml = useCallback(async () => {
    if (!emailData?.id || isDownloadingEml) return;
    setIsDownloadingEml(true);
    try {
      const { filename } = await triggerEmlDownload(emailData.id);
      toast.success(`Downloaded ${filename} — drag into Infor PMS`);
    } catch (err) {
      console.error('Failed to download .eml:', err);
      toast.error('Failed to download email file');
    } finally {
      setIsDownloadingEml(false);
    }
  }, [emailData?.id, isDownloadingEml]);

  useEffect(() => {
    if (!demo) {
      if (activeReplyId === emailData.id) {
        setIsCollapsed(false);
      } else {
        setIsCollapsed(!isLastEmail);
      }
    }
  }, [demo, emailData.id, isLastEmail, activeReplyId]);

  // Separate from collapse/reply toggles so mid-thread reply does not yank viewport to newest.
  useEffect(() => {
    if (!demo && isLastEmail && totalEmails && totalEmails > 5) {
      setTimeout(() => {
        const element = document.getElementById(`mail-${emailData.id}`);
        element?.scrollIntoView({ behavior: 'smooth' });
      }, 100);
    }
  }, [demo, emailData.id, isLastEmail, totalEmails]);

  //   const listUnsubscribeAction = useMemo(
  //     () =>
  //       emailData.listUnsubscribe
  //         ? getListUnsubscribeAction({
  //             listUnsubscribe: emailData.listUnsubscribe,
  //             listUnsubscribePost: emailData.listUnsubscribePost,
  //           })
  //         : undefined,
  //     [emailData.listUnsubscribe, emailData.listUnsubscribePost],
  //   );

  //   const _handleUnsubscribe = async () => {
  //     setIsUnsubscribing(true);
  //     try {
  //       await handleUnsubscribe({
  //         emailData,
  //       });
  //       setIsUnsubscribing(false);
  //       setUnsubscribed(true);
  //     } catch (e) {
  //       setIsUnsubscribing(false);
  //       setUnsubscribed(false);
  //     }
  //   };

  // Clear any pending timeouts when component unmounts
  useEffect(() => {
    return () => {
      if (collapseTimeoutRef.current) {
        clearTimeout(collapseTimeoutRef.current);
      }
    };
  }, []);

  // Function to handle popover state changes
  const handlePopoverChange = useCallback((open: boolean) => {
    setOpenDetailsPopover(open);

    if (!open) {
      // When closing the popover, prevent collapse for a short time
      setPreventCollapse(true);

      // Clear any existing timeout
      if (collapseTimeoutRef.current) {
        clearTimeout(collapseTimeoutRef.current);
      }

      // Set a timeout to allow collapse again after a delay
      collapseTimeoutRef.current = setTimeout(() => {
        setPreventCollapse(false);
      }, 300);
    }
  }, []);

  // Handle email collapse toggle
  const toggleCollapse = useCallback(() => {
    // Only toggle if we're not in prevention mode
    if (!preventCollapse && !openDetailsPopover) {
      setIsCollapsed(!isCollapsed);
    }
  }, [isCollapsed, preventCollapse, openDetailsPopover]);

  // Handle email copy of senders
  const handleCopySenderEmail = useCallback(async (personEmail: string) => {
    const result = await copySenderEmail(personEmail || '');
    if (result === 'copied') {
      toast.success('Email copied to clipboard');
    } else if (result === 'failed') {
      toast.error('Failed to copy email');
    }
  }, []);

  // email printing
  const printMail = () => {
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
          <title>Print Email - ${escapePrintHtml(emailData.subject || 'No Subject')}</title>
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

              /* Remove any default borders */
              * {
                border: none !important;
                box-shadow: none !important;
              }

              /* Ensure clean page breaks */
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
          <div class="email-container">
            <!-- Email Header -->
            <div class="email-header">
              <h1 class="email-title">${escapePrintHtml(emailData.subject || 'No Subject')}</h1>

              ${
                emailData?.tags && emailData.tags.length > 0
                  ? `
                <div class="labels-section">
                  ${emailData.tags
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
                    ${escapePrintHtml(formatMailboxPlain(emailData.sender))}
                  </span>
                </div>

                ${
                  emailData.to && emailData.to.length > 0
                    ? `
                  <div class="meta-row">
                    <span class="meta-label">To:</span>
                    <span class="meta-value">
                      ${formatMailboxListForPrint(emailData.to)}
                    </span>
                  </div>
                `
                    : ''
                }

                ${
                  emailData.cc && emailData.cc.length > 0
                    ? `
                  <div class="meta-row">
                    <span class="meta-label">CC:</span>
                    <span class="meta-value">
                      ${formatMailboxListForPrint(emailData.cc)}
                    </span>
                  </div>
                `
                    : ''
                }

                ${
                  emailData.bcc && emailData.bcc.length > 0
                    ? `
                  <div class="meta-row">
                    <span class="meta-label">BCC:</span>
                    <span class="meta-value">
                      ${formatMailboxListForPrint(emailData.bcc)}
                    </span>
                  </div>
                `
                    : ''
                }

                <div class="meta-row">
                  <span class="meta-label">Date:</span>
                  <span class="meta-value">${formatDate(emailData.receivedOn)}</span>
                </div>
              </div>
            </div>

            <div class="separator"></div>

            <!-- Email Body -->
            <div class="email-body">
              <div class="email-content">
                ${cleanHtml(emailData?.decodedBody || '')}
              </div>
            </div>

            <!-- Attachments -->
            ${
              messageAttachments && messageAttachments.length > 0
                ? `
              <div class="attachments-section">
                <h2 class="attachments-title">Attachments (${messageAttachments.length})</h2>
                ${messageAttachments
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
        </body>
      </html>
    `;

      if (printFrame.contentWindow) {
        // Write content to the iframe
        const iframeDoc = printFrame.contentDocument || printFrame.contentWindow.document;
        iframeDoc.open();
        iframeDoc.write(printContent);
        iframeDoc.close();

        // Wait for content to load, then print
        printFrame.onload = function () {
          setTimeout(() => {
            try {
              if (!printFrame.contentWindow) {
                console.error('Failed to get iframe window');
                return;
              }
              // Focus the iframe and print
              printFrame.contentWindow.focus();
              printFrame.contentWindow.print();

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
      }
    } catch (error) {
      console.error('Error printing email:', error);
      toast.error('Failed to print email. Please try again.');
    }
  };

  const renderPerson = useCallback(
    (person: Sender) => (
      <Popover key={person.email}>
        <PopoverTrigger asChild>
          <div
            key={person.email}
            className="dark:bg-panelDark inline-flex items-center justify-start gap-1.5 overflow-hidden rounded-full border bg-white p-1 pr-2"
          >
            <BimiAvatar
              email={person.email}
              name={person.name || person.email}
              className="h-5 w-5"
            />
            <div className="text-panelDark justify-start text-sm font-medium leading-none dark:text-white">
              {person.name || person.email}
            </div>
          </div>
        </PopoverTrigger>
        <PopoverContent className="min-w-fit text-sm">
          <div className="flex items-center gap-2">
            <BimiAvatar
              email={person.email}
              name={person.name || person.email}
              className="h-12 w-12"
            />
            <div>
              <p className="font-medium">{person.name || 'Unknown'}</p>
              <div className="group flex items-center gap-2">
                <p>{person.email || 'No email'}</p>
                <span className="opacity-0 transition-opacity duration-150 group-hover:opacity-100">
                  <CopyIcon
                    size={14}
                    className="cursor-pointer"
                    onClick={() => handleCopySenderEmail(person.email)}
                  />
                </span>
              </div>
            </div>
          </div>
        </PopoverContent>
      </Popover>
    ),
    [handleCopySenderEmail],
  );

  const people = useMemo(() => {
    if (!activeConnection) return [];
    const allPeople = [
      ...(folder === 'sent' ? [] : [emailData.sender]),
      ...(emailData.to || []),
      ...(emailData.cc || []),
      ...(emailData.bcc || []),
    ];
    return allPeople.filter(
      (p): p is Sender =>
        Boolean(p?.email) &&
        p.email !== activeConnection!.email &&
        p.name !== 'No Sender Name' &&
        p === allPeople.find((other) => other?.email === p?.email),
    );
  }, [emailData, activeConnection]);

  return (
    <div
      className={cn(MAIL_DISPLAY_ROOT_CLASS)}
      id={`mail-${emailData.id}`}
      onClick={(e) => {
        if (openDetailsPopover) {
          e.stopPropagation();
        }
      }}
    >
      <>
        <div className={MAIL_DISPLAY_BODY_SHELL_CLASS}>
          <div className={cn('min-w-0 px-4', index === 0 && 'border-b py-4')}>
            {index === 0 && (
              <>
                <span className="inline-flex items-center gap-2 font-medium text-black dark:text-white">
                  <span>
                    {emailData.subject}{' '}
                    <span className="text-muted-foreground dark:text-[#8C8C8C]">
                      {totalEmails && totalEmails > 1 && `[${totalEmails}]`}
                    </span>
                  </span>
                </span>

                <div className="mt-2 flex flex-wrap items-center gap-2">
                  {emailData?.tags?.length ? (
                    <MailDisplayLabels labels={emailData?.tags.map((t) => t.name) || []} />
                  ) : null}
                  {emailData?.tags?.length ? (
                    <div className="bg-iconLight dark:bg-iconDark/20 relative h-3 w-0.5 rounded-full" />
                  ) : null}
                  <CenturionCategoryPill
                    routeFolder={folder}
                    category={threadData?.centurionCategory}
                    categoryIds={threadData?.categoryIds}
                    idToSlug={idToSlug}
                  />
                  <RenderLabels labels={threadLabels} />
                  {threadLabels.length ? (
                    <div className="bg-iconLight dark:bg-iconDark/20 relative h-3 w-0.5 rounded-full" />
                  ) : null}
                  <div className="text-muted-foreground flex items-center gap-2 text-sm dark:text-[#8C8C8C]">
                    {(() => {
                      if (people.length <= 2) {
                        return people.map(renderPerson);
                      }

                      // Only show first two people plus count if we have at least two people
                      const firstPerson = people[0];
                      const secondPerson = people[1];

                      if (firstPerson && secondPerson) {
                        return (
                          <>
                            {renderPerson(firstPerson)}
                            {renderPerson(secondPerson)}
                            <Tooltip>
                              <TooltipTrigger asChild>
                                <span className="text-sm">
                                  +{people.length - 2}{' '}
                                  {people.length - 2 === 1 ? 'other' : 'others'}
                                </span>
                              </TooltipTrigger>
                              <TooltipContent className="flex flex-col gap-1">
                                {people.slice(2).map((person) => (
                                  <div key={person.email}>{renderPerson(person)}</div>
                                ))}
                              </TooltipContent>
                            </Tooltip>
                          </>
                        );
                      }

                      return null;
                    })()}
                  </div>
                </div>
              </>
            )}
          </div>
          <div className="flex cursor-pointer flex-col pb-2 duration-200" onClick={toggleCollapse}>
            <div className="mt-3 flex w-full min-w-0 items-start justify-between gap-4 px-4">
              <div className="flex w-full min-w-0 justify-center gap-4">
                <BimiAvatar
                  email={emailData?.sender?.email}
                  name={emailData?.sender?.name}
                  className="mt-3 h-8 w-8"
                />

                <div className="flex w-full min-w-0 items-center justify-between">
                  <div className="flex w-full min-w-0 items-center justify-start">
                    <div className="flex w-full min-w-0 flex-col">
                      <div className="flex w-full min-w-0 items-center justify-between">
                          <div className="flex min-w-0 items-center gap-2">
                            <div className="flex min-w-0 items-center gap-2">
                              <span
                                onClick={(e) => {
                                  e.stopPropagation();
                                  e.preventDefault();
                                  void handleCopySenderEmail(emailData?.sender?.email || '');
                                }}
                                onKeyDown={(e) => {
                                  if (e.key === 'Enter' || e.key === ' ') {
                                    e.stopPropagation();
                                    e.preventDefault();
                                    void handleCopySenderEmail(emailData?.sender?.email || '');
                                  }
                                }}
                                role="button"
                                tabIndex={0}
                                title="Copy email address"
                                aria-label="Copy email address"
                                className="hover:bg-muted min-w-0 cursor-pointer"
                              >
                                <MailboxInline sender={emailData?.sender} />
                              </span>
                            <EmailVerificationBadge messageId={emailData?.id} />
                          </div>

                          <Popover open={openDetailsPopover} onOpenChange={handlePopoverChange}>
                            <PopoverTrigger asChild>
                              <button
                                className="hover:bg-iconLight/10 dark:hover:bg-iconDark/20 flex items-center gap-2 rounded-md p-2 cursor-pointer"
                                onClick={(e) => {
                                  e.stopPropagation();
                                  e.preventDefault();
                                  setOpenDetailsPopover(!openDetailsPopover);
                                }}
                                ref={triggerRef}
                              >
                                <p className="text-muted-foreground text-xs underline dark:text-[#8C8C8C]">
                                  {m['common.mailDisplay.details']()}
                                </p>
                              </button>
                            </PopoverTrigger>
                            <PopoverContent
                              className="dark:bg-panelDark flex w-[420px] overflow-auto rounded-lg border p-4 text-left shadow-lg md:w-auto"
                              onBlur={(e) => {
                                if (!triggerRef.current?.contains(e.relatedTarget)) {
                                  setOpenDetailsPopover(false);
                                }
                              }}
                              onClick={(e) => e.stopPropagation()}
                            >
                              <div className="space-y-1 text-sm">
                                <div className="flex">
                                  <span className="w-24 text-end text-gray-500">
                                    {m['common.mailDisplay.from']()}:
                                  </span>
                                  <div className="ml-3">
                                    <span
                                      onClick={(e) => {
                                        e.stopPropagation();
                                        e.preventDefault();
                                        void handleCopySenderEmail(emailData?.sender?.email || '');
                                      }}
                                      onKeyDown={(e) => {
                                        if (e.key === 'Enter' || e.key === ' ') {
                                          e.stopPropagation();
                                          e.preventDefault();
                                          void handleCopySenderEmail(emailData?.sender?.email || '');
                                        }
                                      }}
                                      role="button"
                                      tabIndex={0}
                                      title="Copy email address"
                                      aria-label="Copy email address"
                                      className="hover:bg-muted min-w-0 cursor-pointer"
                                    >
                                      <MailboxInline sender={emailData?.sender} />
                                    </span>
                                  </div>
                                </div>
                                <div className="flex">
                                  <span className="w-24 text-nowrap text-end text-gray-500">
                                    {m['common.mailDisplay.to']()}:
                                  </span>
                                  <span className="text-muted-foreground ml-3 break-all">
                                    {formatMailboxList(emailData?.to)}
                                  </span>
                                </div>
                                {emailData?.replyTo && emailData.replyTo.length > 0 && (
                                  <div className="flex">
                                    <span className="w-24 text-nowrap text-end text-gray-500">
                                      {m['common.mailDisplay.replyTo']()}:
                                    </span>
                                    <span className="text-muted-foreground ml-3 text-nowrap">
                                      {cleanEmailDisplay(emailData?.replyTo)}
                                    </span>
                                  </div>
                                )}
                                {emailData?.cc && emailData.cc.length > 0 && (
                                  <div className="flex">
                                    <span className="shrink-0text-nowrap w-24 text-end text-gray-500">
                                      {m['common.mailDisplay.cc']()}:
                                    </span>
                                    <span className="text-muted-foreground ml-3 break-all">
                                      {formatMailboxList(emailData?.cc)}
                                    </span>
                                  </div>
                                )}
                                {emailData?.bcc && emailData.bcc.length > 0 && (
                                  <div className="flex">
                                    <span className="w-24 text-end text-gray-500">
                                      {m['common.mailDisplay.bcc']()}:
                                    </span>
                                    <span className="text-muted-foreground ml-3 break-all">
                                      {formatMailboxList(emailData?.bcc)}
                                    </span>
                                  </div>
                                )}
                                <div className="flex">
                                  <span className="w-24 text-end text-gray-500">
                                    {m['common.mailDisplay.date']()}:
                                  </span>
                                  <span className="text-muted-foreground ml-3 text-nowrap">
                                    {emailData?.receivedOn &&
                                    !isNaN(new Date(emailData.receivedOn).getTime())
                                      ? format(new Date(emailData.receivedOn), 'PPpp')
                                      : ''}
                                  </span>
                                </div>
                                <div className="flex">
                                  <span className="w-24 text-end text-gray-500">
                                    {m['common.mailDisplay.mailedBy']()}:
                                  </span>
                                  <span className="text-muted-foreground ml-3 text-nowrap">
                                    {cleanEmailDisplay(emailData?.sender?.email)}
                                  </span>
                                </div>
                                <div className="flex">
                                  <span className="w-24 text-end text-gray-500">
                                    {m['common.mailDisplay.signedBy']()}:
                                  </span>
                                  <span className="text-muted-foreground ml-3 text-nowrap">
                                    {cleanEmailDisplay(emailData?.sender?.email)}
                                  </span>
                                </div>
                                {canDebugHeaders && headerDebugEnabled && emailData.debugHeaders?.length ? (
                                  <div className="mt-3 border-t pt-3">
                                    <p className="mb-2 text-xs font-medium text-gray-500">Debug headers</p>
                                    <pre className="max-h-48 overflow-auto whitespace-pre-wrap rounded-md bg-black/[0.03] p-2 font-mono text-[11px] leading-5 dark:bg-white/[0.06]">
                                      {emailData.debugHeaders.map((line) => line.line).join('\n')}
                                    </pre>
                                  </div>
                                ) : null}
                                {emailData.tls && (
                                  <div className="flex items-center">
                                    <span className="w-24 text-end text-gray-500">
                                      {m['common.mailDisplay.security']()}:
                                    </span>
                                    <div className="text-muted-foreground ml-3 flex items-center gap-1">
                                      <Lock className="h-4 w-4 text-green-600" />{' '}
                                      {m['common.mailDisplay.standardEncryption']()}
                                    </div>
                                  </div>
                                )}
                              </div>
                            </PopoverContent>
                          </Popover>
                        </div>

                        <div className="flex shrink-0 items-center justify-center">
                          <div className="text-muted-foreground flex-nowrap! mr-2 flex flex-col items-end text-sm font-medium dark:text-[#8C8C8C]">
                            <time className="whitespace-nowrap">
                              {emailData?.receivedOn ? formatDate(emailData.receivedOn) : ''}
                            </time>
                            {shouldShowSeparateTime(emailData?.receivedOn) && (
                              <time className="whitespace-nowrap text-xs opacity-75">
                                {emailData?.receivedOn && formatTime(emailData.receivedOn)}
                              </time>
                            )}
                          </div>

                          {/* options menu */}
                          <DropdownMenu>
                            <DropdownMenuTrigger asChild>
                              <button
                                onClick={(e) => {
                                  e.stopPropagation();
                                  e.preventDefault();
                                }}
                                className="inline-flex h-7 w-7 items-center justify-center gap-1 overflow-hidden rounded-md bg-white hover:bg-gray-100 focus:outline-none focus:ring-0 dark:bg-[#313131] dark:hover:bg-[#3d3d3d] cursor-pointer transition-colors"
                              >
                                <ThreeDots className="fill-iconLight dark:fill-iconDark" />
                              </button>
                            </DropdownMenuTrigger>
                            <DropdownMenuContent align="end" className="bg-white dark:bg-[#313131]">
                              <DropdownMenuItem
                                onClick={(e) => {
                                  e.preventDefault();
                                  e.stopPropagation();
                                  printMail();
                                }}
                              >
                                <Printer className="fill-iconLight dark:fill-iconDark mr-2 h-4 w-4" />
                                {m['common.mailDisplay.print']()}
                              </DropdownMenuItem>
                              <DropdownMenuItem
                                onClick={(e) => {
                                  e.preventDefault();
                                  e.stopPropagation();
                                  handleDownloadEml();
                                }}
                              >
                                <FileDown className="fill-iconLight dark:text-iconDark mr-2 h-4 w-4" />
                                Download Email (.eml)
                              </DropdownMenuItem>
                              {canDebugHeaders ? (
                                <DropdownMenuItem onClick={toggleHeaderDebug}>
                                  {headerDebugEnabled ? 'Disable header debug' : 'Enable header debug'}
                                </DropdownMenuItem>
                              ) : null}
                              {(messageAttachments?.length ?? 0) > 0 && (
                                <DropdownMenuItem
                                  disabled={!messageAttachments?.length}
                                  className={
                                    !messageAttachments?.length
                                      ? 'data-disabled:pointer-events-auto'
                                      : ''
                                  }
                                  onClick={(e) => {
                                    e.stopPropagation();
                                    e.preventDefault();
                                    handleDownloadAllAttachments(
                                      emailData.subject || 'email',
                                      emailData.id,
                                      messageAttachments || [],
                                    )();
                                  }}
                                >
                                  <HardDriveDownload className="fill-iconLight dark:text-iconDark dark:fill-iconLight mr-2 h-4 w-4" />
                                  Download All Attachments
                                </DropdownMenuItem>
                              )}
                            </DropdownMenuContent>
                          </DropdownMenu>
                        </div>
                      </div>
                      <div className={MAIL_RECIPIENT_HEADER_CLASS}>
                        <div className={MAIL_RECIPIENT_FIELDS_CLASS}>
                          <div className={MAIL_RECIPIENT_LINE_CLASS}>
                            <span className="shrink-0">{m['common.mailDisplay.to']()}:</span>
                            {shouldCollapseRecipientToYou({
                              folder,
                              to: emailData?.to || [],
                              ccLength: (emailData?.cc || []).length,
                              mailboxEmail: activeConnection?.email,
                              fromEmail: emailData?.sender?.email,
                            })
                              ? <span className={MAIL_RECIPIENT_ITEM_CLASS}>You</span>
                              : renderMailboxSummary(emailData?.to || [])}
                          </div>
                          {(emailData?.cc?.length || 0) > 0 && (
                            <div className={MAIL_RECIPIENT_LINE_CLASS}>
                              <span className="shrink-0">{m['common.mailDisplay.cc']()}:</span>
                              {renderMailboxSummary(emailData?.cc || [])}
                            </div>
                          )}
                          {(emailData?.bcc?.length || 0) > 0 && (
                            <div className={MAIL_RECIPIENT_LINE_CLASS}>
                              <span className="shrink-0">Bcc:</span>
                              {renderMailboxSummary(emailData?.bcc || [])}
                            </div>
                          )}
                        </div>
                        <div
                          role="group"
                          aria-label="Message reply actions"
                          className="flex w-full max-w-full flex-wrap justify-end gap-2"
                        >
                          <ActionButton
                            onClick={(e) => {
                              e.stopPropagation();
                              openComposeForMessage('reply');
                            }}
                            icon={<Reply className="fill-muted-foreground dark:fill-[#9B9B9B]" />}
                            text={m['common.mail.reply']()}
                          />
                          <ActionButton
                            onClick={(e) => {
                              e.stopPropagation();
                              openComposeForMessage('replyAll');
                            }}
                            icon={<ReplyAll className="fill-muted-foreground dark:fill-[#9B9B9B]" />}
                            text={m['common.mail.replyAll']()}
                          />
                          <ActionButton
                            onClick={(e) => {
                              e.stopPropagation();
                              openComposeForMessage('forward');
                            }}
                            icon={<Forward className="fill-muted-foreground dark:fill-[#9B9B9B]" />}
                            text={m['common.mail.forward']()}
                          />
                          <ActionButton
                            onClick={(e) => {
                              e.stopPropagation();
                              handleDownloadEml();
                            }}
                            icon={<FileDown className="h-3.5 w-3.5 text-muted-foreground dark:text-[#9B9B9B]" />}
                            text={isDownloadingEml ? '...' : '.eml'}
                            aria-label="Download .eml"
                          />
                        </div>
                      </div>
                    </div>

                    {/* Pending, needs a storage to make the unsubscribe status consitent */}
                    {/* <span className="text-muted-foreground flex grow-0 items-center gap-2 text-sm">
                    {listUnsubscribeAction && (
                      <Dialog>
                        <DialogTrigger asChild>
                          <Button
                            size="xs"
                            variant="secondary"
                            disabled={unsubscribed || isUnsubscribing}
                          >
                            {unsubscribed && <Check className="h-4 w-4" />}
                            {isUnsubscribing && (
                              <LoaderCircleIcon className="h-4 w-4 animate-spin" />
                            )}
                            {unsubscribed
                              ? t('common.mailDisplay.unsubscribed')
                              : t('common.mailDisplay.unsubscribe')}
                          </Button>
                        </DialogTrigger>

                        <DialogContent>
                          <DialogHeader>
                            <DialogTitle>{t('common.mailDisplay.unsubscribe')}</DialogTitle>
                            <DialogDescription className="break-words">
                              {t('common.mailDisplay.unsubscribeDescription')}
                            </DialogDescription>
                          </DialogHeader>
                          <DialogFooter className="gap-2">
                            <DialogClose asChild>
                              <Button disabled={isUnsubscribing} variant="outline">
                                {t('common.mailDisplay.cancel')}
                              </Button>
                            </DialogClose>
                            <DialogClose asChild>
                              <Button disabled={isUnsubscribing} onClick={_handleUnsubscribe}>
                                {t('common.mailDisplay.unsubscribe')}
                              </Button>
                            </DialogClose>
                          </DialogFooter>
                        </DialogContent>
                      </Dialog>
                    )}
                  </span> */}
                  </div>
                </div>
              </div>
            </div>
          </div>

          {/* Outlook: attachments under header/subject, above body. Keep images; docs first. */}
          {messageAttachments && messageAttachments.length > 0 ? (
            <div
              className="w-full min-w-0 max-w-full px-4 pb-2 pt-2"
              onClick={(e) => e.stopPropagation()}
            >
              {/* ponytail: outer scrollport + inner w-max — same as ThreadAttachments */}
              <div className={ATTACHMENT_CHIP_SCROLLPORT_CLASS}>
                <div className={ATTACHMENT_CHIP_TRACK_CLASS}>
                  {sortAttachmentsForDisplay(messageAttachments).map((attachment, attachmentIndex) => (
                    <div
                      key={`${attachment.filename}-${attachment.attachmentId}`}
                      className="flex shrink-0"
                    >
                      <button
                        className="flex cursor-pointer items-center gap-1 rounded-[5px] bg-[#FAFAFA] px-1.5 py-1 text-sm font-medium hover:bg-[#F0F0F0] dark:bg-[#262626] dark:hover:bg-[#303030]"
                        onClick={() => openAttachment(attachment, emailData.id)}
                      >
                        {getFileIcon(attachment.filename)}
                        <span className="max-w-[15ch] truncate text-sm text-black dark:text-white">
                          {attachment.filename}
                        </span>{' '}
                        <span className="text-muted-foreground whitespace-nowrap text-sm dark:text-[#929292]">
                          {formatFileSize(attachment.size)}
                        </span>
                      </button>
                      <button
                        onClick={() => downloadAttachment(attachment, emailData.id)}
                        className="flex cursor-pointer items-center gap-1 rounded-[5px] px-1.5 py-1 text-sm"
                      >
                        <HardDriveDownload className="text-muted-foreground dark:text-muted-foreground h-4 w-4 fill-[#FAFAFA] dark:fill-[#262626]" />
                      </button>
                      {attachmentIndex < messageAttachments.length - 1 && (
                        <div className="m-auto h-2 w-px bg-[#E0E0E0] dark:bg-[#424242]" />
                      )}
                    </div>
                  ))}
                </div>
              </div>
            </div>
          ) : null}

          <div className={cn('h-0 overflow-hidden duration-200', !isCollapsed && 'h-px')}></div>

          <div
            className={cn(
              'grid overflow-hidden duration-200',
              isCollapsed ? 'grid-rows-[0fr]' : 'grid-rows-[1fr]',
            )}
            onClick={(e) => e.stopPropagation()}
          >
            <div className="min-h-0 overflow-hidden">
              <div className="h-fit w-full p-0">
                {/* mail main body */}
                {emailData?.decodedBody ? (
                  <MailContent
                    id={emailData.id}
                    html={emailData?.decodedBody}
                    senderEmail={emailData.sender.email}
                  />
                ) : null}
              </div>
            </div>
          </div>
        </div>
      </>
    </div>
  );
};

export default memo(MailDisplay);

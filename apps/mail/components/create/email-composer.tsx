import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '../ui/tooltip';
import { Command, ImagePlus, Paperclip, Plus, Type, X as XIcon } from 'lucide-react';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { uniqueVerifiedFiles } from '@/hooks/draft-artifact-files';
import { ScheduleSendPicker } from './schedule-send-picker';
import useComposeEditor from '@/hooks/use-compose-editor';
import { gitHubEmojis } from '@tiptap/extension-emoji';
import { zodResolver } from '@hookform/resolvers/zod';
import { CurvedArrow, X } from '../icons/icons';

import { DEMO_MAIL_LIST_DRAFTS_QUERY_PREFIX } from '@/lib/demo/demo-mail-query-keys';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { QuoteHistoryExpander } from './quote-history-expander';
import { demoUpsertDraft } from '@/lib/demo/local-actions';
import { isFrontendOnlyDemo } from '@/lib/demo/runtime';
import { useTRPC } from '@/providers/query-provider';
import { useSettings } from '@/hooks/use-settings';
import { useThread } from '@/hooks/use-threads';
import type { ParsedMessage } from '@/types';

import { cn, formatFileSize } from '@/lib/utils';
import { serializeFiles } from '@/lib/schemas';
import { Input } from '@/components/ui/input';
import { EditorContent } from '@tiptap/react';
import { useForm } from 'react-hook-form';
import { Button } from '../ui/button';
import { useQueryState } from 'nuqs';
import { Toolbar } from './toolbar';
import pluralize from 'pluralize';
import { toast } from 'sonner';
import { z } from 'zod';

import { RecipientAutosuggest } from '@/components/ui/recipient-autosuggest';
import { ImageCompressionSettings } from './image-compression-settings';
import type { ImageQuality } from '@/lib/image-compression';
import { compressImages } from '@/lib/image-compression';

const shortcodeRegex = /:([a-zA-Z0-9_+-]+):/g;
import {
  buildDraftMutationInput,
  chooseDraftEditorState,
  isStaleDraftSendCancelled,
  nextAfterDialogChoice,
  reduceDraftRevision,
  resolveComposeCloseAction,
  shouldPersistDraft,
  type ComposeDialogChoice,
  type DraftRevisionState,
  type PersistDecisionInput,
} from '@/lib/mail/draft-persistence';
import {
  COMPOSE_ATTACHMENT_ACCEPT,
  partitionComposeAttachmentFiles,
} from '@/lib/compose-attachment-policy';
import { resolveComposeEscapeAction } from '@/lib/mail/thread-open-stability';
import { drainAttachmentIntakeQueue } from '@/lib/attachment-intake-queue';
import { NATIVE_VISIBLE_SCROLLBAR_CLASSES } from '@/lib/scrollbar-chrome';
import { registerComposeFlush } from '@/lib/mail/compose-flush-registry';
import { useOptimisticActions } from '@/hooks/use-optimistic-actions';
import { emailListSignature } from '@/lib/mail/compose-signatures';
import { TemplateButton } from './template-button';
import type { HeaderDebugLine } from '@/types';
import { useDraft } from '@/hooks/use-drafts';
import { m } from '@/paraglide/messages';

const hasFileDrag = (dataTransfer: DataTransfer | null): boolean =>
  dataTransfer !== null && Array.from(dataTransfer.types).includes('Files');

interface EmailComposerProps {
  initialTo?: string[];
  initialCc?: string[];
  initialBcc?: string[];
  initialSubject?: string;
  initialMessage?: string;
  initialAttachments?: File[];
  hydratedAttachmentSnapshot?: { key: string; files: File[] };
  onSendEmail: (data: {
    to: string[];
    cc?: string[];
    bcc?: string[];
    subject: string;
    message: string;
    attachments: File[];
    fromEmail?: string;
    scheduleAt?: string;
    draftId?: string;
    excludeQuotedHistory?: boolean;
  }) => Promise<boolean>;
  onClose?: () => void;
  className?: string;
  autofocus?: boolean;
  settingsLoading?: boolean;
  editorClassName?: string;
  /** Sync reply recipients from props without remounting (e.g. reply → reply all). Subject follows props until staff edits begin; body never follows props. */
  syncReplyHeadersFromProps?: boolean;
  replyToMessageId?: string | null;
  replyToMessage?: ParsedMessage | null;
  headerPreview?: HeaderDebugLine[];
  /** Assisted drafts keep the same editor but make the human review step explicit. */
  sendButtonLabel?: string;
}

const schema = z.object({
  to: z.array(z.string().email()).min(1),
  subject: z.string().min(1),
  message: z.string().min(1),
  attachments: z.array(z.any()).optional(),
  headers: z.any().optional(),
  cc: z.array(z.string().email()).optional(),
  bcc: z.array(z.string().email()).optional(),
  threadId: z.string().optional(),
  fromEmail: z.string().optional(),
});

type AttachmentEntry = {
  id: string;
  file: File;
};

type AttachmentPreviewUrlRecord = {
  file: File;
  url: string;
};

export function EmailComposer({
  initialTo = [],
  initialCc = [],
  initialBcc = [],
  initialSubject = '',
  initialMessage = '',
  initialAttachments = [],
  hydratedAttachmentSnapshot,
  onSendEmail,
  onClose,
  className,
  autofocus = false,
  settingsLoading = false,
  editorClassName,
  syncReplyHeadersFromProps = false,
  replyToMessageId = null,
  replyToMessage = null,
  headerPreview = [],
  sendButtonLabel = 'Send',
}: EmailComposerProps) {
  const { data: settings } = useSettings();
  const [showCc, setShowCc] = useState(initialCc.length > 0);
  const [showBcc, setShowBcc] = useState(initialBcc.length > 0);
  const [isLoading, setIsLoading] = useState(false);
  const [isSavingDraft, setIsSavingDraft] = useState(false);
  const [hasUnsavedChanges, setHasUnsavedChanges] = useState(false);
  const [autosaveSuppressedAfterFailure, setAutosaveSuppressedAfterFailure] = useState(false);
  const revisionRef = useRef<DraftRevisionState>({
    localRevision: 0,
    savedRevision: 0,
  });
  const activeDraftIdRef = useRef<string | null>(null);
  const saveInFlightRef = useRef<Promise<'saved' | 'skipped' | 'failed'> | null>(null);
  const markUnsavedChanges = useCallback(() => {
    revisionRef.current = reduceDraftRevision(revisionRef.current, { type: 'edited' });
    setHasUnsavedChanges(true);
    setAutosaveSuppressedAfterFailure(false);
  }, []);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const inlineImageInputRef = useRef<HTMLInputElement>(null);
  const [threadId] = useQueryState('threadId');
  const [isComposeOpen, setIsComposeOpen] = useQueryState('isComposeOpen');
  const [draftId, setDraftId] = useQueryState('draftId');
  const { data: serverDraft } = useDraft(draftId ?? null);
  const { data: threadData } = useThread(threadId ?? null);

  const resolvedReplyToMessage = useMemo(() => {
    if (replyToMessage) return replyToMessage;
    if (replyToMessageId && threadData?.messages) {
      return (
        threadData.messages.find((m) => m.id === replyToMessageId) ??
        (threadData.latest?.id === replyToMessageId ? threadData.latest : null)
      );
    }
    return null;
  }, [replyToMessage, replyToMessageId, threadData?.messages, threadData?.latest]);

  const [isQuoteExcluded, setIsQuoteExcluded] = useState(false);

  useEffect(() => {
    if (draftId) {
      activeDraftIdRef.current = draftId;
    }
  }, [draftId]);

  const [showLeaveConfirmation, setShowLeaveConfirmation] = useState(false);
  const [scheduleAt, setScheduleAt] = useState<string>();
  const [isScheduleValid, setIsScheduleValid] = useState<boolean>(true);
  const [showAttachmentWarning, setShowAttachmentWarning] = useState(false);
  const attachmentEntryIdRef = useRef(initialAttachments.length);
  const initialAttachmentEntries = initialAttachments.map((file, index) => ({
    id: `attachment-${index}`,
    file,
  }));
  const [attachmentEntries, setAttachmentEntries] = useState<AttachmentEntry[]>(
    () => initialAttachmentEntries,
  );
  const originalAttachmentsRef = useRef<AttachmentEntry[]>(initialAttachmentEntries);
  const attachmentQueueRef = useRef<Promise<void>>(Promise.resolve());
  const pendingAttachmentWorkRef = useRef(0);
  const inlineImageQueueRef = useRef<Promise<void>>(Promise.resolve());
  const pendingInlineImageWorkRef = useRef(0);
  const sendInFlightRef = useRef(false);
  const fileDragDepthRef = useRef(0);
  const [isFileDragActive, setIsFileDragActive] = useState(false);
  const [attachmentStatus, setAttachmentStatus] = useState('');
  const [attachmentPreviewUrls, setAttachmentPreviewUrls] = useState<Record<string, string>>({});
  const attachmentPreviewUrlMapRef = useRef(new Map<string, AttachmentPreviewUrlRecord>());
  const [imageQuality, setImageQuality] = useState<ImageQuality>(
    settings?.settings?.imageCompression || 'medium',
  );
  const [activeReplyId] = useQueryState('activeReplyId');
  const [toggleToolbar, setToggleToolbar] = useState(false);

  const attachmentKeywords = [
    'attachment',
    'attached',
    'attaching',
    'see the file',
    'see the files',
  ];

  const trpc = useTRPC();
  const queryClient = useQueryClient();
  const { optimisticDeleteDraft } = useOptimisticActions();
  const { mutateAsync: createDraft } = useMutation(trpc.drafts.create.mutationOptions());

  const form = useForm<z.infer<typeof schema>>({
    resolver: zodResolver(schema),
    defaultValues: {
      to: initialTo,
      cc: initialCc,
      bcc: initialBcc,
      subject: initialSubject,
      message: initialMessage,
      attachments: initialAttachments,
      fromEmail: settings?.settings?.defaultEmailAlias || '',
    },
  });

  const { watch, setValue, getValues } = form;

  const createAttachmentEntry = useCallback(
    (file: File): AttachmentEntry => ({
      id: `attachment-${attachmentEntryIdRef.current++}`,
      file,
    }),
    [],
  );

  const hasSynchronousDraftChanges = useCallback(
    () =>
      hasUnsavedChanges ||
      revisionRef.current.localRevision > revisionRef.current.savedRevision ||
      pendingAttachmentWorkRef.current > 0 ||
      pendingInlineImageWorkRef.current > 0,
    [hasUnsavedChanges],
  );

  const processAndSetAttachments = useCallback(
    async (
      entriesToProcess: AttachmentEntry[],
      quality: ImageQuality,
      showToast: boolean = false,
    ) => {
      const filesToProcess = entriesToProcess.map((entry) => entry.file);
      if (filesToProcess.length === 0) {
        setValue('attachments', [], { shouldDirty: true });
        setAttachmentEntries([]);
        return;
      }

      try {
        const compressedFiles = await compressImages(filesToProcess, {
          quality,
          maxWidth: 1920,
          maxHeight: 1080,
        });

        if (compressedFiles.length !== filesToProcess.length) {
          console.warn('Compressed files array length mismatch:', {
            original: filesToProcess.length,
            compressed: compressedFiles.length,
          });
          setValue('attachments', filesToProcess, { shouldDirty: true });
          setAttachmentEntries(entriesToProcess);
          markUnsavedChanges();
          if (showToast) {
            toast.error('Image compression failed, using original files');
          }
          return;
        }

        const compressedEntries = entriesToProcess.map((entry, index) => ({
          id: entry.id,
          file: compressedFiles[index],
        }));
        setValue('attachments', compressedFiles, { shouldDirty: true });
        setAttachmentEntries(compressedEntries);
        markUnsavedChanges();

        if (showToast && quality !== 'original') {
          let totalOriginalSize = 0;
          let totalCompressedSize = 0;

          const imageFilesExist = filesToProcess.some((file) => file.type.startsWith('image/'));

          if (imageFilesExist) {
            filesToProcess.forEach((originalFile, index) => {
              if (originalFile.type.startsWith('image/') && compressedFiles[index]) {
                totalOriginalSize += originalFile.size;
                totalCompressedSize += compressedFiles[index].size;
              }
            });

            if (totalOriginalSize > totalCompressedSize) {
              const savings = (
                ((totalOriginalSize - totalCompressedSize) / totalOriginalSize) *
                100
              ).toFixed(1);
              if (parseFloat(savings) > 0.1) {
                toast.success(`Images compressed: ${savings}% smaller`);
              }
            }
          }
        }
      } catch (error) {
        console.error('Error compressing images:', error);
        setValue('attachments', filesToProcess, { shouldDirty: true });
        setAttachmentEntries(entriesToProcess);
        markUnsavedChanges();
        if (showToast) {
          toast.error('Image compression failed, using original files');
        }
      }
    },
    [markUnsavedChanges, setValue],
  );

  const externalHeaderSyncKey = useMemo(
    () =>
      [
        emailListSignature(initialTo),
        emailListSignature(initialCc),
        emailListSignature(initialBcc),
        initialSubject ?? '',
      ].join('\f'),
    [initialTo, initialCc, initialBcc, initialSubject],
  );

  useEffect(() => {
    if (!syncReplyHeadersFromProps) return;

    setValue('to', [...initialTo], { shouldDirty: true, shouldTouch: true });
    setValue('cc', [...initialCc], { shouldDirty: true, shouldTouch: true });
    setValue('bcc', [...initialBcc], { shouldDirty: true, shouldTouch: true });
    // Reply/reply-all still updates recipients, but a draft refetch also changes
    // initialSubject. Keep staff ownership of the subject even after autosave.
    if (revisionRef.current.localRevision === 0) {
      setValue('subject', initialSubject ?? '', { shouldDirty: true, shouldTouch: true });
    }
    setShowCc(initialCc.length > 0);
    setShowBcc(initialBcc.length > 0);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- initial* match this key; listing array props would re-run every render (new [] identity from parent).
  }, [externalHeaderSyncKey, syncReplyHeadersFromProps, setValue]);

  const toEmails = watch('to');
  const ccEmails = watch('cc');
  const bccEmails = watch('bcc');
  const subjectInput = watch('subject');
  const attachments = watch('attachments');
  const fromEmail = watch('fromEmail');

  const clearAttachmentState = useCallback(() => {
    originalAttachmentsRef.current = [];
    setValue('attachments', [], { shouldDirty: false });
    setAttachmentEntries([]);
    if (fileInputRef.current) {
      fileInputRef.current.value = '';
    }
  }, [setValue]);

  useEffect(() => {
    const previousMap = attachmentPreviewUrlMapRef.current;
    const nextMap = new Map<string, AttachmentPreviewUrlRecord>();

    attachmentEntries.forEach((attachmentEntry) => {
      const { file } = attachmentEntry;
      if (!file.type.startsWith('image/')) return;
      const existingPreview = previousMap.get(attachmentEntry.id);
      if (existingPreview?.file === file) {
        nextMap.set(attachmentEntry.id, existingPreview);
        return;
      }
      if (existingPreview) {
        URL.revokeObjectURL(existingPreview.url);
      }
      nextMap.set(attachmentEntry.id, {
        file,
        url: URL.createObjectURL(file),
      });
    });

    previousMap.forEach((record, key) => {
      if (!nextMap.has(key)) {
        URL.revokeObjectURL(record.url);
      }
    });

    attachmentPreviewUrlMapRef.current = nextMap;
    setAttachmentPreviewUrls(
      Object.fromEntries(
        Array.from(nextMap, ([attachmentId, record]) => [attachmentId, record.url]),
      ),
    );
  }, [attachmentEntries]);

  useEffect(() => {
    return () => {
      attachmentPreviewUrlMapRef.current.forEach((record) => {
        URL.revokeObjectURL(record.url);
      });
      attachmentPreviewUrlMapRef.current.clear();
    };
  }, []);

  const rejectFileChangeDuringSend = useCallback(() => {
    const message = 'File changes are unavailable while sending';
    setAttachmentStatus(message);
    toast.error(message);
  }, []);

  const enqueueAttachmentTask = useCallback(
    (
      task: () => Promise<void>,
      { marksDraftDirty = false }: { marksDraftDirty?: boolean } = {},
    ) => {
      if (marksDraftDirty) {
        pendingAttachmentWorkRef.current += 1;
        markUnsavedChanges();
      }

      const runTask = async () => {
        try {
          await task();
        } finally {
          if (marksDraftDirty) {
            pendingAttachmentWorkRef.current = Math.max(0, pendingAttachmentWorkRef.current - 1);
          }
        }
      };
      const queuedTask = attachmentQueueRef.current.then(runTask, runTask);
      attachmentQueueRef.current = queuedTask.catch((error) => {
        console.error('Failed to update attachments:', error);
        setAttachmentStatus('Unable to update attachments');
        toast.error('Unable to update attachments');
      });
      return attachmentQueueRef.current;
    },
    [markUnsavedChanges],
  );

  const queueAttachmentCandidates = useCallback(
    (candidates: File[]) => {
      if (sendInFlightRef.current) {
        rejectFileChangeDuringSend();
        return;
      }

      const { accepted, rejected } = partitionComposeAttachmentFiles(candidates);
      const rejectedMessage =
        rejected.length > 0
          ? `${pluralize('unsupported file', rejected.length, true)} not attached`
          : null;

      if (rejectedMessage) {
        toast.error(rejectedMessage);
        setAttachmentStatus(rejectedMessage);
      }
      if (accepted.length === 0) return;

      const acceptedEntries = accepted.map(createAttachmentEntry);
      originalAttachmentsRef.current = [...originalAttachmentsRef.current, ...acceptedEntries];

      return enqueueAttachmentTask(
        async () => {
          await processAndSetAttachments(originalAttachmentsRef.current, imageQuality, true);

          const acceptedMessage = `${pluralize('file', accepted.length, true)} attached`;
          toast.success(acceptedMessage);
          setAttachmentStatus(
            [acceptedMessage, rejectedMessage]
              .filter((message): message is string => Boolean(message))
              .join('. '),
          );
        },
        { marksDraftDirty: true },
      );
    },
    [
      createAttachmentEntry,
      enqueueAttachmentTask,
      imageQuality,
      processAndSetAttachments,
      rejectFileChangeDuringSend,
    ],
  );

  const handleAttachment = useCallback(
    (newFiles: File[]) => queueAttachmentCandidates(newFiles),
    [queueAttachmentCandidates],
  );

  const enqueueInlineImageTask = useCallback(
    (task: () => Promise<void>) => {
      pendingInlineImageWorkRef.current += 1;
      markUnsavedChanges();

      const runTask = async () => {
        try {
          await task();
        } finally {
          pendingInlineImageWorkRef.current = Math.max(0, pendingInlineImageWorkRef.current - 1);
        }
      };
      const queuedTask = inlineImageQueueRef.current.then(runTask, runTask);
      inlineImageQueueRef.current = queuedTask.catch((error) => {
        console.error('Failed to insert inline image:', error);
        setAttachmentStatus('Unable to insert image');
        toast.error('Unable to insert image');
      });
      return inlineImageQueueRef.current;
    },
    [markUnsavedChanges],
  );

  const removeAttachment = useCallback(
    (attachmentId: string) => {
      if (sendInFlightRef.current) {
        rejectFileChangeDuringSend();
        return;
      }

      return enqueueAttachmentTask(
        async () => {
          const newOriginals = originalAttachmentsRef.current.filter(
            (entry) => entry.id !== attachmentId,
          );
          originalAttachmentsRef.current = newOriginals;
          await processAndSetAttachments(newOriginals, imageQuality);
          setAttachmentStatus('Attachment removed');
        },
        { marksDraftDirty: true },
      );
    },
    [enqueueAttachmentTask, imageQuality, processAndSetAttachments, rejectFileChangeDuringSend],
  );

  const editor = useComposeEditor({
    initialValue: initialMessage,
    isReadOnly: isLoading,
    onLengthChange: () => {
      markUnsavedChanges();
    },
    onModEnter: () => {
      void handleSend();
      return true;
    },
    onAttachmentsChange: async (files) => {
      await handleAttachment(files);
    },
    enableInlineFileHandling: false,
    placeholder: 'Start your email here',
    autofocus,
  });

  const hydratedSnapshotRef = useRef<string | null>(null);
  useEffect(() => {
    if (
      !hydratedAttachmentSnapshot ||
      hydratedSnapshotRef.current === hydratedAttachmentSnapshot.key ||
      revisionRef.current.localRevision > 0
    )
      return;
    hydratedSnapshotRef.current = hydratedAttachmentSnapshot.key;
    const files = hydratedAttachmentSnapshot.files;
    setValue('attachments', files, { shouldDirty: false });
    const entries = files.map((file) => ({
      id: `attachment-${attachmentEntryIdRef.current++}`,
      file,
    }));
    setAttachmentEntries(entries);
    originalAttachmentsRef.current = entries;
  }, [hydratedAttachmentSnapshot, setValue]);

  const attachReviewedSnapshot = async () => {
    if (!hydratedAttachmentSnapshot) return;
    const current = getValues('attachments') ?? [];
    const verified = await uniqueVerifiedFiles(current, hydratedAttachmentSnapshot.files);
    const latest = getValues('attachments') ?? [];
    const files = [...latest, ...verified.filter((file) => !latest.includes(file))];
    setValue('attachments', files, { shouldDirty: true });
    const entries = files.map((file) => ({
      id: `attachment-${attachmentEntryIdRef.current++}`,
      file,
    }));
    setAttachmentEntries(entries);
    originalAttachmentsRef.current = entries;
    hydratedSnapshotRef.current = hydratedAttachmentSnapshot.key;
    markUnsavedChanges();
  };

  // Add effect to focus editor when component mounts
  useEffect(() => {
    if (autofocus && editor) {
      const timeoutId = setTimeout(() => {
        editor.commands.focus('end');
      }, 100);
      return () => clearTimeout(timeoutId);
    }
  }, [editor, autofocus]);

  useEffect(() => {
    if (!editor || !serverDraft) return;

    const editorState = chooseDraftEditorState({
      hasLocalEdits: revisionRef.current.localRevision > 0,
      localHtml: editor.getHTML(),
      localSubject: subjectInput,
      serverDraft,
    });

    if (editorState.source !== 'server') return;

    if (editorState.html !== editor.getHTML()) {
      editor.commands.setContent(editorState.html, false);
    }
    if (editorState.subject !== subjectInput) {
      setValue('subject', editorState.subject, { shouldDirty: false });
    }
  }, [editor, serverDraft, setValue, subjectInput]);

  // Remove the TRPC query - we'll use the component's internal logic instead
  useEffect(() => {
    if (isComposeOpen === 'true' && editor) {
      editor.commands.focus();
    }
  }, [isComposeOpen, editor]);

  // Prevent browser navigation/refresh when there's unsaved content
  useEffect(() => {
    if (!editor) return;

    const handleBeforeUnload = (e: BeforeUnloadEvent) => {
      const values = getValues();
      if (
        shouldPersistDraft({
          hasUnsavedChanges: hasSynchronousDraftChanges(),
          existingDraftId: activeDraftIdRef.current,
          initialHtml: initialMessage ?? '',
          html: editor.getHTML(),
          text: editor.getText(),
          to: values.to ?? [],
          subject: values.subject ?? '',
          aiBlocked: false,
        })
      ) {
        e.preventDefault();
        e.returnValue = ''; // Required for Chrome
      }
    };

    window.addEventListener('beforeunload', handleBeforeUnload);
    return () => window.removeEventListener('beforeunload', handleBeforeUnload);
  }, [editor, getValues, hasSynchronousDraftChanges, initialMessage]);

  const drainAttachmentWork = useCallback(async () => {
    for (;;) {
      const queue = attachmentQueueRef.current;
      await drainAttachmentIntakeQueue(
        () => attachmentQueueRef.current,
        () => pendingAttachmentWorkRef.current,
      );

      if (queue === attachmentQueueRef.current && pendingAttachmentWorkRef.current === 0) {
        return;
      }
    }
  }, []);

  const drainInlineImageWork = useCallback(async () => {
    for (;;) {
      const queue = inlineImageQueueRef.current;
      await drainAttachmentIntakeQueue(
        () => inlineImageQueueRef.current,
        () => pendingInlineImageWorkRef.current,
      );

      if (queue === inlineImageQueueRef.current && pendingInlineImageWorkRef.current === 0) {
        return;
      }
    }
  }, []);

  const drainComposeFileWork = useCallback(async () => {
    for (;;) {
      const attachmentQueue = attachmentQueueRef.current;
      const inlineImageQueue = inlineImageQueueRef.current;
      await drainAttachmentWork();
      await drainInlineImageWork();

      if (
        attachmentQueue === attachmentQueueRef.current &&
        inlineImageQueue === inlineImageQueueRef.current &&
        pendingAttachmentWorkRef.current === 0 &&
        pendingInlineImageWorkRef.current === 0
      ) {
        return;
      }
    }
  }, [drainAttachmentWork, drainInlineImageWork]);

  const proceedWithSend = async (sendAlreadyGuarded = false) => {
    const ownsSendGuard = !sendAlreadyGuarded;
    if (ownsSendGuard) {
      if (sendInFlightRef.current) return;
      sendInFlightRef.current = true;
    }

    try {
      if (isLoading) return;
      await drainComposeFileWork();

      // Validate recipient field
      if (!getValues().to || getValues().to.length === 0) {
        toast.error('Recipient is required');
        return;
      }

      if (!isScheduleValid) {
        toast.error('Please choose a valid date & time for scheduling');
        return;
      }

      setIsLoading(true);

      const flushed = await flushDraftUntilCurrent();
      if (!flushed) return;

      const values = getValues();
      const sent = await onSendEmail({
        to: values.to,
        cc: showCc ? values.cc : undefined,
        bcc: showBcc ? values.bcc : undefined,
        subject: values.subject,
        message: editor.getHTML(),
        attachments: values.attachments || [],
        fromEmail: values.fromEmail,
        scheduleAt,
        draftId: activeDraftIdRef.current ?? undefined,
        excludeQuotedHistory: isQuoteExcluded,
      });
      if (!sent) return;

      void Promise.all([
        queryClient.invalidateQueries({ queryKey: trpc.drafts.list.queryKey() }),
        queryClient.invalidateQueries({ queryKey: trpc.mail.unreadCounts.queryKey() }),
        queryClient.invalidateQueries({ queryKey: trpc.mail.listThreads.infiniteQueryKey() }),
      ]);

      activeDraftIdRef.current = null;
      void setDraftId(null);
      setHasUnsavedChanges(false);
      revisionRef.current = { localRevision: 0, savedRevision: 0 };
      editor.commands.clearContent(false);
      form.reset();
      clearAttachmentState();
      setIsComposeOpen(null);
    } catch (error) {
      if (isStaleDraftSendCancelled(error)) return;
      console.error('Error sending email:', error);
      toast.error('Failed to send email');
    } finally {
      if (ownsSendGuard) {
        sendInFlightRef.current = false;
      }
      setIsLoading(false);
    }
  };

  const handleSend = async () => {
    if (sendInFlightRef.current) return;
    sendInFlightRef.current = true;

    try {
      await drainComposeFileWork();
      const values = getValues();
      const messageText = editor.getText().toLowerCase();
      const hasAttachmentKeywords = attachmentKeywords.some((keyword) => {
        const regex = new RegExp(`\\b${keyword.replace(/\s+/g, '\\s+')}\\b`, 'i');
        return regex.test(messageText);
      });

      if (hasAttachmentKeywords && (!values.attachments || values.attachments.length === 0)) {
        setShowAttachmentWarning(true);
        return;
      }

      await proceedWithSend(true);
    } finally {
      sendInFlightRef.current = false;
    }
  };

  const persistDraftOnce = useCallback((): Promise<'saved' | 'skipped' | 'failed'> => {
    if (saveInFlightRef.current) return saveInFlightRef.current;

    let savePromise: Promise<'saved' | 'skipped' | 'failed'> | null = null;
    savePromise = (async (): Promise<'saved' | 'skipped' | 'failed'> => {
      try {
        await drainComposeFileWork();
        const capturedRevision = revisionRef.current.localRevision;
        const values = getValues();
        const snapshot = {
          hasUnsavedChanges: hasSynchronousDraftChanges(),
          initialHtml: initialMessage ?? '',
          aiBlocked: false,
          draftId: activeDraftIdRef.current,
          threadId: threadId ?? null,
          replyToMessageId,
          to: [...(values.to ?? [])],
          cc: [...(values.cc ?? [])],
          bcc: [...(values.bcc ?? [])],
          subject: values.subject ?? '',
          html: editor.getHTML(),
          text: editor.getText(),
          fromEmail: values.fromEmail || undefined,
          attachments: [...(values.attachments ?? [])] as File[],
        };

        if (
          !shouldPersistDraft({
            hasUnsavedChanges: snapshot.hasUnsavedChanges,
            existingDraftId: snapshot.draftId,
            initialHtml: snapshot.initialHtml,
            html: snapshot.html,
            text: snapshot.text,
            to: snapshot.to,
            subject: snapshot.subject,
            aiBlocked: snapshot.aiBlocked,
          })
        ) {
          return 'skipped';
        }

        setIsSavingDraft(true);
        const draftData = buildDraftMutationInput({
          draftId: snapshot.draftId,
          threadId: snapshot.threadId,
          replyToMessageId: snapshot.replyToMessageId,
          to: snapshot.to,
          cc: snapshot.cc,
          bcc: snapshot.bcc,
          subject: snapshot.subject,
          html: snapshot.html,
          fromEmail: snapshot.fromEmail,
          attachments: await serializeFiles(snapshot.attachments),
        });

        const response = isFrontendOnlyDemo()
          ? await demoUpsertDraft(draftData)
          : await createDraft(draftData);

        if (response?.id) {
          activeDraftIdRef.current = response.id;
          if (response.id !== draftId) {
            void setDraftId(response.id);
          }
        }

        if (isFrontendOnlyDemo()) {
          void queryClient.invalidateQueries({ queryKey: [...DEMO_MAIL_LIST_DRAFTS_QUERY_PREFIX] });
        } else {
          const savedDraftId = response?.id ?? snapshot.draftId;
          void Promise.all([
            queryClient.invalidateQueries({ queryKey: trpc.drafts.list.queryKey() }),
            queryClient.invalidateQueries({ queryKey: trpc.mail.unreadCounts.queryKey() }),
            savedDraftId
              ? queryClient.invalidateQueries({
                  queryKey: trpc.drafts.get.queryKey({ id: savedDraftId }),
                })
              : Promise.resolve(),
            threadId
              ? queryClient.invalidateQueries({
                  queryKey: trpc.mail.get.queryKey({ id: threadId }),
                })
              : Promise.resolve(),
            queryClient.invalidateQueries({ queryKey: trpc.mail.listThreads.infiniteQueryKey() }),
          ]);
        }

        revisionRef.current = reduceDraftRevision(revisionRef.current, {
          type: 'saved',
          capturedRevision,
        });
        setHasUnsavedChanges(revisionRef.current.localRevision > revisionRef.current.savedRevision);
        return 'saved';
      } catch (error) {
        console.error('Error saving draft:', error);
        toast.error('Failed to save draft');
        setAutosaveSuppressedAfterFailure(true);
        return 'failed';
      } finally {
        if (saveInFlightRef.current === savePromise) {
          saveInFlightRef.current = null;
        }
        setIsSavingDraft(false);
      }
    })();

    saveInFlightRef.current = savePromise;
    return savePromise;
  }, [
    createDraft,
    draftId,
    editor,
    drainComposeFileWork,
    getValues,
    hasSynchronousDraftChanges,
    initialMessage,
    queryClient,
    replyToMessageId,
    setDraftId,
    threadId,
    trpc,
  ]);

  const flushDraftUntilCurrent = useCallback(async (): Promise<boolean> => {
    for (;;) {
      const result = await persistDraftOnce();
      if (result === 'failed') return false;
      if (result === 'skipped') return true;
      if (revisionRef.current.savedRevision >= revisionRef.current.localRevision) {
        return true;
      }
    }
  }, [persistDraftOnce]);

  const saveDraft = useCallback(async (): Promise<boolean> => {
    return flushDraftUntilCurrent();
  }, [flushDraftUntilCurrent]);

  const buildPersistInput = useCallback((): PersistDecisionInput => {
    const values = getValues();
    return {
      hasUnsavedChanges: hasSynchronousDraftChanges(),
      existingDraftId: activeDraftIdRef.current,
      initialHtml: initialMessage ?? '',
      html: editor?.getHTML() ?? '',
      text: editor?.getText() ?? '',
      to: values.to ?? [],
      subject: values.subject ?? '',
      aiBlocked: false,
    };
  }, [hasSynchronousDraftChanges, initialMessage, editor, getValues]);

  const handleClose = useCallback(() => {
    const action = resolveComposeCloseAction({ ...buildPersistInput(), intent: 'userClose' });
    if (action === 'closeSilent') {
      onClose?.();
      return;
    }
    setShowLeaveConfirmation(true);
  }, [buildPersistInput, onClose]);

  const handleEscapeClose = useCallback(
    (isComposing: boolean) => {
      const action = resolveComposeEscapeAction({ ...buildPersistInput(), isComposing });
      if (action === 'ignore') return;
      if (action === 'closeSilent') {
        onClose?.();
        return;
      }
      setShowLeaveConfirmation(true);
    },
    [buildPersistInput, onClose],
  );

  const handleDialogChoice = useCallback(
    async (choice: ComposeDialogChoice) => {
      const next = nextAfterDialogChoice(choice);
      if (next === 'dismiss') {
        setShowLeaveConfirmation(false);
        return;
      }
      if (next === 'saveThenClose') {
        const ok = await saveDraft();
        if (!ok && shouldPersistDraft(buildPersistInput())) return;
        setShowLeaveConfirmation(false);
        onClose?.();
        return;
      }
      if (draftId) {
        optimisticDeleteDraft(draftId);
      }
      setShowLeaveConfirmation(false);
      onClose?.();
    },
    [buildPersistInput, draftId, onClose, optimisticDeleteDraft, saveDraft],
  );

  useEffect(() => {
    const flush = async () => {
      const values = getValues();
      const action = resolveComposeCloseAction({
        hasUnsavedChanges: hasSynchronousDraftChanges(),
        existingDraftId: activeDraftIdRef.current,
        initialHtml: initialMessage ?? '',
        html: editor?.getHTML() ?? '',
        text: editor?.getText() ?? '',
        to: values.to ?? [],
        subject: values.subject ?? '',
        aiBlocked: false,
        intent: 'threadSwitch',
      });
      if (action === 'flushAndLeave') {
        await saveDraft();
      }
    };
    registerComposeFlush(flush);
    return () => registerComposeFlush(null);
  }, [hasSynchronousDraftChanges, initialMessage, editor, saveDraft, getValues]);

  useEffect(() => {
    if (!editor) return;

    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        e.stopPropagation();
        handleEscapeClose(e.isComposing);
      }
    };

    document.addEventListener('keydown', handleKeyDown, true);
    return () => document.removeEventListener('keydown', handleKeyDown, true);
  }, [editor, handleEscapeClose]);

  // Component unmount protection
  useEffect(() => {
    return () => {
      // This cleanup runs when component is about to unmount
      const hasContent = editor?.getText()?.trim().length > 0;
      if (hasContent && !showLeaveConfirmation) {
        // If we have content and haven't shown confirmation, it means
        // the component is being unmounted unexpectedly
        console.warn('Email composer unmounting with unsaved content');
      }
    };
  }, [editor, showLeaveConfirmation]);

  useEffect(() => {
    if (isSavingDraft || !hasUnsavedChanges || autosaveSuppressedAfterFailure) return;

    const autoSaveTimer = setTimeout(() => {
      void persistDraftOnce();
    }, 3000);

    return () => clearTimeout(autoSaveTimer);
  }, [autosaveSuppressedAfterFailure, hasUnsavedChanges, isSavingDraft, persistDraftOnce]);

  // keep fromEmail in sync when settings load
  useEffect(() => {
    const preferred = settings?.settings?.defaultEmailAlias || '';

    if (preferred && getValues('fromEmail') !== preferred) {
      setValue('fromEmail', preferred, { shouldDirty: false });
    }
  }, [settings?.settings?.defaultEmailAlias, getValues, setValue]);

  const handleFileDragEnter = useCallback((event: React.DragEvent<HTMLDivElement>) => {
    if (!hasFileDrag(event.dataTransfer)) return;

    event.preventDefault();
    fileDragDepthRef.current += 1;
    setIsFileDragActive(true);
    setAttachmentStatus('Drop files to attach');
  }, []);

  const handleFileDragOver = useCallback((event: React.DragEvent<HTMLDivElement>) => {
    if (!hasFileDrag(event.dataTransfer)) return;

    event.preventDefault();
    event.dataTransfer.dropEffect = 'copy';
  }, []);

  const handleFileDragLeave = useCallback((event: React.DragEvent<HTMLDivElement>) => {
    if (!hasFileDrag(event.dataTransfer)) return;

    fileDragDepthRef.current = Math.max(0, fileDragDepthRef.current - 1);
    if (fileDragDepthRef.current === 0) {
      setIsFileDragActive(false);
      setAttachmentStatus('');
    }
  }, []);

  const handleFileDrop = useCallback(
    (event: React.DragEvent<HTMLDivElement>) => {
      if (!hasFileDrag(event.dataTransfer)) return;

      event.preventDefault();
      event.stopPropagation();
      fileDragDepthRef.current = 0;
      setIsFileDragActive(false);

      const droppedFiles = Array.from(event.dataTransfer.files);
      if (droppedFiles.length === 0) {
        setAttachmentStatus('No files to attach');
        return;
      }

      setAttachmentStatus('Attaching files');
      void queueAttachmentCandidates(droppedFiles);
    },
    [queueAttachmentCandidates],
  );

  const handlePasteFiles = useCallback(
    (event: React.ClipboardEvent<HTMLDivElement>) => {
      const clipboardData = event.clipboardData;
      if (!clipboardData || !clipboardData.files.length) return;

      event.preventDefault();
      event.stopPropagation();
      setAttachmentStatus('Attaching files');
      void queueAttachmentCandidates(Array.from(clipboardData.files));
    },
    [queueAttachmentCandidates],
  );

  const handleInlineImage = useCallback(
    (event: React.ChangeEvent<HTMLInputElement>) => {
      const file = event.target.files?.[0];
      event.target.value = '';
      if (!file || !editor) return;

      if (sendInFlightRef.current) {
        rejectFileChangeDuringSend();
        return;
      }

      if (!file.type.startsWith('image/')) {
        const message = 'Only image files can be inserted inline';
        setAttachmentStatus(message);
        toast.error(message);
        return;
      }

      return enqueueInlineImageTask(
        () =>
          new Promise<void>((resolve) => {
            const reader = new FileReader();
            const fail = () => {
              setAttachmentStatus('Unable to insert image');
              toast.error('Unable to insert image');
              resolve();
            };

            reader.onload = () => {
              if (typeof reader.result !== 'string') {
                fail();
                return;
              }

              try {
                editor
                  .chain()
                  .insertContentAt(editor.state.selection.anchor, {
                    type: 'image',
                    attrs: {
                      src: reader.result,
                    },
                  })
                  .focus()
                  .run();
                setAttachmentStatus('Image inserted into email');
                resolve();
              } catch {
                fail();
              }
            };
            reader.onerror = fail;
            reader.onabort = fail;
            reader.readAsDataURL(file);
          }),
      );
    },
    [editor, enqueueInlineImageTask, rejectFileChangeDuringSend],
  );

  const handleQualityChange = (newQuality: ImageQuality) => {
    if (sendInFlightRef.current) {
      rejectFileChangeDuringSend();
      return;
    }

    setImageQuality(newQuality);
    return enqueueAttachmentTask(
      async () => {
        await processAndSetAttachments(originalAttachmentsRef.current, newQuality, true);
        setAttachmentStatus('Attachment compression updated');
      },
      { marksDraftDirty: true },
    );
  };

  const handleInlineImagePickerClick = useCallback(() => {
    if (sendInFlightRef.current) {
      rejectFileChangeDuringSend();
      return;
    }
    inlineImageInputRef.current?.click();
  }, [rejectFileChangeDuringSend]);

  const handleScheduleChange = useCallback((value?: string) => {
    setScheduleAt(value);
  }, []);

  const handleScheduleValidityChange = useCallback((valid: boolean) => {
    setIsScheduleValid(valid);
  }, []);

  const replaceEmojiShortcodes = (text: string): string => {
    if (!text.trim().length || !text.includes(':')) return text;
    return text.replace(shortcodeRegex, (match, shortcode): string => {
      const emoji = gitHubEmojis.find(
        (e) => e.shortcodes.includes(shortcode) || e.name === shortcode,
      );
      return emoji?.emoji ?? match;
    });
  };

  const sendButton = (
    <Button
      size={'xs'}
      onClick={handleSend}
      disabled={isLoading || settingsLoading || !isScheduleValid}
    >
      <div className="flex items-center justify-center">
        <div className="text-primary-foreground text-center text-sm leading-none">
          <span>{sendButtonLabel} </span>
        </div>
      </div>
      <div className="bg-primary-foreground/10 flex h-5 items-center justify-center gap-1 rounded-sm px-1">
        <Command className="text-primary-foreground h-3.5 w-3.5" />
        <CurvedArrow className="fill-primary-foreground mt-1.5 h-4 w-4" />
      </div>
    </Button>
  );

  return (
    <div
      onPasteCapture={handlePasteFiles}
      onDragEnter={handleFileDragEnter}
      onDragOver={handleFileDragOver}
      onDragLeave={handleFileDragLeave}
      onDropCapture={handleFileDrop}
      className={cn(
        'relative flex max-h-[500px] w-full max-w-[750px] flex-col overflow-hidden rounded-2xl bg-[#FAFAFA] shadow-sm dark:bg-[#202020]',
        className,
      )}
    >
      <div role="status" aria-live="polite" className="sr-only">
        {attachmentStatus}
      </div>
      {isFileDragActive ? (
        <div
          aria-hidden="true"
          className="pointer-events-none absolute inset-0 z-10 flex items-center justify-center bg-black/20"
        >
          <span className="bg-background rounded-md px-4 py-2 text-sm font-medium shadow-sm">
            Drop files to attach
          </span>
        </div>
      ) : null}
      <div className="no-scrollbar dark:bg-panelDark flex min-h-0 flex-1 flex-col overflow-y-auto rounded-2xl">
        {/* To, Cc, Bcc */}
        <div className="shrink-0 overflow-visible border-b border-[#E7E7E7] pb-2 dark:border-[#252525]">
          <div className="flex min-w-0 justify-between px-3 pt-3">
            <div className="flex min-w-0 flex-1 items-center gap-2">
              <p className="shrink-0 text-sm font-medium text-[#8C8C8C]">To:</p>
              <RecipientAutosuggest
                control={form.control}
                name="to"
                placeholder="Enter email address"
                disabled={isLoading}
                onValueChange={markUnsavedChanges}
              />
            </div>

            <div className="flex shrink-0 gap-2">
              <button
                type="button"
                className="flex h-full cursor-pointer items-center gap-2 rounded-sm px-1 py-0.5 text-sm font-medium text-[#8C8C8C] transition-colors hover:bg-gray-50 hover:text-[#A8A8A8] dark:hover:bg-[#404040]"
                onClick={() => setShowCc(!showCc)}
              >
                <span>Cc</span>
              </button>
              <button
                type="button"
                className="flex h-full cursor-pointer items-center gap-2 rounded-sm px-1 py-0.5 text-sm font-medium text-[#8C8C8C] transition-colors hover:bg-gray-50 hover:text-[#A8A8A8] dark:hover:bg-[#404040]"
                onClick={() => setShowBcc(!showBcc)}
              >
                <span>Bcc</span>
              </button>
              {onClose && (
                <button
                  type="button"
                  aria-label="Close composer"
                  className="flex h-full cursor-pointer items-center gap-2 rounded-sm px-1 py-0.5 text-sm font-medium text-[#8C8C8C] transition-colors hover:bg-gray-50 hover:text-[#A8A8A8] dark:hover:bg-[#404040]"
                  onClick={handleClose}
                >
                  <X className="h-3.5 w-3.5 fill-[#9A9A9A]" />
                </button>
              )}
            </div>
          </div>

          <div className={`flex flex-col gap-2 ${showCc || showBcc ? 'pt-2' : ''}`}>
            {/* CC Section */}
            {showCc && (
              <div className="flex min-w-0 items-center gap-2 px-3">
                <p className="shrink-0 text-sm font-medium text-[#8C8C8C]">Cc:</p>
                <RecipientAutosuggest
                  control={form.control}
                  name="cc"
                  placeholder="Enter email for Cc"
                  disabled={isLoading}
                  onValueChange={markUnsavedChanges}
                />
              </div>
            )}

            {/* BCC Section */}
            {showBcc && (
              <div className="flex min-w-0 items-center gap-2 px-3">
                <p className="shrink-0 text-sm font-medium text-[#8C8C8C]">Bcc:</p>
                <RecipientAutosuggest
                  control={form.control}
                  name="bcc"
                  placeholder="Enter email for Bcc"
                  disabled={isLoading}
                  onValueChange={markUnsavedChanges}
                />
              </div>
            )}
          </div>
        </div>

        {/* Subject */}
        {!activeReplyId ? (
          <div className="flex items-center gap-2 border-b p-3">
            <p className="text-sm font-medium text-[#8C8C8C]">Subject:</p>
            <input
              id="compose-subject"
              name="subject"
              className="h-4 w-full bg-transparent text-sm font-normal leading-normal text-black placeholder:text-[#797979] focus:outline-none dark:text-white/90"
              placeholder="Re: Design review feedback"
              value={subjectInput}
              onChange={(e) => {
                const value = replaceEmojiShortcodes(e.target.value);
                setValue('subject', value);
                markUnsavedChanges();
              }}
            />
          </div>
        ) : null}

        <input type="hidden" name="fromEmail" value={fromEmail || ''} />

        {headerPreview.length > 0 ? (
          <div className="border-t bg-[#FFFFFF] px-3 py-2 text-xs dark:bg-[#202020]">
            <p className="mb-1 font-medium text-[#8C8C8C]">Headers on send</p>
            <pre className="max-h-32 overflow-auto whitespace-pre-wrap rounded-md bg-black/[0.03] p-2 font-mono text-[11px] leading-5 dark:bg-white/[0.06]">
              {headerPreview.map((line) => line.line).join('\n')}
            </pre>
          </div>
        ) : null}

        {/* Message Content */}
        <div
          className={cn(
            'flex-1 overflow-y-auto border-t bg-[#FFFFFF] px-3 py-3 outline-white/5 dark:bg-[#202020]',
            NATIVE_VISIBLE_SCROLLBAR_CLASSES,
          )}
        >
          <div
            onClick={() => {
              editor.commands.focus();
            }}
            className={cn(`min-h-[200px] w-full`, editorClassName)}
          >
            <EditorContent editor={editor} className="h-full w-full max-w-full overflow-x-auto" />
          </div>
          {resolvedReplyToMessage && (
            <QuoteHistoryExpander
              replyToMessage={resolvedReplyToMessage}
              isExcluded={isQuoteExcluded}
              onExcludeChange={setIsQuoteExcluded}
            />
          )}
        </div>
      </div>

      {/* Bottom Actions */}
      <div className="inline-flex w-full shrink-0 items-end justify-between self-stretch rounded-b-2xl bg-[#FFFFFF] px-3 py-3 outline-white/5 dark:bg-[#202020]">
        <div className="flex flex-col items-start justify-start gap-2">
          {hydratedAttachmentSnapshot &&
          hydratedSnapshotRef.current !== hydratedAttachmentSnapshot.key ? (
            <Button type="button" variant="outline" onClick={attachReviewedSnapshot}>
              Attach reviewed draft files
            </Button>
          ) : null}
          {toggleToolbar && <Toolbar editor={editor} />}
          <div className="flex flex-wrap items-center justify-start gap-2">
            {sendButton}
            <ScheduleSendPicker
              value={scheduleAt}
              onChange={handleScheduleChange}
              onValidityChange={handleScheduleValidityChange}
            />
            <Button
              variant={'secondary'}
              size={'xs'}
              onClick={() => fileInputRef.current?.click()}
              disabled={isLoading}
              className="bg-background cursor-pointer border transition-colors hover:bg-gray-50 dark:hover:bg-[#404040]"
            >
              <Plus className="h-3 w-3 fill-[#9A9A9A]" />
              <span className="hidden px-0.5 text-sm md:block">Add</span>
            </Button>
            <Button
              type="button"
              variant="secondary"
              size="xs"
              aria-label="Insert image"
              onClick={handleInlineImagePickerClick}
              disabled={isLoading}
              className="bg-background cursor-pointer border transition-colors hover:bg-gray-50 dark:hover:bg-[#404040]"
            >
              <ImagePlus className="h-3 w-3" />
              <span className="px-0.5 text-sm">Insert image</span>
            </Button>
            <TemplateButton
              editor={editor}
              subject={subjectInput}
              setSubject={(value) => setValue('subject', value)}
              to={toEmails}
              cc={ccEmails ?? []}
              bcc={bccEmails ?? []}
              setRecipients={(field, val) => setValue(field, val)}
              onApply={markUnsavedChanges}
            />
            <Input
              type="file"
              id="attachment-input"
              className="hidden"
              onChange={(event) => {
                const fileList = event.target.files;
                if (fileList) {
                  void queueAttachmentCandidates(Array.from(fileList));
                }
                event.target.value = '';
              }}
              multiple
              accept={COMPOSE_ATTACHMENT_ACCEPT}
              disabled={isLoading}
              ref={fileInputRef}
              style={{ zIndex: 100 }}
            />
            <Input
              type="file"
              id="inline-image-input"
              className="hidden"
              accept="image/*"
              disabled={isLoading}
              ref={inlineImageInputRef}
              onChange={handleInlineImage}
            />
            {attachments && attachments.length > 0 && (
              <Popover modal={true}>
                <PopoverTrigger asChild>
                  <button
                    className="focus-visible:ring-ring flex cursor-pointer items-center gap-1.5 rounded-md border border-[#E7E7E7] bg-white/5 px-2 py-1 text-sm hover:bg-white/10 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-offset-2 dark:border-[#2B2B2B]"
                    aria-label={`View ${attachments.length} attached ${pluralize('file', attachments.length)}`}
                  >
                    <Paperclip className="h-3.5 w-3.5 text-[#9A9A9A]" />
                    <span className="font-medium">{attachments.length}</span>
                  </button>
                </PopoverTrigger>
                <PopoverContent
                  className="z-100 w-[340px] rounded-lg p-0 shadow-lg dark:bg-[#202020]"
                  align="start"
                  sideOffset={6}
                >
                  <div className="flex flex-col">
                    <div className="border-b border-[#E7E7E7] p-3 dark:border-[#2B2B2B]">
                      <h4 className="text-sm font-semibold text-black dark:text-white/90">
                        Attachments
                      </h4>
                      <p className="text-muted-foreground text-xs dark:text-[#9B9B9B]">
                        {pluralize('file', attachments.length, true)}
                      </p>
                    </div>

                    <div className="border-b border-[#E7E7E7] p-3 dark:border-[#2B2B2B]">
                      <ImageCompressionSettings
                        quality={imageQuality}
                        onQualityChange={handleQualityChange}
                        className="border-0 shadow-none"
                      />
                    </div>

                    <div className="max-h-[250px] flex-1 space-y-0.5 overflow-y-auto p-1.5 [-ms-overflow-style:none] [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
                      {attachmentEntries.map((attachmentEntry) => {
                        const { file } = attachmentEntry;
                        const attachmentKey = attachmentEntry.id;
                        const nameParts = file.name.split('.');
                        const extension = nameParts.length > 1 ? nameParts.pop() : undefined;
                        const nameWithoutExt = nameParts.join('.');
                        const maxNameLength = 22;
                        const truncatedName =
                          nameWithoutExt.length > maxNameLength
                            ? `${nameWithoutExt.slice(0, maxNameLength)}…`
                            : nameWithoutExt;
                        return (
                          <div
                            key={attachmentEntry.id}
                            className="group flex items-center justify-between gap-3 rounded-md px-1.5 py-1.5 hover:bg-black/5 dark:hover:bg-white/10"
                          >
                            <div className="flex min-w-0 flex-1 items-center gap-3">
                              <div className="flex h-7 w-7 shrink-0 items-center justify-center rounded bg-[#F0F0F0] dark:bg-[#2C2C2C]">
                                {file.type.startsWith('image/') ? (
                                  <img
                                    src={attachmentPreviewUrls[attachmentKey]}
                                    alt={file.name}
                                    className="h-full w-full rounded object-cover"
                                    aria-hidden="true"
                                  />
                                ) : (
                                  <span className="text-sm" aria-hidden="true">
                                    {file.type.includes('pdf')
                                      ? '📄'
                                      : file.type.includes('excel') ||
                                          file.type.includes('spreadsheetml')
                                        ? '📊'
                                        : file.type.includes('word') ||
                                            file.type.includes('wordprocessingml')
                                          ? '📝'
                                          : '📎'}
                                  </span>
                                )}
                              </div>
                              <div className="flex min-w-0 flex-1 flex-col">
                                <p
                                  className="flex items-baseline text-sm text-black dark:text-white/90"
                                  title={file.name}
                                >
                                  <span className="truncate">{truncatedName}</span>
                                  {extension && (
                                    <span className="ml-0.5 shrink-0 text-[10px] text-[#8C8C8C] dark:text-[#9A9A9A]">
                                      .{extension}
                                    </span>
                                  )}
                                </p>
                                <p className="text-muted-foreground text-xs dark:text-[#9B9B9B]">
                                  {formatFileSize(file.size)}
                                </p>
                              </div>
                            </div>
                            <button
                              type="button"
                              onClick={async (e: React.MouseEvent<HTMLButtonElement>) => {
                                e.preventDefault();
                                e.stopPropagation();

                                try {
                                  await removeAttachment(attachmentEntry.id);
                                } catch (error) {
                                  console.error('Failed to remove attachment:', error);
                                  toast.error('Failed to remove attachment');
                                }
                              }}
                              className="focus-visible:ring-ring ml-1 flex h-6 w-6 shrink-0 cursor-pointer items-center justify-center rounded-full bg-transparent hover:bg-black/5 focus-visible:outline-none focus-visible:ring-2"
                              aria-label={`Remove ${file.name}`}
                            >
                              <XIcon className="text-muted-foreground h-3.5 w-3.5 hover:text-black dark:text-[#9B9B9B] dark:hover:text-white" />
                            </button>
                          </div>
                        );
                      })}
                    </div>
                  </div>
                </PopoverContent>
              </Popover>
            )}
            <TooltipProvider>
              <Tooltip>
                <TooltipTrigger asChild>
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon"
                    onClick={() => setToggleToolbar(!toggleToolbar)}
                    className={`h-auto w-auto rounded p-1.5 ${toggleToolbar ? 'bg-muted' : 'bg-background'} cursor-pointer border transition-colors hover:bg-gray-50 dark:hover:bg-[#404040]`}
                  >
                    <Type className="h-4 w-4" />
                  </Button>
                </TooltipTrigger>
                <TooltipContent>Formatting options</TooltipContent>
              </Tooltip>
            </TooltipProvider>
          </div>
        </div>
      </div>

      <Dialog open={showLeaveConfirmation} onOpenChange={setShowLeaveConfirmation}>
        <DialogContent showOverlay className="z-99999 sm:max-w-[425px]">
          <DialogHeader>
            <DialogTitle>{m['common.replyCompose.closeDraftTitle']()}</DialogTitle>
            <DialogDescription>{m['common.replyCompose.closeDraftBody']()}</DialogDescription>
          </DialogHeader>
          <DialogFooter className="mt-2">
            <Button
              variant="outline"
              onClick={() => void handleDialogChoice('keepEditing')}
              className="cursor-pointer"
            >
              {m['common.replyCompose.keepEditing']()}
            </Button>
            <Button onClick={() => void handleDialogChoice('saveDraft')} className="cursor-pointer">
              {m['common.replyCompose.saveDraft']()}
            </Button>
            <Button
              variant="destructive"
              onClick={() => void handleDialogChoice('discard')}
              className="cursor-pointer"
            >
              {m['common.replyCompose.discardDraft']()}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={showAttachmentWarning} onOpenChange={setShowAttachmentWarning}>
        <DialogContent showOverlay className="z-99999 sm:max-w-[425px]">
          <DialogHeader>
            <DialogTitle>Attachment Warning</DialogTitle>
            <DialogDescription>
              Looks like you mentioned an attachment in your message, but there are no files
              attached. Are you sure you want to send this email?
            </DialogDescription>
          </DialogHeader>
          <DialogFooter className="mt-2">
            <Button
              variant="outline"
              onClick={() => {
                setShowAttachmentWarning(false);
              }}
              className="cursor-pointer"
            >
              Recheck
            </Button>
            <Button
              onClick={() => {
                setShowAttachmentWarning(false);
                void proceedWithSend();
              }}
              className="cursor-pointer"
            >
              Send Anyway
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

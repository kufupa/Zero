import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '../ui/tooltip';
import { Command, Paperclip, Plus, Type, X as XIcon } from 'lucide-react';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { ScheduleSendPicker } from './schedule-send-picker';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import useComposeEditor from '@/hooks/use-compose-editor';
import { CurvedArrow, X } from '../icons/icons';
import { gitHubEmojis } from '@tiptap/extension-emoji';
import { zodResolver } from '@hookform/resolvers/zod';

import { useTRPC } from '@/providers/query-provider';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useSettings } from '@/hooks/use-settings';
import { DEMO_MAIL_LIST_DRAFTS_QUERY_PREFIX } from '@/lib/demo/demo-mail-query-keys';
import { isFrontendOnlyDemo } from '@/lib/demo/runtime';
import { demoUpsertDraft } from '@/lib/demo/local-actions';

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
import { compressImages } from '@/lib/image-compression';
import type { ImageQuality } from '@/lib/image-compression';

const shortcodeRegex = /:([a-zA-Z0-9_+-]+):/g;
import { TemplateButton } from './template-button';
import { emailListSignature } from '@/lib/mail/compose-signatures';
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
import { resolveComposeEscapeAction } from '@/lib/mail/thread-open-stability';
import { registerComposeFlush } from '@/lib/mail/compose-flush-registry';
import { useOptimisticActions } from '@/hooks/use-optimistic-actions';
import { m } from '@/paraglide/messages';
import { useDraft } from '@/hooks/use-drafts';
import type { HeaderDebugLine } from '@/types';

interface EmailComposerProps {
  initialTo?: string[];
  initialCc?: string[];
  initialBcc?: string[];
  initialSubject?: string;
  initialMessage?: string;
  initialAttachments?: File[];
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
  }) => Promise<boolean>;
  onClose?: () => void;
  className?: string;
  autofocus?: boolean;
  settingsLoading?: boolean;
  editorClassName?: string;
  /** When set, sync to/cc/bcc/subject from props when they change without remounting (e.g. reply → reply all). Never overwrites the message body from props. */
  syncReplyHeadersFromProps?: boolean;
  replyToMessageId?: string | null;
  headerPreview?: HeaderDebugLine[];
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

export function EmailComposer({
  initialTo = [],
  initialCc = [],
  initialBcc = [],
  initialSubject = '',
  initialMessage = '',
  initialAttachments = [],
  onSendEmail,
  onClose,
  className,
  autofocus = false,
  settingsLoading = false,
  editorClassName,
  syncReplyHeadersFromProps = false,
  replyToMessageId = null,
  headerPreview = [],
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
  const [threadId] = useQueryState('threadId');
  const [isComposeOpen, setIsComposeOpen] = useQueryState('isComposeOpen');
  const [draftId, setDraftId] = useQueryState('draftId');
  const { data: serverDraft } = useDraft(draftId ?? null);

  useEffect(() => {
    if (draftId) {
      activeDraftIdRef.current = draftId;
    }
  }, [draftId]);

  const [showLeaveConfirmation, setShowLeaveConfirmation] = useState(false);
  const [scheduleAt, setScheduleAt] = useState<string>();
  const [isScheduleValid, setIsScheduleValid] = useState<boolean>(true);
  const [showAttachmentWarning, setShowAttachmentWarning] = useState(false);
  const [originalAttachments, setOriginalAttachments] = useState<File[]>(initialAttachments);
  const [attachmentPreviewUrls, setAttachmentPreviewUrls] = useState<Record<string, string>>({});
  const attachmentPreviewUrlMapRef = useRef(new Map<string, string>());
  const [imageQuality, setImageQuality] = useState<ImageQuality>(
    settings?.settings?.imageCompression || 'medium',
  );
  const [activeReplyId] = useQueryState('activeReplyId');
  const [toggleToolbar, setToggleToolbar] = useState(false);
  const processAndSetAttachments = async (
    filesToProcess: File[],
    quality: ImageQuality,
    showToast: boolean = false,
  ) => {
    if (filesToProcess.length === 0) {
      setValue('attachments', [], { shouldDirty: true });
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
        markUnsavedChanges();
        if (showToast) {
          toast.error('Image compression failed, using original files');
        }
        return;
      }

      setValue('attachments', compressedFiles, { shouldDirty: true });
      markUnsavedChanges();

      if (showToast && quality !== 'original') {
        let totalOriginalSize = 0;
        let totalCompressedSize = 0;

        const imageFilesExist = filesToProcess.some((f) => f.type.startsWith('image/'));

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
      markUnsavedChanges();
      if (showToast) {
        toast.error('Image compression failed, using original files');
      }
    }
  };

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
      fromEmail:
        settings?.settings?.defaultEmailAlias ||
        '',
    },
  });

  const { watch, setValue, getValues } = form;

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
    setValue('subject', initialSubject ?? '', { shouldDirty: true, shouldTouch: true });
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
  const getAttachmentKey = useCallback(
    (file: File) => `${file.name}-${file.size}-${file.lastModified}`,
    [],
  );

  const clearAttachmentState = useCallback(() => {
    setOriginalAttachments([]);
    setValue('attachments', [], { shouldDirty: false });
    if (fileInputRef.current) {
      fileInputRef.current.value = '';
    }
  }, [setValue]);

  useEffect(() => {
    const files = (attachments ?? []) as File[];
    const previousMap = attachmentPreviewUrlMapRef.current;
    const nextMap = new Map<string, string>();

    files.forEach((file) => {
      if (!file.type.startsWith('image/')) return;
      const key = getAttachmentKey(file);
      const existingUrl = previousMap.get(key);
      nextMap.set(key, existingUrl ?? URL.createObjectURL(file));
    });

    previousMap.forEach((url, key) => {
      if (!nextMap.has(key)) {
        URL.revokeObjectURL(url);
      }
    });

    attachmentPreviewUrlMapRef.current = nextMap;
    setAttachmentPreviewUrls(Object.fromEntries(nextMap));
  }, [attachments, getAttachmentKey]);

  useEffect(() => {
    return () => {
      attachmentPreviewUrlMapRef.current.forEach((url) => {
        URL.revokeObjectURL(url);
      });
      attachmentPreviewUrlMapRef.current.clear();
    };
  }, []);

  const handleAttachment = async (newFiles: File[]) => {
    if (newFiles && newFiles.length > 0) {
      const newOriginals = [...originalAttachments, ...newFiles];
      setOriginalAttachments(newOriginals);
      await processAndSetAttachments(newOriginals, imageQuality, true);
    }
  };

  const removeAttachment = async (index: number) => {
    const newOriginals = originalAttachments.filter((_, i) => i !== index);
    setOriginalAttachments(newOriginals);
    await processAndSetAttachments(newOriginals, imageQuality);
    markUnsavedChanges();
  };

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
    placeholder: 'Start your email here',
    autofocus,
  });

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
          hasUnsavedChanges,
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
  }, [
    editor,
    getValues,
    hasUnsavedChanges,
    initialMessage,
  ]);

  const proceedWithSend = async () => {
    try {
      if (isLoading) return;

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
      });
      if (!sent) return;

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
      setIsLoading(false);
    }
  };

  const handleSend = async () => {
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

    await proceedWithSend();
  };

  const persistDraftOnce = useCallback(async (): Promise<'saved' | 'skipped' | 'failed'> => {
    if (saveInFlightRef.current) return saveInFlightRef.current;

    const capturedRevision = revisionRef.current.localRevision;
    const values = getValues();
    const snapshot = {
      hasUnsavedChanges:
        revisionRef.current.localRevision > revisionRef.current.savedRevision,
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

    let savePromise!: Promise<'saved' | 'skipped' | 'failed'>;
    savePromise = (async (): Promise<'saved' | 'skipped' | 'failed'> => {
      try {
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
            savedDraftId
              ? queryClient.invalidateQueries({
                  queryKey: trpc.drafts.get.queryKey({ id: savedDraftId }),
                })
              : Promise.resolve(),
            threadId
              ? queryClient.invalidateQueries({ queryKey: trpc.mail.get.queryKey({ id: threadId }) })
              : Promise.resolve(),
            queryClient.invalidateQueries({ queryKey: trpc.mail.listThreads.infiniteQueryKey() }),
          ]);
        }

        revisionRef.current = reduceDraftRevision(revisionRef.current, {
          type: 'saved', capturedRevision,
        });
        setHasUnsavedChanges(
          revisionRef.current.localRevision > revisionRef.current.savedRevision,
        );
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
    getValues,
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
      hasUnsavedChanges,
      initialHtml: initialMessage ?? '',
      html: editor?.getHTML() ?? '',
      text: editor?.getText() ?? '',
      to: values.to ?? [],
      subject: values.subject ?? '',
      aiBlocked: false,
    };
  }, [
    hasUnsavedChanges,
    initialMessage,
    editor,
    getValues,
  ]);

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
        hasUnsavedChanges,
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
  }, [
    hasUnsavedChanges,
    initialMessage,
    editor,
    saveDraft,
    getValues,
  ]);

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
  }, [
    autosaveSuppressedAfterFailure,
    hasUnsavedChanges,
    isSavingDraft,
    persistDraftOnce,
  ]);

  useEffect(() => {
    const handlePasteFiles = (event: ClipboardEvent) => {
      const clipboardData = event.clipboardData;
      if (!clipboardData || !clipboardData.files.length) return;

      const pastedFiles = Array.from(clipboardData.files);
      if (pastedFiles.length > 0) {
        event.preventDefault();
        handleAttachment(pastedFiles);
        toast.success(`${pluralize('file', pastedFiles.length, true)} attached`);
      }
    };

    document.addEventListener('paste', handlePasteFiles);
    return () => {
      document.removeEventListener('paste', handlePasteFiles);
    };
  }, [handleAttachment]);

  // keep fromEmail in sync when settings load
  useEffect(() => {
    const preferred =
      settings?.settings?.defaultEmailAlias || '';

    if (preferred && getValues('fromEmail') !== preferred) {
      setValue('fromEmail', preferred, { shouldDirty: false });
    }
  }, [settings?.settings?.defaultEmailAlias, getValues, setValue]);

  const handleQualityChange = async (newQuality: ImageQuality) => {
    setImageQuality(newQuality);
    await processAndSetAttachments(originalAttachments, newQuality, true);
  };

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
    <Button size={'xs'} onClick={handleSend} disabled={isLoading || settingsLoading || !isScheduleValid}>
      <div className="flex items-center justify-center">
        <div className="text-center text-sm leading-none text-white dark:text-black">
          <span>Send </span>
        </div>
      </div>
      <div className="flex h-5 items-center justify-center gap-1 rounded-sm bg-white/10 px-1 dark:bg-black/10">
        <Command className="h-3.5 w-3.5 text-white dark:text-black" />
        <CurvedArrow className="mt-1.5 h-4 w-4 fill-white dark:fill-black" />
      </div>
    </Button>
  );

  return (
    <div
      className={cn(
        'flex max-h-[500px] w-full max-w-[750px] flex-col overflow-hidden rounded-2xl bg-[#FAFAFA] shadow-sm dark:bg-[#202020]',
        className,
      )}
    >
      <div className="no-scrollbar dark:bg-panelDark flex min-h-0 flex-1 flex-col overflow-y-auto rounded-2xl">
        {/* To, Cc, Bcc */}
        <div className="shrink-0 overflow-visible border-b border-[#E7E7E7] pb-2 dark:border-[#252525]">
          <div className="flex justify-between px-3 pt-3">
            <div className="flex min-w-0 flex-1 items-center gap-2">
              <p className="text-sm font-medium text-[#8C8C8C]">To:</p>
              <RecipientAutosuggest
                control={form.control}
                name="to"
                placeholder="Enter email address"
                disabled={isLoading}
                onValueChange={markUnsavedChanges}
              />
            </div>

            <div className="flex gap-2">
              <button
                tabIndex={-1}
                className="flex h-full items-center gap-2 text-sm font-medium text-[#8C8C8C] hover:text-[#A8A8A8] hover:bg-gray-50 dark:hover:bg-[#404040] transition-colors cursor-pointer rounded-sm px-1 py-0.5"
                onClick={() => setShowCc(!showCc)}
              >
                <span>Cc</span>
              </button>
              <button
                tabIndex={-1}
                className="flex h-full items-center gap-2 text-sm font-medium text-[#8C8C8C] hover:text-[#A8A8A8] hover:bg-gray-50 dark:hover:bg-[#404040] transition-colors cursor-pointer rounded-sm px-1 py-0.5"
                onClick={() => setShowBcc(!showBcc)}
              >
                <span>Bcc</span>
              </button>
              {onClose && (
                <button
                  tabIndex={-1}
                  className="flex h-full items-center gap-2 text-sm font-medium text-[#8C8C8C] hover:text-[#A8A8A8] hover:bg-gray-50 dark:hover:bg-[#404040] transition-colors cursor-pointer rounded-sm px-1 py-0.5"
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
              <div className="flex items-center gap-2 px-3">
                <p className="text-sm font-medium text-[#8C8C8C]">Cc:</p>
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
              <div className="flex items-center gap-2 px-3">
                <p className="text-sm font-medium text-[#8C8C8C]">Bcc:</p>
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
        <div className="flex-1 overflow-y-auto border-t bg-[#FFFFFF] px-3 py-3 outline-white/5 dark:bg-[#202020]">
          <div
            onClick={() => {
              editor.commands.focus();
            }}
            className={cn(`min-h-[200px] w-full`, editorClassName)}
          >
            <EditorContent editor={editor} className="h-full w-full max-w-full overflow-x-auto" />
          </div>
        </div>
      </div>

      {/* Bottom Actions */}
      <div className="inline-flex w-full shrink-0 items-end justify-between self-stretch rounded-b-2xl bg-[#FFFFFF] px-3 py-3 outline-white/5 dark:bg-[#202020]">
        <div className="flex flex-col items-start justify-start gap-2">
          {toggleToolbar && <Toolbar editor={editor} />}
          <div className="flex flex-wrap items-center justify-start gap-2">
            {sendButton}
            <ScheduleSendPicker
              value={scheduleAt}
              onChange={handleScheduleChange}
              onValidityChange={handleScheduleValidityChange}
            />
            <Button variant={'secondary'} size={'xs'} onClick={() => fileInputRef.current?.click()} className="bg-background border hover:bg-gray-50 dark:hover:bg-[#404040] transition-colors cursor-pointer">
              <Plus className="h-3 w-3 fill-[#9A9A9A]" />
              <span className="hidden px-0.5 text-sm md:block">Add</span>
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
              onChange={async (event) => {
                const fileList = event.target.files;
                if (fileList) {
                  await handleAttachment(Array.from(fileList));
                }
              }}
              multiple
              accept="image/*,.pdf,.doc,.docx,.xls,.xlsx,.txt"
              ref={fileInputRef}
              style={{ zIndex: 100 }}
            />
            {attachments && attachments.length > 0 && (
              <Popover modal={true}>
                <PopoverTrigger asChild>
                  <button
                    className="focus-visible:ring-ring flex items-center gap-1.5 rounded-md border border-[#E7E7E7] bg-white/5 px-2 py-1 text-sm hover:bg-white/10 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-offset-2 dark:border-[#2B2B2B] cursor-pointer"
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
                      {attachments.map((file: File, index: number) => {
                        const attachmentKey = getAttachmentKey(file);
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
                              key={attachmentKey}
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
                                  await removeAttachment(index);
                                } catch (error) {
                                  console.error('Failed to remove attachment:', error);
                                  toast.error('Failed to remove attachment');
                                }
                              }}
                              className="focus-visible:ring-ring ml-1 flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-transparent hover:bg-black/5 focus-visible:outline-none focus-visible:ring-2 cursor-pointer"
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
                    tabIndex={-1}
                    variant="ghost"
                    size="icon"
                    onClick={() => setToggleToolbar(!toggleToolbar)}
                    className={`h-auto w-auto rounded p-1.5 ${toggleToolbar ? 'bg-muted' : 'bg-background'} border hover:bg-gray-50 dark:hover:bg-[#404040] transition-colors cursor-pointer`}
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
            <Button
              onClick={() => void handleDialogChoice('saveDraft')}
              className="cursor-pointer"
            >
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

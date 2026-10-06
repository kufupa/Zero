import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import {
  getStaleDraftRetryInput,
  isStaleDraftConflict,
  shouldEnsureEditableDraftForReply,
} from '@/lib/mail/draft-persistence';
import {
  isAssistedDraft,
  useDraft,
  useDraftArtifactHydration,
  useEnsureEditableDraftForReply,
} from '@/hooks/use-drafts';
import {
  buildOutboundHeaderPreview,
  canShowHeaderDebug,
  isHeaderDebugEnabled,
} from '@/lib/mail/header-debug';
import { constructReplyBody, constructForwardBody } from '@/lib/utils';
import { deriveReplyRecipients } from '@/lib/mail/reply-recipients';
import { useActiveConnection } from '@/hooks/use-connections';
import { useEffect, useMemo, useRef, useState } from 'react';
import { demoSendEmail } from '@/lib/demo/local-actions';
import { EmailComposer } from '../create/email-composer';
import { isFrontendOnlyDemo } from '@/lib/demo/runtime';
import { useHotkeysContext } from 'react-hotkeys-hook';
import { useTRPC } from '@/providers/query-provider';
import { useMutation } from '@tanstack/react-query';
import { useUndoSend } from '@/hooks/use-undo-send';
import { useTimezone } from '@/hooks/use-timezone';
import { useSettings } from '@/hooks/use-settings';
import { Button } from '@/components/ui/button';
import { useThread } from '@/hooks/use-threads';
import { useSession } from '@/lib/auth-client';
import { serializeFiles } from '@/lib/schemas';
import { m } from '@/paraglide/messages';
import type { Sender } from '@/types';
import { useQueryState } from 'nuqs';
import posthog from 'posthog-js';
import { toast } from 'sonner';

interface ReplyComposeProps {
  messageId?: string;
}

export default function ReplyCompose({ messageId }: ReplyComposeProps) {
  const [mode, setMode] = useQueryState('mode');
  const { enableScope, disableScope } = useHotkeysContext();

  const [draftId, setDraftId] = useQueryState('draftId');
  const [threadId] = useQueryState('threadId');
  const [, setActiveReplyId] = useQueryState('activeReplyId');
  const { data: emailData, refetch, latestDraft, aiDraftCandidates } = useThread(threadId);
  const { data: draft } = useDraft(draftId ?? null);
  const draftArtifacts = useDraftArtifactHydration(draft as never);
  const trpc = useTRPC();
  const { mutateAsync: sendEmail } = useMutation(trpc.mail.send.mutationOptions());
  const { mutateAsync: approveDraft } = useMutation(trpc.drafts.approve.mutationOptions());
  const { mutateAsync: ensureEditableDraftForReply } = useEnsureEditableDraftForReply();
  const ensuredDraftKeyRef = useRef<string | null>(null);
  const [replyComposeViewportElement, setReplyComposeViewportElement] =
    useState<HTMLDivElement | null>(null);
  const [showStaleDraftConfirmation, setShowStaleDraftConfirmation] = useState(false);
  const staleDraftResolverRef = useRef<((confirmed: boolean) => void) | null>(null);
  const { data: activeConnection } = useActiveConnection();
  const { data: settings, isLoading: settingsLoading } = useSettings();
  const { data: session } = useSession();
  const { handleUndoSend } = useUndoSend();

  const timezone = useTimezone();

  const isAssistedDraftForId = (candidateId?: string | null) => {
    if (!candidateId) return false;
    if (draft?.id === candidateId) return isAssistedDraft(draft);
    if (latestDraft?.id === candidateId) return isAssistedDraft(latestDraft);
    return false;
  };

  // Find the specific message to reply to
  const replyToMessage =
    (messageId && emailData?.messages.find((msg) => msg.id === messageId)) || emailData?.latest;

  useEffect(() => {
    if (!mode || !messageId || !replyComposeViewportElement) return;

    const frameId = requestAnimationFrame(() => {
      if (!replyComposeViewportElement.isConnected) return;

      const behavior = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches
        ? 'auto'
        : 'smooth';

      replyComposeViewportElement.scrollIntoView({
        behavior,
        block: 'end',
        inline: 'nearest',
      });
    });

    return () => {
      cancelAnimationFrame(frameId);
    };
  }, [mode, messageId, replyComposeViewportElement]);

  const confirmStaleDraftSend = () =>
    new Promise<boolean>((resolve) => {
      staleDraftResolverRef.current = resolve;
      setShowStaleDraftConfirmation(true);
    });

  const handleStaleDraftDecision = (confirmed: boolean) => {
    setShowStaleDraftConfirmation(false);
    staleDraftResolverRef.current?.(confirmed);
    staleDraftResolverRef.current = null;
  };

  useEffect(() => {
    // Bind URL draftId to existing active thread draft so Save updates instead of INSERT.
    if (latestDraft?.id && !draftId && mode) {
      void setDraftId(latestDraft.id);
    }
  }, [latestDraft?.id, draftId, mode, setDraftId]);

  useEffect(() => {
    const decision = shouldEnsureEditableDraftForReply({
      demoMode: isFrontendOnlyDemo(),
      threadId,
      replyToMessageId: replyToMessage?.id ?? null,
      activeDraftId: latestDraft?.id ?? null,
      aiCandidateCount: aiDraftCandidates?.length ?? 0,
    });

    if (!decision.shouldEnsure) return;

    const ensureKey = `${decision.threadId}:${decision.replyToMessageId ?? 'none'}`;
    if (ensuredDraftKeyRef.current === ensureKey) return;
    ensuredDraftKeyRef.current = ensureKey;

    void ensureEditableDraftForReply({
      threadId: decision.threadId,
      replyToMessageId: decision.replyToMessageId,
    }).then((editableDraft) => {
      setDraftId(editableDraft.id);
      void refetch();
    });
  }, [
    aiDraftCandidates?.length,
    ensureEditableDraftForReply,
    latestDraft?.id,
    refetch,
    replyToMessage?.id,
    setDraftId,
    threadId,
  ]);

  const handleSendEmail = async (data: {
    to: string[];
    cc?: string[];
    bcc?: string[];
    subject: string;
    message: string;
    attachments: File[];
    scheduleAt?: string;
    draftId?: string;
    excludeQuotedHistory?: boolean;
  }): Promise<boolean> => {
    if(draftArtifacts.entries.some(a=>a.state!=='available')){toast.error('Required draft attachments are unavailable.');return false;}
    if (!replyToMessage) {
      toast.error('No message available to reply to.');
      return false;
    }
    if (!activeConnection?.email) {
      toast.error('No active account is available.');
      return false;
    }

    try {
      const userEmail = activeConnection.email.toLowerCase();
      const userName = activeConnection.name || session?.user?.name || '';

      const senderEmail = (settings?.settings?.defaultEmailAlias || userEmail || '').trim();
      const fromEmail = userName.trim()
        ? `${userName.replace(/[<>]/g, '')} <${senderEmail}>`
        : senderEmail;

      const toRecipients: Sender[] = data.to.map((email) => ({
        email,
        name: email.split('@')[0] || 'User',
      }));

      const ccRecipients: Sender[] | undefined = data.cc
        ? data.cc.map((email) => ({
            email,
            name: email.split('@')[0] || 'User',
          }))
        : undefined;

      const bccRecipients: Sender[] | undefined = data.bcc
        ? data.bcc.map((email) => ({
            email,
            name: email.split('@')[0] || 'User',
          }))
        : undefined;

      const quoteAttributionRecipients =
        replyToMessage.to?.length > 0
          ? replyToMessage.to
          : replyToMessage.sender
            ? [replyToMessage.sender]
            : [];

      const emailBody = data.excludeQuotedHistory
        ? data.message
        : mode === 'forward'
          ? constructForwardBody(
              data.message,
              replyToMessage.receivedOn || '',
              { ...replyToMessage.sender, subject: replyToMessage.subject },
              quoteAttributionRecipients,
              replyToMessage.decodedBody,
              data.subject,
              timezone,
            )
          : constructReplyBody(
              data.message,
              replyToMessage.receivedOn || '',
              replyToMessage.sender,
              quoteAttributionRecipients,
              replyToMessage.decodedBody,
              data.subject,
              timezone,
              replyToMessage.cc,
            );

      const serializedAttachments = await serializeFiles(data.attachments);
      let draftApproval: Awaited<ReturnType<typeof approveDraft>> | undefined;
      const aiDraftBeingSent = !isFrontendOnlyDemo() && isAssistedDraftForId(data.draftId);
      if (aiDraftBeingSent) {
        try {
          draftApproval = await approveDraft({
            draftId: data.draftId!,
            subject: data.subject,
            html: emailBody,
            text: '',
            originalMessage: replyToMessage.decodedBody,
            to: data.to,
            cc: data.cc ?? [],
            bcc: data.bcc ?? [],
            attachments: serializedAttachments,
          });
        } catch (error) {
          console.error('AI draft review failed:', error);
          toast.error('Review the assisted draft before sending.');
          return false;
        }
      }

      const sendInput = {
        to: toRecipients,
        cc: ccRecipients,
        bcc: bccRecipients,
        subject: data.subject,
        message: emailBody,
        attachments: serializedAttachments,
        fromEmail: fromEmail,
        draftId: data.draftId,
        replyToMessageId: replyToMessage?.id,
        headers: {
          'In-Reply-To': replyToMessage?.messageId ?? '',
          References: [
            ...(replyToMessage?.references ? replyToMessage.references.split(' ') : []),
            replyToMessage?.messageId,
          ]
            .filter(Boolean)
            .join(' '),
          'Thread-Id': replyToMessage?.threadId ?? '',
        },
        threadId: replyToMessage?.threadId,
        isForward: mode === 'forward',
        originalMessage: replyToMessage.decodedBody,
        scheduleAt: data.scheduleAt,
        ...(draftApproval ? { draftApproval } : {}),
      };

      const sendWithInput = async (input: typeof sendInput) =>
        isFrontendOnlyDemo() ? demoSendEmail(input) : sendEmail(input);

      let result;
      try {
        result = await sendWithInput(sendInput);
      } catch (error) {
        if (!isStaleDraftConflict(error)) {
          console.error('Error sending email:', error);
          toast.error(m['pages.createEmail.failedToSendEmail']());
          return false;
        }
        const confirmed = await confirmStaleDraftSend();
        if (!confirmed) return false;
        try {
          result = await sendWithInput(getStaleDraftRetryInput(sendInput));
        } catch (retryError) {
          console.error('Error sending email:', retryError);
          toast.error(m['pages.createEmail.failedToSendEmail']());
          return false;
        }
      }

      posthog.capture('Reply Email Sent');

      // Reset states
      setMode(null);
      await refetch();

      handleUndoSend(result, settings, {
        to: data.to,
        cc: data.cc,
        bcc: data.bcc,
        subject: data.subject,
        message: data.message,
        attachments: data.attachments,
        scheduleAt: data.scheduleAt,
      });
      return true;
    } catch (error) {
      console.error('Error sending email:', error);
      toast.error(m['pages.createEmail.failedToSendEmail']());
      return false;
    }
  };

  useEffect(() => {
    if (mode) {
      enableScope('compose');
    } else {
      disableScope('compose');
    }
    return () => {
      disableScope('compose');
    };
  }, [mode, enableScope, disableScope]);

  const ensureEmailArray = (emails: string | string[] | undefined | null): string[] => {
    if (!emails) return [];
    if (Array.isArray(emails)) {
      return emails.map((email) => email.trim().replace(/[<>]/g, ''));
    }
    if (typeof emails === 'string') {
      return emails
        .split(',')
        .map((email) => email.trim())
        .filter((email) => email.length > 0)
        .map((email) => email.replace(/[<>]/g, ''));
    }
    return [];
  };

  const draftTo = ensureEmailArray(draft?.to);
  const draftCc = ensureEmailArray(draft?.cc);
  const draftBcc = ensureEmailArray(draft?.bcc);

  const excludedReplyEmails = useMemo(
    () => [activeConnection?.email, session?.user?.email],
    [activeConnection?.email, session?.user?.email],
  );

  const derivedReplyRecipients = useMemo(
    () =>
      deriveReplyRecipients({
        mode: mode as 'reply' | 'replyAll' | 'forward' | null | undefined,
        message: replyToMessage,
        excludedEmails: excludedReplyEmails,
      }),
    [excludedReplyEmails, mode, replyToMessage],
  );

  // Draft/recipient affinity only — do not use for React `key` (including `mode` there remounts the composer and wipes the body on reply/replyAll/forward switches).
  const composeSeed = `${mode ?? 'view'}:${replyToMessage?.id ?? 'latest'}`;
  const replyComposeInstanceId = replyToMessage?.id ?? threadId ?? 'latest';
  const initializedComposeInstanceRef = useRef<string | null>(null);
  const savedDraftId = draftId ?? latestDraft?.id;
  const savedAttachmentCount = draft?.attachments?.length ?? 0;
  const savedDraftReady =
    !savedDraftId ||
    (draft?.id === savedDraftId &&
      draftArtifacts.entries.length === savedAttachmentCount &&
      draftArtifacts.files.length === savedAttachmentCount &&
      draftArtifacts.entries.every((a) => a.state === 'available'));
  // Start with the complete saved attachment set. Once staff can edit, refetches
  // must keep this composer mounted and preserve their attachment removals.
  if (!mode) initializedComposeInstanceRef.current = null;
  else if (emailData && savedDraftReady)
    initializedComposeInstanceRef.current = replyComposeInstanceId;
  const canEditReply = initializedComposeInstanceRef.current === replyComposeInstanceId;
  const draftRecipientSeedRef = useRef<string | null>(draftId ? composeSeed : null);

  useEffect(() => {
    if (!draftId) {
      draftRecipientSeedRef.current = null;
      return;
    }

    if (!draftRecipientSeedRef.current) {
      draftRecipientSeedRef.current = composeSeed;
    }
  }, [draftId, composeSeed]);

  const hasDraftRecipients = draftTo.length > 0 || draftCc.length > 0 || draftBcc.length > 0;
  const shouldUseDraftRecipients =
    hasDraftRecipients && Boolean(draftId) && draftRecipientSeedRef.current === composeSeed;
  const initialToRecipients = shouldUseDraftRecipients
    ? draftTo.length > 0
      ? draftTo
      : derivedReplyRecipients.to
    : derivedReplyRecipients.to;
  const initialCcRecipients = shouldUseDraftRecipients ? draftCc : derivedReplyRecipients.cc;
  const initialBccRecipients = shouldUseDraftRecipients ? draftBcc : [];

  const replyComposeInitialSubject = useMemo(() => {
    if (draft?.subject) return draft.subject;
    const raw = replyToMessage?.subject?.trim() ?? '';
    if (!raw) return '';
    if (mode === 'forward') {
      if (/^fwd?:/i.test(raw)) return raw;
      return `Fwd: ${raw}`;
    }
    if (mode === 'reply' || mode === 'replyAll') {
      if (/^re:/i.test(raw)) return raw;
      return `Re: ${raw}`;
    }
    return raw;
  }, [draft?.subject, mode, replyToMessage?.subject]);

  const headerPreview = useMemo(() => {
    if (!canShowHeaderDebug(activeConnection?.id) || !isHeaderDebugEnabled()) return [];
    return buildOutboundHeaderPreview({
      transportEmail: activeConnection?.email,
      inReplyTo: replyToMessage?.messageId,
      references: replyToMessage?.references,
    });
  }, [
    activeConnection?.email,
    activeConnection?.id,
    replyToMessage?.messageId,
    replyToMessage?.references,
  ]);

  if (!mode || !emailData) return null;

  return (
    <div ref={setReplyComposeViewportElement} className="w-full overflow-visible rounded-2xl border">
      {draftArtifacts.entries.length ? (
        <div role="status" aria-live="polite" className="p-2 text-sm">
          {draftArtifacts.entries.map((a) => (
            <div key={a.artifactRef}>
              {a.filename} ·{' '}
              {a.state === 'available'
                ? 'Available'
                : a.state === 'loading'
                  ? 'Loading'
                  : a.state === 'permission_denied'
                    ? 'Permission denied'
                    : 'Attachment unavailable'}
              {a.state === 'fetch_error' ? (
                <Button type="button" variant="ghost" onClick={draftArtifacts.retry}>
                  Retry {a.filename}
                </Button>
              ) : null}
            </div>
          ))}
        </div>
      ) : null}
      {!canEditReply ? (
        <div role="status" className="p-2 text-sm">
          Saved reply attachments must be available before editing.
        </div>
      ) : (
        <EmailComposer
          key={`reply-compose-${replyComposeInstanceId}`}
          className="max-w-none! w-full overflow-visible pb-1"
          onSendEmail={handleSendEmail}
          onClose={async () => {
            setMode(null);
            setDraftId(null);
            setActiveReplyId(null);
          }}
          hydratedAttachmentSnapshot={
            draftArtifacts.entries.every((a) => a.state === 'available') &&
            draftArtifacts.entries.length
              ? { key: draftArtifacts.snapshotKey, files: draftArtifacts.files }
              : undefined
          }
          initialAttachments={draftArtifacts.files}
          initialMessage={draft?.content ?? latestDraft?.content ?? undefined}
          initialTo={initialToRecipients}
          initialCc={initialCcRecipients}
          initialBcc={initialBccRecipients}
          initialSubject={replyComposeInitialSubject}
          syncReplyHeadersFromProps
          autofocus={true}
          settingsLoading={settingsLoading}
          replyToMessageId={replyToMessage?.id ?? null}
          replyToMessage={replyToMessage}
          headerPreview={headerPreview}
          sendButtonLabel={isAssistedDraftForId(draftId) ? 'Review & Send' : 'Send'}
        />
      )}
      <Dialog open={showStaleDraftConfirmation} onOpenChange={setShowStaleDraftConfirmation}>
        <DialogContent showOverlay className="z-99999 sm:max-w-[425px]">
          <DialogHeader>
            <DialogTitle>Send stale draft?</DialogTitle>
            <DialogDescription>
              Newer messages arrived after this draft was started. Review latest reply before
              sending, or send anyway.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter className="mt-2">
            <Button variant="outline" onClick={() => handleStaleDraftDecision(false)}>
              Cancel
            </Button>
            <Button onClick={() => handleStaleDraftDecision(true)}>Send anyway</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

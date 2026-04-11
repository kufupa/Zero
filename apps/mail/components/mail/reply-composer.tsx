import { useUndoSend } from '@/hooks/use-undo-send';
import { constructReplyBody, constructForwardBody } from '@/lib/utils';
import { useActiveConnection } from '@/hooks/use-connections';
import { useEmailAliases } from '@/hooks/use-email-aliases';
import { EmailComposer } from '../create/email-composer';
import { useHotkeysContext } from 'react-hotkeys-hook';
import { useTRPC } from '@/providers/query-provider';
import { useMutation } from '@tanstack/react-query';
import { useSettings } from '@/hooks/use-settings';
import { useThread } from '@/hooks/use-threads';
import { useSession } from '@/lib/auth-client';
import { serializeFiles } from '@/lib/schemas';
import { useDraft } from '@/hooks/use-drafts';
import { m } from '@/paraglide/messages';
import { deriveReplyRecipients } from '@/lib/mail/reply-recipients';
import type { Sender } from '@/types';
import { useQueryState } from 'nuqs';
import { useEffect, useMemo, useRef } from 'react';
import posthog from 'posthog-js';
import { toast } from 'sonner';
import { demoSendEmail } from '@/lib/demo/local-actions';
import { isFrontendOnlyDemo } from '@/lib/demo/runtime';

interface ReplyComposeProps {
  messageId?: string;
}

export default function ReplyCompose({ messageId }: ReplyComposeProps) {
  const [mode, setMode] = useQueryState('mode');
  const { enableScope, disableScope } = useHotkeysContext();
  const { data: aliases } = useEmailAliases();

  const [draftId, setDraftId] = useQueryState('draftId');
  const [threadId] = useQueryState('threadId');
  const [, setActiveReplyId] = useQueryState('activeReplyId');
  const { data: emailData, refetch, latestDraft } = useThread(threadId);
  const { data: draft } = useDraft(draftId ?? null);
  const trpc = useTRPC();
  const { mutateAsync: sendEmail } = useMutation(trpc.mail.send.mutationOptions());
  const { data: activeConnection } = useActiveConnection();
  const { data: settings, isLoading: settingsLoading } = useSettings();
  const { data: session } = useSession();
  const { handleUndoSend } = useUndoSend();

  // Find the specific message to reply to
  const replyToMessage =
    (messageId && emailData?.messages.find((msg) => msg.id === messageId)) || emailData?.latest;

  const handleSendEmail = async (data: {
    to: string[];
    cc?: string[];
    bcc?: string[];
    subject: string;
    message: string;
    attachments: File[];
    scheduleAt?: string;
  }) => {
    if (!replyToMessage) {
      toast.error('No message available to reply to.');
      return;
    }
    if (!activeConnection?.email) {
      toast.error('No active account is available.');
      return;
    }

    try {
      const userEmail = activeConnection.email.toLowerCase();
      const userName = activeConnection.name || session?.user?.name || '';

      let fromEmail = userEmail;

      if (aliases && aliases.length > 0 && replyToMessage) {
        const allRecipients = [
          ...(replyToMessage.to || []),
          ...(replyToMessage.cc || []),
          ...(replyToMessage.bcc || []),
        ];
        const matchingAlias = aliases.find((alias) =>
          allRecipients.some(
            (recipient) => recipient.email.toLowerCase() === alias.email.toLowerCase(),
          ),
        );

        if (matchingAlias) {
          fromEmail = userName.trim()
            ? `${userName.replace(/[<>]/g, '')} <${matchingAlias.email}>`
            : matchingAlias.email;
        } else {
          const primaryEmail =
            aliases.find((alias) => alias.primary)?.email || aliases[0]?.email || userEmail;
          fromEmail = userName.trim()
            ? `${userName.replace(/[<>]/g, '')} <${primaryEmail}>`
            : primaryEmail;
        }
      }

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

      const zeroSignature = settings?.settings.zeroSignature
        ? '<p style="color: #666; font-size: 12px;">Sent via <a href="https://0.email/" style="color: #0066cc; text-decoration: none;">Zero</a></p>'
        : '';

      const emailBody =
        mode === 'forward'
          ? constructForwardBody(
              data.message + zeroSignature,
              new Date(replyToMessage.receivedOn || '').toLocaleString(),
              { ...replyToMessage.sender, subject: replyToMessage.subject },
              toRecipients,
              //   replyToMessage.decodedBody,
            )
          : constructReplyBody(
              data.message + zeroSignature,
              new Date(replyToMessage.receivedOn || '').toLocaleString(),
              replyToMessage.sender,
              toRecipients,
              //   replyToMessage.decodedBody,
            );

      const result = isFrontendOnlyDemo()
        ? await demoSendEmail({
            to: toRecipients,
            cc: ccRecipients,
            bcc: bccRecipients,
            subject: data.subject,
            message: emailBody,
            attachments: await serializeFiles(data.attachments),
            fromEmail: fromEmail,
            draftId: draftId ?? undefined,
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
          })
        : await sendEmail({
            to: toRecipients,
            cc: ccRecipients,
            bcc: bccRecipients,
            subject: data.subject,
            message: emailBody,
            attachments: await serializeFiles(data.attachments),
            fromEmail: fromEmail,
            draftId: draftId ?? undefined,
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
          });

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
    } catch (error) {
      console.error('Error sending email:', error);
      toast.error(m['pages.createEmail.failedToSendEmail']());
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
    () => [activeConnection?.email, session?.user?.email, ...(aliases?.map((alias) => alias.email) ?? [])],
    [activeConnection?.email, aliases, session?.user?.email],
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

  const composeSeed = `${mode ?? 'view'}:${replyToMessage?.id ?? 'latest'}`;
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

  if (!mode || !emailData) return null;

  return (
    <div className="w-full rounded-2xl overflow-visible border">
      <EmailComposer
        key={`reply-composer-${composeSeed}`}
        editorClassName="min-h-[50px]"
        className="w-full max-w-none! pb-1 overflow-visible"
        onSendEmail={handleSendEmail}
        onClose={async () => {
          setMode(null);
          setDraftId(null);
          setActiveReplyId(null);
        }}
        initialMessage={draft?.content ?? latestDraft?.decodedBody}
        initialTo={initialToRecipients}
        initialCc={initialCcRecipients}
        initialBcc={initialBccRecipients}
        initialSubject={draft?.subject}
        autofocus={true}
        settingsLoading={settingsLoading}
        replyingTo={replyToMessage?.sender.email}
      />
    </div>
  );
}

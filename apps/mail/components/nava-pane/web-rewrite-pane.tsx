import { useLayoutEffect } from 'react';
import type { ReactNode } from 'react';
import { createNavaApi } from '@/components/nava-rewrite/api';
import { NavaController } from '@/components/nava-rewrite/controller';
import { NavaPane, PaneMessage } from '@/components/nava-rewrite/pane';
import { webMessageBody, webThreadInput } from '@/components/nava-rewrite/web-input';
import { useActiveConnection } from '@/hooks/use-connections';
import { useThread } from '@/hooks/use-threads';
import { useSession } from '@/lib/auth-client';
import { isFrontendOnlyDemo } from '@/lib/demo/runtime';
import { resolvePublicBackendUrl } from '@/lib/public-backend-url';
import { useHmsJobNoticeReporter } from '@/lib/quote-workflow/hms-job-notice-context';
import { latestInboundMessage, singleInboundMessageId } from '@/lib/workstation/web-pane-bridge';

const api = createNavaApi({
  baseUrl: resolvePublicBackendUrl(),
  fetch: (input, init) => fetch(input, { ...init, credentials: 'include' }),
});

function RewriteEmailReporter({ emailKey, emailSubject }: { emailKey: string; emailSubject: string | null }) {
  const reporter = useHmsJobNoticeReporter();
  useLayoutEffect(() => {
    reporter.setCurrentEmail({ emailKey, emailSubject });
  }, [emailKey, emailSubject, reporter.setCurrentEmail]);
  return null;
}

export function WebRewritePane({ threadId, sourceThreadId, sourceMessageId, requireSelectedMessage = false, fallback }: {
  threadId: string;
  sourceThreadId?: string;
  sourceMessageId?: string | null;
  requireSelectedMessage?: boolean;
  fallback: ReactNode;
}) {
  const thread = useThread(threadId);
  const { data: connection, isLoading: connectionLoading, isError: connectionError } = useActiveConnection();
  const { data: session, isLoading: sessionLoading } = useSession();
  const messages = thread.isThreadDataMismatch ? undefined : thread.data?.messages;
  const selectedId = sourceMessageId != null ? sourceMessageId
    : requireSelectedMessage
      ? singleInboundMessageId(messages ?? [], connection?.email ?? '', sourceThreadId ?? threadId)
      : latestInboundMessage(messages ?? [], connection?.email ?? '')?.id ?? null;
  const matches = messages?.filter(message => message.id === selectedId && !message.isDraft &&
    (!sourceThreadId || message.threadId === sourceThreadId)) ?? [];
  const selected = matches.length === 1 ? matches[0] : undefined;
  const date = selected ? new Date(selected.receivedOn) : null;
  const email = selected ? {
    sender: selected.sender.name || selected.sender.email,
    subject: selected.subject,
    ...(date && !Number.isNaN(date.getTime()) ? { receivedLabel: date.toLocaleString(), receivedDateTime: selected.receivedOn } : {}),
    ...(selected.body ? { body: webMessageBody(selected.body, selected.processedHtml).text } : {}),
  } : null;
  const emailKey = selected ? JSON.stringify([connection?.id ?? '', 'thread', selected.id]) : threadId;
  const emailSubject = selected?.subject?.trim() || null;
  const source = sessionLoading || connectionLoading || thread.isThreadDataMismatch
    ? { status: 'loading' as const, reason: 'Loading conversation…' }
    : !session?.user ? { status: 'unavailable' as const, reason: 'Sign in to open this email in Nava.' }
      : connectionError || !connection ? { status: 'unavailable' as const, reason: 'Could not load your mailbox. Reload and try again.' }
        : thread.isError ? { status: 'unavailable' as const, reason: 'Could not load this thread. Reload and try again.' }
          : !thread.data ? { status: 'loading' as const, reason: 'Loading conversation…' }
            : !selected ? { status: 'unavailable' as const, reason: 'Select an email in this thread.' }
              : webThreadInput({ thread: thread.data, requestedThreadId: threadId,
                selectedMessageId: selected.id, connectionId: connection.id, isDemo: isFrontendOnlyDemo() });
  const owner = JSON.stringify([session?.user?.id, session?.session?.id, connection?.id]);

  if (source.status === 'unavailable') return fallback;

  return <div data-preview-status={source.status} data-preview-thread={threadId} className="flex h-full min-h-0 flex-col overflow-hidden bg-white">
    <RewriteEmailReporter emailKey={emailKey} emailSubject={emailSubject} />
    {source.status === 'ready'
      ? <NavaController key={owner} input={source.input} email={email} api={api} stageWorkflows={['create']} />
      : <><NavaPane email={email}><PaneMessage>{source.reason}</PaneMessage></NavaPane>
        {!email && <p role="status" className="px-4 pb-4 text-sm text-slate-600">{source.reason}</p>}</>}
  </div>;
}

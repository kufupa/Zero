import { useLayoutEffect } from 'react';
import { NavaRewriteHost } from '@/components/nava-rewrite/host';
import { webThreadInput } from '@/components/nava-rewrite/web-input';
import { useActiveConnection } from '@/hooks/use-connections';
import { useThread } from '@/hooks/use-threads';
import { isFrontendOnlyDemo } from '@/lib/demo/runtime';
import { useWebPreview, type PreviewSelection } from '@/lib/workstation/web-pane-bridge';
import { useHmsJobNoticeReporter } from '@/lib/quote-workflow/hms-job-notice-context';

function statusCopy(selection: PreviewSelection): string {
  if (selection.status === 'loading') return 'Loading thread…';
  if (selection.status === 'error') return 'Could not load this thread.';
  if (selection.status === 'unsynced' && selection.reason === 'no_message_id') return 'This email has no Message-ID. Select another email or sync the mailbox.';
  if (selection.status === 'unsynced' && selection.reason === 'select_message') return 'Select a guest email in this thread.';
  if (selection.status === 'unsynced' && selection.reason === 'source_message_unavailable') return 'This email is unavailable. Select a guest email in this thread.';
  if (selection.status === 'unsynced') return 'No guest email in this thread.';
  return '';
}

export function WebPanePanel({
  threadId,
  sourceThreadId,
  sourceMessageId,
  requireSelectedMessage = false,
}: {
  threadId: string;
  sourceThreadId?: string;
  sourceMessageId?: string | null;
  requireSelectedMessage?: boolean;
  onOpenThread?: (threadId: string, sourceMessageId?: string) => void;
  goldLabelEnabled?: boolean;
  hmsNoticesManagedByParent?: boolean;
}) {
  const { selection, bridge } = useWebPreview({
    threadId,
    ...(sourceThreadId ? { sourceThreadId } : {}),
    ...(sourceMessageId != null ? { sourceMessageId } : {}),
    ...(requireSelectedMessage ? { requireSelectedMessage } : {}),
  });
  const thread = useThread(threadId);
  const { data: connection } = useActiveConnection();
  const reporter = useHmsJobNoticeReporter();
  const email = selection.status === 'ready' ? selection.email : null;
  const emailKey = email?.entryId
    ? JSON.stringify([email.storeId ?? '', email.folderEntryId ?? '', email.entryId]) : threadId;
  const emailSubject = email?.subject?.trim() || null;
  useLayoutEffect(() => {
    reporter.setCurrentEmail({ emailKey, emailSubject });
  }, [emailKey, emailSubject, reporter.setCurrentEmail]);

  const source = selection.status !== 'ready'
    ? { status: selection.status === 'loading' ? 'loading' as const : 'unavailable' as const, reason: statusCopy(selection) }
    : !thread.data || thread.isThreadDataMismatch || !connection
      ? { status: 'loading' as const, reason: 'Loading conversation…' }
      : webThreadInput({ thread: thread.data, requestedThreadId: threadId,
        selectedMessageId: selection.email.entryId, connectionId: connection.id, isDemo: isFrontendOnlyDemo() });

  return <div data-preview-status={selection.status} data-preview-reason={selection.status === 'unsynced' ? selection.reason : undefined}
    data-preview-thread={threadId} className="h-full min-h-0 overflow-hidden">
    <NavaRewriteHost bridge={bridge} source={source} preview />
  </div>;
}

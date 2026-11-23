import { useCallback, useLayoutEffect, useState } from 'react';
import { useWebPreview, type PreviewSelection } from '@/lib/workstation/web-pane-bridge';
import { NavaRewriteHost } from '@/components/nava-rewrite/host';
import { useRewriteEligibility } from '@/components/nava-rewrite/eligibility';
import { webThreadInput } from '@/components/nava-rewrite/web-input';
import type { ThreadInput } from '@/components/nava-rewrite/wire';
import type { WorkstationEmailPayload } from '@/lib/workstation/bridge-protocol';
import { isFrontendOnlyDemo } from '@/lib/demo/runtime';
import {
  HmsJobNoticeBanner,
  HmsJobRunningChip,
} from '@/components/quote-workflow/hms-job-notices';
import { useHmsJobNoticeReporter } from '@/lib/quote-workflow/hms-job-notice-context';

function statusCopy(selection: PreviewSelection): string {
  if (selection.status === 'loading') return 'Loading thread…';
  if (selection.status === 'error') return 'Could not load this thread.';
  if (selection.status === 'unsynced' && selection.reason === 'no_message_id') {
    return 'Not analysable: this guest email has no Message-ID, so Nava cannot bind it.';
  }
  if (selection.status === 'unsynced' && selection.reason === 'select_message')
    return 'Select a guest email in this thread to use with Nava.';
  if (selection.status === 'unsynced' && selection.reason === 'source_message_unavailable')
    return 'This email is unavailable. Select a guest email in this thread to use with Nava.';
  if (selection.status === 'unsynced') return 'No guest email in this thread to analyse.';
  return '';
}

/** The selected-thread Nava pane; only the normal mail route enables gold-label writes. */
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
  const { selection, bridge, thread } = useWebPreview({
    threadId,
    ...(sourceThreadId ? { sourceThreadId } : {}),
    ...(sourceMessageId != null ? { sourceMessageId } : {}),
    ...(requireSelectedMessage ? { requireSelectedMessage } : {}),
  });
  const reporter = useHmsJobNoticeReporter();
  const activeEmail = selection.status === 'ready' ? selection.email : null;
  const emailKey = activeEmail?.entryId
    ? JSON.stringify([activeEmail.storeId ?? '', activeEmail.folderEntryId ?? '', activeEmail.entryId])
    : threadId;
  const emailSubject = activeEmail?.subject?.trim() || null;

  useLayoutEffect(() => {
    reporter.setCurrentEmail({ emailKey, emailSubject });
  }, [emailKey, emailSubject, reporter.setCurrentEmail]);

  if (selection.status !== 'ready') {
    const reason = selection.status === 'unsynced' ? selection.reason : undefined;
    return (
      <div
        data-preview-status={selection.status}
        data-preview-reason={reason}
        data-preview-thread={threadId}
        className="flex h-full min-h-0 flex-col text-sm text-slate-600"
      >
        <div className="flex h-11 shrink-0 items-center justify-end px-3">
          <HmsJobRunningChip />
        </div>
        <HmsJobNoticeBanner />
        <p role={selection.status === 'error' ? 'alert' : 'status'} className="p-4">
          {statusCopy(selection)}
        </p>
      </div>
    );
  }
  const candidate = selection.threadId && selection.email.storeId
    ? webThreadInput({
      thread, requestedThreadId: threadId, selectedMessageId: selection.email.entryId,
      connectionId: selection.email.storeId, isDemo: isFrontendOnlyDemo(),
    }) : null;
  const input = candidate?.status === 'ready' ? candidate.input : null;
  const selected = input?.messages.find(message => message.id === selection.email.entryId);
  const matches = input && selected && selected.direction === 'inbound' && selected.subject === selection.email.subject &&
    selected.from.email === selection.email.senderEmail &&
    selected.rfc_message_id?.trim() === selection.email.internetMessageId;
  return (
    <div
      data-preview-status="ready"
      data-preview-thread={threadId}
      data-preview-message={selection.email.entryId}
      className="flex h-full min-h-0 min-w-0 flex-col overflow-hidden"
    >
      {matches && selection.threadId ? <WebRewriteSelection key={JSON.stringify([input.selected_message_id, selection.threadId, selection.email.entryId])} email={selection.email} threadId={selection.threadId}
        input={input} /> : <NavaRewriteHost bridge={bridge} preview source={{ status: 'unavailable', reason: candidate?.status === 'unavailable' ? candidate.reason : 'Select a guest email to use Nava.' }} />}
    </div>
  );
}

function WebRewriteSelection({ email, input, threadId }: {
  email: WorkstationEmailPayload;
  threadId: string;
  input: ThreadInput;
}) {
  const eligibility = useRewriteEligibility(input.mailbox_id);
  const [rejected, setRejected] = useState(false);
  const onSourceNotEligible = useCallback(() => setRejected(true), []);
  return <NavaRewriteHost webmail={{
    email, threadId, onSourceNotEligible,
    source: eligibility === 'ineligible' || rejected
      ? { status: 'unavailable', reason: 'This email is unavailable in Nava. Select another guest email.' }
      : eligibility === 'eligible'
      ? { status: 'ready', input: { ...input, property_code: 'HRCEN' } }
      : { status: 'loading', reason: 'Opening selected email…' },
  }} />;
}

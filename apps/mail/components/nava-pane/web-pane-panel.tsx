import { useLayoutEffect } from 'react';
import { ReservationPaneHost } from '@/components/nava-pane/reservation-pane-host';
import { WebRewritePane } from '@/components/nava-pane/web-rewrite-pane';
import { useRewriteEligibility } from '@/components/nava-rewrite/eligibility';
import { HmsJobNoticeBanner, HmsJobRunningChip } from '@/components/quote-workflow/hms-job-notices';
import { useActiveConnection } from '@/hooks/use-connections';
import { useWebPreview, type PreviewSelection } from '@/lib/workstation/web-pane-bridge';
import { useHmsJobNoticeReporter } from '@/lib/quote-workflow/hms-job-notice-context';

function statusCopy(selection: PreviewSelection): string {
  if (selection.status === 'loading') return 'Loading thread…';
  if (selection.status === 'error') return 'Could not load this thread.';
  if (selection.status === 'unsynced' && selection.reason === 'no_message_id') return 'Not analysable: this guest email has no Message-ID, so Nava cannot bind it.';
  if (selection.status === 'unsynced' && selection.reason === 'select_message') return 'Select a guest email in this thread to use with Nava.';
  if (selection.status === 'unsynced' && selection.reason === 'source_message_unavailable') return 'This email is unavailable. Select a guest email in this thread to use with Nava.';
  if (selection.status === 'unsynced') return 'No guest email in this thread to analyse.';
  return '';
}

type WebPanePanelProps = {
  threadId: string;
  sourceThreadId?: string;
  sourceMessageId?: string | null;
  requireSelectedMessage?: boolean;
  onOpenThread?: (threadId: string, sourceMessageId?: string) => void;
  goldLabelEnabled?: boolean;
  hmsNoticesManagedByParent?: boolean;
};

export function WebPanePanel(props: WebPanePanelProps) {
  return <EligibleWebPane {...props} />;
}

function EligibleWebPane(props: WebPanePanelProps) {
  const { data: connection, isLoading } = useActiveConnection();
  const eligibility = useRewriteEligibility(connection?.id);

  if (isLoading || (connection && eligibility === 'checking')) {
    return <div role="status" className="p-4 text-sm text-slate-600">Loading Nava…</div>;
  }
  return connection && eligibility === 'eligible'
    ? <WebRewritePane {...props} fallback={<LegacyWebPane {...props} />} />
    : <LegacyWebPane {...props} />;
}

function LegacyWebPane({
  threadId,
  sourceThreadId,
  sourceMessageId,
  requireSelectedMessage = false,
}: WebPanePanelProps) {
  const { selection, bridge } = useWebPreview({
    threadId,
    ...(sourceThreadId ? { sourceThreadId } : {}),
    ...(sourceMessageId != null ? { sourceMessageId } : {}),
    ...(requireSelectedMessage ? { requireSelectedMessage } : {}),
  });
  const reporter = useHmsJobNoticeReporter();
  const email = selection.status === 'ready' ? selection.email : null;
  const emailKey = email?.entryId
    ? JSON.stringify([email.storeId ?? '', email.folderEntryId ?? '', email.entryId]) : threadId;
  const emailSubject = email?.subject?.trim() || null;
  useLayoutEffect(() => {
    reporter.setCurrentEmail({ emailKey, emailSubject });
  }, [emailKey, emailSubject, reporter.setCurrentEmail]);

  if (selection.status !== 'ready') {
    return <div data-preview-status={selection.status} data-preview-reason={selection.status === 'unsynced' ? selection.reason : undefined}
      data-preview-thread={threadId} className="flex h-full min-h-0 flex-col text-sm text-slate-600">
      <div className="flex h-11 shrink-0 items-center justify-end px-3"><HmsJobRunningChip /></div>
      <HmsJobNoticeBanner />
      <p role={selection.status === 'error' ? 'alert' : 'status'} className="p-4">{statusCopy(selection)}</p>
    </div>;
  }
  return <div data-preview-status="ready" data-preview-thread={threadId} className="h-full min-h-0 overflow-hidden">
    <ReservationPaneHost bridge={bridge} preview webSelectedThreadId={selection.threadId} />
  </div>;
}

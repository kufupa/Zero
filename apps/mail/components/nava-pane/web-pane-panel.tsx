import { useLayoutEffect } from 'react';
import { useWebPreview, type PreviewSelection } from '@/lib/workstation/web-pane-bridge';
import { NavaPane } from '@/components/nava-pane/nava-pane';
import {
  HmsJobNoticeBanner,
  HmsJobRunningChip,
} from '@/components/quote-workflow/hms-job-notices';
import { useHmsJobNoticeReporter } from '@/lib/quote-workflow/hms-job-notice-context';

function statusCopy(selection: PreviewSelection): string {
  if (selection.status === 'loading') return 'Loading thread…';
  if (selection.status === 'error') return 'Could not load this thread.';
  if (selection.status === 'unsynced' && selection.reason === 'no_message_id') {
    return 'Not analysable: the latest guest email has no Message-ID, so Nava cannot bind it.';
  }
  if (selection.status === 'unsynced') return 'No guest email in this thread to analyse.';
  return '';
}

/** The selected-thread Nava pane; only the normal mail route enables gold-label writes. */
export function WebPanePanel({
  threadId,
  sourceThreadId,
  onOpenThread,
  goldLabelEnabled = false,
  hmsNoticesManagedByParent = false,
}: {
  threadId: string;
  sourceThreadId?: string;
  onOpenThread?: (threadId: string) => void;
  goldLabelEnabled?: boolean;
  hmsNoticesManagedByParent?: boolean;
}) {
  const { selection, bridge } = useWebPreview({
    threadId,
    ...(sourceThreadId ? { sourceThreadId } : {}),
  });
  const reporter = useHmsJobNoticeReporter();
  const activeEmail = selection.status === 'ready' ? selection.email : null;
  const emailKey = activeEmail?.internetMessageId?.trim() || activeEmail?.entryId || threadId;
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
  return (
    <div
      data-preview-status="ready"
      data-preview-thread={threadId}
      className="h-full overflow-y-auto"
    >
      <NavaPane
        bridge={bridge}
        preview
        onOpenThread={onOpenThread}
        goldLabelEnabled={goldLabelEnabled}
        hmsNoticesManagedByParent={hmsNoticesManagedByParent}
      />
    </div>
  );
}

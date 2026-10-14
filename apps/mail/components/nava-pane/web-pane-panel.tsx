import { useWebPreview, type PreviewSelection } from '@/lib/workstation/web-pane-bridge';
import { NavaPane } from '@/components/nava-pane/nava-pane';

function statusCopy(selection: PreviewSelection): string {
  if (selection.status === 'loading') return 'Loading thread…';
  if (selection.status === 'error') return 'Could not load this thread.';
  if (selection.status === 'unsynced' && selection.reason === 'no_message_id') {
    return 'Not analysable: the latest guest email has no Message-ID, so Nava cannot bind it.';
  }
  if (selection.status === 'unsynced') return 'No guest email in this thread to analyse.';
  return '';
}

/** The Nava pane for one thread, read-only, fed by the thread's latest guest email. */
export function WebPanePanel({ threadId }: { threadId: string }) {
  const { selection, bridge } = useWebPreview({ threadId });
  if (selection.status !== 'ready') {
    const reason = selection.status === 'unsynced' ? selection.reason : undefined;
    return (
      <div
        data-preview-status={selection.status}
        data-preview-reason={reason}
        data-preview-thread={threadId}
        role={selection.status === 'error' ? 'alert' : 'status'}
        className="p-4 text-sm text-slate-600"
      >
        {statusCopy(selection)}
      </div>
    );
  }
  return (
    <div
      data-preview-status="ready"
      data-preview-thread={threadId}
      className="h-full overflow-y-auto"
    >
      <NavaPane bridge={bridge} preview />
    </div>
  );
}

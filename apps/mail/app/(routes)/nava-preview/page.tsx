import { useWebPreview } from '@/lib/workstation/web-pane-bridge';
import { workItemsFromTrpc, quoteAnalysisOf, type StoredWork } from '@/lib/quote-workflow/backend-bind';
import { inMailbox } from '@/lib/mail/mail-cache-scope';
import { WorkflowBadge } from '@/components/quote-workflow/workflow-badge';
import type { ThreadListItem } from '@zero/server/driver/types';
import { trpcClient, useTRPC } from '@/providers/query-provider';
import { Link, useSearchParams } from 'react-router';
import { useQuery } from '@tanstack/react-query';
import { authProxy } from '@/lib/auth-proxy';
import { useEffect, useState } from 'react';

const LIST_LIMIT = 50;

/** Same guard as /mail: no session, no viewer. */
export async function clientLoader({ request }: { request: Request }) {
  const session = await authProxy.api.getSession({ headers: request.headers });
  if (!session) return Response.redirect(new URL('/login', new URL(request.url).origin));
  return null;
}

/** The list's wire type. The query's inferred union narrows to ids only, so rows are typed here. */
type ListedThread = Pick<ThreadListItem, 'id'> & {
  subject?: string | null;
  snippet?: string | null;
  latestMessageAt?: string | Date | null;
};

function parseWhen(value: string | Date | null | undefined): Date | null {
  if (!value) return null;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

function formatWhen(value: string | Date | null | undefined): string {
  return (
    parseWhen(value)?.toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' }) ?? ''
  );
}

/** Read the selected message and its existing classification without opening or changing a work item. */
function PreviewMessage({ threadId, sourceMessageId }: { threadId: string; sourceMessageId: string | null }) {
  const { selection } = useWebPreview({ threadId, ...(sourceMessageId ? { sourceMessageId } : {}), requireSelectedMessage: true });
  const [stored, setStored] = useState<{ key: string; result: StoredWork } | null>(null);
  const email = selection.status === 'ready' ? selection.email : null;
  const sourceThread = selection.status === 'ready' ? selection.threadId ?? null : null;
  const readKey = JSON.stringify([threadId, sourceThread, email?.entryId, email?.internetMessageId,
    email?.storeId, email?.subject, email?.bodyText, email?.bodyHtml]);
  useEffect(() => {
    setStored(null);
    const query = workItemsFromTrpc(trpcClient).getByMessage?.query;
    const mailbox = inMailbox(email?.storeId ?? null);
    if (!query || !mailbox || !sourceThread || !email?.entryId || !email.internetMessageId) return;
    let live = true;
    void query({ internetMessageId: email.internetMessageId,
      selection: { kind: 'web', threadId: sourceThread, messageId: email.entryId } }, mailbox)
      .then((result) => { if (live) setStored({ key: readKey, result }); }).catch(() => { if (live) setStored(null); });
    return () => { live = false; };
  }, [readKey]);
  if (selection.status !== 'ready') {
    const text = selection.status === 'loading' ? 'Loading thread…' : selection.status === 'error'
      ? 'Could not load this thread.' : 'Select a guest email in webmail.';
    return <div data-preview-status={selection.status} data-preview-thread={threadId}
      data-preview-reason={selection.status === 'unsynced' ? selection.reason : undefined} className="p-4 text-sm text-slate-600" role="status">{text}</div>;
  }
  return <div data-preview-status="ready" data-preview-thread={threadId} className="nava-pane-scroll flex h-full flex-col gap-4 overflow-y-auto p-4">
    {stored?.key === readKey && stored.result.status === 'ready'
      ? <WorkflowBadge analysis={quoteAnalysisOf(stored.result.analysis)} kind={stored.result.kind} /> : null}
    <div className="flex flex-col gap-1">
      <h2 data-pii className="text-sm font-semibold text-slate-900">{selection.email.subject || '(no subject)'}</h2>
      <p data-pii className="text-xs text-slate-500">{selection.email.senderName || selection.email.senderEmail}</p>
    </div>
    <p data-pii className="whitespace-pre-wrap break-words text-sm leading-relaxed text-slate-700">{selection.email.bodyText}</p>
  </div>;
}

export default function NavaPreviewPage() {
  const trpc = useTRPC();
  const [params] = useSearchParams();
  const deepLinked = params.get('thread');
  const recent = useQuery(
    trpc.mail.listThreads.queryOptions({ folder: 'inbox', limit: LIST_LIMIT }),
  );
  const rows = (recent.data?.threads ?? []) as ListedThread[];
  const selectedId = deepLinked || rows[0]?.id || null;
  const selectedMessageId = deepLinked ? params.get('sourceMessageId') : null;

  return (
    <div className="flex h-screen w-full min-w-0 overflow-hidden bg-[#f8fafc] text-[#0f172a]">
      <aside className="flex min-w-0 flex-1 flex-col border-r border-[#e2e8f0] bg-white">
        <header className="border-b border-[#e2e8f0] px-4 py-3">
          <h1 className="text-sm font-semibold">Recent threads</h1>
          {selectedId ? (
            <Link className="text-xs text-blue-700 underline" to={`/mail/inbox?threadId=${encodeURIComponent(selectedId)}${selectedMessageId ? `&sourceMessageId=${encodeURIComponent(selectedMessageId)}` : ''}`}>
              Open in webmail
            </Link>
          ) : null}
        </header>
        <div className="min-h-0 flex-1 overflow-y-auto">
          {recent.isLoading ? <p className="p-4 text-sm text-slate-500">Loading threads…</p> : null}
          {recent.isError ? (
            <p role="alert" className="p-4 text-sm text-red-700">
              Could not load threads.
            </p>
          ) : null}
          <ul className="divide-y divide-[#e2e8f0]">
            {rows.map((row) => (
              <li key={row.id}>
                <Link
                  to={`/nava-preview?thread=${encodeURIComponent(row.id)}`}
                  data-thread-id={row.id}
                  aria-current={row.id === selectedId ? 'true' : undefined}
                  className="flex flex-col gap-0.5 px-4 py-2.5 hover:bg-slate-50 aria-[current=true]:bg-slate-100"
                >
                  <span data-pii className="truncate text-sm font-medium">
                    {row.subject || '(no subject)'}
                  </span>
                  <span data-pii className="truncate text-xs text-slate-500">{row.snippet ?? ''}</span>
                  <time
                    dateTime={parseWhen(row.latestMessageAt)?.toISOString()}
                    className="text-[11px] text-slate-500"
                  >
                    {formatWhen(row.latestMessageAt)}
                  </time>
                </Link>
              </li>
            ))}
          </ul>
        </div>
      </aside>
      <section
        aria-label="Nava pane"
        data-preview-pane
        className="flex h-screen w-[420px] shrink-0 flex-col overflow-hidden border-l border-[#e2e8f0] bg-white"
      >
        {selectedId ? (
          <PreviewMessage
            key={selectedId}
            threadId={selectedId}
            sourceMessageId={selectedMessageId}
          />
        ) : (
          <p className="p-4 text-sm text-slate-500">No thread selected.</p>
        )}
      </section>
    </div>
  );
}

import { WebPanePanel } from '@/components/nava-pane/web-pane-panel';
import type { ThreadListItem } from '@zero/server/driver/types';
import { useTRPC } from '@/providers/query-provider';
import { Link, useSearchParams } from 'react-router';
import { useQuery } from '@tanstack/react-query';
import { authProxy } from '@/lib/auth-proxy';

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

export default function NavaPreviewPage() {
  const trpc = useTRPC();
  const [params] = useSearchParams();
  const deepLinked = params.get('thread');
  const recent = useQuery(
    trpc.mail.listThreads.queryOptions({ folder: 'inbox', limit: LIST_LIMIT }),
  );
  const rows = (recent.data?.threads ?? []) as ListedThread[];
  const selectedId = deepLinked || rows[0]?.id || null;

  return (
    <div className="flex h-screen w-full min-w-0 overflow-hidden bg-[#f8fafc] text-[#0f172a]">
      <aside className="flex min-w-0 flex-1 flex-col border-r border-[#e2e8f0] bg-white">
        <header className="border-b border-[#e2e8f0] px-4 py-3">
          <h1 className="text-sm font-semibold">Recent threads</h1>
          <p className="text-[11px] text-slate-500">
            Read-only preview. Nothing is written to Outlook or HMS.
          </p>
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
                  <span className="truncate text-sm font-medium">
                    {row.subject || '(no subject)'}
                  </span>
                  <span className="truncate text-xs text-slate-500">{row.snippet ?? ''}</span>
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
          <WebPanePanel key={selectedId} threadId={selectedId} />
        ) : (
          <p className="p-4 text-sm text-slate-500">No thread selected.</p>
        )}
      </section>
    </div>
  );
}

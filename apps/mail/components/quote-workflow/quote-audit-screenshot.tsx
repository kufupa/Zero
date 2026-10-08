import { useEffect, useRef, useState, type ReactNode } from 'react';
import type { QuoteRunScreenshotResult } from '@/lib/quote-workflow/types';

export type LoadRunScreenshot = (input: { runId: string; name: string }) => Promise<QuoteRunScreenshotResult>;

const NONE_COPY = 'No HMS screenshot for this quote.';
const UNAVAILABLE_COPY =
  'The HMS screenshot could not be loaded. Check the quoted details and PDF before sending.';

/** The HMS result or rates screen when one was captured, otherwise the last step. */
export function pickThumbnailIndex(names: readonly string[]): number {
  const preferred = names.findIndex((name) => /result|rates/i.test(name));
  return preferred >= 0 ? preferred : names.length - 1;
}

type ShotState = { status: 'loading' } | QuoteRunScreenshotResult;

/**
 * Loads one screenshot for runId + name. Called only once a quote has completed.
 * A response for a name the viewer has already moved past is dropped.
 */
function useRunScreenshot(
  runId: string | null,
  name: string | undefined,
  load: LoadRunScreenshot | undefined,
): ShotState {
  const loadRef = useRef(load);
  useEffect(() => {
    loadRef.current = load;
  }, [load]);
  const key = runId && name ? `${runId}\u0000${name}` : null;
  const [loaded, setLoaded] = useState<{ key: string; result: QuoteRunScreenshotResult } | null>(null);

  useEffect(() => {
    if (!runId || !name) return;
    const requestKey = `${runId}\u0000${name}`;
    let current = true;
    const fetchShot = async (): Promise<QuoteRunScreenshotResult> => {
      try {
        if (!loadRef.current) return { status: 'unavailable', reason: 'not_connected' };
        return await loadRef.current({ runId, name });
      } catch {
        return { status: 'unavailable', reason: 'request_failed' };
      }
    };
    void fetchShot().then((result) => {
      if (current) setLoaded({ key: requestKey, result });
    });
    return () => {
      current = false;
    };
  }, [runId, name]);

  if (!key || loaded?.key !== key) return { status: 'loading' };
  return loaded.result;
}

function AuditNote({ tone = 'muted', children }: { tone?: 'muted' | 'warning'; children: ReactNode }) {
  return (
    <p
      className={`rounded-xs border px-3 py-2 text-[11px] ${
        tone === 'warning'
          ? 'border-amber-200 bg-amber-50 text-amber-800'
          : 'border-[#e2e8f0] bg-white text-[#64748b]'
      }`}
    >
      {children}
    </p>
  );
}

function AuditThumbnail({
  runId,
  name,
  loadScreenshot,
  onOpen,
}: {
  runId: string;
  name: string;
  loadScreenshot?: LoadRunScreenshot;
  onOpen: () => void;
}) {
  const shot = useRunScreenshot(runId, name, loadScreenshot);
  if (shot.status === 'loading') return <AuditNote>Loading the HMS screenshot…</AuditNote>;
  if (shot.status === 'unavailable') return <AuditNote tone="warning">{UNAVAILABLE_COPY}</AuditNote>;
  return (
    <button
      type="button"
      aria-label="See what Luna did in HMS"
      onClick={onOpen}
      className="flex flex-col gap-1.5 rounded-xs border border-[#cbd5e1] bg-white p-2 text-left hover:border-[#0066cc]"
    >
      <img
        src={shot.dataUrl}
        alt="Thumbnail of the HMS screenshot for this quote"
        className="max-h-44 w-full rounded-xs border border-[#e2e8f0] object-contain object-top"
      />
      <span className="text-[12px] font-semibold text-[#0066cc]">See what Luna did in HMS</span>
    </button>
  );
}

function ScreenshotViewer({
  runId,
  names,
  index,
  loadScreenshot,
  onIndex,
  onClose,
}: {
  runId: string;
  names: readonly string[];
  index: number;
  loadScreenshot?: LoadRunScreenshot;
  onIndex: (index: number) => void;
  onClose: () => void;
}) {
  const shot = useRunScreenshot(runId, names[index], loadScreenshot);
  const closeRef = useRef<HTMLButtonElement>(null);
  const onCloseRef = useRef(onClose);
  useEffect(() => {
    onCloseRef.current = onClose;
  });
  useEffect(() => {
    closeRef.current?.focus();
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onCloseRef.current();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, []);

  const navButton =
    'h-9 w-9 shrink-0 rounded-xs border border-white/40 text-base font-bold text-white disabled:opacity-30';
  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label="HMS quote screenshots"
      className="fixed inset-0 z-50 flex flex-col gap-3 bg-slate-900/90 p-3"
    >
      <div className="flex items-center justify-between gap-2 text-xs text-white">
        <span>
          {index + 1} of {names.length}
        </span>
        <button
          ref={closeRef}
          type="button"
          aria-label="Close screenshot"
          onClick={onClose}
          className="rounded-xs border border-white/40 px-2 py-1 font-semibold text-white"
        >
          Close
        </button>
      </div>
      <div className="flex min-h-0 flex-1 items-center gap-2">
        <button
          type="button"
          aria-label="Previous screenshot"
          className={navButton}
          disabled={index <= 0}
          onClick={() => onIndex(index - 1)}
        >
          ‹
        </button>
        <div className="flex min-h-0 flex-1 items-center justify-center overflow-auto">
          {shot.status === 'ready' ? (
            <img
              src={shot.dataUrl}
              alt={`HMS screenshot ${index + 1} of ${names.length}`}
              className="max-h-full max-w-full object-contain"
            />
          ) : (
            <p className="text-center text-xs text-white">
              {shot.status === 'loading' ? 'Loading the HMS screenshot…' : UNAVAILABLE_COPY}
            </p>
          )}
        </div>
        <button
          type="button"
          aria-label="Next screenshot"
          className={navButton}
          disabled={index >= names.length - 1}
          onClick={() => onIndex(index + 1)}
        >
          ›
        </button>
      </div>
    </div>
  );
}

/**
 * Audit proof for a completed staff quote: a thumbnail of the most relevant HMS
 * screenshot that opens a full-size viewer over all of them.
 */
export function QuoteAuditScreenshot({
  runId,
  screenshots,
  loadScreenshot,
}: {
  runId: string | null;
  screenshots: readonly string[];
  loadScreenshot?: LoadRunScreenshot;
}) {
  const [viewerIndex, setViewerIndex] = useState<number | null>(null);
  if (!runId || screenshots.length === 0) return <AuditNote>{NONE_COPY}</AuditNote>;
  const thumbIndex = pickThumbnailIndex(screenshots);
  return (
    <section className="flex flex-col gap-2">
      <AuditThumbnail
        runId={runId}
        name={screenshots[thumbIndex]!}
        loadScreenshot={loadScreenshot}
        onOpen={() => setViewerIndex(thumbIndex)}
      />
      {viewerIndex !== null ? (
        <ScreenshotViewer
          runId={runId}
          names={screenshots}
          index={viewerIndex}
          loadScreenshot={loadScreenshot}
          onIndex={setViewerIndex}
          onClose={() => setViewerIndex(null)}
        />
      ) : null}
    </section>
  );
}

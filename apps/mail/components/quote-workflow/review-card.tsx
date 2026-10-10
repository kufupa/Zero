import {
  HMS_NOTE_MAX,
  HMS_NOTE_MIN,
  HMS_WRITE_COPY,
  refusalCopy,
  type HmsApprovalClient,
  type HmsReviewInput,
  type HmsWriteView,
} from '@/lib/quote-workflow/hms-write';
import { QuoteAuditScreenshot, type LoadRunScreenshot } from './quote-audit-screenshot';
import type { QuoteRunScreenshotResult } from '@/lib/quote-workflow/types';
import { useId, useState } from 'react';
import { toast } from 'sonner';

const focusRing = 'focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2';

/** Button and text classes shared by the approve and review cards. */
export const writeClasses = {
  primary: `rounded-sm bg-[#0066cc] px-3 py-1.5 text-[12px] font-semibold text-white disabled:opacity-50 ${focusRing} focus-visible:outline-[#0066cc]`,
  secondary: `rounded-sm border border-[#0066cc] bg-white px-3 py-1.5 text-[12px] font-semibold text-[#0066cc] disabled:opacity-50 ${focusRing} focus-visible:outline-[#0066cc]`,
  danger: `rounded-sm border border-[#b91c1c] bg-white px-3 py-1.5 text-[12px] font-semibold text-[#b91c1c] disabled:opacity-50 ${focusRing} focus-visible:outline-[#b91c1c]`,
  note: 'text-[11px] text-[#64748b]',
  alert: 'text-[11.5px] font-semibold text-red-700',
  textarea: `w-full rounded-sm border border-[#cbd5e1] px-2 py-1.5 text-[12px] text-[#1e293b] ${focusRing} focus-visible:outline-[#0066cc]`,
};

type Run = NonNullable<HmsWriteView['run']>;

/** The viewer takes a screenshot as the quote run reads it. The evidence reply carries only the data URL. */
function shotOf(name: string, dataUrl: string): QuoteRunScreenshotResult {
  const mimeType = /^data:([^;,]+)/.exec(dataUrl)?.[1] ?? 'image/png';
  const base64 = dataUrl.slice(dataUrl.indexOf(',') + 1);
  return {
    status: 'ready',
    name,
    mimeType,
    sizeBytes: Math.floor((base64.length * 3) / 4),
    dataUrl,
  };
}

/**
 * Review of an executed or stopped HMS write (U18). Shows the before and after screenshots the write sealed, then Review
 * OK or Flag. A flag needs a note. Screenshots past their keep window are not shown.
 */
export function ReviewCard({
  client,
  workItemId,
  run,
  onChanged,
}: {
  client: HmsApprovalClient;
  workItemId: string;
  run: Run;
  onChanged: () => void;
}) {
  const noteId = useId();
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // The decision made here, shown before the next state read lands.
  const [outcome, setOutcome] = useState<'ok' | 'flag' | null>(null);
  const [rereadNote, setRereadNote] = useState<string | null>(null);

  const reviewed = run.reviewed ?? outcome;
  const live = run.evidence.filter((row) => !row.expired);
  const expiredAll = run.evidence.length > 0 && live.length === 0;

  const loadShot: LoadRunScreenshot = async ({ name }) => {
    const row = run.evidence.find((item) => item.name === name);
    if (!row) return { status: 'unavailable', reason: 'evidence_unavailable' };
    const reply = await client.evidence({ workItemId, eventId: row.eventId });
    return reply.status === 'ok'
      ? shotOf(name, reply.dataUrl)
      : { status: 'unavailable', reason: reply.reason };
  };

  // A flag drops the snapshot the write was approved from, so HMS is read again for the next approval (KTD11).
  const rereadAfterFlag = () => {
    setRereadNote(HMS_WRITE_COPY.rereading);
    client
      .reread({ workItemId })
      .then(
        (reply) =>
          setRereadNote(
            reply.status === 'stored' ? HMS_WRITE_COPY.rereadDone : HMS_WRITE_COPY.rereadNeeded,
          ),
        () => setRereadNote(HMS_WRITE_COPY.rereadNeeded),
      )
      .finally(onChanged);
  };

  const decide = (decision: 'ok' | 'flag') => {
    const text = note.trim();
    if (decision === 'flag' && text.length < HMS_NOTE_MIN) {
      setError(HMS_WRITE_COPY.flagNoteNeeded);
      return;
    }
    const input: HmsReviewInput =
      decision === 'flag' ? { workItemId, decision, note: text } : { workItemId, decision };
    setBusy(true);
    setError(null);
    client
      .review(input)
      .then(() => {
        toast.success(decision === 'ok' ? HMS_WRITE_COPY.reviewedOk : HMS_WRITE_COPY.flagged);
        setOutcome(decision);
        onChanged();
        if (decision === 'flag') rereadAfterFlag();
      })
      .catch((err: unknown) => setError(refusalCopy(err)))
      .finally(() => setBusy(false));
  };

  return (
    <div className="flex flex-col gap-2 border-t border-[#e2e8f0] pt-3">
      {expiredAll ? (
        <p className={writeClasses.note}>{HMS_WRITE_COPY.expired}</p>
      ) : (
        <QuoteAuditScreenshot
          runId={live.length > 0 ? run.runId : null}
          screenshots={live.map((row) => row.name)}
          loadScreenshot={loadShot}
        />
      )}
      {live.length > 0 && live.length < run.evidence.length ? (
        <p className={writeClasses.note}>{HMS_WRITE_COPY.someExpired}</p>
      ) : null}
      {reviewed === null ? (
        <div className="flex flex-col gap-2">
          <label htmlFor={noteId} className="text-[12px] font-semibold text-[#1e293b]">
            {HMS_WRITE_COPY.reviewLabel}
          </label>
          <textarea
            id={noteId}
            value={note}
            onChange={(event) => setNote(event.target.value)}
            maxLength={HMS_NOTE_MAX}
            rows={2}
            className={writeClasses.textarea}
          />
          <div className="flex flex-wrap gap-2">
            <button
              type="button"
              className={writeClasses.primary}
              disabled={busy}
              onClick={() => decide('ok')}
            >
              {HMS_WRITE_COPY.reviewOk}
            </button>
            <button
              type="button"
              className={writeClasses.danger}
              disabled={busy}
              onClick={() => decide('flag')}
            >
              {HMS_WRITE_COPY.flag}
            </button>
          </div>
        </div>
      ) : null}
      <div role="status" aria-live="polite" className="text-[12px] text-[#334155]">
        {reviewed === 'ok'
          ? HMS_WRITE_COPY.reviewedOk
          : reviewed === 'flag'
            ? HMS_WRITE_COPY.flagged
            : null}
      </div>
      {rereadNote && reviewed === 'flag' ? (
        <p role="status" className={writeClasses.note}>
          {rereadNote}
        </p>
      ) : null}
      {error ? (
        <p role="alert" className={writeClasses.alert}>
          {error}
        </p>
      ) : null}
    </div>
  );
}

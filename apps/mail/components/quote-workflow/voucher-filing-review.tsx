'use client';

import { useEffect, useRef, useState } from 'react';
import { Notice, PrimaryButton, SecondaryButton, paneFieldClass } from '@/components/nava-pane/pane-ui';
import { HMS_NOTE_MAX, HMS_NOTE_MIN } from '@/lib/quote-workflow/hms-write';

type ReviewOperation = {
  operationId: string;
  state: string;
  evidence: { eventId: string; expired: boolean } | null;
  review: 'ok' | 'flag' | null;
};
type EvidenceScope = { workItemId: string; messageId: string; operationId: string; eventId: string };
type ReviewClient = {
  /** Server must derive the returned scope from the authorized stored evidence, not echo pane input. */
  evidence(input: EvidenceScope):
    Promise<({ status: 'ok'; dataUrl: string } & EvidenceScope) | { status: 'unavailable' }>;
  /** Server must validate that this exact, unexpired evidence event belongs to the authorized operation. */
  review(input: { workItemId: string; messageId: string; operationId: string; eventId: string; decision: 'ok' | 'flag'; note?: string }): Promise<unknown>;
};

type ReviewProps = {
  client: ReviewClient; workItemId: string; messageId: string; operation: ReviewOperation; onRefresh: () => void;
  reviewAttempts: { current: Set<string> };
};

/** Reset the review when its exact operation or evidence changes. */
export function VoucherFilingReview(props: ReviewProps) {
  const { workItemId, messageId, operation } = props;
  const key = JSON.stringify([workItemId, messageId, operation.operationId, operation.evidence?.eventId, operation.evidence?.expired]);
  return <CurrentFilingReview key={key} {...props} />;
}

function CurrentFilingReview({ client, workItemId, messageId, operation, onRefresh, reviewAttempts }: ReviewProps) {
  const [shot, setShot] = useState<{ status: 'loading' | 'ready' | 'shown' | 'unavailable'; client: ReviewClient; dataUrl?: string; imageToken?: object }>({ status: 'loading', client });
  // Changing the evidence client invalidates the displayed image immediately, before effects run.
  const visibleShot = shot.client === client ? shot : { status: 'loading' as const, client };
  const [note, setNote] = useState('');
  const [noteError, setNoteError] = useState(false);
  const [pending, setPending] = useState(() => reviewAttempts.current.has(operation.operationId));
  const [reviewError, setReviewError] = useState(false);
  const sent = useRef(false);
  const mounted = useRef(false);
  const evidence = operation.evidence;
  const eventId = evidence && typeof evidence.eventId === 'string' && evidence.eventId.length > 0 && typeof evidence.expired === 'boolean'
    ? evidence.eventId : null;
  const evidenceValid = eventId !== null;
  const expired = evidenceValid && evidence?.expired === true;

  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  useEffect(() => {
    let live = true;
    if (!eventId || expired) { setShot({ status: 'unavailable', client }); return; }
    setShot({ status: 'loading', client });
    void Promise.resolve().then(() => client.evidence({ workItemId, messageId, operationId: operation.operationId, eventId })).then((result) => {
      if (!live) return;
      if (result && result.status === 'ok' && result.workItemId === workItemId && result.messageId === messageId &&
          result.operationId === operation.operationId && result.eventId === eventId &&
          typeof result.dataUrl === 'string' && /^data:image\/png;base64,[A-Za-z0-9+/]+={0,2}$/.test(result.dataUrl)) {
        setShot({ status: 'ready', client, dataUrl: result.dataUrl, imageToken: {} });
      } else setShot({ status: 'unavailable', client });
    }, () => { if (live) setShot({ status: 'unavailable', client }); });
    return () => { live = false; };
  }, [client, workItemId, messageId, operation.operationId, eventId, expired]);

  const decide = async (decision: 'ok' | 'flag') => {
    if (!eventId || operation.state !== 'filed' || operation.review !== null || visibleShot.status !== 'shown' || sent.current || reviewAttempts.current.has(operation.operationId)) return;
    const text = note.trim();
    if (decision === 'flag' && text.length < HMS_NOTE_MIN) { setNoteError(true); return; }
    sent.current = true;
    reviewAttempts.current.add(operation.operationId);
    setNoteError(false); setPending(true); setReviewError(false);
    try {
      await client.review({ workItemId, messageId, operationId: operation.operationId, eventId, decision,
        ...(decision === 'flag' ? { note: text } : {}) });
    } catch { if (mounted.current) setReviewError(true); }
    // A mutation reply is not a durable review: read the exact operation again before proceeding.
    if (mounted.current) onRefresh();
  };

  return (
    <div className="flex flex-col gap-2 border-t border-[#e2e8f0] pt-2">
      <p className="text-[12px] font-semibold text-[#1e293b]">Review the HMS screenshot</p>
      {!evidenceValid ? <Notice tone="warn">Screenshot information is unavailable. Check in HMS before continuing.</Notice> :
        expired ? <Notice tone="warn">This screenshot has expired. Check in HMS before continuing.</Notice> :
        visibleShot.status === 'loading' ? <p role="status" className="text-[11.5px] text-[#334155]">Loading the HMS screenshot…</p> :
        visibleShot.status === 'unavailable' ? <Notice tone="warn">The screenshot could not be loaded. Check in HMS before continuing.</Notice> :
        <img data-pii src={visibleShot.dataUrl} alt="HMS filing screenshot" className="w-full rounded-sm border border-[#cbd5e1] object-contain"
          onLoad={() => setShot((current) => current.client === client && current.imageToken === visibleShot.imageToken && current.status === 'ready' ? { ...current, status: 'shown' } : current)}
          onError={() => setShot((current) => current.client === client && current.imageToken === visibleShot.imageToken ? { status: 'unavailable', client } : current)} />}
      {operation.review === 'ok' ? <p role="status" className="text-[11.5px] text-[#334155]">Screenshot review confirmed.</p> : null}
      {operation.review === 'flag' ? <Notice tone="warn">Review flagged. Check this filing before continuing.</Notice> : null}
      {operation.review !== null && operation.review !== 'ok' && operation.review !== 'flag' ?
        <Notice tone="warn">Review status is unavailable. Check before continuing.</Notice> : null}
      {operation.state === 'filed' && operation.review === null && visibleShot.status === 'shown' && !pending ? <>
        <label className="text-[11.5px] text-[#334155]">Note for a flagged review
          <textarea value={note} onChange={(event) => setNote(event.target.value)} maxLength={HMS_NOTE_MAX} rows={2} className={`mt-1 ${paneFieldClass} h-auto`} />
        </label>
        {noteError ? <Notice tone="warn">Add at least 3 characters explaining the problem.</Notice> : null}
        <div className="flex flex-wrap gap-2">
          <PrimaryButton onClick={() => void decide('ok')}>Confirm review</PrimaryButton>
          <SecondaryButton onClick={() => void decide('flag')}>Flag a problem</SecondaryButton>
        </div>
      </> : null}
      {operation.review === null && pending ? <>
        <p role="status" className="text-[11.5px] text-[#334155]">Checking whether your review was saved…</p>
        {reviewError ? <Notice tone="warn">Could not confirm that your review was saved. Check before continuing.</Notice> : null}
        <SecondaryButton onClick={onRefresh}>Check review status</SecondaryButton>
      </> : null}
    </div>
  );
}

'use client';

import { useEffect, useRef, useState } from 'react';
import { paneTextareaClass, SecondaryButton } from '@/components/nava-pane/pane-ui';
import type { BatchChildReview, BatchEvidenceScope, PaneBatchClient } from '@/lib/quote-workflow/pane-batch-booking';

type Shot = { status: 'idle' | 'loading' | 'unavailable' | 'expired' } |
  { status: 'available'; evidenceVersion: string; dataUrl: string };
export type ReviewAttempt = { review: BatchChildReview; epoch: number; verified?: BatchChildReview };

function sameScope(expected: BatchEvidenceScope, actual: BatchEvidenceScope): boolean {
  return actual.workItemId === expected.workItemId && actual.runId === expected.runId && actual.childId === expected.childId;
}

function matchingReview(scope: BatchEvidenceScope, review: BatchChildReview | null | undefined): BatchChildReview | null {
  return review && sameScope(scope, review) && typeof review.evidenceVersion === 'string' && review.evidenceVersion.length > 0 &&
    (review.decision === 'ok' || review.decision === 'flag') ? review : null;
}

/** Render only evidence returned for this particular confirmed child and its originating write run. */
export function BatchBookingEvidence({ client, batchRunId, allocationId, scope, reviewed, refreshEpoch, currentReadSequence, pending, onPending, onVerified }: {
  client: PaneBatchClient; batchRunId: string; allocationId: string; scope: BatchEvidenceScope;
  reviewed?: BatchChildReview | null; refreshEpoch: number; currentReadSequence: () => number;
  pending?: ReviewAttempt; onPending: (attempt: ReviewAttempt) => void; onVerified: (review: BatchChildReview) => void;
}) {
  const [shot, setShot] = useState<Shot>({ status: 'idle' });
  const [imageLoaded, setImageLoaded] = useState(false);
  const [flagging, setFlagging] = useState(false);
  const [note, setNote] = useState('');
  const [saving, setSaving] = useState(false);
  const sequence = useRef(0);
  useEffect(() => () => { sequence.current += 1; }, []);
  const readReview = matchingReview(scope, reviewed);
  const sameDecision = (value: BatchChildReview | null, expected: BatchChildReview) => value &&
    sameScope(expected, value) && value.evidenceVersion === expected.evidenceVersion && value.decision === expected.decision;
  // A prior result cannot confirm a new submission. Only a matching read begun after it can.
  const verified = matchingReview(scope, pending?.verified);
  const outcome = pending
    ? (sameDecision(verified, pending.review) ? verified :
      refreshEpoch > pending.epoch && sameDecision(readReview, pending.review) ? readReview : null)
    : readReview;
  const reviewUncertain = !!pending && !outcome;

  async function showScreenshot() {
    if (!client.evidence || shot.status === 'loading') return;
    const request = ++sequence.current;
    setShot({ status: 'loading' }); setImageLoaded(false);
    try {
      const reply = await client.evidence(scope);
      if (request !== sequence.current) return;
      if (!sameScope(scope, reply)) { setShot({ status: 'unavailable' }); return; }
      if (reply.status === 'expired' || reply.status === 'unavailable') { setShot({ status: reply.status }); return; }
      // Do not load remote URLs or arbitrary HTML from an evidence response.
      if (reply.status !== 'available' || typeof reply.evidenceVersion !== 'string' || !reply.evidenceVersion ||
          typeof reply.dataUrl !== 'string' || reply.dataUrl.length > 16_000_000 ||
          !/^data:image\/png;base64,[A-Za-z0-9+/]+={0,2}$/.test(reply.dataUrl)) {
        setShot({ status: 'unavailable' }); return;
      }
      setShot({ status: 'available', evidenceVersion: reply.evidenceVersion, dataUrl: reply.dataUrl });
    } catch { if (request === sequence.current) setShot({ status: 'unavailable' }); }
  }

  async function record(decision: 'ok' | 'flag') {
    if (!client.reviewChild || shot.status !== 'available' || !imageLoaded || saving || outcome || reviewUncertain ||
        (decision === 'flag' && note.trim().length < 3)) return;
    const evidenceVersion = shot.evidenceVersion;
    const expected: BatchChildReview = { ...scope, evidenceVersion, decision };
    const request = ++sequence.current;
    // Even an error may follow a durable write. Hold this exact decision until a fresh read proves it.
    onPending({ review: expected, epoch: currentReadSequence() });
    setSaving(true);
    try {
      const reply = await client.reviewChild(decision === 'flag'
        ? { ...scope, evidenceVersion, decision, note: note.trim() }
        : { ...scope, evidenceVersion, decision });
      if (request !== sequence.current) return;
      if (reply.status !== 'recorded' || !sameScope(scope, reply) || reply.evidenceVersion !== evidenceVersion || reply.decision !== decision) throw new Error('review_mismatch');
      // The acknowledgement is not proof of persistence: read the batch afresh, scoped to its run.
      const result = await client.read({ workItemId: scope.workItemId, runId: batchRunId });
      if (request !== sequence.current) return;
      if (result.workItemId !== scope.workItemId || result.runId !== batchRunId || !Array.isArray(result.rooms)) throw new Error('review_read_mismatch');
      const matches = result.rooms.filter((room) => room.allocationId === allocationId);
      const room = matches[0];
      if (matches.length !== 1 || room?.status !== 'confirmed' || room.screenshotRecorded !== true || room.readbackRecorded !== true ||
          room.attempt?.runId !== scope.runId || room.attempt?.childId !== scope.childId ||
          !sameDecision(matchingReview(scope, room.reviewed), expected)) throw new Error('review_read_mismatch');
      onVerified(expected); setFlagging(false);
    } catch {
      // Failed/mismatched acknowledgements and reads remain held; no automatic re-submit.
    } finally { if (request === sequence.current) setSaving(false); }
  }

  return <div className="flex flex-col gap-2 border-t border-[#e2e8f0] pt-2">
    {outcome ? <p role="status">{outcome.decision === 'ok' ? 'HMS booking reviewed.' : 'Flagged for follow-up.'}</p> : null}
    {!client.evidence ? <p>Screenshot review is not available yet. Check HMS directly.</p> : null}
    {client.evidence && shot.status !== 'available' && shot.status !== 'loading' ?
      <SecondaryButton onClick={() => void showScreenshot()}>{shot.status === 'idle' ? 'View HMS screenshot' : 'Try screenshot again'}</SecondaryButton> : null}
    {shot.status === 'loading' ? <p role="status">Loading the HMS screenshot…</p> : null}
    {shot.status === 'expired' ? <p>The HMS screenshot has expired. Check HMS directly.</p> : null}
    {shot.status === 'unavailable' ? <p>Nava could not show the HMS screenshot. Check HMS directly.</p> : null}
    {shot.status === 'available' ? <figure className="flex flex-col gap-1">
      <figcaption>Saved in HMS</figcaption>
      <img src={shot.dataUrl} alt="Saved booking in HMS" className="h-auto w-full" onLoad={() => setImageLoaded(true)}
        onError={() => { setImageLoaded(false); setShot({ status: 'unavailable' }); }} />
    </figure> : null}
    {shot.status === 'available' && !outcome && !client.reviewChild ? <p>Screenshot review is not available yet. Check HMS directly.</p> : null}
    {reviewUncertain && !outcome ? <p role="alert">Review may have been saved. Refresh booking results before reviewing again.</p> : null}
    {saving ? <p role="status">Saving review. This can take more than 30 seconds.</p> : null}
    {shot.status === 'available' && client.reviewChild && !outcome && !reviewUncertain ? <div className="flex flex-col gap-2">
      {!imageLoaded ? <p>Wait for the screenshot before reviewing.</p> : null}
      {flagging ? <label className="flex flex-col gap-1">What needs attention?
        <textarea data-pii className={paneTextareaClass} maxLength={500} value={note} onChange={(event) => setNote(event.target.value)} />
      </label> : null}
      <div className="flex flex-wrap gap-2">
        {!flagging ? <SecondaryButton disabled={!imageLoaded || saving} onClick={() => void record('ok')}>Review OK</SecondaryButton> : null}
        {flagging ? <SecondaryButton disabled={!imageLoaded || saving || note.trim().length < 3} onClick={() => void record('flag')}>Save flag</SecondaryButton> :
          <SecondaryButton disabled={!imageLoaded || saving} onClick={() => setFlagging(true)}>Flag a problem</SecondaryButton>}
        {flagging ? <SecondaryButton disabled={saving} onClick={() => setFlagging(false)}>Cancel</SecondaryButton> : null}
      </div>
    </div> : null}
  </div>;
}

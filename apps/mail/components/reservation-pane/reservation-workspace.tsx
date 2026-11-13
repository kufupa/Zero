'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogTitle } from '@/components/ui/dialog';
import type { PaneBridge } from '@/lib/workstation/pane-bridge-types';
import { useQuoteOutput } from './use-quote-output';
import type { SaveQuoteOutput } from './quote-output-panel';
import { snapshotMatchesSource } from '@/lib/reservation-workflow/views';
import { ReservationPane } from './reservation-pane';
import type { ReservationPaneSnapshot, ReservationSourceContext, ReservationWorkflowClient } from '@/lib/reservation-workflow/types';

export type ReservationWorkspaceProps = {
  source: ReservationSourceContext;
  client: ReservationWorkflowClient;
  bridge?: PaneBridge; hostType?: 'webmail' | 'outlook';
  onOpenEvidence?: (ref: string) => void;
  onOpenAttachment?: (ref: string) => void;
};

/** New shared Outlook/webmail mount. Host auth, bridge, mailbox and source resolution remain outside. */
export function ReservationWorkspace({ source, client, onOpenEvidence, onOpenAttachment, bridge, hostType = 'webmail' }: ReservationWorkspaceProps) {
  const [boundSnapshot, setBoundSnapshot] = useState<{ key: string; value: ReservationPaneSnapshot } | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const activeSource = useRef('');
  const refreshCount = useRef(0);
  const request = useRef<{ key: string; promise: Promise<ReservationPaneSnapshot>; prefill: Promise<ReservationPaneSnapshot> | null } | null>(null);
  const key = JSON.stringify([source.mailboxId, source.propertyId, source.threadId, source.messageId,
    source.sourceHash, source.arrivedAt, source.selectionEpoch]);
  const snapshot = boundSnapshot?.key === key ? boundSnapshot.value : null;
  const [confirmation, setConfirmation] = useState<{ message: string; label: string } | null>(null);
  const confirmResolve = useRef<((accepted: boolean) => void) | null>(null);
  const finishConfirmation = (accepted: boolean) => { confirmResolve.current?.(accepted); confirmResolve.current = null; setConfirmation(null); };
  const confirm = (message: string, label: string) => new Promise<boolean>(resolve => {
    confirmResolve.current?.(false); confirmResolve.current = resolve; setConfirmation({ message, label });
  });
  useEffect(() => { setConfirmation(null); return () => { confirmResolve.current?.(false); confirmResolve.current = null; }; }, [key]);

  const quoteOutput = useQuoteOutput({ source, bridge, isCurrentSource: candidate => activeSource.current === key && candidate.messageId === source.messageId && candidate.sourceHash === source.sourceHash && candidate.selectionEpoch === source.selectionEpoch });
  const saveQuoteOutput: SaveQuoteOutput = input => hostType === 'outlook'
    ? quoteOutput.createOutlookReply({ ...input, confirmUnknown: () => confirm('A previous reply may exist. Check Outlook Drafts first. Continue only if you verified there is no duplicate.', 'I checked Drafts · continue') })
    : quoteOutput.saveWebReply({ ...input, confirmReplace: () => confirm('This thread has an existing unsent draft. Replace it with the reviewed quotation?', 'Replace unsent draft') });

  useEffect(() => {
    let live = true;
    refreshCount.current = 0;
    activeSource.current = key;
    setBoundSnapshot(current => current?.key === key ? current : null);
    setLoadError(null);
    if (request.current?.key !== key) request.current = { key, promise: client.ensure({ source, mode: 'initialize' }), prefill: null };
    const initialRequest = request.current;
    const acceptPrefill = (next: ReservationPaneSnapshot) => {
      if (!live || activeSource.current !== key || !snapshotMatchesSource(next, source)) return;
      setBoundSnapshot(bound => {
        const current = bound?.key === key ? bound.value : null;
        if (!current || next.session.seq > current.session.seq) return { key, value: next };
        if (next.session.seq < current.session.seq) return bound;
        if (Boolean(current.session.sourceChanged) !== Boolean(next.session.sourceChanged))
          return next.session.sourceChanged ? { key, value: next } : bound;
        const rank = { idle: 0, queued: 1, running: 2, failed: 3, complete: 3, superseded: 4 } as const;
        const oldMeta = current.session.draft.prefill, newMeta = next.session.draft.prefill;
        if ((newMeta?.attemptCount ?? 0) < (oldMeta?.attemptCount ?? 0) ||
            ((newMeta?.attemptCount ?? 0) === (oldMeta?.attemptCount ?? 0) &&
              rank[newMeta?.status ?? 'idle'] < rank[oldMeta?.status ?? 'idle'])) return bound;
        return { key, value: next };
      });
    };
    initialRequest.promise.then((next) => {
      if (!live || activeSource.current !== key) return;
      if (!snapshotMatchesSource(next, source)) {
        setLoadError('The reservation draft did not match the selected email.');
        return;
      }
      acceptPrefill(next);
      if (!next.session.sourceChanged && (!next.session.draft.prefill || next.session.draft.prefill.status === 'idle')) {
        const prefill = initialRequest.prefill ?? client.prefill({ source, snapshot: next });
        initialRequest.prefill = prefill;
        void prefill.then(acceptPrefill).catch((error: unknown) => {
          if (initialRequest.prefill === prefill) initialRequest.prefill = null;
          if (!live || activeSource.current !== key) return;
          setLoadError(error instanceof Error ? error.message : 'Prefill did not finish. Your editable draft is available.');
        });
      } else if (next.session.draft.prefill?.status === 'running' || next.session.draft.prefill?.status === 'queued') acceptPrefill(next);
    }).catch((error: unknown) => {
      if (!live || activeSource.current !== key) return;
      setLoadError(error instanceof Error ? error.message : 'The source-bound reservation draft could not be opened.');
    });
    return () => { live = false; };
  }, [client, key, source]);

  const acceptSnapshot = useCallback((next: ReservationPaneSnapshot) => {
    if (activeSource.current !== key || !snapshotMatchesSource(next, source)) return;
    setBoundSnapshot(bound => {
      const current = bound?.key === key ? bound.value : null;
      if (current && (next.session.seq < current.session.seq ||
          (next.session.seq === current.session.seq && current.session.sourceChanged && !next.session.sourceChanged))) return bound;
      return { key, value: next };
    });
    setLoadError(null);
  }, [key, source]);

  useEffect(() => {
    if (!snapshot || snapshot.session.sourceChanged || !['running', 'queued'].includes(snapshot.session.draft.prefill?.status ?? '')) {
      refreshCount.current = 0;
      return;
    }
    let live = true;
    let timer: ReturnType<typeof setTimeout>;
    const poll = () => { timer = setTimeout(() => {
      if (++refreshCount.current > 900) { setLoadError('Prefill is still processing. Reopen this email to check progress; your draft is retained.'); return; }
      void client.get({ source, snapshot, backgroundPoll: true }).then(next => {
        if (!live || activeSource.current !== key) return;
        if (snapshotMatchesSource(next, source)) {
          setLoadError(null);
          setBoundSnapshot(bound => {
            if (bound?.key !== key || bound.value !== snapshot || next.session.seq < bound.value.session.seq ||
                (next.session.seq === bound.value.session.seq && bound.value.session.sourceChanged && !next.session.sourceChanged)) return bound;
            const rank = { idle: 0, queued: 1, running: 2, failed: 3, complete: 3, superseded: 4 } as const;
            const oldMeta = bound.value.session.draft.prefill, newMeta = next.session.draft.prefill;
            if (next.session.seq === bound.value.session.seq &&
                ((newMeta?.attemptCount ?? 0) < (oldMeta?.attemptCount ?? 0) ||
                 (newMeta?.attemptCount ?? 0) === (oldMeta?.attemptCount ?? 0) &&
                 rank[newMeta?.status ?? 'idle'] < rank[oldMeta?.status ?? 'idle'])) return bound;
            return { key, value: next };
          });
        }
        poll();
      }).catch(() => {
        if (live && activeSource.current === key) {
          setLoadError('Could not refresh the email prefill. Retrying; your draft is retained.');
          poll();
        }
      });
    }, 2000); };
    poll();
    return () => { live = false; clearTimeout(timer); };
  }, [client, key, snapshot, source]);

  return <><ReservationPane source={source} client={client} snapshot={snapshotMatchesSource(snapshot, source) ? snapshot : null} loadError={loadError} onSnapshot={acceptSnapshot}
    onOpenEvidence={onOpenEvidence} onOpenAttachment={onOpenAttachment} onSaveQuoteOutput={saveQuoteOutput} />
    <Dialog open={Boolean(confirmation)} onOpenChange={open => { if (!open) finishConfirmation(false); }}>
      <DialogContent showOverlay><DialogTitle>Save quotation reply</DialogTitle><DialogDescription>{confirmation?.message}</DialogDescription>
        <DialogFooter><button type="button" onClick={() => finishConfirmation(false)}>Keep existing draft</button><button type="button" onClick={() => finishConfirmation(true)}>{confirmation?.label}</button></DialogFooter>
      </DialogContent>
    </Dialog></>;
}

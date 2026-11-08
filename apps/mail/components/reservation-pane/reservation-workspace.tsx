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
  const [snapshot, setSnapshot] = useState<ReservationPaneSnapshot | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const activeSource = useRef('');
  const request = useRef<{ key: string; promise: Promise<ReservationPaneSnapshot> } | null>(null);
  const key = `${source.mailboxId}:${source.selectionEpoch}:${source.messageId}:${source.sourceHash}`;
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
    let refreshTimer: ReturnType<typeof setTimeout> | undefined;
    let refreshCount = 0;
    activeSource.current = key;
    setSnapshot(null);
    setLoadError(null);
    if (request.current?.key !== key) request.current = { key, promise: client.ensure({ source, mode: 'initialize' }) };
    const acceptPrefill = (next: ReservationPaneSnapshot) => {
      if (!live || activeSource.current !== key) return;
      setSnapshot(current => !current || next.session.seq >= current.session.seq ? next : current);
      if (next.session.draft.prefill?.status === 'running') {
        if (++refreshCount > 90) { setLoadError('Reading this email is taking longer than expected. Reopen it to check progress; your draft is retained.'); return; }
        refreshTimer = setTimeout(() => {
          void client.get({ source, snapshot: next }).then(acceptPrefill).catch(() => {
            if (live && activeSource.current === key) setLoadError('Could not refresh the email prefill. Reopen it to check progress; your draft is retained.');
          });
        }, 2000);
      }
    };
    request.current.promise.then((next) => {
      if (!live || activeSource.current !== key) return;
      setSnapshot(next);
      if (!next.session.draft.prefill || next.session.draft.prefill.status === 'idle') {
        void client.prefill({ source, snapshot: next }).then(acceptPrefill).catch((error: unknown) => {
          if (!live || activeSource.current !== key) return;
          setLoadError(error instanceof Error ? error.message : 'Prefill did not finish. Your editable draft is available.');
        });
      } else if (next.session.draft.prefill.status === 'running') acceptPrefill(next);
    }).catch((error: unknown) => {
      if (!live || activeSource.current !== key) return;
      setLoadError(error instanceof Error ? error.message : 'The source-bound reservation draft could not be opened.');
    });
    return () => { live = false; if (refreshTimer) clearTimeout(refreshTimer); };
  }, [client, key, source]);

  const acceptSnapshot = useCallback((next: ReservationPaneSnapshot) => {
    if (activeSource.current !== key || next.sourceMessageId !== source.messageId) return;
    setSnapshot(current => !current || next.session.seq >= current.session.seq ? next : current);
    setLoadError(null);
  }, [key, source.messageId]);

  return <><ReservationPane source={source} client={client} snapshot={snapshotMatchesSource(snapshot, source) ? snapshot : null} loadError={loadError} onSnapshot={acceptSnapshot}
    onOpenEvidence={onOpenEvidence} onOpenAttachment={onOpenAttachment} onSaveQuoteOutput={saveQuoteOutput} />
    <Dialog open={Boolean(confirmation)} onOpenChange={open => { if (!open) finishConfirmation(false); }}>
      <DialogContent showOverlay><DialogTitle>Save quotation reply</DialogTitle><DialogDescription>{confirmation?.message}</DialogDescription>
        <DialogFooter><button type="button" onClick={() => finishConfirmation(false)}>Keep existing draft</button><button type="button" onClick={() => finishConfirmation(true)}>{confirmation?.label}</button></DialogFooter>
      </DialogContent>
    </Dialog></>;
}

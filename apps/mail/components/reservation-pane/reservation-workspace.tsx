'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { ReservationPane } from './reservation-pane';
import type { ReservationPaneSnapshot, ReservationSourceContext, ReservationWorkflowClient } from '@/lib/reservation-workflow/types';

export type ReservationWorkspaceProps = {
  source: ReservationSourceContext;
  client: ReservationWorkflowClient;
  onOpenEvidence?: (ref: string) => void;
  onOpenAttachment?: (ref: string) => void;
};

/** New shared Outlook/webmail mount. Host auth, bridge, mailbox and source resolution remain outside. */
export function ReservationWorkspace({ source, client, onOpenEvidence, onOpenAttachment }: ReservationWorkspaceProps) {
  const [snapshot, setSnapshot] = useState<ReservationPaneSnapshot | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const activeSource = useRef('');
  const request = useRef<{ key: string; promise: Promise<ReservationPaneSnapshot> } | null>(null);
  const key = `${source.mailboxId}:${source.selectionEpoch}:${source.messageId}:${source.sourceHash}`;

  useEffect(() => {
    let live = true;
    activeSource.current = key;
    setSnapshot(null);
    setLoadError(null);
    if (request.current?.key !== key) request.current = { key, promise: client.ensure({ source }) };
    request.current.promise.then((next) => {
      if (!live || activeSource.current !== key) return;
      setSnapshot(next);
    }).catch((error: unknown) => {
      if (!live || activeSource.current !== key) return;
      setLoadError(error instanceof Error ? error.message : 'The source-bound reservation draft could not be opened.');
    });
    return () => { live = false; };
  }, [client, key, source]);

  const acceptSnapshot = useCallback((next: ReservationPaneSnapshot) => {
    if (activeSource.current !== key || next.sourceMessageId !== source.messageId) return;
    setSnapshot(next);
    setLoadError(null);
  }, [key, source.messageId]);

  return <ReservationPane source={source} client={client} snapshot={snapshot} loadError={loadError} onSnapshot={acceptSnapshot}
    onOpenEvidence={onOpenEvidence} onOpenAttachment={onOpenAttachment} />;
}

import { useEffect, useMemo, useRef, useState } from 'react';
import { useSession } from '@/lib/auth-client';
import { useActiveConnection } from '@/hooks/use-connections';
import { trpcClient } from '@/providers/query-provider';
import type { PaneBridge } from '@/lib/workstation/pane-bridge-types';
import { useOutlookSync } from '@/lib/workstation/use-outlook-sync';
import { OutlookSyncProgress } from '@/components/workstation/outlook-sync-progress';
import { OutlookPaneSignIn } from '@/app/(routes)/outlook-pane/outlook-pane-sign-in';
import { SelectedEmailBlock } from './blocks/selected-email';
import { ReservationWorkspace } from '@/components/reservation-pane/reservation-workspace';
import { createTrpcReservationWorkflowClient } from '@/lib/reservation-workflow/client';
import type { ReservationSourceContext } from '@/lib/reservation-workflow/types';
import {
  createPaneVersionWatch, fetchPaneVersion, loadedPaneBuild, PANE_RELEASE_POLL_MS,
  reloadAtEmailSwitch, reloadPane, type PaneVersion,
} from '@/lib/workstation/pane-release-watch';
import { mutationsInFlight } from '@/lib/workstation/mutations-in-flight';

type Props = {
  bridge: PaneBridge;
  preview?: boolean;
  webSelectedThreadId?: string;
};
type ResolvedSource = {
  owner: string;
  source: ReservationSourceContext;
};

/** Installed bridge/auth/sync remain shared; the old quote workflow is never mounted here. */
export function ReservationPaneHost({ bridge, preview = false, webSelectedThreadId }: Props) {
  const { data: session, isLoading: sessionLoading } = useSession();
  const { data: connection, isLoading: connectionLoading } = useActiveConnection();
  const email = bridge.activeEmail;
  const sync = useOutlookSync({
    userId: session?.user?.id ?? null,
    sessionId: session?.session?.id ?? null,
    transportId: connection?.id ?? null,
    mailbox: connection?.email ?? '',
    deviceId: bridge.workstationInfo?.deviceId ?? null,
    capabilityVersion: bridge.capabilities?.mailboxSync,
    readRoots: bridge.capabilities?.readRoots ?? [],
    authorized: Boolean(bridge.isConnected && !bridge.requiresRelogin && !bridge.authorizationUnavailable),
    readOnlyStatus: preview,
    activateNative: bridge.activateMailboxSync,
  });
  const selection = useMemo(() => {
    if (!email?.entryId) return null;
    if (preview) return webSelectedThreadId
      ? { kind: 'web' as const, messageId: email.entryId, threadId: webSelectedThreadId } : null;
    if (!email.storeId) return null;
    return { kind: 'outlook' as const, storeId: email.storeId, entryId: email.entryId,
      ...(email.folderEntryId ? { folderEntryId: email.folderEntryId } : {}) };
  }, [email?.entryId, email?.storeId, email?.folderEntryId, preview, webSelectedThreadId]);
  const owner = session?.user?.id && connection?.id && selection
    ? JSON.stringify([session.user.id, session.session?.id, connection.id, selection,
      email?.internetMessageId, email?.subject, email?.bodyText, email?.bodyHtml]) : null;
  const epoch = useRef({ owner, value: 0 });
  if (epoch.current.owner !== owner) epoch.current = { owner, value: epoch.current.value + 1 };
  const currentOwner = useRef(owner);
  currentOwner.current = owner;
  const [resolved, setResolved] = useState<ResolvedSource | null>(null);
  const [sourceError, setSourceError] = useState<string | null>(null);
  const client = useMemo(() => createTrpcReservationWorkflowClient(trpcClient), []);
  const [pendingBuild, setPendingBuild] = useState<PaneVersion | null>(null);
  const [loadedBuild] = useState(() => loadedPaneBuild());
  const lastSelection = useRef<string | null>(null);
  const [reloading, setReloading] = useState(false);

  useEffect(() => {
    if (!import.meta.env.PROD || !loadedBuild) return;
    const watcher = createPaneVersionWatch({ loadedBuild, fetchServed: fetchPaneVersion, onPending: setPendingBuild });
    const check = () => void watcher.check();
    check();
    const timer = window.setInterval(check, PANE_RELEASE_POLL_MS);
    window.addEventListener('focus', check);
    return () => { window.clearInterval(timer); window.removeEventListener('focus', check); };
  }, [loadedBuild]);

  useEffect(() => {
    const identity = selection ? JSON.stringify([connection?.id, selection]) : null;
    if (!identity) return;
    const switched = lastSelection.current !== null && lastSelection.current !== identity;
    lastSelection.current = identity;
    if (switched && reloadAtEmailSwitch({ pending: pendingBuild !== null, mutationsInFlight: mutationsInFlight() })) {
      setReloading(true);
      reloadPane();
    }
  }, [selection, connection?.id, pendingBuild]);

  useEffect(() => {
    if (resolved?.owner === owner && owner !== null) return;
    setResolved(null);
    setSourceError(null);
    if (!owner || !selection || !email || !connection?.id || bridge.requiresRelogin ||
      (!preview && (bridge.updateRequired || bridge.authorizationUnavailable || bridge.selectionOutsideMailbox))) return;
    const selectedEpoch = epoch.current.value;
    let alive = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let attempts = 0;
    const resolve = async () => {
      try {
        const result = await trpcClient.reservationWorkflowV2.resolveSource.query({ selection,
          ...(email.internetMessageId ? { internetMessageId: email.internetMessageId } : {}) });
        if (!alive || currentOwner.current !== owner || epoch.current.value !== selectedEpoch) return;
        if (result.status !== 'ok') {
          setSourceError(result.status === 'wrong_property'
            ? result.message : 'Waiting for this email to become available in Nava.');
          if (result.status === 'source_unavailable' && ++attempts < 12) timer = setTimeout(() => void resolve(), 10_000);
          return;
        }
        setSourceError(null);
        setResolved({ owner, source: {
          mailboxId: connection.id,
          propertyId: result.propertyCode,
          messageId: result.source.messageId,
          threadId: result.source.threadId,
          sourceHash: result.source.sourceHash,
          arrivedAt: result.source.arrivedAt,
          internetMessageId: result.internetMessageId,
          selectionEpoch: selectedEpoch,
          subject: email.subject,
          sender: email.senderEmail,
          receivedAt: result.source.arrivedAt,
          attachments: result.attachments.filter((item) => !item.isInline).map((item) => ({
            sourceRef: item.id, name: item.filename, mimeType: item.mimeType,
            uploadability: /\.pdf$/iu.test(item.filename) &&
              ['application/pdf', 'application/x-pdf', 'application/octet-stream'].includes(
                item.mimeType.split(';', 1)[0]?.trim().toLowerCase() ?? '') &&
              item.sizeBytes > 0 && item.sizeBytes <= 10 * 1024 * 1024
              ? 'unknown' as const : 'unsupported' as const,
          })),
        } });
      } catch {
        if (alive && currentOwner.current === owner) setSourceError('Nava could not open this email. Check your connection.');
      }
    };
    void resolve();
    return () => { alive = false; if (timer) clearTimeout(timer); };
  }, [owner, selection, connection?.id, resolved?.owner, bridge.requiresRelogin, bridge.updateRequired,
    bridge.authorizationUnavailable, bridge.selectionOutsideMailbox, preview, sync.status?.committed]);

  if (sessionLoading || connectionLoading) return <p className="p-4 text-sm text-slate-600">Loading Nava…</p>;
  if (!session?.user || bridge.requiresRelogin) return <OutlookPaneSignIn />;
  if (reloading) return <p className="p-4 text-sm text-slate-600">Loading the latest Nava pane…</p>;
  const source = resolved?.owner === owner ? resolved.source : null;
  return (
    <div className="flex h-full min-h-0 flex-col bg-slate-50 text-slate-800">
      <header className="flex shrink-0 items-center justify-between gap-2 border-b border-slate-200 bg-white p-3">
        <div className="min-w-0"><strong className="text-base">Nava</strong>
          <p className="truncate text-xs text-slate-500">{connection?.email || 'Select a mailbox'}</p></div>
        <OutlookSyncProgress status={sync.status} notApplicable={sync.notApplicable} mailbox={connection?.email ?? ''}
          onControl={(operation) => void sync.control(operation)} error={sync.error} busy={sync.busy}
          controlsEnabled={!preview && sync.eligible} />
      </header>
      {pendingBuild ? <p role="status" className="px-3 py-2 text-xs">New version available. It will load when you open another email.</p> : null}
      {!preview && bridge.updateRequired ? <p role="alert" className="p-3 text-sm">Update the Outlook add-in to open email in Nava.</p> : null}
      {!preview && bridge.selectionOutsideMailbox ? <p role="alert" className="p-3 text-sm">Select an email in the connected mailbox.</p> : null}
      {!preview && !bridge.workstationInfo?.paired ? <button type="button" className="m-3 rounded border p-2 text-sm"
        onClick={() => void bridge.pairDevice().catch(() => setSourceError('Nava could not connect this Outlook. Try again.'))}>Connect this Outlook</button> : null}
      {!preview && bridge.authorizationUnavailable ? <button type="button" className="m-3 rounded border p-2 text-sm"
        onClick={bridge.refreshAuthorization}>Reconnect Outlook</button> : null}
      <SelectedEmailBlock activeEmail={email} />
      {sourceError ? <p role="status" className="p-3 text-sm text-slate-600">{sourceError}</p> : null}
      {email && !source && !sourceError ? <p role="status" className="p-3 text-sm text-slate-600">Opening selected email…</p> : null}
      {source ? <ReservationWorkspace key={`${owner}:${source.selectionEpoch}`} source={source} client={client} /> : null}
    </div>
  );
}

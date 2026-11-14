import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useSession } from '@/lib/auth-client';
import { useActiveConnection } from '@/hooks/use-connections';
import { trpcClient } from '@/providers/query-provider';
import type { PaneBridge } from '@/lib/workstation/pane-bridge-types';
import { openAttachmentViaBlob } from '@/lib/attachment-access';
import { inMailbox } from '@/lib/mail/mail-cache-scope';
import { useOutlookSync } from '@/lib/workstation/use-outlook-sync';
import { OutlookSyncProgress } from '@/components/workstation/outlook-sync-progress';
import { OutlookPaneSignIn } from '@/app/(routes)/outlook-pane/outlook-pane-sign-in';
import { SelectedEmailBlock } from './blocks/selected-email';
import { ReservationWorkspace } from '@/components/reservation-pane/reservation-workspace';
import { createTrpcReservationWorkflowClient } from '@/lib/reservation-workflow/client';
import type { PropertyConfiguration, PropertySwitch, ReservationSourceContext } from '@/lib/reservation-workflow/types';
import { Dialog, DialogClose, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { toast } from 'sonner';
import {
  createPaneVersionWatch, fetchPaneVersion, loadedPaneBuild, PANE_RELEASE_POLL_MS,
  reloadAtEmailSwitch, reloadPane, type PaneVersion,
} from '@/lib/workstation/pane-release-watch';
import { mutationsInFlight } from '@/lib/workstation/mutations-in-flight';
import { htmlToPlainText } from '../../../server-pilot/src/mail/inbound-reaction-parser';

type Props = {
  bridge: PaneBridge;
  preview?: boolean;
  webSelectedThreadId?: string;
};
type ResolvedSource = {
  owner: string;
  source: ReservationSourceContext;
};

type SourceEvidencePreview = { owner: string | null; reference: string; title: string; text: string };

async function sourceEvidenceRef(messageId: string, role: string, identity: string): Promise<string> {
  const input = new TextEncoder().encode(`${messageId}\u001f${role}\u001f${identity}`);
  const digest = await globalThis.crypto.subtle.digest('SHA-256', input);
  const hex = [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
  return `src_${hex.slice(0, 12)}`;
}

async function selectedContentHash(email: { subject: string; senderEmail: string; bodyText: string; bodyHtml: string; transportHeaders?: string }) {
  // Match canonical ingestion's whitespace normalization, keeping body text out of the request URL.
  const body = ((email.bodyHtml && htmlToPlainText(email.bodyHtml)) || email.bodyText).replace(/\s+/g, ' ').trim();
  // The bridge exposes Exchange DNs; native sync resolves SMTP. Transport From corroborates the same sender.
  const headers = email.transportHeaders?.replace(/\r?\n[ \t]+/g, ' ').split(/\r?\n/) ?? [];
  const senderHeader = (headers.find((line) => /^Sender:/i.test(line)) ?? headers.find((line) => /^From:/i.test(line)))
    ?.replace(/^[^:]+:\s*/, '').trim() ?? '';
  const senderValue = email.senderEmail.includes('@') ? email.senderEmail : senderHeader;
  const sender = (/<([^<>]+)>/.exec(senderValue)?.[1] ?? senderValue).trim().toLowerCase();
  if (!/^[^\s<>@]+@[^\s<>@]+$/.test(sender)) return undefined;
  const value = JSON.stringify([email.subject.replace(/\s+/g, ' ').trim(), sender, body]);
  const hash = await globalThis.crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
  return [...new Uint8Array(hash)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

/** Installed bridge/auth/sync remain shared; the old quote workflow is never mounted here. */
export function ReservationPaneHost({ bridge, preview = false, webSelectedThreadId }: Props) {
  const { data: session, isLoading: sessionLoading } = useSession();
  const { data: connection, isLoading: connectionLoading } = useActiveConnection();
  const email = bridge.activeEmail;
  const [propertySelection, setPropertySelection] = useState<{ transportId: string; propertySwitch: PropertySwitch } | null>(null);
  const propertySwitch = propertySelection && propertySelection.transportId === connection?.id ? propertySelection.propertySwitch : undefined;
  const propertyScope = JSON.stringify([session?.user?.id, session?.session?.id, connection?.id, propertySwitch]);
  const propertyEpoch = useRef({ scope: propertyScope, value: 0 });
  if (propertyEpoch.current.scope !== propertyScope)
    propertyEpoch.current = { scope: propertyScope, value: propertyEpoch.current.value + 1 };
  const [loadedConfiguration, setLoadedConfiguration] = useState<{ key: string; value: PropertyConfiguration } | null>(null);
  const [configurationError, setConfigurationError] = useState(false);
  const configurationKey = JSON.stringify([session?.user?.id, session?.session?.id, connection?.id, propertySwitch]);
  const configuration = loadedConfiguration?.key === configurationKey ? loadedConfiguration.value : null;
  const configurationEpoch = useRef({ key: configurationKey, value: 0 });
  if (configurationEpoch.current.key !== configurationKey)
    configurationEpoch.current = { key: configurationKey, value: configurationEpoch.current.value + 1 };
  useEffect(() => {
    let live = true;
    const selectedEpoch = configurationEpoch.current.value;
    setConfigurationError(false);
    const mailbox = inMailbox(connection?.id ?? null);
    if (!session?.user?.id || !mailbox) return () => { live = false; };
    void trpcClient.quoteWorkflow.rateCatalogue.query(propertySwitch ? { propertySwitch } : undefined, mailbox)
      .then(value => { if (live && configurationEpoch.current.value === selectedEpoch && value.transportId === connection?.id && (!propertySwitch || value.propertyCode === propertySwitch))
        setLoadedConfiguration({ key: configurationKey, value }); })
      .catch(() => { if (live && configurationEpoch.current.value === selectedEpoch) setConfigurationError(true); });
    return () => { live = false; };
  }, [session?.user?.id, session?.session?.id, connection?.id, propertySwitch, configurationKey]);
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
    ? JSON.stringify([session.user.id, session.session?.id, connection.id, propertySwitch, selection,
      email?.internetMessageId, email?.subject, email?.senderEmail, email?.transportHeaders,
      email?.bodyText, email?.bodyHtml]) : null;
  const epoch = useRef({ owner, value: 0 });
  if (epoch.current.owner !== owner) epoch.current = { owner, value: epoch.current.value + 1 };
  const currentOwner = useRef(owner);
  currentOwner.current = owner;
  const [resolved, setResolved] = useState<ResolvedSource | null>(null);
  const source = resolved?.owner === owner ? resolved.source : null;
  const [sourceEvidencePreview, setSourceEvidencePreview] = useState<SourceEvidencePreview | null>(null);
  const [sourceError, setSourceError] = useState<string | null>(null);
  const [sourceRetryable, setSourceRetryable] = useState(false);
  const [sourceRetry, setSourceRetry] = useState(0);
  const sourceLoad = useRef({ owner, retry: sourceRetry, startedAt: null as number | null });
  if (sourceLoad.current.owner !== owner || sourceLoad.current.retry !== sourceRetry)
    sourceLoad.current = { owner, retry: sourceRetry, startedAt: null };
  const client = useMemo(() => createTrpcReservationWorkflowClient(trpcClient, configuration), [configuration]);
  const [pendingBuild, setPendingBuild] = useState<PaneVersion | null>(null);
  const [loadedBuild] = useState(() => loadedPaneBuild());
  const lastSelection = useRef<string | null>(null);
  const [reloading, setReloading] = useState(false);

  const openAttachment = useCallback(async (sourceRef: string) => {
    if (!source) return;
    const attachment = source.attachments.find((item) => item.sourceRef === sourceRef);
    if (!attachment) {
      toast.error('This attachment is no longer part of the selected email.');
      return;
    }
    const mailboxOptions = inMailbox(source.mailboxId);
    if (!mailboxOptions) {
      toast.error('The selected mailbox is unavailable. Reopen the email and try again.');
      return;
    }
    try {
      const mail = trpcClient.mail as unknown as {
        getAttachment: { query(input: { messageId: string; attachmentId: string }, options: { context: { activeTransportId: string } }): Promise<{ url: string }> };
      };
      await openAttachmentViaBlob({ messageId: source.messageId, attachmentId: attachment.sourceRef,
        filename: attachment.name, mimeType: attachment.mimeType ?? 'application/octet-stream', size: attachment.size }, {
        getSignedUrl: async (messageId, attachmentId) => {
          const result = await mail.getAttachment.query({ messageId, attachmentId }, mailboxOptions);
          return result.url;
        },
      });
    } catch (error) {
      toast.error(error instanceof Error && error.message === 'Popup blocked'
        ? 'Allow popups to open this attachment.' : 'Nava could not open this source attachment.');
    }
  }, [source]);

  const openEvidence = useCallback(async (reference: string) => {
    if (!source) return;
    try {
      const currentMessageRef = await sourceEvidenceRef(source.messageId, 'message', source.messageId);
      if (currentOwner.current !== owner) return;
      if (currentMessageRef === reference) {
        const headers = [
          `From: ${source.sender}`,
          `Subject: ${source.subject || 'Untitled email'}`,
          `Received: ${source.receivedAt || source.arrivedAt}`,
        ];
        const body = source.sourceText?.trim() || '[This synced email has no readable message text.]';
        setSourceEvidencePreview({ owner, reference, title: 'Selected email evidence', text: `${headers.join('\n')}\n\n${body}` });
        return;
      }
      for (const attachment of source.attachments) {
        const textRef = await sourceEvidenceRef(source.messageId, 'attachment_text', attachment.sourceRef);
        if (currentOwner.current !== owner) return;
        if (textRef === reference) {
          await openAttachment(attachment.sourceRef);
          return;
        }
        for (let page = 1; page <= 3; page += 1) {
          const visionRef = await sourceEvidenceRef(source.messageId, 'attachment_vision', `${attachment.sourceRef}:${page}`);
          if (currentOwner.current !== owner) return;
          if (visionRef === reference) {
            await openAttachment(attachment.sourceRef);
            return;
          }
        }
      }
      if (currentOwner.current !== owner) return;
      setSourceEvidencePreview({ owner, reference, title: 'Source item not available in this email',
        text: 'This source is not available in the selected email. Check related emails or the reservation in Infor to review it.' });
    } catch {
      toast.error('Nava could not resolve this source reference.');
    }
  }, [email?.bodyText, email?.receivedTime, email?.senderName, email?.subject, openAttachment, owner, source]);

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
    setSourceRetryable(false);
    if (!owner || !selection || !email || !connection?.id || !configuration || bridge.requiresRelogin ||
      (!preview && (bridge.updateRequired || bridge.authorizationUnavailable || bridge.selectionOutsideMailbox))) return;
    const startedAt = sourceLoad.current.startedAt ?? Date.now();
    sourceLoad.current.startedAt = startedAt;
    const selectedEpoch = epoch.current.value;
    let alive = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let attempts = 0;
    const resolve = async () => {
      try {
        const contentHash = preview ? undefined : await selectedContentHash(email);
        if (!alive || currentOwner.current !== owner || epoch.current.value !== selectedEpoch) return;
        const result = await trpcClient.reservationWorkflowV2.resolveSource.query({ selection,
          ...(propertySwitch ? { propertySwitch } : {}),
          ...(contentHash ? { contentHash } : {}),
          ...(email.internetMessageId ? { internetMessageId: email.internetMessageId } : {}) });
        if (!alive || currentOwner.current !== owner || epoch.current.value !== selectedEpoch) return;
        if (result.status !== 'ok') {
          const elapsedMs = Date.now() - startedAt;
          setSourceRetryable(result.status === 'source_unavailable' && result.reason !== 'ambiguous');
          const message = result.status === 'wrong_property'
            ? result.message : result.reason === 'ambiguous'
              ? 'Nava found more than one matching email. Check sync details or contact support to resolve this copy.'
              : result.reason === 'content_mismatch'
                ? 'The selected email differs from Nava’s copy. Retry after Outlook finishes copying it.'
              : result.reason === 'attention'
                ? 'This email copy needs attention before Nava can open it. Open sync details and choose Retry missing.'
                : elapsedMs >= 110_000
                  ? 'Nava could not open this email copy yet. Retry opening it, or reconnect Outlook if copying has stopped.'
                  : elapsedMs >= 30_000
                  ? 'This email is taking longer to open. Nava will keep checking; you can retry now.'
                  : 'Waiting for this email to become available in Nava.';
          setSourceError(result.status === 'source_unavailable' && elapsedMs >= 30_000 &&
            ['ambiguous', 'attention', 'content_mismatch'].includes(result.reason)
            ? `This email is taking longer to open. ${message}` : message);
          if (result.status === 'source_unavailable' && result.reason !== 'ambiguous' && ++attempts < 12)
            timer = setTimeout(() => void resolve(), 10_000);
          return;
        }
        if (result.propertyCode !== configuration.propertyCode || result.source.propertyId !== configuration.propertyCode) {
          setSourceError('The selected hotel could not be verified. Reopen the email and try again.');
          return;
        }
        setSourceError(null);
        setResolved({ owner, source: {
          mailboxId: connection.id,
          propertyId: result.propertyCode,
          ...(propertySwitch ? { propertySwitch } : {}),
          propertySelectionEpoch: propertyEpoch.current.value,
          messageId: result.source.messageId,
          threadId: result.source.threadId,
          sourceHash: result.source.sourceHash,
          arrivedAt: result.source.arrivedAt,
          internetMessageId: result.internetMessageId,
          selectionEpoch: selectedEpoch,
          subject: result.sourceSubject,
          sender: result.sourceSender,
          sourceText: result.sourceText,
          selfPreStay: result.selfPreStay,
          receivedAt: result.source.arrivedAt,
          attachments: result.attachments.filter((item) => !item.isInline).map((item) => ({
            sourceRef: item.id, name: item.filename, mimeType: item.mimeType, size: item.sizeBytes,
            uploadability: /\.pdf$/iu.test(item.filename) &&
              ['application/pdf', 'application/x-pdf', 'application/octet-stream'].includes(
                item.mimeType.split(';', 1)[0]?.trim().toLowerCase() ?? '') &&
              item.sizeBytes > 0 && item.sizeBytes <= 10 * 1024 * 1024
              ? 'unknown' as const : 'unsupported' as const,
          })),
        } });
      } catch {
        if (alive && currentOwner.current === owner && epoch.current.value === selectedEpoch) {
          setSourceError('Nava could not open this email. Check your connection and retry.');
          setSourceRetryable(true);
        }
      }
    };
    void resolve();
    return () => { alive = false; if (timer) clearTimeout(timer); };
  }, [owner, selection, connection?.id, resolved?.owner, bridge.requiresRelogin, bridge.updateRequired,
    bridge.authorizationUnavailable, bridge.selectionOutsideMailbox, preview, sync.status?.committed, sourceRetry, configuration, propertySwitch]);

  if (sessionLoading || connectionLoading) return <p className="p-4 text-sm text-slate-600">Loading Nava…</p>;
  if (!session?.user || bridge.requiresRelogin) return <OutlookPaneSignIn />;
  if (reloading) return <p className="p-4 text-sm text-slate-600">Loading the latest Nava pane…</p>;
  const currentEvidencePreview = sourceEvidencePreview?.owner === owner ? sourceEvidencePreview : null;
  return (
    <div className={`flex w-full flex-1 min-w-0 ${preview ? 'h-full' : 'h-screen'} min-h-0 flex-col overflow-hidden bg-slate-50 text-slate-800`}>
      <header className="flex shrink-0 items-center justify-between gap-2 border-b border-slate-200 bg-white p-3">
        <div className="min-w-0"><strong className="text-base">Nava</strong>
          <p className="truncate text-xs text-slate-500">{connection?.email || 'Select a mailbox'}</p></div>
        {(configuration?.propertyCode === 'HRDAV' || configuration?.propertyCode === 'HRDAVS' || propertySwitch) && connection?.id &&
          <label className="text-xs">Hotel <select value={propertySwitch ?? 'HRDAV'}
            onChange={event => setPropertySelection({ transportId: connection.id, propertySwitch: event.target.value === 'HRDAVS' ? 'HRDAVS' : 'HRDAV' })}>
            <option value="HRDAV">Da Vinci</option><option value="HRDAVS">Da Vinci HRDAVS</option>
          </select></label>}
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
      {configurationError ? <p role="alert" className="p-3 text-sm">Hotel configuration is unavailable. Reopen Nava and try again.</p> : null}
      {sourceError ? <div className="p-3 text-sm text-slate-600"><p role="status">{sourceError}</p>
        {sourceRetryable && <button type="button" className="mt-2 rounded border border-slate-300 px-3 py-2"
          onClick={() => setSourceRetry(value => value + 1)}>Retry opening email</button>}
      </div> : null}
      {email && !source && !sourceError ? <p role="status" className="p-3 text-sm text-slate-600">Opening selected email…</p> : null}
      {source ? <ReservationWorkspace key={`${owner}:${source.selectionEpoch}`} source={source} activeProperty={configuration?.propertyCode} configuration={configuration} client={client} bridge={bridge} hostType={preview ? 'webmail' : 'outlook'}
        onOpenEvidence={(reference) => void openEvidence(reference)} onOpenAttachment={(reference) => void openAttachment(reference)} /> : null}
      <Dialog open={currentEvidencePreview !== null} onOpenChange={(open) => { if (!open) setSourceEvidencePreview(null); }}>
        <DialogContent showOverlay className="max-h-[85dvh] max-w-3xl overflow-y-auto">
          <DialogHeader>
            <DialogTitle>{currentEvidencePreview?.title ?? 'Source evidence'}</DialogTitle>
            <DialogDescription>Review the original email or attachment.</DialogDescription>
          </DialogHeader>
          {currentEvidencePreview && <pre className="max-h-[65dvh] overflow-auto whitespace-pre-wrap break-words rounded-md border bg-white p-3 text-xs leading-relaxed">
            {currentEvidencePreview.text}
          </pre>}
          <DialogClose asChild><button type="button" className="rounded-md border px-3 py-2 text-sm">Close</button></DialogClose>
        </DialogContent>
      </Dialog>
    </div>
  );
}

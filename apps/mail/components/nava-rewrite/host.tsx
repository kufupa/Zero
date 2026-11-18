'use client';

import { useRef, useState } from 'react';
import { OutlookPaneSignIn } from '@/app/(routes)/outlook-pane/outlook-pane-sign-in';
import { OutlookSyncProgress } from '@/components/workstation/outlook-sync-progress';
import { useActiveConnection } from '@/hooks/use-connections';
import { useSession } from '@/lib/auth-client';
import { resolvePublicBackendUrl } from '@/lib/public-backend-url';
import type { PaneBridge } from '@/lib/workstation/pane-bridge-types';
import type { ReservationSourceContext } from '@/lib/reservation-workflow/types';
import { useOutlookSync } from '@/lib/workstation/use-outlook-sync';
import { quoteCoverHtml, useQuoteOutput } from '@/components/reservation-pane/use-quote-output';
import type { QuoteOutput, QuoteOutputArtifact } from '@/lib/reservation-workflow/quote-output';
import { createNavaApi } from './api';
import { NavaController } from './controller';
import type { QuoteDraftRequest } from './controller';
import { NavaPane, PaneMessage } from './pane';
import type { SelectedEmail } from './pane';
import type { ThreadInput } from './wire';

const api = createNavaApi({
  baseUrl: resolvePublicBackendUrl(),
  fetch: (input, init) => fetch(input, { ...init, credentials: 'include' }),
});

type Source =
  | { status: 'ready'; input: ThreadInput; draftSource?: ReservationSourceContext }
  | { status: 'unavailable'; reason: string }
  | { status: 'loading'; reason: string };

function selectedEmail(bridge: PaneBridge): SelectedEmail | null {
  const email = bridge.activeEmail;
  if (!email || bridge.selectionOutsideMailbox) return null;
  const date = new Date(email.receivedTime);
  const validDate = !Number.isNaN(date.getTime());
  return {
    sender: email.senderName || email.senderEmail,
    subject: email.subject,
    ...(validDate ? { receivedLabel: date.toLocaleString(), receivedDateTime: email.receivedTime } : {}),
    ...(email.bodyText ? { body: email.bodyText } : {}),
  };
}

/** Host owns authentication, mailbox and native bridge; workflow calls use only the new API. */
export function NavaRewriteHost({ bridge, source, preview = false }: {
  bridge: PaneBridge;
  source: Source;
  preview?: boolean;
}) {
  const { data: session, isLoading: sessionLoading } = useSession();
  const { data: connection, isLoading: connectionLoading } = useActiveConnection();
  const [bridgeError, setBridgeError] = useState<string | null>(null);
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

  if (sessionLoading || connectionLoading) return <p className="p-4 text-sm text-slate-600">Loading Nava…</p>;
  if (!session?.user || bridge.requiresRelogin) return <OutlookPaneSignIn />;

  const email = selectedEmail(bridge);
  const bridgeUnavailable = !preview && (bridge.updateRequired || bridge.selectionOutsideMailbox || bridge.authorizationUnavailable || !bridge.workstationInfo?.paired);
  const sourceMessage = bridge.updateRequired ? 'Update the Outlook add-in to open email in Nava.'
    : bridge.selectionOutsideMailbox ? 'Select an email in the connected mailbox.'
    : bridge.authorizationUnavailable ? 'Reconnect Outlook to open email in Nava.'
    : !preview && !bridge.workstationInfo?.paired ? 'Connect this Outlook to open email in Nava.'
    : source.status !== 'ready' && (preview || email) ? source.reason : null;
  const owner = JSON.stringify([session.user.id, session.session?.id, connection?.id]);

  return (
    <div className={`flex w-full min-w-0 min-h-0 flex-col overflow-hidden bg-white ${preview ? 'h-full' : 'h-screen'}`}>
      <div className="flex shrink-0 items-center justify-between gap-2 border-b border-slate-200 px-3 py-2 text-xs text-slate-500">
        <span className="min-w-0 truncate">{connection?.email || 'Select a mailbox'}</span>
        <OutlookSyncProgress status={sync.status} notApplicable={sync.notApplicable} mailbox={connection?.email ?? ''}
          onControl={(operation) => { void sync.control(operation).catch(() => setBridgeError('Could not update Outlook sync. Try again.')); }}
          error={sync.error} busy={sync.busy} controlsEnabled={!preview && sync.eligible} />
      </div>
      {!preview && !bridge.workstationInfo?.paired && !bridge.updateRequired && <button type="button" className="m-3 rounded border p-2 text-sm"
        onClick={() => { setBridgeError(null); void bridge.pairDevice().catch(() => setBridgeError('Could not connect Outlook. Try again.')); }}>Connect this Outlook</button>}
      {!preview && bridge.authorizationUnavailable && <button type="button" className="m-3 rounded border p-2 text-sm"
        onClick={bridge.refreshAuthorization}>Reconnect Outlook</button>}
      {bridgeError && <p role="alert" className="px-3 py-2 text-sm">{bridgeError}</p>}
      {!bridgeUnavailable && source.status === 'ready' && email && source.input.messages.some(message => message.attachment_status !== 'complete') &&
        <p role="status" className="shrink-0 px-3 py-2 text-sm text-slate-700">Check attachments in Outlook - Nava could not read them</p>}
      {!bridgeUnavailable && source.status === 'ready' && email ? source.draftSource && !preview
        ? <RewriteWithOutlookDraft key={owner} input={source.input} email={email} bridge={bridge} source={source.draftSource} />
        : <NavaController key={owner} input={source.input} email={email} api={api} /> : <>
        <NavaPane email={email}>{sourceMessage && <PaneMessage>{sourceMessage}</PaneMessage>}</NavaPane>
        {!email && sourceMessage && <p role="status" className="px-4 pb-4 text-sm text-slate-600">{sourceMessage}</p>}
      </>}
    </div>
  );
}

function RewriteWithOutlookDraft({ input, email, bridge, source }: {
  input: ThreadInput; email: SelectedEmail; bridge: PaneBridge; source: ReservationSourceContext;
}) {
  const selected = useRef(bridge.activeEmail);
  const live = useRef({ bridge, source });
  live.current = { bridge, source };
  const isCurrentSource = (candidate: ReservationSourceContext) => {
    const current = live.current;
    const active = current.bridge.activeEmail;
    const original = selected.current;
    return Boolean(original && active && current.bridge.isConnected && current.bridge.workstationInfo?.paired &&
      !current.bridge.requiresRelogin && !current.bridge.updateRequired && !current.bridge.authorizationUnavailable && !current.bridge.selectionOutsideMailbox &&
      active.entryId === original.entryId && active.storeId === original.storeId && active.folderEntryId === original.folderEntryId &&
      candidate.messageId === current.source.messageId && candidate.threadId === current.source.threadId &&
      candidate.mailboxId === current.source.mailboxId && candidate.sourceHash === current.source.sourceHash);
  };
  const output = useQuoteOutput({ source, configuration: null, bridge, isCurrentSource });

  async function saveQuoteDraft(request: QuoteDraftRequest) {
    const selectedMail = input.messages.find(message => message.id === input.selected_message_id && message.direction === 'inbound');
    if (!selectedMail || source.messageId !== input.selected_message_id || !request.isCurrentSnapshot())
      return { status: 'error', message: 'The selected email or quote changed. Review it again.' };
    const pdf = request.artifacts.find(item => item.name === 'Quotation.pdf' && item.mime_type === 'application/pdf');
    const xlsx = request.artifacts.find(item => item.name === 'Quotation.xlsx' && item.mime_type === 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    if (!pdf || !xlsx || request.artifacts.length !== 2) return { status: 'error', message: 'The PDF and Excel files are not both available. Check the quote again.' };
    try {
      const artifacts: QuoteOutputArtifact[] = [];
      for (const [kind, item] of [['pdf_quote', pdf], ['xlsx_quote', xlsx]] as const) {
        if (!request.isCurrentSnapshot() || !isCurrentSource(source)) throw new Error('The selected email or quote changed. Review it again.');
        const response = await api.getArtifact(item.id);
        const bytes = new Uint8Array(await response.arrayBuffer());
        if (!bytes.length || bytes.length > 1_400_000 || response.headers.get('content-type')?.split(';')[0]?.trim().toLowerCase() !== item.mime_type)
          throw new Error('A quote file could not be verified for Outlook. Generate the quote again.');
        const digest = await crypto.subtle.digest('SHA-256', bytes);
        const sha256 = [...new Uint8Array(digest)].map(byte => byte.toString(16).padStart(2, '0')).join('');
        let binary = '';
        for (let offset = 0; offset < bytes.length; offset += 0x8000) binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000));
        artifacts.push({ kind, fileName: item.name, mimeType: item.mime_type, sizeBytes: bytes.length, sha256, bytesBase64: btoa(binary) });
      }
      if (!request.isCurrentSnapshot() || !isCurrentSource(source)) throw new Error('The selected email or quote changed. Review it again.');
      const prepared: QuoteOutput = { requestId: request.quoteId, operationId: JSON.stringify([request.proposalId, request.revision, request.jobId]), observationRef: request.jobId,
        cover: { to: selectedMail.from.email, subject: source.subject, body: request.body }, artifacts,
        failures: [], issues: [], stale: false, inventoryDecline: false };
      const result = await output.createOutlookReply({ output: prepared, html: quoteCoverHtml(request.body), isCurrentSnapshot: request.isCurrentSnapshot,
        confirmUnknown: () => window.confirm('An earlier reply may exist. Check Outlook Drafts first. Continue only if you verified there is no duplicate.') });
      if (result.status !== 'created' || !result.readback) return result;
      return { ...result, message: `Draft available in Outlook Drafts, not sent. Review its cover there. Subject: ${result.readback.subject}. Files: ${result.readback.attachmentNames.join(', ')}.` };
    } catch (error) {
      return { status: 'error', message: error instanceof Error ? error.message : 'Could not prepare the quote draft. Try again.' };
    }
  }

  return <NavaController input={input} email={email} api={api} saveQuoteDraft={saveQuoteDraft} />;
}

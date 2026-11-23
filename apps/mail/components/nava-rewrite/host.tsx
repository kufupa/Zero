'use client';

import { useEffect, useRef, useState } from 'react';
import { parseAsString, useQueryStates } from 'nuqs';
import { runComposeSwitch } from '@/lib/mail/compose-flush-registry';
import emailAddresses from 'email-addresses';
import { OutlookPaneSignIn } from '@/app/(routes)/outlook-pane/outlook-pane-sign-in';
import { OutlookSyncProgress } from '@/components/workstation/outlook-sync-progress';
import { useActiveConnection } from '@/hooks/use-connections';
import { useSession } from '@/lib/auth-client';
import { resolvePublicBackendUrl } from '@/lib/public-backend-url';
import { AttachmentMetaSchema, MailLocationSchema, type WorkstationEmailPayload } from '@/lib/workstation/bridge-protocol';
import { z } from 'zod';
import type { QuoteDraftBinding } from './quote-output-bridge';
import type { PaneBridge } from '@/lib/workstation/pane-bridge-types';
import type { ReservationSourceContext } from '@/components/nava-rewrite/source-types';
import { useOutlookSync } from '@/lib/workstation/use-outlook-sync';
import { quoteCoverHtml, saveQuoteWebDraft, useQuoteOutput } from './quote-output-bridge';
import type { QuoteOutput, QuoteOutputArtifact } from './source-types';
import { inMailbox } from '@/lib/mail/mail-cache-scope';
import { trpcClient } from '@/providers/query-provider';
import { canonicalMessageId } from '../../../server-pilot/src/mail/ingest/message-id';
import { createNavaApi } from './api';
import { quoteArtifactIds } from './quote-draft';
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

function selectedEmail(email: WorkstationEmailPayload | null): SelectedEmail | null {
  if (!email) return null;
  const date = new Date(email.receivedTime);
  const validDate = !Number.isNaN(date.getTime());
  return {
    sender: email.senderName || email.senderEmail,
    subject: email.subject,
    ...(validDate ? { receivedLabel: date.toLocaleString(), receivedDateTime: email.receivedTime } : {}),
    ...(email.bodyText ? { body: email.bodyText } : {}),
  };
}

type HostProps = { bridge: PaneBridge; source: Source; preview?: boolean } | {
  webmail: { email: WorkstationEmailPayload; threadId: string; source: Source; onSourceNotEligible: () => void };
};

/** Workflow calls use the same authenticated API in both mail clients. */
export function NavaRewriteHost(props: HostProps) {
  if ('webmail' in props) return <RewriteWithWebmail {...props.webmail} />;
  return <RewriteWithOutlook {...props} />;
}

function RewriteWithWebmail({ email, threadId, source, onSourceNotEligible }: Extract<HostProps, { webmail: unknown }>['webmail']) {
  const [compose, setCompose] = useQueryStates({ mode: parseAsString, activeReplyId: parseAsString, draftId: parseAsString });
  const current = useRef(true);
  useEffect(() => { current.current = true; return () => { current.current = false; }; }, []);
  const active = selectedEmail(email);
  const selected = source.status === 'ready'
    ? source.input.messages.find(message => message.id === source.input.selected_message_id) : undefined;
  const selectedWarning = selected && selected.attachment_status !== 'complete'
    ? selected.attachment_status === 'has_unread'
      ? 'Check the selected email’s attachments. Nava has not read them all.'
      : 'Nava could not verify which attachments the selected email has.'
    : null;
  const otherWarning = source.status === 'ready' &&
    source.input.messages.some(message => message.id !== source.input.selected_message_id && message.attachment_status !== 'complete')
    ? 'Open the other emails to review their attachments. Nava has only attachment status for those emails.' : null;
  async function saveQuoteDraft(request: QuoteDraftRequest) {
    if (source.status !== 'ready' || !selected || selected.direction !== 'inbound' ||
        selected.id !== email.entryId || !selected.rfc_message_id || !request.isCurrentSnapshot()) {
      return { status: 'error', message: 'The selected email or quote changed. Review it again.' };
    }
    const { input } = source;
    try {
      const match = await trpcClient.paneSource.resolveSource.query({
        internetMessageId: selected.rfc_message_id, selection: { kind: 'web', threadId, messageId: selected.id },
      }, { ...inMailbox(input.mailbox_id), signal: request.signal });
      const sender = match.status === 'ok' && match.sourceSender ? emailAddresses.parseOneAddress(match.sourceSender) : null;
      if (match.status !== 'ok' || match.propertyCode !== input.property_code || match.source.propertyId !== input.property_code ||
          match.source.threadId !== threadId || match.source.messageId !== selected.id || match.sourceSubject !== selected.subject ||
          sender?.type !== 'mailbox' || sender.address.trim().toLowerCase() !== selected.from.email.trim().toLowerCase() ||
          canonicalMessageId(match.internetMessageId) !== canonicalMessageId(selected.rfc_message_id)) {
        return { status: 'error', message: 'The selected guest email could not be verified for this draft.' };
      }
      const prepared = await readQuoteOutput(request, selected.from.email, selected.subject);
      const result = await saveQuoteWebDraft({
        source: { mailboxId: input.mailbox_id, threadId, messageId: selected.id, subject: selected.subject },
        output: prepared, html: quoteCoverHtml(request.body), verifyCurrent: request.verifyCurrentSnapshot,
        quoteBinding: draftBinding(request),
        // oxlint-disable-next-line no-alert
        confirmReplace: () => window.confirm('Replace this thread’s existing unsent draft with the reviewed quotation?'),
      });
      return result.status === 'saved'
        ? { status: 'created', message: 'Saved an unsent draft with the PDF and Excel files. Open Drafts to review it.' }
        : result;
    } catch (error) {
      return { status: 'error', message: error instanceof Error ? error.message : 'Could not prepare the quote draft. Try again.' };
    }
  }

  async function findQuoteDraft(binding: QuoteDraftBinding) {
    if (source.status !== 'ready' || !selected) return false;
    const found = await trpcClient.drafts.quoteReply.query({ threadId, messageId: selected.id, binding }, inMailbox(source.input.mailbox_id));
    return current.current && Boolean(found);
  }
  async function openQuoteDraft(binding: QuoteDraftBinding, isCurrent = () => true) {
    if (source.status !== 'ready' || !selected) return null;
    const found = await trpcClient.drafts.quoteReply.query({ threadId, messageId: selected.id, binding }, inMailbox(source.input.mailbox_id));
    if (!found || !current.current || !isCurrent()) throw new Error('Draft unavailable');
    if (compose.mode && compose.draftId === found.id) return null;
    // Flush/save open composer first; refuse switch when dirty draft cannot be preserved.
    const outcome = await runComposeSwitch(async () => {
      if (!current.current || !isCurrent()) throw new Error('Draft unavailable');
      await setCompose({ mode: 'reply', activeReplyId: selected.id, draftId: found.id });
    });
    if (outcome !== 'switched') {
      throw new Error(outcome === 'unfinished_recipient'
        ? 'Finish entering the recipient before opening this draft.'
        : 'Save or keep the current draft before opening this quote draft.');
    }
    return null;
  }

  return <div data-nava-host={source.status === 'ready' ? 'webmail-rewrite' : 'webmail-checking'} className="flex h-full min-h-0 w-full min-w-0 flex-col overflow-hidden bg-white">
    {(selectedWarning || otherWarning) &&
      <p role="status" className="shrink-0 px-3 py-2 text-sm text-slate-700">{[selectedWarning, otherWarning].filter(Boolean).join(' ')}</p>}
    {source.status === 'ready'
      ? <NavaController input={source.input} email={active} api={api} onSourceNotEligible={onSourceNotEligible} quoteDraftTarget="webmail" saveQuoteDraft={saveQuoteDraft} findQuoteDraft={findQuoteDraft} openQuoteDraft={openQuoteDraft} />
      : <NavaPane email={active}><PaneMessage>{source.reason}</PaneMessage></NavaPane>}
  </div>;
}

function RewriteWithOutlook({ bridge, source, preview = false }: Extract<HostProps, { bridge: PaneBridge }>) {
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

  const email = selectedEmail(bridge.selectionOutsideMailbox ? null : bridge.activeEmail);
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
        ? <RewriteWithOutlookDraft key={JSON.stringify([owner, source.draftSource.messageId, source.draftSource.sourceHash, bridge.activeEmail?.entryId, bridge.activeEmail?.storeId])} input={source.input} email={email} bridge={bridge} source={source.draftSource} />
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
  const output = useQuoteOutput({ source, bridge, isCurrentSource });

  async function saveQuoteDraft(request: QuoteDraftRequest) {
    const selectedMail = input.messages.find(message => message.id === input.selected_message_id && message.direction === 'inbound');
    if (!selectedMail || source.messageId !== input.selected_message_id || !request.isCurrentSnapshot())
      return { status: 'error', message: 'The selected email or quote changed. Review it again.' };
    try {
      const prepared = await readQuoteOutput(request, selectedMail.from.email, source.subject, () => isCurrentSource(source));
      const result = await output.createOutlookReply({ output: prepared, html: quoteCoverHtml(request.body), isCurrentSnapshot: request.isCurrentSnapshot,
        verifyCurrentSnapshot: request.verifyCurrentSnapshot,
        // oxlint-disable-next-line no-alert
        confirmUnknown: () => window.confirm('An earlier reply may exist. Check Outlook Drafts first. Continue only if you verified there is no duplicate.') });
      if (result.status !== 'created' || !result.readback || !result.location) return result;
      try { localStorage.setItem(outlookDraftKey(source, draftBinding(request)), JSON.stringify(result.location)); }
      catch { return { status: 'unknown', message: 'The draft was saved in Outlook Drafts. Open it there to review and send.' }; }
      return { ...result, message: `Draft available in Outlook Drafts, not sent. Review its cover there. Subject: ${result.readback.subject}. Files: ${result.readback.attachmentNames.join(', ')}.` };
    } catch (error) {
      return { status: 'error', message: error instanceof Error ? error.message : 'Could not prepare the quote draft. Try again.' };
    }
  }

  async function openQuoteDraft(binding: QuoteDraftBinding, isCurrent = () => true) {
    // Preview only — draft already lives in Outlook Drafts (openInComposer: false). No active-editor switch.
    if (!isCurrent() || !isCurrentSource(source)) return null;
    const raw = localStorage.getItem(outlookDraftKey(source, binding));
    if (!raw) return null;
    const location = MailLocationSchema.parse(JSON.parse(raw));
    const identity = { entryId: location.entryId, storeId: location.storeId, folderEntryId: location.folderEntryId };
    const draft = await bridge.sendCommand<typeof identity, WorkstationEmailPayload | null>('GET_EMAIL_BY_ENTRY_ID', identity);
    const files = z.array(AttachmentMetaSchema).parse(await bridge.sendCommand<typeof identity, unknown>('GET_ATTACHMENT_METADATA', identity));
    if (!isCurrent() || !isCurrentSource(source) || !draft || draft.entryId !== identity.entryId || draft.storeId !== identity.storeId ||
        draft.folderEntryId !== identity.folderEntryId) return null;
    return { subject: draft.subject, to: draft.to, cc: draft.cc, body: draft.bodyText, files: files.map(file => file.fileName) };
  }
  async function findQuoteDraft(binding: QuoteDraftBinding) {
    if (!isCurrentSource(source)) return false;
    try { return Boolean(localStorage.getItem(outlookDraftKey(source, binding))); } catch { return false; }
  }
  return <NavaController input={input} email={email} api={api} quoteDraftTarget="outlook" saveQuoteDraft={saveQuoteDraft} findQuoteDraft={findQuoteDraft} openQuoteDraft={openQuoteDraft} />;
}

function draftBinding(request: QuoteDraftRequest): QuoteDraftBinding {
  const artifactIds = quoteArtifactIds(request.artifacts);
  if (!artifactIds) throw new Error('The PDF and Excel files are not both available. Check the quote again.');
  return { proposalId: request.proposalId, revision: request.revision, quoteId: request.quoteId, jobId: request.jobId, artifactIds };
}

function outlookDraftKey(source: ReservationSourceContext, binding: QuoteDraftBinding) {
  return `nava-quote-draft:${JSON.stringify([source.mailboxId, source.propertyId, source.threadId, source.messageId, source.sourceHash, binding])}`;
}

async function readQuoteOutput(request: QuoteDraftRequest, recipient: string, subject: string, isCurrentSource = () => true): Promise<QuoteOutput> {
  if (!quoteArtifactIds(request.artifacts)) throw new Error('The PDF and Excel files are not both available. Check the quote again.');
  const artifacts: QuoteOutputArtifact[] = [];
  for (const [index, item] of request.artifacts.entries()) {
    const kind = index%2===0 ? 'pdf_quote' : 'xlsx_quote';
    if (!request.isCurrentSnapshot() || !isCurrentSource()) throw new Error('The selected email or quote changed. Review it again.');
    const response = await api.getArtifact(item.id, { signal: request.signal });
    const bytes = new Uint8Array(await response.arrayBuffer());
    if (!bytes.length || bytes.length > 1_400_000 || response.headers.get('content-type')?.split(';')[0]?.trim().toLowerCase() !== item.mime_type)
      throw new Error('A quote file could not be verified. Generate the quote again.');
    const digest = await crypto.subtle.digest('SHA-256', bytes);
    const sha256 = [...new Uint8Array(digest)].map(byte => byte.toString(16).padStart(2, '0')).join('');
    let binary = '';
    for (let offset = 0; offset < bytes.length; offset += 0x8000) binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000));
    artifacts.push({ kind, fileName: item.name, mimeType: item.mime_type, sizeBytes: bytes.length, sha256, bytesBase64: btoa(binary) });
  }
  if (!request.isCurrentSnapshot() || !isCurrentSource()) throw new Error('The selected email or quote changed. Review it again.');
  return { requestId: request.quoteId, operationId: JSON.stringify([request.proposalId, request.revision, request.jobId]), observationRef: request.jobId,
    cover: { to: recipient, subject, body: request.body }, artifacts,
    failures: [], issues: [], stale: false, inventoryDecline: false };
}

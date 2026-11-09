'use client';

import { useEffect, useRef, useState } from 'react';
import type { ReservationPaneSnapshot, ReservationSourceContext } from '@/lib/reservation-workflow/types';
import { quoteOutputState } from '@/lib/reservation-workflow/views';
import { inMailbox } from '@/lib/mail/mail-cache-scope';
import { createOperationId, type MailLocation, type WorkstationEmailPayload } from '@/lib/workstation/bridge-protocol';
import { beginMutation, endMutation } from '@/lib/workstation/mutations-in-flight';
import type { PaneBridge } from '@/lib/workstation/pane-bridge-types';
import { trpcClient } from '@/providers/query-provider';
import { getQuoteOutput, type QuoteOutput, type QuoteOutputArtifact, type QuoteOutputResult } from '@/lib/reservation-workflow/quote-output';
export { getQuoteOutput, quoteCoverHtml } from '@/lib/reservation-workflow/quote-output';
export type { QuoteOutput, QuoteOutputArtifact, QuoteOutputResult } from '@/lib/reservation-workflow/quote-output';

type Confirm = () => boolean | Promise<boolean>;

const MARKER = 'nava_v2_quote_unresolved_reply_v1';
const RETRY_WINDOW_MS = 15 * 60 * 1000;
const MAX_ATTACHMENT_BYTES = 15 * 1024 * 1024;
// Older Outlook bridge fingerprints use a 2 MiB JSON string limit, including base64.
const MAX_OUTLOOK_ATTACHMENT_BYTES = 1_400_000;

function sourceKey(source: ReservationSourceContext): string {
  return JSON.stringify([source.mailboxId, source.propertyId, source.messageId, source.threadId,
    source.sourceHash, source.selectionEpoch]);
}

async function verifyAttachments(artifacts: QuoteOutputArtifact[]): Promise<void> {
  let total = 0;
  for (const item of artifacts) {
    if (!item.fileName || item.fileName.length > 255 || item.fileName.includes('/') || item.fileName.includes('\\') || [...item.fileName].some(character => character.charCodeAt(0) < 32) ||
        !/^[a-zA-Z0-9!#$&^_.+-]+\/[a-zA-Z0-9!#$&^_.+-]+$/.test(item.mimeType) ||
        !Number.isSafeInteger(item.sizeBytes) || item.sizeBytes <= 0 || item.sizeBytes > MAX_ATTACHMENT_BYTES ||
        !/^[a-f0-9]{64}$/.test(item.sha256) ||
        !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(item.bytesBase64) ||
        item.bytesBase64.length > Math.ceil(MAX_ATTACHMENT_BYTES / 3) * 4) throw new Error('A quote attachment is invalid. Generate the quote again.');
    const binary = atob(item.bytesBase64);
    if (binary.length !== item.sizeBytes || btoa(binary) !== item.bytesBase64) throw new Error('A quote attachment is incomplete. Generate the quote again.');
    total += binary.length;
    if (total > 32 * 1024 * 1024) throw new Error('The quote attachments exceed the reply size limit.');
    const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0));
    const digest = await crypto.subtle.digest('SHA-256', bytes);
    const hash = [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
    if (hash !== item.sha256) throw new Error('A quote attachment failed its integrity check. Generate the quote again.');
  }
}

function readMarker(): string | null { try { return sessionStorage.getItem(MARKER); } catch { return null; } }
function writeMarker(value: string | null): boolean {
  try { if (value === null) sessionStorage.removeItem(MARKER); else sessionStorage.setItem(MARKER, value); return true; }
  catch { return false; }
}
function sameEmail(left: WorkstationEmailPayload | null, right: WorkstationEmailPayload): boolean {
  return !!left && left.entryId === right.entryId && left.storeId === right.storeId && left.folderEntryId === right.folderEntryId &&
    (!right.internetMessageId || left.internetMessageId === right.internetMessageId);
}
function address(value: string): string { return value.trim().toLowerCase(); }
function replySubject(subject: string): string {
  const base = subject.replace(/\s+/g, ' ').trim() || 'Quotation';
  return /^re:/i.test(base) ? base : `Re: ${base}`;
}
function failure(error: unknown): string { return error instanceof Error ? error.message : 'The reply could not be saved.'; }
function replaceToken(error: unknown): string | null {
  const item = error as { data?: { code?: string }; message?: string };
  const prefix = 'DRAFT_REPLACE_CONFIRM_REQUIRED:';
  return item.data?.code === 'CONFLICT' && item.message?.startsWith(prefix) ? item.message.slice(prefix.length) : null;
}

type Pending = {
  key: string; fingerprint: string; startedAt: number; output: QuoteOutput; html: string; email: WorkstationEmailPayload;
  create: { operationId: string; entryId: string; storeId: string; folderEntryId: string; htmlBody: string; replyAll: false; openInComposer: false };
  location?: MailLocation;
  attachments?: Array<{ operationId: string; entryId: string; storeId: string; folderEntryId: string; fileName: string; base64Data: string }>;
  completed: number;
};

/** Source and mailbox remain host-owned. The caller supplies a live selection guard and reviewed HTML. */
export function useQuoteOutput({ source, bridge, isCurrentSource }: {
  source: ReservationSourceContext; bridge?: PaneBridge;
  isCurrentSource: (source: ReservationSourceContext) => boolean;
}) {
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const busy = useRef(false), pending = useRef<Pending | null>(null), mounted = useRef(false);
  const live = useRef({ source, bridge, isCurrentSource });
  live.current = { source, bridge, isCurrentSource };
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  const key = sourceKey(source);
  const current = () => mounted.current && sourceKey(live.current.source) === key && live.current.isCurrentSource(source);
  const outputFor = (snapshot: ReservationPaneSnapshot | null, requestId: string) => getQuoteOutput(source, snapshot, requestId);
  const report = (status: QuoteOutputResult['status'], message: string): QuoteOutputResult => {
    if (mounted.current && sourceKey(live.current.source) === key) setError(status === 'error' || status === 'unknown' ? message : null);
    return { status, message };
  };
  const getReady = async (requestId: string, html: string, snapshot: ReservationPaneSnapshot, isCurrentSnapshot?: () => boolean) => {
    if (!current() || isCurrentSnapshot && !isCurrentSnapshot()) throw new Error('The selected email or quote changed. Review it again.');
    if (!quoteOutputState(snapshot, requestId).textOnly) throw new Error('Choose the text reply and review document requests first.');
    const output = getQuoteOutput(source, snapshot, requestId);
    if (!output || output.issues.length || !output.cover) throw new Error(output?.issues[0] ?? 'Generate the quote and cover reply first.');
    if (output.artifacts.length) throw new Error('Generate a new text-only quote before saving the reply. Handle documents separately.');
    if (!html.trim()) throw new Error('Review the cover reply before creating a draft.');
    await verifyAttachments(output.artifacts);
    if (!current() || isCurrentSnapshot && !isCurrentSnapshot()) throw new Error('The selected email or quote changed. Review it again.');
    const latest = getQuoteOutput(source, snapshot, requestId);
    if (!latest || latest.operationId !== output.operationId || latest.issues.length) throw new Error('The quote changed. Review the latest output.');
    return output;
  };

  const saveWebReply = async ({ snapshot, requestId, html, to, confirmReplace, isCurrentSnapshot }: {
    snapshot: ReservationPaneSnapshot; requestId: string; html: string; to?: string; confirmReplace?: Confirm; isCurrentSnapshot?: () => boolean;
  }): Promise<QuoteOutputResult> => {
    if (busy.current) return { status: 'error', message: 'A reply is already being prepared.' };
    busy.current = true; setSaving(true); setError(null); beginMutation();
    try {
      const output = await getReady(requestId, html, snapshot, isCurrentSnapshot), recipient = (to ?? output.cover!.to).trim();
      if (!/^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/.test(recipient)) throw new Error('Enter a recipient email address.');
      const payload = { threadId: source.threadId!, replyToMessageId: source.messageId, to: [recipient],
        subject: replySubject(source.subject), html, replyKind: 'quote' as const,
        attachments: output.artifacts.map((item) => ({ name: item.fileName, type: item.mimeType,
          size: item.sizeBytes, lastModified: Date.now(), base64: item.bytesBase64 })) };
      try { await trpcClient.drafts.saveReply.mutate(payload, inMailbox(source.mailboxId)); }
      catch (error) {
        const token = replaceToken(error);
        if (!token) throw error;
        if (!confirmReplace) return report('error', 'This thread has another draft. Confirm replacement before saving.');
        if (!await confirmReplace()) return report('cancelled', 'The existing draft was kept.');
        if (!current() || isCurrentSnapshot && !isCurrentSnapshot()) throw new Error('The selected email or quote changed. The existing draft was kept.');
        const latest = getQuoteOutput(source, snapshot, requestId);
        if (!latest || latest.operationId !== output.operationId || latest.issues.length) throw new Error('The quote changed. Review the latest output.');
        await trpcClient.drafts.saveReply.mutate({ ...payload, replaceDraft: token }, inMailbox(source.mailboxId));
      }
      return report('saved', 'The reviewed reply was saved as an unsent draft.');
    } catch (error) { return report('error', failure(error)); }
    finally { busy.current = false; if (mounted.current) setSaving(false); endMutation(); }
  };

  const createOutlookReply = async ({ snapshot, requestId, html, confirmUnknown, isCurrentSnapshot }: {
    snapshot: ReservationPaneSnapshot; requestId: string; html: string; confirmUnknown?: Confirm; isCurrentSnapshot?: () => boolean;
  }): Promise<QuoteOutputResult> => {
    if (busy.current) return { status: 'error', message: 'A reply is already being prepared.' };
    busy.current = true; setSaving(true); setError(null); beginMutation();
    let submitted = false;
    try {
      const output = await getReady(requestId, html, snapshot, isCurrentSnapshot), host = live.current.bridge, email = host?.activeEmail;
      if (!host || !email || !email.entryId || !email.storeId || !email.folderEntryId ||
          !host.supportsAction('GET_ACTIVE_EMAIL') || !host.supportsAction('CREATE_REPLY_DRAFT') ||
          (output.artifacts.length && !host.supportsAction('ADD_ATTACHMENT_TO_DRAFT'))) throw new Error('Connect Outlook and update the add-in before creating this draft.');
      if (output.artifacts.length && host.capabilities?.preservesAttachmentFilenames !== true) throw new Error('Update the Outlook add-in to attach correctly named PDF and Excel files. The files remain available to download.');
      if (output.artifacts.some(item => item.sizeBytes > MAX_OUTLOOK_ATTACHMENT_BYTES)) throw new Error('A quotation file exceeds the Outlook add-in limit. Download and attach it manually; no reply was created.');
      if (source.internetMessageId && email.internetMessageId !== source.internetMessageId) throw new Error('The selected Outlook email changed. Select it again.');
      if (!output.cover?.to.trim() || address(output.cover.to) !== address(email.senderEmail)) throw new Error('Outlook replies to the original sender. Check the quote recipient before creating this draft.');
      const fingerprint = JSON.stringify([key, output.operationId, html, output.artifacts.map((item) => [item.fileName, item.sha256])]);
      let attempt = pending.current;
      if ((attempt && (attempt.key !== key || attempt.fingerprint !== fingerprint ||
          Date.now() - attempt.startedAt >= RETRY_WINDOW_MS)) || (!attempt && readMarker())) {
        if (!confirmUnknown || !await confirmUnknown()) return report('cancelled', 'Check Outlook Drafts before starting another reply.');
        if (!current() || isCurrentSnapshot && !isCurrentSnapshot()) throw new Error('The selected email or quote changed. Review it again.');
        pending.current = null; attempt = null;
      }
      if (!attempt) {
        attempt = { key, fingerprint, startedAt: Date.now(), output, html, email, completed: 0,
          create: { operationId: createOperationId(), entryId: email.entryId, storeId: email.storeId,
            folderEntryId: email.folderEntryId, htmlBody: html, replyAll: false, openInComposer: false } };
        pending.current = attempt;
      }
      if (!attempt.location) {
        const selected = await host.sendCommand<Record<string, never>, WorkstationEmailPayload | null>('GET_ACTIVE_EMAIL', {});
        if (!current() || isCurrentSnapshot && !isCurrentSnapshot() || !sameEmail(selected, attempt.email) || !sameEmail(live.current.bridge?.activeEmail ?? null, attempt.email)) throw new Error('The selected Outlook email changed. Select it again.');
        if (!writeMarker(attempt.create.operationId)) throw new Error('Outlook retry protection is unavailable. Reopen the pane and try again.');
        submitted = true;
        const location = await host.sendCommand<typeof attempt.create, MailLocation>('CREATE_REPLY_DRAFT', attempt.create);
        if (!location?.entryId || !location.storeId || !location.folderEntryId) throw new Error('Outlook did not confirm the draft location.');
        attempt.location = location;
      }
      if (!current()) return report('unknown', 'A reply may have been created. Check Outlook Drafts before continuing.');
      const location = attempt.location;
      attempt.attachments ??= attempt.output.artifacts.map((item) => ({ operationId: createOperationId(),
        entryId: location.entryId, storeId: location.storeId, folderEntryId: location.folderEntryId,
        fileName: item.fileName, base64Data: item.bytesBase64 }));
      for (let index = attempt.completed; index < attempt.attachments.length; index++) {
        if (!current()) return report('unknown', 'The reply may be incomplete. Check Outlook Drafts before continuing.');
        submitted = true;
        await host.sendCommand('ADD_ATTACHMENT_TO_DRAFT', attempt.attachments[index]!);
        attempt.completed = index + 1;
      }
      if (readMarker() === attempt.create.operationId) writeMarker(null);
      pending.current = null;
      return report('created', 'The reviewed reply and available files were created in Outlook Drafts.');
    } catch (error) {
      if (submitted || pending.current?.location || (pending.current && readMarker() === pending.current.create.operationId))
        return report('unknown', `${failure(error)} Retry the same reply, or check Outlook Drafts.`);
      if (pending.current && !readMarker()) pending.current = null;
      return report('error', failure(error));
    } finally { busy.current = false; if (mounted.current) setSaving(false); endMutation(); }
  };
  return { outputFor, saveWebReply, createOutlookReply, saving, error };
}

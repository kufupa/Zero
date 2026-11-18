'use client';

import { useEffect, useRef, useState } from 'react';
import { z } from 'zod';
import type { PropertyConfiguration, ReservationPaneSnapshot, ReservationSourceContext } from '@/lib/reservation-workflow/types';
import { inMailbox } from '@/lib/mail/mail-cache-scope';
import { AttachmentContentSchema, AttachmentMetaSchema, MailLocationSchema, createOperationId,
  type MailLocation, type WorkstationEmailPayload } from '@/lib/workstation/bridge-protocol';
import { beginMutation, endMutation } from '@/lib/workstation/mutations-in-flight';
import type { PaneBridge } from '@/lib/workstation/pane-bridge-types';
import { trpcClient } from '@/providers/query-provider';
import { completeQuotePackage, getQuotePackageOutput, type QuoteOutput, type QuoteOutputArtifact, type QuoteOutputResult } from '@/lib/reservation-workflow/quote-output';
export { getQuoteOutput, quoteCoverHtml } from '@/lib/reservation-workflow/quote-output';
export type { QuoteOutput, QuoteOutputArtifact, QuoteOutputResult } from '@/lib/reservation-workflow/quote-output';

type Confirm = () => boolean | Promise<boolean>;
type OutlookReplyInput = {
  html: string; confirmUnknown?: Confirm;
} & ({ snapshot: ReservationPaneSnapshot; requestId: string; isCurrentSnapshot?: () => boolean; verifyCurrentSnapshot?: () => Promise<boolean> } |
  { output: QuoteOutput; isCurrentSnapshot: () => boolean; verifyCurrentSnapshot: () => Promise<boolean> });
export type OutlookReplyResult = QuoteOutputResult & { readback?: { subject: string; attachmentNames: string[] } };

const MARKER = 'nava_v2_quote_unresolved_reply_v1';
const COMPLETED_PREFIX = 'nava_quote_completed_reply_v1:';
const RETRY_WINDOW_MS = 15 * 60 * 1000;
const MAX_ATTACHMENT_BYTES = 15 * 1024 * 1024;
// Older Outlook bridge fingerprints use a 2 MiB JSON string limit, including base64.
const MAX_OUTLOOK_ATTACHMENT_BYTES = 1_400_000;

function sourceKey(source: ReservationSourceContext): string {
  return JSON.stringify([source.mailboxId, source.propertyId, source.messageId, source.threadId,
    source.sourceHash, source.propertySelectionEpoch, source.selectionEpoch]);
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

const storedAttemptBase = z.object({ version: z.literal(2), fingerprint: z.string().regex(/^[a-f0-9]{64}$/),
  startedAt: z.number().int().positive(), createOperationId: z.string().regex(/^op_\d+_[a-f0-9]{32}$/),
  recipientOperationId: z.string().regex(/^op_\d+_[a-f0-9]{32}$/).optional() });
const storedAttemptSchema = z.discriminatedUnion('phase', [
  storedAttemptBase.extend({ phase: z.literal('creating') }),
  storedAttemptBase.extend({ phase: z.literal('attaching'), location: MailLocationSchema,
    attachmentOperationIds: z.array(z.string().regex(/^op_\d+_[a-f0-9]{32}$/)).max(64) }),
]);
type StoredAttempt = z.infer<typeof storedAttemptSchema>;

function readMarker(): string | null {
  try { return localStorage.getItem(MARKER) ?? sessionStorage.getItem(MARKER); } catch { return null; }
}
function writeMarker(value: string | null): boolean {
  try {
    if (value === null) { localStorage.removeItem(MARKER); sessionStorage.removeItem(MARKER); }
    else localStorage.setItem(MARKER, value);
    return true;
  }
  catch { return false; }
}
function storedAttempt(raw: string | null): StoredAttempt | null {
  if (!raw) return null;
  try { const parsed = storedAttemptSchema.safeParse(JSON.parse(raw)); return parsed.success ? parsed.data : null; }
  catch { return null; }
}
async function fingerprintFor(source: ReservationSourceContext, email: WorkstationEmailPayload, output: QuoteOutput, html: string): Promise<string> {
  const input = JSON.stringify([source.mailboxId, source.propertyId, source.messageId, source.threadId, source.sourceHash, source.subject,
    email.entryId, email.storeId, email.folderEntryId, output.requestId, output.operationId, output.observationRef, output.cover?.to, html, output.artifacts.map(item => [item.fileName, item.sha256])]);
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(input));
  return [...new Uint8Array(digest)].map(byte => byte.toString(16).padStart(2, '0')).join('');
}
async function completedKey(source: ReservationSourceContext, email: WorkstationEmailPayload, output: QuoteOutput): Promise<string> {
  const input=JSON.stringify([source.mailboxId,source.propertyId,source.messageId,source.threadId,source.sourceHash,
    email.entryId,email.storeId,email.folderEntryId,output.requestId,output.operationId,output.observationRef,
    output.artifacts.map(item=>[item.fileName,item.sha256])]);
  const digest=await crypto.subtle.digest('SHA-256',new TextEncoder().encode(input));
  return COMPLETED_PREFIX+[...new Uint8Array(digest)].map(byte=>byte.toString(16).padStart(2,'0')).join('');
}
const completedSchema=z.object({fingerprint:z.string().regex(/^[a-f0-9]{64}$/),location:MailLocationSchema}).strict();
// Same rule as canonicalMessageId in apps/server-pilot/src/mail/ingest/message-id.ts: strip angle
// brackets, unquote a quoted local part, lowercase. Outlook gives the raw header; the server returns this form.
function canonicalMessageId(raw: string | null | undefined): string | null {
  const id = raw?.trim().replace(/^<+|>+$/g, '').trim();
  if (!id) return null;
  if (!id.startsWith('"')) return id.toLowerCase();
  let local = '';
  for (let index = 1; index < id.length; index++) {
    const character = id[index]!;
    if (character === '\\' && index + 1 < id.length) { local += id[++index]!; continue; }
    if (character === '"') return (local + id.slice(index + 1)).toLowerCase() || null;
    local += character;
  }
  return id.toLowerCase();
}
function sameEmail(left: WorkstationEmailPayload | null, right: WorkstationEmailPayload): boolean {
  return !!left && left.entryId === right.entryId && left.storeId === right.storeId && left.folderEntryId === right.folderEntryId &&
    (!right.internetMessageId || canonicalMessageId(left.internetMessageId) === canonicalMessageId(right.internetMessageId));
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

export async function saveQuoteWebDraft({ source, output, html, to, confirmReplace, verifyCurrent }: {
  source: Pick<ReservationSourceContext, 'mailboxId' | 'threadId' | 'messageId' | 'subject'>;
  output: QuoteOutput;
  html: string;
  to?: string;
  confirmReplace?: Confirm;
  verifyCurrent: () => boolean | Promise<boolean>;
}): Promise<QuoteOutputResult> {
  try {
    const recipient = (to ?? output.cover?.to ?? '').trim();
    if (!source.threadId || !completeQuotePackage(output) || !html.trim()) {
      throw new Error('Review the cover and complete quote before saving a draft.');
    }
    if (!/^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/.test(recipient)) throw new Error('Enter a recipient email address.');
    await verifyAttachments(output.artifacts);
    if (!await verifyCurrent()) throw new Error('The selected email or quote changed. Review it again.');
    const payload = { threadId: source.threadId, replyToMessageId: source.messageId, to: [recipient],
      subject: replySubject(source.subject), html, replyKind: 'quote' as const,
      attachments: output.artifacts.map((item) => ({ name: item.fileName, type: item.mimeType,
        size: item.sizeBytes, lastModified: Date.now(), base64: item.bytesBase64 })) };
    const options = inMailbox(source.mailboxId);
    try { await trpcClient.drafts.saveReply.mutate(payload, options); }
    catch (error) {
      const token = replaceToken(error);
      if (!token) throw error;
      if (!confirmReplace) return { status: 'error', message: 'This thread has another draft. Confirm replacement before saving.' };
      if (!await confirmReplace()) return { status: 'cancelled', message: 'The existing draft was kept.' };
      if (!await verifyCurrent()) throw new Error('The selected email or quote changed. The existing draft was kept.');
      await trpcClient.drafts.saveReply.mutate({ ...payload, replaceDraft: token }, options);
    }
    return { status: 'saved', message: 'The reviewed reply was saved as an unsent draft.' };
  } catch (error) { return { status: 'error', message: failure(error) }; }
}

type Pending = {
  key: string; fingerprint: string; startedAt: number; output: QuoteOutput; html: string; email: WorkstationEmailPayload;
  recipientOperationId: string;
  create: { operationId: string; entryId: string; storeId: string; folderEntryId: string; htmlBody: string; replyAll: false; openInComposer: false };
  location?: MailLocation;
  attachments?: Array<{ operationId: string; entryId: string; storeId: string; folderEntryId: string; fileName: string; base64Data: string }>;
  completed: number;
};

function persistAttempt(attempt: Pending): boolean {
  const base = { version: 2 as const, fingerprint: attempt.fingerprint, startedAt: attempt.startedAt,
    createOperationId: attempt.create.operationId, recipientOperationId: attempt.recipientOperationId };
  const journal: StoredAttempt = attempt.location && attempt.attachments
    ? { ...base, phase: 'attaching', location: attempt.location, attachmentOperationIds: attempt.attachments.map(item => item.operationId) }
    : { ...base, phase: 'creating' };
  return writeMarker(JSON.stringify(journal));
}

/** Source and mailbox remain host-owned. The caller supplies a live selection guard and reviewed HTML. */
export function useQuoteOutput({ source, configuration, bridge, isCurrentSource }: {
  source: ReservationSourceContext; bridge?: PaneBridge;
  configuration: PropertyConfiguration | null;
  isCurrentSource: (source: ReservationSourceContext) => boolean;
}) {
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const busy = useRef(false), pending = useRef<Pending | null>(null), mounted = useRef(false);
  const live = useRef({ source, configuration, bridge, isCurrentSource });
  live.current = { source, configuration, bridge, isCurrentSource };
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  const key = sourceKey(source);
  const current = () => mounted.current && sourceKey(live.current.source) === key && live.current.isCurrentSource(source);
  const outputFor = (snapshot: ReservationPaneSnapshot | null, requestId: string) => getQuotePackageOutput(source, snapshot, requestId, configuration);
  const report = (status: QuoteOutputResult['status'], message: string): QuoteOutputResult => {
    if (mounted.current && sourceKey(live.current.source) === key) setError(status === 'error' || status === 'unknown' ? message : null);
    return { status, message };
  };
  const getReady = async (requestId: string, html: string, snapshot: ReservationPaneSnapshot, isCurrentSnapshot?: () => boolean) => {
    if (!current() || isCurrentSnapshot && !isCurrentSnapshot()) throw new Error('The selected email or quote changed. Review it again.');
    const output = getQuotePackageOutput(source, snapshot, requestId, configuration);
    if (!output || !completeQuotePackage(output)) throw new Error(output?.issues[0] ?? 'Generate the complete quote with PDF and Excel first.');
    if (!html.trim()) throw new Error('Review the cover reply before creating a draft.');
    await verifyAttachments(output.artifacts);
    if (!current() || isCurrentSnapshot && !isCurrentSnapshot()) throw new Error('The selected email or quote changed. Review it again.');
    const latest = getQuotePackageOutput(source, snapshot, requestId, live.current.configuration);
    if (!latest || latest.operationId !== output.operationId || !completeQuotePackage(latest)) throw new Error('The quote changed. Review the latest output.');
    return output;
  };

  const saveWebReply = async ({ snapshot, requestId, html, to, confirmReplace, isCurrentSnapshot }: {
    snapshot: ReservationPaneSnapshot; requestId: string; html: string; to?: string; confirmReplace?: Confirm; isCurrentSnapshot?: () => boolean;
  }): Promise<QuoteOutputResult> => {
    if (busy.current) return { status: 'error', message: 'A reply is already being prepared.' };
    busy.current = true; setSaving(true); setError(null); beginMutation();
    try {
      const output = outputFor(snapshot, requestId);
      if (!output) throw new Error('Generate the complete quote with PDF and Excel first.');
      const result = await saveQuoteWebDraft({ source, output, html, to, confirmReplace, verifyCurrent: () => {
        if (!current() || isCurrentSnapshot && !isCurrentSnapshot()) return false;
        const latest = getQuotePackageOutput(source, snapshot, requestId, live.current.configuration);
        return !!latest && latest.operationId === output.operationId && completeQuotePackage(latest);
      } });
      return report(result.status, result.message);
    } catch (error) { return report('error', failure(error)); }
    finally { busy.current = false; if (mounted.current) setSaving(false); endMutation(); }
  };

  const createOutlookReplyLocked = async (input: OutlookReplyInput): Promise<OutlookReplyResult> => {
    const { html, confirmUnknown, isCurrentSnapshot, verifyCurrentSnapshot } = input;
    if (busy.current) return { status: 'error', message: 'A reply is already being prepared.' };
    busy.current = true; setSaving(true); setError(null); beginMutation();
    let submitted = false;
    try {
      let output: QuoteOutput;
      if ('output' in input) {
        if(typeof verifyCurrentSnapshot!=='function') throw new Error('The quote connection is unavailable. Review the quote again.');
        if (!current() || isCurrentSnapshot && !isCurrentSnapshot()) throw new Error('The selected email or quote changed. Review it again.');
        const artifacts=input.output.artifacts;
        if (!completeQuotePackage(input.output) || input.output.inventoryDecline || !html.trim() || artifacts.length!==2 ||
            !artifacts.some(item=>item.kind==='pdf_quote' && item.fileName==='Quotation.pdf' && item.mimeType==='application/pdf') ||
            !artifacts.some(item=>item.kind==='xlsx_quote' && item.fileName==='Quotation.xlsx' && item.mimeType==='application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'))
          throw new Error('Review the cover reply and generate the PDF and Excel files first.');
        await verifyAttachments(input.output.artifacts);
        if (!current() || isCurrentSnapshot && !isCurrentSnapshot()) throw new Error('The selected email or quote changed. Review it again.');
        output = input.output;
      } else {
        output = await getReady(input.requestId, html, input.snapshot, isCurrentSnapshot);
      }
      const host = live.current.bridge, email = host?.activeEmail;
      if (!host || !email || !email.entryId || !email.storeId || !email.folderEntryId ||
          !host.supportsAction('GET_ACTIVE_EMAIL') || !host.supportsAction('CREATE_REPLY_DRAFT') ||
          !host.supportsAction('UPDATE_DRAFT') || !host.supportsAction('GET_EMAIL_BY_ENTRY_ID') || !host.supportsAction('GET_ATTACHMENT_METADATA') ||
          (output.artifacts.length && (!host.supportsAction('ADD_ATTACHMENT_TO_DRAFT') || !host.supportsAction('READ_ATTACHMENT_BASE64'))))
        throw new Error('Connect Outlook and update the add-in before creating this draft.');
      if (output.artifacts.length && host.capabilities?.preservesAttachmentFilenames !== true) throw new Error('Update the Outlook add-in to attach correctly named PDF and Excel files.');
      if (output.artifacts.some(item => item.sizeBytes > MAX_OUTLOOK_ATTACHMENT_BYTES)) throw new Error('A quotation file exceeds the Outlook add-in limit. No reply was created.');
      if (source.internetMessageId && canonicalMessageId(email.internetMessageId) !== canonicalMessageId(source.internetMessageId)) throw new Error('The selected Outlook email changed. Select it again.');
      const recipient = output.cover!.to.trim(), subject = replySubject(source.subject);
      if (!z.string().email().safeParse(recipient).success) throw new Error('Enter a recipient email address.');
      const verifyBeforeMutation=async()=>{
        if(!current() || isCurrentSnapshot && !isCurrentSnapshot()) throw new Error('The selected email or quote changed. Review it again.');
        let verified=false;
        try { verified=!verifyCurrentSnapshot || await verifyCurrentSnapshot(); } catch { /* Fail closed on a disconnected signed check. */ }
        if(!verified || !current() || isCurrentSnapshot && !isCurrentSnapshot())
          throw new Error('The quote changed or its connection was lost. Review it again.');
      };
      const fingerprint = await fingerprintFor(source, email, output, html);
      if (!current() || isCurrentSnapshot && !isCurrentSnapshot()) throw new Error('The selected email or quote changed. Review it again.');
      const completionKey = 'output' in input ? await completedKey(source,email,output) : null;
      let completed: z.infer<typeof completedSchema> | null = null;
      if(completionKey) {
        const raw=localStorage.getItem(completionKey);
        if(raw) {
          const parsed=completedSchema.safeParse(JSON.parse(raw));
          if(!parsed.success) return report('unknown','Check the existing Outlook draft before continuing.');
          completed=parsed.data;
          if(completed.fingerprint!==fingerprint) return report('unknown','The quote already has an Outlook draft. Check it before changing the cover.');
        }
      }
      const inspectDraft = async (location:MailLocation, expected:QuoteOutput, expectedHtml:string) => {
        const identity={entryId:location.entryId,storeId:location.storeId,folderEntryId:location.folderEntryId};
        const draft=await host.sendCommand<typeof identity,WorkstationEmailPayload|null>('GET_EMAIL_BY_ENTRY_ID',identity);
        const metadata=z.array(AttachmentMetaSchema).parse(await host.sendCommand<typeof identity,unknown>('GET_ATTACHMENT_METADATA',identity));
        const normalize=(value:string)=>value.replace(/\s+/gu,' ').trim();
        const body=document.createElement('div'); body.innerHTML=expectedHtml;
        body.querySelectorAll('br').forEach(lineBreak=>lineBreak.replaceWith('\n'));
        const expectedBody=normalize(body.textContent??'');
        if(!current() || isCurrentSnapshot && !isCurrentSnapshot() || !draft || draft.entryId!==location.entryId ||
            draft.storeId!==location.storeId || draft.folderEntryId!==location.folderEntryId ||
            normalize(draft.subject)!==normalize(subject) || !expectedBody || !normalize(draft.bodyText).includes(expectedBody))
          throw new Error('Outlook could not confirm the draft and attachments.');
        for(const item of expected.artifacts) {
          const matches=metadata.filter(att=>att.fileName===item.fileName);
          if(matches.length!==1 || matches[0]!.byteSize!==item.sizeBytes) throw new Error('Outlook could not confirm the draft and attachments.');
          const payload={...identity,attachmentIndex:matches[0]!.index};
          const content=AttachmentContentSchema.parse(await host.sendCommand<typeof payload,unknown>('READ_ATTACHMENT_BASE64',payload));
          if(content.fileName!==item.fileName || content.byteSize!==item.sizeBytes || content.base64Data!==item.bytesBase64)
            throw new Error('A draft attachment did not match the generated file. Check Outlook Drafts.');
        }
        if(!draft.to || address(draft.to)!==address(recipient) || draft.cc?.trim())
          throw new Error('Outlook could not verify the recipient address. Check the address in Drafts before sending.');
        if(!current() || isCurrentSnapshot && !isCurrentSnapshot()) throw new Error('The selected email or quote changed. Check Outlook Drafts.');
        return {subject:draft.subject,attachmentNames:metadata.filter(item=>
          expected.artifacts.some(artifact=>artifact.fileName===item.fileName)).map(item=>item.fileName)};
      };
      if(completed) {
        submitted=true;
        await verifyBeforeMutation();
        const readback=await inspectDraft(completed.location,output,html);
        return {...report('created','Quote saved in Outlook Drafts. Review it there before sending.'),readback};
      }
      let attempt = pending.current;
      const marker = readMarker(), saved = storedAttempt(marker), age = saved ? Date.now() - saved.startedAt : -1;
      if (!attempt && saved?.phase === 'attaching' && saved.fingerprint === fingerprint && age >= 0 && age < RETRY_WINDOW_MS &&
          saved.attachmentOperationIds.length === output.artifacts.length) {
        attempt = { key, fingerprint, startedAt: saved.startedAt, output, html, email, completed: 0,
          recipientOperationId: saved.recipientOperationId ?? createOperationId(),
          create: { operationId: saved.createOperationId, entryId: email.entryId, storeId: email.storeId,
            folderEntryId: email.folderEntryId, htmlBody: html, replyAll: false, openInComposer: false } };
        attempt.location = saved.location;
        attempt.attachments = output.artifacts.map((item, index) => ({ operationId: saved.attachmentOperationIds[index]!,
          entryId: saved.location.entryId, storeId: saved.location.storeId, folderEntryId: saved.location.folderEntryId,
          fileName: item.fileName, base64Data: item.bytesBase64 }));
        pending.current = attempt;
      }
      if ((attempt && (attempt.key !== key || attempt.fingerprint !== fingerprint ||
          Date.now() - attempt.startedAt >= RETRY_WINDOW_MS)) || (!attempt && marker)) {
        if (!confirmUnknown || !await confirmUnknown()) return report('cancelled', 'Check Outlook Drafts before starting another reply.');
        if (!current() || isCurrentSnapshot && !isCurrentSnapshot()) throw new Error('The selected email or quote changed. Review it again.');
        pending.current = null; attempt = null;
      }
      if (!attempt) {
        attempt = { key, fingerprint, startedAt: Date.now(), output, html, email, completed: 0,
          recipientOperationId: createOperationId(),
          create: { operationId: createOperationId(), entryId: email.entryId, storeId: email.storeId,
            folderEntryId: email.folderEntryId, htmlBody: html, replyAll: false, openInComposer: false } };
        pending.current = attempt;
      }
      if (!attempt.location) {
        const selected = await host.sendCommand<Record<string, never>, WorkstationEmailPayload | null>('GET_ACTIVE_EMAIL', {});
        if (!current() || isCurrentSnapshot && !isCurrentSnapshot() || !sameEmail(selected, attempt.email) || !sameEmail(live.current.bridge?.activeEmail ?? null, attempt.email)) throw new Error('The selected Outlook email changed. Select it again.');
        await verifyBeforeMutation();
        if (!persistAttempt(attempt)) throw new Error('Outlook retry protection is unavailable. Reopen the pane and try again.');
        submitted = true;
        const location = await host.sendCommand<typeof attempt.create, MailLocation>('CREATE_REPLY_DRAFT', attempt.create);
        if (!location?.entryId || !location.storeId || !location.folderEntryId) throw new Error('Outlook did not confirm the draft location.');
        if (location.locationUnverified || location.draftPlacementWarning || location.storeId !== email.storeId)
          throw new Error('Outlook could not confirm where the draft was saved.');
        attempt.location = location;
      }
      if (!current()) return report('unknown', 'A reply may have been created. Check Outlook Drafts before continuing.');
      const location = attempt.location;
      attempt.attachments ??= attempt.output.artifacts.map((item) => ({ operationId: createOperationId(),
        entryId: location.entryId, storeId: location.storeId, folderEntryId: location.folderEntryId,
        fileName: item.fileName, base64Data: item.bytesBase64 }));
      if (!persistAttempt(attempt)) throw new Error('Outlook could not retain the draft for a safe retry.');
      const identity = { entryId: location.entryId, storeId: location.storeId, folderEntryId: location.folderEntryId };
      if (!current() || isCurrentSnapshot && !isCurrentSnapshot()) return report('unknown', 'The reply may be incomplete. Check Outlook Drafts before continuing.');
      const recipientUpdate = { ...identity, operationId: attempt.recipientOperationId, to: recipient, cc: '', bcc: '', subject };
      await verifyBeforeMutation();
      submitted = true;
      const updated = await host.sendCommand<typeof recipientUpdate, MailLocation>('UPDATE_DRAFT', recipientUpdate);
      if (!updated || updated.entryId !== identity.entryId || updated.storeId !== identity.storeId ||
          updated.folderEntryId !== identity.folderEntryId || updated.locationUnverified || updated.draftPlacementWarning)
        throw new Error('Outlook could not confirm the draft recipient was updated.');
      const readMetadata = async () => {
        const result = await host.sendCommand<typeof identity, unknown>('GET_ATTACHMENT_METADATA', identity);
        return z.array(AttachmentMetaSchema).parse(result);
      };
      const matchesArtifact = async (item: QuoteOutputArtifact, metadata: z.infer<typeof AttachmentMetaSchema>[]) => {
        const matches = metadata.filter(att => att.fileName === item.fileName);
        if (!matches.length) return false;
        if (matches.length !== 1 || matches[0]!.byteSize !== item.sizeBytes) throw new Error('The draft contains an unexpected attachment. Check Outlook Drafts.');
        const payload = { ...identity, attachmentIndex: matches[0]!.index };
        const content = AttachmentContentSchema.parse(await host.sendCommand<typeof payload, unknown>('READ_ATTACHMENT_BASE64', payload));
        if (content.fileName !== item.fileName || content.byteSize !== item.sizeBytes || content.base64Data !== item.bytesBase64)
          throw new Error('A draft attachment did not match the generated file. Check Outlook Drafts.');
        return true;
      };
      for (let index = attempt.completed; index < attempt.attachments.length; index++) {
        if (!current() || isCurrentSnapshot && !isCurrentSnapshot()) return report('unknown', 'The reply may be incomplete. Check Outlook Drafts before continuing.');
        if (await matchesArtifact(attempt.output.artifacts[index]!, await readMetadata())) { attempt.completed = index + 1; continue; }
        if (!current() || isCurrentSnapshot && !isCurrentSnapshot()) return report('unknown', 'The reply may be incomplete. Check Outlook Drafts before continuing.');
        await verifyBeforeMutation();
        submitted = true;
        const attachment = attempt.attachments[index]!;
        const added = await host.sendCommand<typeof attachment, boolean>('ADD_ATTACHMENT_TO_DRAFT', attachment);
        if (added !== true) throw new Error('Outlook did not confirm an attachment.');
        attempt.completed = index + 1;
      }
      const readback=await inspectDraft(location,attempt.output,attempt.html);
      if(completionKey) localStorage.setItem(completionKey,JSON.stringify({fingerprint,location}));
      if (storedAttempt(readMarker())?.createOperationId === attempt.create.operationId) writeMarker(null);
      pending.current = null;
      return {...report('created', 'Quote saved in Outlook Drafts. Review it there before sending.'),
        readback};
    } catch (error) {
      if (submitted || pending.current?.location || (pending.current && storedAttempt(readMarker())?.createOperationId === pending.current.create.operationId))
        return report('unknown', `${failure(error)} Retry the same reply, or check Outlook Drafts.`);
      if (pending.current && !readMarker()) pending.current = null;
      return report('error', failure(error));
    } finally { busy.current = false; if (mounted.current) setSaving(false); endMutation(); }
  };
  const createOutlookReply = async (input: OutlookReplyInput): Promise<OutlookReplyResult> => {
    if (!navigator.locks) return report('error', 'Update the Outlook browser to safely prepare the draft.');
    return navigator.locks.request('nava-v2-quote-outlook-draft', { ifAvailable: true }, lock =>
      lock ? createOutlookReplyLocked(input) : report('error', 'A quote draft is already being prepared.'));
  };
  return { outputFor, saveWebReply, createOutlookReply, saving, error };
}

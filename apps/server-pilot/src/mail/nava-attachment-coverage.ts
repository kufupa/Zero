import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { and, eq, inArray } from 'drizzle-orm';
import { z } from 'zod';
import { getDb } from '../db/client.js';
import { attachment, message } from '../db/schema/mail.js';
import { syncObservationV1 } from '../outlook-sync/contracts.js';
import { toParsedMessage } from '../trpc/wire-compat.js';
import { loadConversationMetaForThread } from './conversation-group.js';

const address = z.object({ name:z.string().nullable(), email:z.string() }).strict();
const importScope = z.object({
  source: z.literal('outlook'), mode: z.literal('live'), property_code: z.literal('HRCEN'),
  source_thread_id: z.string(), mailbox_id: z.string(), selected_message_id: z.string(),
  messages: z.array(z.object({ id: z.string(), rfc_message_id: z.string().nullable(), direction: z.enum(['inbound','outbound']),
    from:address, to:z.array(address), cc:z.array(address), received_at: z.string(), subject: z.string(), body_text: z.string(),
    body_html: z.null(), attachment_status:z.literal('complete'), attachments: z.array(z.never()) }).strict()).min(1),
}).strict();

function sourceAddress(value: {name?:string;email:string}) {
  const localPart=value.email.trim().split('@')[0];
  return {name:value.name===localPart?null:value.name??null,email:value.email};
}

const lineageId=z.string().min(1).max(512).refine(id=>id===id.trim() && !/[\x00-\x1f\x7f]/.test(id));
const semanticVersion=z.union([z.number(),z.string().regex(/^[1-9]\d*$/)]).refine(value=>Number.isSafeInteger(Number(value)) && Number(value)>0);
const noFileInventory=z.object({
  linkedOptionalMissing:z.array(z.never()).optional(),
  linkedAttachmentScopes:z.array(z.object({
    sourceId:lineageId,sourceObservationId:lineageId,semanticVersion,enumerated:z.literal(true),
    missing:z.array(z.never()),persisted:z.array(z.never()),
  })).min(1),
});
const firstObservation=z.object({
  sourceId:lineageId,sourceObservationId:lineageId,semanticVersion,canonicalContentVersion:semanticVersion,
  optionalMissing:z.array(z.never()),evidence:syncObservationV1,
});

function inventoried(provenance: Record<string, unknown> | null): boolean {
  const parsed=noFileInventory.safeParse(provenance);
  if (!parsed.success) return false;
  const scopes=parsed.data.linkedAttachmentScopes;
  if (parsed.data.linkedOptionalMissing) {
    return new Set(scopes.map(scope=>JSON.stringify([scope.sourceId,scope.sourceObservationId]))).size===scopes.length;
  }
  if (scopes.length!==1) return false;
  const own=firstObservation.safeParse(provenance);
  if (!own.success) return false;
  const [scope]=scopes, {sourceId,sourceObservationId,semanticVersion,canonicalContentVersion,evidence}=own.data;
  const version=Number(semanticVersion), roles=evidence.requiredArtifactRoles;
  return scope.sourceId===sourceId && scope.sourceObservationId===sourceObservationId && Number(scope.semanticVersion)===version
    && Number(canonicalContentVersion)===version && evidence.sourceObservationId===sourceObservationId && evidence.semanticVersion===version
    && evidence.semanticReady && evidence.availability==='available' && evidence.direction!=='unknown'
    && roles.includes('original-msg') && (roles.includes('body-text') || roles.includes('body-html'))
    && !roles.some(role=>role.startsWith('attachment:')) && !evidence.optionalMissing?.length && !evidence.contentIdentity?.attachments.length;
}

export function validCoverageRequest(raw:string, auth:string|null, secret:string): string|null {
  const match=auth?.match(/^(\d{13}\.[a-f0-9]{32})\.([a-f0-9]{64})$/);
  if (!match || Math.abs(Date.now()-Number(match[1].split('.')[0]))>30_000) return null;
  const expected=createHmac('sha256',secret).update('nava:attachment-recheck:v1\0').update(match[1]).update('\0').update(raw).digest();
  return timingSafeEqual(expected,Buffer.from(match[2],'hex')) ? match[1] : null;
}

export async function signNavaAttachmentCoverage(raw: string, mailboxId: string, secret: string, challenge: string) {
  const parsed = importScope.safeParse(JSON.parse(raw));
  if (!parsed.success || parsed.data.mailbox_id!==mailboxId) return null;
  const input = parsed.data;
  const imported = new Map(input.messages.map(item=>[item.id,item]));
  if (imported.size!==input.messages.length || !imported.has(input.selected_message_id)) return null;
  const versions = await getDb().transaction(async tx => {
    const [selected] = await tx.select({ threadId: message.threadId }).from(message)
      .where(and(eq(message.id,input.selected_message_id),eq(message.transportId,mailboxId),eq(message.direction,'inbound')));
    if (!selected) return null;
    const scope = await loadConversationMetaForThread(tx,mailboxId,selected.threadId);
    if (scope.conversationId!==input.source_thread_id) return null;
    const rows = await tx.select().from(message).where(and(eq(message.transportId,mailboxId),
      inArray(message.threadId,[selected.threadId,...scope.linkedThreadIds]))).orderBy(message.id);
    if (rows.length!==imported.size) return null;
    const files = await tx.select({ id:attachment.id }).from(attachment)
      .where(inArray(attachment.messageId,rows.map(row=>row.id))).limit(1);
    if (files.length) return null;
    const messageIdKey=(id:string)=>id.trim().replace(/^<|>$/g,'').toLowerCase();
    const knownIds=new Set(rows.flatMap(row=>row.messageIdHeader?[messageIdKey(row.messageIdHeader)]:[]));
    for (const row of rows) {
      const candidate = imported.get(row.id);
      const provenance = row.sourceProvenance;
      if (!candidate || !row.textBody?.trim() || !inventoried(provenance)) return null;
      // Known message links do not establish that all Outlook ancestors synced.
      // Refuse if the host has a causal reference but not its canonical message.
      if ([row.inReplyTo,...(row.references??[])].some(id=>id && !knownIds.has(messageIdKey(id)))) return null;
      const canonical=toParsedMessage(row);
      if (!isDeepStrictEqual(candidate,{
        id:canonical.id,rfc_message_id:canonical.messageId??null,direction:row.direction,
        from:sourceAddress(canonical.sender),to:canonical.to.map(sourceAddress),cc:(canonical.cc??[]).map(sourceAddress),
        received_at:canonical.receivedOn,subject:canonical.subject,body_text:canonical.body,body_html:null,
        attachment_status:'complete',attachments:[],
      })) return null;
    }
    return rows.map(row=>[row.id,row.sourceProvenance]);
  },{ isolationLevel:'repeatable read',accessMode:'read only' });
  if (!versions) return null;
  const version = createHash('sha256').update(JSON.stringify(versions)).digest('hex');
  return `${version}.${createHmac('sha256',secret).update('nava:attachment-coverage:v1\0').update(challenge).update('\0').update(version).update('\0').update(raw).digest('hex')}`;
}

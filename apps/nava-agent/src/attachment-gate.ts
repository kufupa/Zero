import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import type { TransactionSql } from 'postgres';
import { sql } from './db.js';

export const attachmentCheckPath = '/staff_attachments_checked';
export const attachmentsUnconfirmed = {
  code: 'ATTACHMENTS_UNCONFIRMED',
  message: 'Nava cannot verify attachment coverage or staff review for this conversation. Check the emails before running Prepare.',
} as const;

function verifyAttachmentCoverage(raw: string, proof: unknown, secret: string, challenge: string): string | null {
  if (typeof proof!=='string' || !/^[a-f0-9]{64}\.[a-f0-9]{64}$/.test(proof)) return null;
  const [version, signature] = proof.split('.');
  const expected = createHmac('sha256',secret).update('nava:attachment-coverage:v1\0').update(challenge).update('\0').update(version).update('\0').update(raw).digest();
  return timingSafeEqual(expected,Buffer.from(signature,'hex')) ? version : null;
}

export function verifyAttachmentImport(raw: string, header: string | undefined, secret: string | undefined): string | null {
  const match=header?.match(/^(\d{13})\.(.+)$/);
  if (!secret || !match || Math.abs(Date.now()-Number(match[1]))>30_000) return null;
  return verifyAttachmentCoverage(raw,match[2],secret,match[1]);
}

async function stillCompleteOnHost(raw: string, version: string) {
  const origin=process.env.NAVA_ATTACHMENT_AUTHORITY_URL;
  const secret=process.env.NAVA_STAFF_JWT_SECRET;
  if (!origin || !secret) return false;
  try {
    const url=new URL(origin);
    if (url.protocol!=='http:' || !['127.0.0.1','[::1]'].includes(url.hostname) || url.username || url.password
        || url.search || url.hash || url.pathname!=='/api/nava/v1/internal/attachment-coverage') return false;
    const challenge=`${Date.now()}.${randomBytes(16).toString('hex')}`;
    const sig=createHmac('sha256',secret).update('nava:attachment-recheck:v1\0').update(challenge).update('\0').update(raw).digest('hex');
    const reply=await fetch(url,{method:'POST',body:raw,redirect:'error',signal:AbortSignal.timeout(3500),headers:{
      'Content-Type':'application/json','X-Nava-Coverage-Request':`${challenge}.${sig}`,
    }});
    if (!reply.ok) { await reply.body?.cancel(); return false; }
    return verifyAttachmentCoverage(raw,(await reply.json())?.proof,secret,challenge)===version;
  } catch { return false; }
}

export function canonicalJson(value: unknown): string {
  return JSON.stringify(value,(_key,item:unknown)=>item && typeof item==='object' && !Array.isArray(item)
    ? Object.fromEntries(Object.entries(item).sort(([a],[b])=>a<b?-1:a>b?1:0)) : item);
}

export function attachmentSnapshotDigest(thread: {source:string;mailbox_id:string;source_thread_id:string;selected_message_id:string}, messages: {id:string}[]) {
  return createHash('sha256').update(canonicalJson([thread.source,thread.mailbox_id,thread.source_thread_id,thread.selected_message_id,
    [...messages].sort((a,b)=>a.id<b.id?-1:a.id>b.id?1:0)])).digest('hex');
}

export async function completeAttachmentSnapshot(tx: TransactionSql, sessionId: string, requireFresh=false) {
  const [proof] = await tx`SELECT t.id,t.source,t.mailbox_id,t.source_thread_id,t.selected_message_id,t.property_code,t.mode,
    e.payload->'attachment_coverage'->>'digest' AS digest,e.payload->'attachment_coverage'->>'version' AS version
    FROM nava_agent.agent_session s JOIN nava_agent.mail_thread t ON t.id=s.thread_id
    JOIN nava_agent.agent_event e ON e.session_id=s.id AND e.kind='import'
    WHERE s.id=${sessionId} AND t.mode='live' AND t.selection_key LIKE 'prepare:%'
      AND e.payload->'attachment_coverage'->>'version' IS NOT NULL LIMIT 1`;
  if (!proof) return false;
  const rows = await tx`SELECT payload FROM nava_agent.mail_message WHERE thread_id=${proof.id}`;
  const messages = rows.map(row=>row.payload);
  const identity={source:proof.source,mailbox_id:proof.mailbox_id,source_thread_id:proof.source_thread_id,selected_message_id:proof.selected_message_id};
  if (!messages.length || !messages.some(item=>item.id===identity.selected_message_id) || attachmentSnapshotDigest(identity,messages)!==proof.digest) return false;
  return !requireFresh || await stillCompleteOnHost(JSON.stringify({...identity,property_code:proof.property_code,mode:proof.mode,messages}),proof.version);
}

export async function staffAttachmentsChecked(db: TransactionSql, proposalId: string, revision: number) {
  const [edit] = await db`SELECT after = 'true'::jsonb AS checked FROM nava_agent.staff_edit
    WHERE proposal_id=${proposalId} AND revision=${revision} AND kind='edit' AND path=${attachmentCheckPath}
    ORDER BY sequence DESC LIMIT 1`;
  return edit?.checked === true;
}

export type StaffStage = { proposalId: string; revision: number; jobId: string; workerId: string; epoch: string };

export async function confirmedQueuedCreate(stage: StaffStage | undefined, sessionId: string, input: { booking: unknown; action: unknown }) {
  if (!stage) return false;
  return sql.begin('isolation level repeatable read read only', async tx => {
    const [proposal] = await tx`SELECT p.current FROM nava_agent.proposal p
      JOIN nava_agent.agent_session s ON s.id=p.session_id AND s.thread_id=p.thread_id
      JOIN nava_agent.mail_thread t ON t.id=p.thread_id
      WHERE p.id=${stage.proposalId} AND p.session_id=${sessionId} AND p.revision=${stage.revision}
        AND p.workflow='create' AND p.phase='staging' AND p.stage->>'state'='queued'
        AND p.stage->>'job_id'=${stage.jobId} AND p.stage->>'revision'=${String(stage.revision)}
        AND t.mode='live' AND t.selection_key LIKE 'prepare:%' AND s.worker_id=${stage.workerId}
        AND s.lease_epoch=${stage.epoch}::bigint AND s.lease_until>clock_timestamp()`;
    if (!proposal || !isDeepStrictEqual(proposal.current?.bookings, [input.booking])
        || !isDeepStrictEqual(proposal.current?.actions, [input.action])) return false;
    return await staffAttachmentsChecked(tx,stage.proposalId,stage.revision) && await completeAttachmentSnapshot(tx,sessionId,true);
  });
}

import { createHash, randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { NAVA_ARRIVAL_VERSION } from './ai/run-ledger.js';
import { getDb } from './db/client.js';
import { canonicalCenturionArrivalImport, isCenturionFilingSource } from './mail/nava-outlook-import.js';
import { canonicalImportBody, configuredAgentOrigin, staffToken } from './nava-rewrite-gateway.js';

/** Claim a durable live-admission job after the ingest transaction has committed. */
async function prefillOne(shutdown: AbortSignal): Promise<boolean> {
  const origin = configuredAgentOrigin(process.env.NAVA_AGENT_BASE_URL);
  const secret = process.env.NAVA_STAFF_JWT_SECRET;
  if (!origin || !secret) return false;
  const db = getDb();
  const claim = randomUUID();
  const rows = await db.execute(sql`
    UPDATE ai_workflow_run SET state='running', claim_token=${claim}, attempts=attempts+1,
      started_at=coalesce(started_at,now()), updated_at=now()
    WHERE id=(SELECT id FROM ai_workflow_run WHERE prompt_version=${NAVA_ARRIVAL_VERSION}
      AND ((state IN ('queued','retry_wait') AND (next_run_at IS NULL OR next_run_at<=now()))
        OR (state='running' AND updated_at<now()-interval '10 minutes'))
      ORDER BY created_at,id LIMIT 1 FOR UPDATE SKIP LOCKED)
    RETURNING id,transport_id,trigger_message_id,attempts`);
  const row = rows[0];
  if (!row) return false;
  const id = String(row.id), mailboxId = String(row.transport_id), messageId = String(row.trigger_message_id);
  const signal = AbortSignal.any([shutdown, AbortSignal.timeout(120_000)]);
  try {
    const canonical = await canonicalCenturionArrivalImport(mailboxId, messageId);
    if (!canonical) throw new Error('SOURCE_UNAVAILABLE');
    const body = await canonicalImportBody(canonical, signal, attachmentId => isCenturionFilingSource({
      mailboxId, conversationId: canonical.source_thread_id, messageId, attachmentId,
    }), 'nava_arrival');
    const token = staffToken('nava-arrival', [mailboxId], secret).token;
    const response = await fetch(`${origin}/api/nava/v1/threads`, {
      method: 'POST', redirect: 'error', signal, body,
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json',
        'idempotency-key': createHash('sha256').update(body).digest('hex') },
    });
    if (!response.ok) throw new Error(`IMPORT_HTTP_${response.status}`);
    const result: unknown = await response.json();
    const threadId = typeof result === 'object' && result !== null && 'id' in result && typeof result.id === 'string'
      ? result.id : null;
    await db.execute(sql`UPDATE ai_workflow_run SET state='succeeded', finished_at=now(),updated_at=now(),
      metrics=${JSON.stringify({ threadId, sourceMessageId: messageId })}::jsonb, claim_token=NULL
      WHERE id=${id} AND claim_token=${claim}`);
  } catch (error) {
    const reason = error instanceof Error && /^IMPORT_HTTP_\d+$/.test(error.message) ? error.message
      : error instanceof Error && error.message === 'SOURCE_UNAVAILABLE' ? error.message : 'IMPORT_UNAVAILABLE';
    const retryMinutes = reason === 'SOURCE_UNAVAILABLE' ? Math.min(30, Number(row.attempts)) : 1;
    await db.execute(sql`UPDATE ai_workflow_run SET state='retry_wait',
      next_run_at=now()+(${retryMinutes} * interval '1 minute'),last_error=${reason},updated_at=now(),claim_token=NULL
      WHERE id=${id} AND claim_token=${claim}`);
    console.error('Nava arrival prefill failed', { id, reason });
  }
  return true;
}

/** Import up to ten messages at a time; the agent owns the actual prefill work. */
export async function drainNavaArrivals(signal: AbortSignal): Promise<void> {
  await Promise.all(Array.from({ length: 10 }, async () => {
    while (!signal.aborted && await prefillOne(signal)) { /* drain admitted mail */ }
  }));
}

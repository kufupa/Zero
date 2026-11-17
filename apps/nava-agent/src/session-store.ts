import type postgres from 'postgres';
import { z } from 'zod';
import { sql, uid, json } from './db.js';

const block = z.object({type: z.string()}).passthrough();
const messageSchema = z.object({role: z.enum(['user', 'assistant']), content: z.array(block), stop_reason: z.string().nullable().optional()}).strict();
export type RuntimeMessage = z.infer<typeof messageSchema>;
export type Lease = {sessionId: string; workerId: string; epoch: string};
export type Go = {executionId: string; revision: number; idempotencyKey: string; actor: string; toolUseId: string; snapshot: unknown; dispatch: 'pending' | 'dispatched'; details: unknown};
export type SessionState = {threadId: string; sessionId: string; messages: RuntimeMessage[]; pendingToolUseId: string | null; version: number; toolOutcomes: Record<string, unknown>; status: string};
type Tx = postgres.TransactionSql;

function required(value: string, name: string): void {
  if (!value.trim()) throw new Error(`${name}_REQUIRED`);
}
function duration(ms: number): void {
  if (!Number.isSafeInteger(ms) || ms < 1 || ms > 3_600_000) throw new Error('INVALID_LEASE_DURATION');
}
function version(value: unknown): number {
  const n = Number(value);
  if (!Number.isSafeInteger(n) || n < 0) throw new Error('INVALID_MESSAGES_VERSION');
  return n;
}
async function lockLease(tx: Tx, lease: Lease) {
  const [row] = await tx`SELECT *, messages_version::text AS version FROM nava_agent.agent_session
    WHERE id=${lease.sessionId} AND worker_id=${lease.workerId} AND lease_epoch=${lease.epoch}::bigint
      AND lease_until > clock_timestamp() FOR NO KEY UPDATE`;
  if (!row) throw new Error('LEASE_LOST');
  return row;
}
export async function writeEvent(tx: Tx, sessionId: string, kind: string, payload: unknown) {
  await tx`SELECT pg_advisory_xact_lock(hashtextextended(${'nava:events:' + sessionId}, 0))`;
  await tx`INSERT INTO nava_agent.agent_event(id,session_id,kind,payload) VALUES (${uid('evt')},${sessionId},${kind},${json(payload)})`;
}
function resultIdsInclude(results: RuntimeMessage['content'], id: string): boolean {
  return results.some(result => result.tool_use_id === id);
}
function lastTool(messages: RuntimeMessage[], toolUseId: string) {
  const last = messages.at(-1);
  return last?.role === 'assistant' ? last.content.find(item => item.type === 'tool_use' && item.id === toolUseId) : undefined;
}

export async function claim(sessionId: string, workerId: string, leaseMs: number): Promise<Lease | null> {
  required(sessionId, 'SESSION_ID'); required(workerId, 'WORKER_ID'); duration(leaseMs);
  const [row] = await sql`UPDATE nava_agent.agent_session SET worker_id=${workerId},
    lease_until=clock_timestamp()+(${leaseMs} * interval '1 millisecond'), lease_epoch=lease_epoch+1, updated_at=now()
    WHERE id=${sessionId} AND (worker_id IS NULL OR lease_until IS NULL OR lease_until <= clock_timestamp())
    RETURNING lease_epoch::text AS epoch`;
  return row ? {sessionId, workerId, epoch: row.epoch} : null;
}
export async function refresh(lease: Lease, leaseMs: number): Promise<boolean> {
  duration(leaseMs);
  const rows = await sql`UPDATE nava_agent.agent_session SET lease_until=clock_timestamp()+(${leaseMs} * interval '1 millisecond'),updated_at=now()
    WHERE id=${lease.sessionId} AND worker_id=${lease.workerId} AND lease_epoch=${lease.epoch}::bigint
      AND lease_until > clock_timestamp() RETURNING id`;
  return rows.length === 1;
}
export async function release(lease: Lease): Promise<boolean> {
  const rows = await sql`UPDATE nava_agent.agent_session SET worker_id=NULL,lease_until=NULL,updated_at=now()
    WHERE id=${lease.sessionId} AND worker_id=${lease.workerId} AND lease_epoch=${lease.epoch}::bigint
      AND lease_until > clock_timestamp() RETURNING id`;
  return rows.length === 1;
}
export async function load(sessionId: string): Promise<SessionState> {
  return sql.begin('isolation level repeatable read read only', async tx => {
    const [row] = await tx`SELECT id,thread_id,messages,messages_version::text AS version,pending_tool_use_id,status
      FROM nava_agent.agent_session WHERE id=${sessionId}`;
    if (!row) throw new Error('SESSION_NOT_FOUND');
    const outcomes = await tx`SELECT payload FROM nava_agent.agent_event WHERE session_id=${sessionId} AND kind='tool_outcome' ORDER BY sequence`;
    const toolOutcomes: Record<string, unknown> = Object.create(null);
    for (const entry of outcomes) {
      const payload = z.object({tool_use_id:z.string(),result:z.unknown()}).parse(entry.payload);
      toolOutcomes[payload.tool_use_id] = payload.result;
    }
    return {threadId:row.thread_id, sessionId:row.id, messages:z.array(messageSchema).parse(row.messages),
      pendingToolUseId:row.pending_tool_use_id, version:version(row.version), toolOutcomes, status:row.status};
  });
}

export async function append(lease: Lease, expectedVersion: number, deliveryId: string, input: RuntimeMessage): Promise<number> {
  required(deliveryId, 'DELIVERY_ID'); version(expectedVersion);
  const message = messageSchema.parse(input);
  return sql.begin(async tx => {
    const row = await lockLease(tx, lease);
    const [prior] = await tx`SELECT payload->>'version' AS version, payload->'message'=${json(message)}::jsonb AS same
      FROM nava_agent.agent_event WHERE session_id=${lease.sessionId} AND kind='runtime_message' AND payload->>'delivery_id'=${deliveryId}`;
    if (prior) {
      if (!prior.same) throw new Error('DELIVERY_CONFLICT');
      return version(prior.version);
    }
    if (version(row.version) !== expectedVersion) throw new Error('VERSION_CONFLICT');
    const pending = row.pending_tool_use_id;
    const history = z.array(messageSchema).parse(row.messages);
    const last = history.at(-1);
    const uses = last?.role === 'assistant' ? last.content.filter(b => b.type === 'tool_use') : [];
    const results = message.content.filter(b => b.type === 'tool_result');
    if (uses.length) {
      const ids = z.array(z.string().min(1)).parse(uses.map(b => b.id));
      const resultIds = z.array(z.string().min(1)).parse(results.map(b => b.tool_use_id));
      if (message.role !== 'user' || new Set(ids).size !== ids.length ||
          resultIds.length !== ids.length || new Set(resultIds).size !== resultIds.length || resultIds.some(id => !ids.includes(id))) {
        throw new Error('TOOL_RESULTS_INCOMPLETE');
      }
      const outcomes = await tx`SELECT payload->>'tool_use_id' AS tool_use_id FROM nava_agent.agent_event
        WHERE session_id=${lease.sessionId} AND kind='tool_outcome' AND payload->>'tool_use_id' = ANY(${tx.array(ids)})`;
      if (outcomes.length !== ids.length) throw new Error('TOOL_OUTCOME_REQUIRED');
    } else if (results.length) throw new Error('UNEXPECTED_TOOL_RESULT');
    const resolves = pending && resultIdsInclude(results, pending);
    if (pending && !resolves) throw new Error('SESSION_PARKED');
    const next = expectedVersion + 1;
    if (!Number.isSafeInteger(next)) throw new Error('INVALID_MESSAGES_VERSION');
    await tx`UPDATE nava_agent.agent_session SET messages=messages || ${json([message])}::jsonb,messages_version=${next},
      pending_tool_use_id=CASE WHEN ${Boolean(resolves)} THEN NULL ELSE pending_tool_use_id END,
      status=CASE WHEN ${Boolean(resolves)} THEN 'running' ELSE status END,updated_at=now() WHERE id=${lease.sessionId}`;
    await writeEvent(tx, lease.sessionId, 'runtime_message', {delivery_id:deliveryId,version:next,message});
    return next;
  });
}
export async function event(lease: Lease, kind: string, payload: unknown): Promise<void> {
  required(kind, 'EVENT_KIND');
  if (kind === 'runtime_message' || kind === 'tool_outcome') throw new Error('RESERVED_EVENT_KIND');
  await sql.begin(async tx => { await lockLease(tx, lease); await writeEvent(tx, lease.sessionId, kind, payload); });
}
export async function park(lease: Lease, toolUseId: string): Promise<void> {
  required(toolUseId, 'TOOL_USE_ID');
  await sql.begin(async tx => {
    const row = await lockLease(tx, lease);
    if (row.pending_tool_use_id === toolUseId && row.status === 'waiting_go') return;
    if (row.pending_tool_use_id) throw new Error('ALREADY_PARKED');
    const tool = lastTool(z.array(messageSchema).parse(row.messages), toolUseId);
    if (!tool) throw new Error('TOOL_USE_NOT_FOUND');
    const [outcome] = await tx`SELECT id FROM nava_agent.agent_event WHERE session_id=${lease.sessionId} AND kind='tool_outcome' AND payload->>'tool_use_id'=${toolUseId}`;
    if (outcome) throw new Error('TOOL_ALREADY_RESOLVED');
    if (tool.name === 'hms_save') {
      const input = z.object({proposal_id:z.string().min(1),expected_revision:z.number().int().positive()}).parse(tool.input);
      const [proposal] = await tx`SELECT id,revision,phase FROM nava_agent.proposal WHERE id=${input.proposal_id} AND session_id=${lease.sessionId} FOR UPDATE`;
      if (!proposal) throw new Error('PROPOSAL_NOT_FOUND');
      if (proposal.revision !== input.expected_revision) throw new Error('VERSION_CONFLICT');
      if (proposal.phase !== 'ready' && proposal.phase !== 'waiting_go') throw new Error('NOT_READY');
      await tx`UPDATE nava_agent.proposal SET phase='waiting_go',updated_at=now() WHERE id=${input.proposal_id}`;
    }
    await tx`UPDATE nava_agent.agent_session SET pending_tool_use_id=${toolUseId},status='waiting_go',updated_at=now() WHERE id=${lease.sessionId}`;
    await writeEvent(tx, lease.sessionId, 'pause', {tool_use_id:toolUseId});
  });
}
export async function recordToolOutcome(lease: Lease, toolUseId: string, result: unknown): Promise<void> {
  required(toolUseId, 'TOOL_USE_ID');
  await sql.begin(async tx => {
    const row = await lockLease(tx, lease);
    const [prior] = await tx`SELECT payload->'result'=${json(result)}::jsonb AS same FROM nava_agent.agent_event
      WHERE session_id=${lease.sessionId} AND kind='tool_outcome' AND payload->>'tool_use_id'=${toolUseId}`;
    if (prior) { if (!prior.same) throw new Error('TOOL_OUTCOME_CONFLICT'); return; }
    const tool = lastTool(z.array(messageSchema).parse(row.messages), toolUseId);
    if (!tool) throw new Error('TOOL_USE_NOT_FOUND');
    if (row.pending_tool_use_id === toolUseId && tool.name === 'hms_save') throw new Error('USE_FINISH_GO');
    await writeEvent(tx, lease.sessionId, 'tool_outcome', {tool_use_id:toolUseId,result});
  });
}
export async function finish(lease: Lease, reason: string): Promise<void> {
  required(reason, 'REASON');
  await sql.begin(async tx => {
    const row = await lockLease(tx, lease);
    if (row.pending_tool_use_id) throw new Error('SESSION_PARKED');
    await tx`UPDATE nava_agent.agent_session SET status='idle',updated_at=now() WHERE id=${lease.sessionId}`;
    await writeEvent(tx, lease.sessionId, 'turn_finished', {reason});
  });
}

type GoClaim = {proposalId:string; expectedRevision:number; idempotencyKey:string; actor:string};
export async function claimGo(input: GoClaim): Promise<Go> {
  return sql.begin(tx => claimGoInTransaction(tx, input));
}
export async function claimGoInTransaction(tx: Tx, input: GoClaim): Promise<Go> {
  const {proposalId, expectedRevision, idempotencyKey, actor} = input;
  required(proposalId, 'PROPOSAL_ID'); required(idempotencyKey, 'IDEMPOTENCY_KEY'); required(actor, 'ACTOR');
  if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 1) throw new Error('INVALID_REVISION');
    const [ref] = await tx`SELECT session_id FROM nava_agent.proposal WHERE id=${proposalId}`;
    if (!ref) throw new Error('PROPOSAL_NOT_FOUND');
    const [session] = await tx`SELECT * FROM nava_agent.agent_session WHERE id=${ref.session_id} FOR NO KEY UPDATE`;
    const [p] = await tx`SELECT * FROM nava_agent.proposal WHERE id=${proposalId} AND session_id=${ref.session_id} FOR UPDATE`;
    if (!session || !p) throw new Error('PROPOSAL_NOT_FOUND');
    const oldGo = p.execution?.go;
    if (oldGo) {
      if (oldGo.idempotencyKey !== idempotencyKey || oldGo.actor !== actor || oldGo.revision !== expectedRevision) throw new Error('GO_CONFLICT');
      return oldGo;
    }
    if (p.revision !== expectedRevision) throw new Error('VERSION_CONFLICT');
    if (p.phase !== 'waiting_go' || session.status !== 'waiting_go' || !session.pending_tool_use_id) throw new Error('NOT_WAITING_GO');
    const tool = lastTool(z.array(messageSchema).parse(session.messages), session.pending_tool_use_id);
    if (tool?.name !== 'hms_save' || typeof tool.input !== 'object' || tool.input === null || !('proposal_id' in tool.input) || tool.input.proposal_id !== proposalId) throw new Error('PENDING_PROPOSAL_MISMATCH');
    const go: Go = {executionId:uid('execution'), revision:expectedRevision, idempotencyKey, actor,
      toolUseId:session.pending_tool_use_id, snapshot:p.current, dispatch:'pending', details:null};
    const [seq] = await tx`SELECT COALESCE(max(sequence),0)+1 AS n FROM nava_agent.staff_edit WHERE proposal_id=${proposalId}`;
    await tx`INSERT INTO nava_agent.staff_edit(id,sequence,proposal_id,session_id,workflow,kind,revision,who,snapshot)
      VALUES (${uid('edit')},${seq.n},${proposalId},${session.id},${p.workflow},'staff_final',${expectedRevision},${actor},${json(p.current)})`;
    await tx`UPDATE nava_agent.proposal SET phase='saving',execution=COALESCE(execution,'{}'::jsonb) || ${json({go})}::jsonb,updated_at=now() WHERE id=${proposalId}`;
    await writeEvent(tx, session.id, 'go_claimed', {proposal_id:proposalId,execution_id:go.executionId,revision:expectedRevision,actor});
    return go;
}
export async function markDispatched(lease: Lease, proposalId: string, executionId: string, details: unknown): Promise<void> {
  required(proposalId, 'PROPOSAL_ID'); required(executionId, 'EXECUTION_ID');
  await sql.begin(async tx => {
    const session = await lockLease(tx, lease);
    const [p] = await tx`SELECT *,current=execution->'go'->'snapshot' AS snapshot_matches FROM nava_agent.proposal WHERE id=${proposalId} AND session_id=${lease.sessionId} FOR UPDATE`;
    const go = p?.execution?.go;
    if (!go || go.executionId !== executionId || p.phase !== 'saving' || go.toolUseId !== session.pending_tool_use_id) throw new Error('EXECUTION_MISMATCH');
    if (go.dispatch !== 'pending') throw new Error('ALREADY_DISPATCHED');
    if (p.revision !== go.revision || !p.snapshot_matches) throw new Error('VERSION_CONFLICT');
    await tx`UPDATE nava_agent.proposal SET execution=jsonb_set(execution,'{go}',${json({...go,dispatch:'dispatched',details})}::jsonb),updated_at=now() WHERE id=${proposalId}`;
    await writeEvent(tx, lease.sessionId, 'save_dispatched', {proposal_id:proposalId,execution_id:executionId,details});
  });
}

export type GoCompletion = {outcome:'saved'|'not_saved'|'uncertain'; toolResult:unknown; proposalResult:unknown};
export async function finishGo(lease: Lease, proposalId: string, executionId: string, completion: GoCompletion): Promise<void> {
  required(proposalId, 'PROPOSAL_ID'); required(executionId, 'EXECUTION_ID');
  if (!['saved', 'not_saved', 'uncertain'].includes(completion.outcome)) throw new Error('INVALID_OUTCOME');
  await sql.begin(async tx => {
    const session = await lockLease(tx, lease);
    const [p] = await tx`SELECT *, execution->'go'->'completion'=${json(completion)}::jsonb AS same_completion
      FROM nava_agent.proposal WHERE id=${proposalId} AND session_id=${lease.sessionId} FOR UPDATE`;
    const go = p?.execution?.go;
    if (!go || go.executionId !== executionId) throw new Error('EXECUTION_MISMATCH');
    if (go.completion) { if (!p.same_completion) throw new Error('OUTCOME_CONFLICT'); return; }
    if (p.phase !== 'saving' || session.pending_tool_use_id !== go.toolUseId) throw new Error('EXECUTION_MISMATCH');
    if (completion.outcome !== 'not_saved' && go.dispatch !== 'dispatched') throw new Error('NOT_DISPATCHED');
    const [prior] = await tx`SELECT payload->'result'=${json(completion.toolResult)}::jsonb AS same FROM nava_agent.agent_event
      WHERE session_id=${lease.sessionId} AND kind='tool_outcome' AND payload->>'tool_use_id'=${go.toolUseId}`;
    if (prior && !prior.same) throw new Error('TOOL_OUTCOME_CONFLICT');
    if (!prior) await writeEvent(tx, lease.sessionId, 'tool_outcome', {tool_use_id:go.toolUseId,result:completion.toolResult});
    const phase = completion.outcome === 'saved' ? 'done' : completion.outcome === 'uncertain' ? 'uncertain' : 'error';
    await tx`UPDATE nava_agent.proposal SET phase=${phase},result=${json(completion.proposalResult)},
      execution=jsonb_set(execution,'{go}',${json({...go,completion})}::jsonb),updated_at=now() WHERE id=${proposalId}`;
    await writeEvent(tx, lease.sessionId, 'save_outcome', {proposal_id:proposalId,execution_id:executionId,outcome:completion.outcome});
  });
}

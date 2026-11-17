import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import postgres from 'postgres';
import { getPostgresSslOptions } from '../db/ssl-config.js';
import type { ReservationWorkflowV2ItemInput } from './reservation-workflow-v2-contract.js';
import type { AiRunFence } from './run-ledger.js';
import { and, eq } from 'drizzle-orm';
import type { DB } from '../db/client.js';
import { workItem } from '../db/schema/work.js';
import { aiWorkflowRun } from '../db/schema/mail.js';
type WorkTx = DB | Parameters<Parameters<DB['transaction']>[0]>[0];

type ActionCursor = ReservationWorkflowV2ItemInput & { transportId: string; jobFence?: AiRunFence; signal?: AbortSignal; laneToken?: string };
/** Only paths known to avoid target locks may borrow a shared credential. */
export function reservationActionCredentialReadOnly(method: string, workflow: string | undefined, nativeFieldPath: unknown): boolean {
  if (!workflow || !['quote', 'create', 'filing', 'cancel', 'amend'].includes(workflow)) return false;
  switch (method) {
    case 'lookup': return workflow !== 'amend' || typeof nativeFieldPath !== 'string';
    case 'prepare': return workflow !== 'amend';
    case 'guestProfileOptions':
    case 'prepareGuestProfile':
    case 'lookupServices':
    case 'verifyNativeLead': return true;
    default: return false;
  }
}

export const RESERVATION_ACTION_FENCE_KEY = '__reservationActionLane';
const actionScope = new AsyncLocalStorage<ActionCursor>();
const lanePools = new Map<string, { client: ReturnType<typeof postgres>; active: Set<AbortController> }>();

export async function closeReservationActionLanes(): Promise<void> {
  const pools = [...lanePools.values()];
  lanePools.clear();
  for (const pool of pools) {
    for (const loss of pool.active) loss.abort(Object.assign(new Error('Nava problem, not yours. Contact Nava support.'), { code: 'RESERVATION_ACTION_LOCK_LOST' }));
  }
  const results = await Promise.allSettled(pools.map(pool => pool.client.end({ timeout: 5 })));
  const failure = results.find(result => result.status === 'rejected');
  if (failure?.status === 'rejected') throw failure.reason;
}

function lanePool(url: string) {
  let pool = lanePools.get(url);
  if (!pool) {
    const active = new Set<AbortController>();
    const client = postgres(url, { max: 3, idle_timeout: 0, max_lifetime: 0, connect_timeout: 10, ssl: getPostgresSslOptions(url),
      onclose: () => { for (const loss of active) loss.abort(Object.assign(new Error('Nava problem, not yours. Contact Nava support.'), { code: 'RESERVATION_ACTION_LOCK_LOST' })); } });
    pool = { client, active };
    lanePools.set(url, pool);
  }
  return pool;
}

export function currentReservationActionCursor(workItemId: string): ActionCursor | undefined {
  const current = actionScope.getStore();
  return current?.workItemId === workItemId ? current : undefined;
}

export function withReservationActionCursor<T>(cursor: ActionCursor, operation: () => Promise<T>): Promise<T> {
  const inherited = currentReservationActionCursor(cursor.workItemId);
  return actionScope.run({ ...cursor, signal: inherited?.signal ?? cursor.signal,
    laneToken: inherited?.laneToken ?? cursor.laneToken }, operation);
}

export function assertReservationActionLive(): void { actionScope.getStore()?.signal?.throwIfAborted(); }

export async function assertReservationActionFence(tx: WorkTx, workItemId: string): Promise<void> {
  assertReservationActionLive();
  const cursor = currentReservationActionCursor(workItemId);
  if (!cursor?.laneToken) return;
  const [row] = await tx.select({ state: workItem.state }).from(workItem)
    .where(and(eq(workItem.id, workItemId), eq(workItem.transportId, cursor.transportId))).limit(1).for('update');
  if (row && row.state?.[RESERVATION_ACTION_FENCE_KEY] !== cursor.laneToken)
    throw Object.assign(new Error('The draft changed while Infor was being checked. Try again.'), { code: 'RESERVATION_ACTION_FENCE_STALE' });
}

export async function lockReservationActionClaim(tx: WorkTx, workItemId: string): Promise<void> {
  assertReservationActionLive();
  const cursor = currentReservationActionCursor(workItemId), fence = cursor?.jobFence;
  if (!cursor || !fence) return;
  const [run] = await tx.select({ deadlineAt: aiWorkflowRun.deadlineAt }).from(aiWorkflowRun).where(and(
    eq(aiWorkflowRun.id, fence.runId), eq(aiWorkflowRun.transportId, cursor.transportId),
    eq(aiWorkflowRun.workItemId, workItemId), eq(aiWorkflowRun.triggerMessageId, cursor.source.messageId),
    eq(aiWorkflowRun.claimOwner, fence.claimOwner), eq(aiWorkflowRun.claimToken, fence.claimToken),
    eq(aiWorkflowRun.state, 'running'))).limit(1).for('update');
  if (!run?.deadlineAt || run.deadlineAt.getTime() <= Date.now())
    throw Object.assign(new Error('reservation warmup claim expired'), { code: 'HMS_CREDENTIAL_RUN_STALE' });
}

async function within<T>(work: () => Promise<T>, signal: AbortSignal): Promise<T> {
  signal.throwIfAborted();
  let rejectAbort: () => void = () => {};
  const aborted = new Promise<never>((_resolve, reject) => {
    rejectAbort = () => reject(signal.reason);
    signal.addEventListener('abort', rejectAbort, { once: true });
  });
  try { return await Promise.race([work(), aborted]); }
  finally { signal.removeEventListener('abort', rejectAbort); }
}

/** Native callers must acquire their credential before entering this draft lane. */
export async function withReservationActionLane<T>(cursor: ActionCursor, operation: () => Promise<T>, options: {
  signal?: AbortSignal; acquisitionSignal?: AbortSignal; deadlineAt?: number; databaseUrl?: string;
} = {}): Promise<T> {
  const inherited = currentReservationActionCursor(cursor.workItemId);
  if (inherited?.transportId === cursor.transportId) return operation();
  const url = options.databaseUrl ?? process.env.DATABASE_URL;
  if (!url) throw new Error('reservation_action_database_required');
  const loss = new AbortController();
  let closing = false;
  const pool = lanePool(url);
  pool.active.add(loss);
  let connection: Awaited<ReturnType<typeof pool.client.reserve>> | undefined;
  const timeout = AbortSignal.timeout(Math.min(75_000, Math.max(1, (options.deadlineAt ?? Date.now() + 75_000) - Date.now())));
  const signal = AbortSignal.any([loss.signal, ...(cursor.signal ? [cursor.signal] : []), ...(options.signal ? [options.signal] : [])]);
  const acquisition = AbortSignal.any([signal, timeout, ...(options.acquisitionSignal ? [options.acquisitionSignal] : [])]);
  const key = JSON.stringify(['reservation-pane-action', cursor.transportId, cursor.workItemId]);
  let acquired = false;
  let timer: ReturnType<typeof setInterval> | undefined;
  let heartbeat: Promise<void> | undefined;
  const releaseConnection = async () => {
    if (!connection) return;
    try {
      loss.signal.throwIfAborted();
      // This queued unlock also settles an acquisition query whose abort won the race.
      const rows = await within(() => connection!.unsafe('SELECT pg_advisory_unlock(hashtextextended($1, 0)) AS released', [key]), AbortSignal.timeout(5000));
      if (acquired && rows[0]?.released !== true) throw new Error('reservation_action_lock_release_failed');
    } catch (failure) {
      await pool.client.end({ timeout: 5 });
      if (lanePools.get(url) === pool) lanePools.delete(url);
      throw failure;
    } finally { connection.release(); }
  };
  try {
    const reservation = pool.client.reserve();
    try { connection = await within(() => reservation, acquisition); }
    catch (failure) { void reservation.then(late => late.release(), () => {}); throw failure; }
    const reserved = connection;
    const [backend] = await within(() => reserved.unsafe('SELECT pg_backend_pid() AS pid'), acquisition);
    const pid = backend?.pid;
    while (!acquired) {
      const rows = await within(() => reserved.unsafe('SELECT pg_try_advisory_lock(hashtextextended($1, 0)) AS acquired', [key]), acquisition);
      acquired = rows[0]?.acquired === true;
      if (!acquired) await delay(25, undefined, { signal: acquisition });
    }
    const laneToken = randomUUID();
    await within(() => reserved.unsafe(`UPDATE work_item
      SET state = jsonb_set(coalesce(state, '{}'::jsonb), ARRAY[$1::text], to_jsonb($2::text), true)
      WHERE id = $3 AND transport_id = $4`, [RESERVATION_ACTION_FENCE_KEY, laneToken, cursor.workItemId, cursor.transportId]), acquisition);
    timer = setInterval(() => {
      if (heartbeat || closing) return;
      heartbeat = within(() => reserved.unsafe('SELECT pg_backend_pid() AS pid'), AbortSignal.timeout(10_000))
        .then(rows => { if (rows[0]?.pid !== pid) loss.abort(Object.assign(new Error('Nava problem, not yours. Contact Nava support.'), { code: 'RESERVATION_ACTION_LOCK_LOST' })); }, () => loss.abort(Object.assign(new Error('Nava problem, not yours. Contact Nava support.'), { code: 'RESERVATION_ACTION_LOCK_LOST' })))
        .finally(() => { heartbeat = undefined; });
    }, 5000);
    timer.unref();
    const result = await actionScope.run({ ...cursor, signal, laneToken }, operation);
    signal.throwIfAborted();
    return result;
  } catch (failure) {
    if (!acquired && timeout.aborted) throw Object.assign(new Error('Your draft is still being checked. Try again in a moment; your edits are retained.'), { code: 'RESERVATION_ACTION_LOCK_BUSY' });
    throw failure;
  } finally {
    closing = true;
    if (timer) clearInterval(timer);
    pool.active.delete(loss);
    await releaseConnection();
  }
}

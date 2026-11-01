import { createHash } from 'node:crypto';
import { and, eq } from 'drizzle-orm';
import type { DB } from '../db/client.js';
import { aiWorkflowRun } from '../db/schema/mail.js';
import { workEvent, workItem } from '../db/schema/work.js';

const STATE_KEY = 'reservationistHandledRequests';
const digest = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const object = (value: unknown): Record<string, unknown> =>
  value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};

/**
 * Model task ids can change on a re-read. Carry a staff decision only when the
 * exact source span and request kind still match uniquely. Ambiguous or
 * unlocated tasks remain scoped to their original run.
 */
export function requestCompletionKeys(result: unknown, runId: string): Map<string, string> {
  const value = object(result);
  if (value.version !== 1 || !Array.isArray(value.tasks) || value.tasks.length > 32 || !runId) return new Map();
  const tasks = value.tasks.map(object);
  const ids = tasks.map(task => task.id);
  if (ids.some(id => typeof id !== 'string' || !id || id.length > 512) || new Set(ids).size !== ids.length) return new Map();
  const candidates = tasks.map(task => {
    const source = object(task.requestSource);
    if (typeof task.kind !== 'string' || !task.kind || typeof source.attachmentId !== 'string' || !source.attachmentId ||
        typeof source.sourceHash !== 'string' || !/^[a-f0-9]{64}$/.test(source.sourceHash) ||
        !Number.isSafeInteger(source.page) || Number(source.page) < 1 ||
        !Number.isSafeInteger(source.start) || !Number.isSafeInteger(source.end) ||
        Number(source.start) < 0 || Number(source.end) <= Number(source.start) ||
        typeof source.quote !== 'string' || source.quote.length !== Number(source.end) - Number(source.start)) return null;
    return digest(['request-v1', task.kind, source.attachmentId, source.sourceHash, source.page, source.start, source.end]);
  });
  return new Map(tasks.map((task, index) => {
    const candidate = candidates[index];
    const key = candidate && candidates.filter(other => other === candidate).length === 1
      ? candidate : digest(['run-task-v1', runId, task.id]);
    return [task.id as string, key];
  }));
}

export function handledRequestKeys(state: unknown): Set<string> {
  const saved = object(object(state)[STATE_KEY]);
  return new Set(Object.entries(saved).filter(([key, handled]) => /^[a-f0-9]{64}$/.test(key) && handled === true).map(([key]) => key));
}

/** Newest first: retain a previously identified ask until staff acknowledge it. */
export function outstandingRequestHistory(runs: readonly { id: string; result: unknown }[], state: unknown) {
  const handled = handledRequestKeys(state), seen = new Set<string>();
  const outstanding: { runId: string; taskId: string; kind: string; quote: string }[] = [];
  for (const run of runs) {
    const value = object(run.result), keys = requestCompletionKeys(run.result, run.id);
    if (!Array.isArray(value.tasks)) continue;
    for (const raw of value.tasks) {
      const task = object(raw), taskId = typeof task.id === 'string' ? task.id : '';
      const key = keys.get(taskId);
      if (!key || seen.has(key)) continue;
      seen.add(key);
      if (handled.has(key)) continue;
      const source = object(task.requestSource);
      outstanding.push({ runId: run.id, taskId, kind: typeof task.kind === 'string' ? task.kind : '',
        quote: typeof source.quote === 'string' ? source.quote.slice(0, 40_000) : '' });
    }
  }
  return outstanding;
}

export function hasOutstandingRequests(result: unknown, runId: string, state: unknown): boolean {
  if (result == null) return false; // Older non-reservationist runs have no task inventory.
  const value = object(result);
  if (value.version !== 1 || !Array.isArray(value.tasks)) return true;
  // An unread business attachment is staff work even when no ask was extracted.
  // A person can still explicitly close the work item after reviewing it.
  if (Array.isArray(value.sourceRecoveries) && value.sourceRecoveries.some(raw => {
    const recovery = object(raw);
    return recovery.kind === 'attachment_manual' && recovery.disclosure === 'staff_only' && recovery.signatureNoise !== true;
  })) return true;
  if (!value.tasks.length) return false;
  const keys = requestCompletionKeys(result, runId), handled = handledRequestKeys(state);
  return keys.size !== value.tasks.length || [...keys.values()].some(key => !handled.has(key));
}

/** Keep earlier asks, but let the latest review replace stale file warnings. */
export function hasOutstandingRequestHistory(runs: readonly { id: string; result: unknown }[], state: unknown): boolean {
  const index = runs.findIndex(run => run.result != null);
  if (index < 0) return false;
  const latest = runs[index]!;
  return hasOutstandingRequests(latest.result, latest.id, state) || outstandingRequestHistory(runs.slice(index + 1), state).length > 0;
}

/** Staff acknowledgement only; it does not authorize a send or an HMS write. */
export async function setRequestHandled(db: DB, input: {
  transportId: string; workItemId: string; userId: string; runId: string; taskId: string; handled: boolean;
}): Promise<'recorded' | 'not_found' | 'stale'> {
  return db.transaction(async tx => {
    const [item] = await tx.select({ id: workItem.id, threadId: workItem.threadId, sourceMessageId: workItem.sourceMessageId, state: workItem.state, status: workItem.status })
      .from(workItem).where(and(eq(workItem.id, input.workItemId), eq(workItem.transportId, input.transportId))).limit(1).for('update');
    if (!item?.threadId || !item.sourceMessageId) return 'not_found';
    const [run] = await tx.select({ id: aiWorkflowRun.id, metrics: aiWorkflowRun.metrics }).from(aiWorkflowRun)
      .where(and(eq(aiWorkflowRun.id, input.runId), eq(aiWorkflowRun.transportId, input.transportId), eq(aiWorkflowRun.threadId, item.threadId),
        eq(aiWorkflowRun.triggerMessageId, item.sourceMessageId), eq(aiWorkflowRun.runKind, 'candidate_draft'),
        eq(aiWorkflowRun.executorLane, 'default'), eq(aiWorkflowRun.state, 'succeeded'))).limit(1);
    if (!run) return 'stale';
    const key = requestCompletionKeys(run.metrics?.reservationistResult, run.id).get(input.taskId);
    if (!key) return 'stale';
    const handled = handledRequestKeys(item.state);
    if (handled.has(key) === input.handled) return 'recorded';
    if (input.handled) handled.add(key); else handled.delete(key);
    const state = { ...item.state };
    if (handled.size) state[STATE_KEY] = Object.fromEntries([...handled].map(saved => [saved, true]));
    else delete state[STATE_KEY];
    const reopen = !input.handled && (item.status === 'done' || item.status === 'dismissed');
    await tx.update(workItem).set({ state, updatedAt: new Date(), ...(reopen ? {
      status: 'needs_you', sentAt: null, sentMessageId: null, followUpDueAt: null,
    } : {}) }).where(eq(workItem.id, item.id));
    await tx.insert(workEvent).values({ workItemId: item.id, actorKind: 'user', actorUserId: input.userId,
      type: 'request.handled', value: { key, runId: run.id, handled: input.handled } });
    if (reopen) await tx.insert(workEvent).values({ workItemId: item.id, actorKind: 'user', actorUserId: input.userId,
      type: 'status.changed', value: { from: item.status, to: 'needs_you', reason: 'request_reopened' } });
    return 'recorded';
  });
}

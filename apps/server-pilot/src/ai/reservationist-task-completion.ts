import { createHash } from 'node:crypto';
import { and, desc, eq, inArray, sql } from 'drizzle-orm';
import type { DB } from '../db/client.js';
import { aiWorkflowRun, message } from '../db/schema/mail.js';
import { mailExtraction, workEvent, workItem } from '../db/schema/work.js';
import { voucherReviewRecoveryId } from './reservationist-source-recovery.js';

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

/** A reclassification creates a new item; acknowledgements belong to the source email. */
export async function handledRequestStates(db: DB, input: { transportId: string; threadId: string; sourceIds: string[] }) {
  if (!input.sourceIds.length) return new Map<string, Record<string, unknown>>();
  const events = await db.select({ sourceId: workItem.sourceMessageId, value: workEvent.value })
    .from(workEvent).innerJoin(workItem, eq(workItem.id, workEvent.workItemId))
    .where(and(eq(workItem.transportId, input.transportId), eq(workItem.threadId, input.threadId),
      inArray(workItem.sourceMessageId, input.sourceIds), eq(workEvent.type, 'request.handled')))
    .orderBy(desc(workEvent.at), desc(workEvent.id));
  const seen = new Map<string, Set<string>>(), states = new Map<string, Record<string, unknown>>();
  for (const event of events) {
    const value = object(event.value), key = value.key;
    if (!event.sourceId || typeof key !== 'string' || !/^[a-f0-9]{64}$/.test(key) || typeof value.handled !== 'boolean') continue;
    const sourceSeen = seen.get(event.sourceId) ?? new Set<string>();
    if (sourceSeen.has(key)) continue;
    sourceSeen.add(key);
    seen.set(event.sourceId, sourceSeen);
    const state = states.get(event.sourceId) ?? { [STATE_KEY]: {} };
    if (value.handled) (state[STATE_KEY] as Record<string, boolean>)[key] = true;
    states.set(event.sourceId, state);
  }
  return states;
}

/** Newest first: retain earlier asks and their staff acknowledgement. */
export function requestHistory(runs: readonly { id: string; result: unknown }[], state: unknown) {
  const handled = handledRequestKeys(state), seen = new Set<string>();
  const requests: { runId: string; taskId: string; kind: string; quote: string; handled: boolean }[] = [];
  for (const run of runs) {
    const value = object(run.result), keys = requestCompletionKeys(run.result, run.id);
    if (!Array.isArray(value.tasks)) continue;
    for (const raw of value.tasks) {
      const task = object(raw), taskId = typeof task.id === 'string' ? task.id : '';
      const key = keys.get(taskId);
      if (!key || seen.has(key)) continue;
      seen.add(key);
      const source = object(task.requestSource);
      requests.push({ runId: run.id, taskId, kind: typeof task.kind === 'string' ? task.kind : '', handled: handled.has(key),
        quote: typeof source.quote === 'string' ? source.quote.slice(0, 40_000) : '' });
    }
  }
  return requests;
}

export function outstandingRequestHistory(runs: readonly { id: string; result: unknown }[], state: unknown) {
  return requestHistory(runs, state).filter(task => !task.handled);
}

export function hasOutstandingRequests(result: unknown, runId: string, state: unknown): boolean {
  if (result == null) return false; // Older non-reservationist runs have no task inventory.
  const value = object(result);
  if (value.version !== 1 || !Array.isArray(value.tasks)) return true;
  // An unread business attachment or ungrouped voucher request is staff work even when no task was extracted.
  // A person can still explicitly close the work item after reviewing it.
  if (Array.isArray(value.sourceRecoveries) && value.sourceRecoveries.some(raw => {
    const recovery = object(raw);
    return (recovery.kind === 'attachment_manual' && recovery.disclosure === 'staff_only' && recovery.signatureNoise !== true) ||
      !!voucherReviewRecoveryId(recovery);
  })) return true;
  if (!value.tasks.length) return false;
  const keys = requestCompletionKeys(result, runId), handled = handledRequestKeys(state);
  return keys.size !== value.tasks.length || [...keys.values()].some(key => !handled.has(key));
}

type HistoryRun = { id: string; result: unknown; source?: unknown };

/** A later read can clear an attachment warning; rereading does not clear a voucher check. */
export function outstandingSourceRecoveries(runs: readonly HistoryRun[]) {
  const failures = new Set<string>(), seenVouchers = new Set<string>(), successes = new Map<string, Set<string>>();
  const outstanding: { runId: string; sourceRef: string; kind: 'attachment_manual' | 'voucher_review'; id?: string }[] = [];
  const remember = (ref: unknown, hash: unknown) => {
    if (typeof ref !== 'string' || typeof hash !== 'string' || !/^[a-f0-9]{64}$/.test(hash)) return;
    const hashes = successes.get(ref) ?? new Set<string>();
    hashes.add(hash);
    successes.set(ref, hashes);
  };
  for (const run of runs) {
    const result = object(run.result);
    if (result.version !== 1) continue;
    const source = object(run.source);
    const emails = Array.isArray(source.messages) ? source.messages.map(object) : [];
    if (Array.isArray(result.sourceRecoveries)) for (const raw of result.sourceRecoveries) {
      const recovery = object(raw), ref = recovery.sourceRef, hash = recovery.sourceHash;
      if (recovery.kind === 'voucher_review') {
        const id = voucherReviewRecoveryId(recovery);
        if (id && typeof ref === 'string' && !seenVouchers.has(id)) {
          seenVouchers.add(id);
          outstanding.push({ runId: run.id, sourceRef: ref, kind: 'voucher_review', id });
        }
        continue;
      }
      if (recovery.kind !== 'attachment_manual' || recovery.disclosure !== 'staff_only' || recovery.signatureNoise === true ||
          typeof ref !== 'string' || !ref) continue;
      const laterHashes = successes.get(ref);
      const subject = ref.startsWith('message-subject:');
      // The snapshot binds the subject through identityHash, not the body hash.
      const identity = subject ? emails.find(email => `message-subject:${email.id}` === ref)?.identityHash : hash;
      const failureKey = JSON.stringify([ref, typeof hash === 'string' ? hash : null]);
      const reviewed = laterHashes && (typeof identity === 'string' ? laterHashes.has(identity) : !subject && typeof hash !== 'string');
      if (!failures.has(failureKey) && !reviewed)
        outstanding.push({ runId: run.id, sourceRef: ref, kind: 'attachment_manual' });
      failures.add(failureKey);
    }
    if (Array.isArray(source.attachments)) for (const raw of source.attachments) {
      const attachment = object(raw);
      remember(attachment.attachmentId, attachment.sourceHash);
    }
    for (const email of emails) {
      if (typeof email.id === 'string') {
        remember(`message:${email.id}`, email.sourceHash);
        remember(`message-subject:${email.id}`, email.identityHash);
      }
    }
  }
  return outstanding;
}

/** Keep earlier asks and unread files until staff handle them or the file is reviewed. */
export function hasOutstandingRequestHistory(runs: readonly HistoryRun[], state: unknown): boolean {
  const index = runs.findIndex(run => run.result != null);
  if (index < 0) return false;
  const latest = runs[index]!;
  return hasOutstandingRequests(latest.result, latest.id, state) || outstandingRequestHistory(runs.slice(index + 1), state).length > 0 ||
    outstandingSourceRecoveries(runs).length > 0;
}

/** Staff acknowledgement only; it does not authorize a send or an HMS write. */
export async function setRequestHandled(db: DB, input: {
  transportId: string; workItemId: string; userId: string; runId: string; taskId: string; handled: boolean;
}): Promise<'recorded' | 'not_found' | 'stale'> {
  return db.transaction(async tx => {
    const [identity] = await tx.select({ threadId: workItem.threadId, sourceMessageId: workItem.sourceMessageId })
      .from(workItem).where(and(eq(workItem.id, input.workItemId), eq(workItem.transportId, input.transportId))).limit(1);
    if (!identity?.threadId || !identity.sourceMessageId) return 'not_found';
    // Serialize decisions across classifications without holding a message row
    // while a reply import or an HMS approval holds the work item.
    const lockKey = JSON.stringify(['request-handled', input.transportId, identity.sourceMessageId]);
    await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${lockKey}, 0))`);
    const [source] = await tx.select({ id: message.id }).from(message)
      .where(and(eq(message.id, identity.sourceMessageId), eq(message.transportId, input.transportId), eq(message.threadId, identity.threadId)))
      .limit(1);
    if (!source) return 'not_found';
    const [item] = await tx.select({ id: workItem.id, threadId: workItem.threadId, sourceMessageId: workItem.sourceMessageId, kind: workItem.kind, state: workItem.state, status: workItem.status })
      .from(workItem).where(and(eq(workItem.id, input.workItemId), eq(workItem.transportId, input.transportId))).limit(1).for('update');
    if (!item?.threadId || !item.sourceMessageId || item.threadId !== identity.threadId || item.sourceMessageId !== identity.sourceMessageId) return 'not_found';
    const [latestRead] = await tx.select({ kind: mailExtraction.kind }).from(mailExtraction)
      .where(and(eq(mailExtraction.messageId, item.sourceMessageId), eq(mailExtraction.status, 'succeeded')))
      .orderBy(desc(mailExtraction.createdAt), desc(mailExtraction.id)).limit(1);
    if (latestRead?.kind && latestRead.kind !== item.kind) return 'stale';
    const [run] = await tx.select({ id: aiWorkflowRun.id, metrics: aiWorkflowRun.metrics }).from(aiWorkflowRun)
      .where(and(eq(aiWorkflowRun.id, input.runId), eq(aiWorkflowRun.transportId, input.transportId), eq(aiWorkflowRun.threadId, item.threadId),
        eq(aiWorkflowRun.triggerMessageId, item.sourceMessageId), eq(aiWorkflowRun.runKind, 'candidate_draft'),
        eq(aiWorkflowRun.executorLane, 'default'), eq(aiWorkflowRun.state, 'succeeded'))).limit(1);
    if (!run) return 'stale';
    const key = requestCompletionKeys(run.metrics?.reservationistResult, run.id).get(input.taskId);
    if (!key) return 'stale';
    const states = await handledRequestStates(tx as unknown as DB, { transportId: input.transportId, threadId: item.threadId, sourceIds: [item.sourceMessageId] });
    const handled = handledRequestKeys(states.get(item.sourceMessageId));
    if (handled.has(key) === input.handled) return 'recorded';
    if (input.handled) handled.add(key); else handled.delete(key);
    const state = { ...item.state };
    if (handled.size) state[STATE_KEY] = Object.fromEntries([...handled].map(saved => [saved, true]));
    else delete state[STATE_KEY];
    const reopen = !input.handled && (item.status === 'done' || item.status === 'dismissed');
    await tx.update(workItem).set({ state, updatedAt: new Date(), ...(reopen ? {
      status: 'needs_you', sentAt: null, sentMessageId: null, followUpDueAt: null,
    } : {}) }).where(eq(workItem.id, item.id));
    await tx.insert(workEvent).values({ workItemId: item.id, actorKind: 'user', actorUserId: input.userId, at: sql`clock_timestamp()`,
      type: 'request.handled', value: { key, runId: run.id, handled: input.handled } });
    if (reopen) await tx.insert(workEvent).values({ workItemId: item.id, actorKind: 'user', actorUserId: input.userId,
      type: 'status.changed', value: { from: item.status, to: 'needs_you', reason: 'request_reopened' } });
    return 'recorded';
  });
}

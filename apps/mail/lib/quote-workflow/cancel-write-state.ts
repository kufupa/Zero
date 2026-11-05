import { z } from 'zod';
import { getMailCacheScope, inMailbox, subscribeMailCacheScope } from '@/lib/mail/mail-cache-scope';

const sourceSchema = z.object({ threadId: z.string().min(1), messageId: z.string().min(1),
  sourceHash: z.string().regex(/^[a-f0-9]{64}$/) }).strict();
const cancelSelectionSchema = z.object({ workItemId: z.string().uuid(), source: sourceSchema,
  confirmation: z.string().regex(/^\d+-\d+$/), arrival: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  internetMessageId: z.string().trim().min(1) }).strict();
type MailOptions = NonNullable<ReturnType<typeof inMailbox>> & { signal: AbortSignal };
function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
export type CancelWriteSelection = z.infer<typeof cancelSelectionSchema>;
export type CancelWriteState =
  | { kind: 'empty' }
  | { kind: 'running'; runId: string }
  | { kind: 'done'; runId: string; outcome: 'cancelled' | 'cancel_unconfirmed' | 'cancel_penalty_pending'; notice?: string };

/** Read the existing write state only while the selected email and mailbox remain current. */
export function cancelWriteStateClientFromTrpc(trpc: unknown, input: CancelWriteSelection, scope: {
  transportId: string; signal: AbortSignal; isCurrent: () => boolean; onInvalidated: () => void;
}): { read(expectedRunId?: string): Promise<CancelWriteState>; dispose(): void } | null {
  const selection = cancelSelectionSchema.safeParse(input), initial = getMailCacheScope();
  if (!selection.success || !scope.transportId || !initial.userId || initial.activeTransportId !== scope.transportId ||
      scope.signal.aborted || !trpc || (typeof trpc !== 'object' && typeof trpc !== 'function')) return null;
  const query = (trpc as { hmsApproval?: { writeState?: { query?: (input: {
    workItemId: string; internetMessageId: string; selectedSource: CancelWriteSelection['source'];
    cancelSource: CancelWriteSelection['source'];
  }, options: MailOptions) => Promise<unknown> } } }).hmsApproval?.writeState?.query;
  if (typeof query !== 'function') return null;

  const selected = selection.data, userId = initial.userId;
  const mailbox = { ...inMailbox(scope.transportId)!, signal: scope.signal };
  let disposed = false, unsubscribe = () => {}, notify = () => {};
  const invalidated = new Promise<null>((resolve) => { notify = () => resolve(null); });
  const dispose = () => {
    if (disposed) return;
    disposed = true;
    unsubscribe();
    scope.signal.removeEventListener('abort', invalidate);
    notify();
  };
  const invalidate = () => {
    if (disposed) return;
    dispose();
    scope.onInvalidated();
  };
  const current = () => {
    if (disposed) return false;
    const active = getMailCacheScope();
    try {
      if (scope.signal.aborted || active.userId !== userId || active.activeTransportId !== scope.transportId || !scope.isCurrent()) invalidate();
    } catch { invalidate(); }
    return !disposed;
  };
  unsubscribe = subscribeMailCacheScope(current);
  scope.signal.addEventListener('abort', invalidate, { once: true });
  if (!current()) return null;

  return {
    dispose,
    async read(expectedRunId) {
      if (!current()) throw new Error('state_changed');
      const result = await Promise.race([query({ workItemId: selected.workItemId,
        internetMessageId: selected.internetMessageId, selectedSource: selected.source, cancelSource: selected.source }, mailbox), invalidated]);
      if (!current() || !isRecord(result) || !isRecord(result.form) || typeof result.needsCheck !== 'boolean') {
        throw new Error('state_changed');
      }
      if (result.run === null && !result.needsCheck && !expectedRunId) return { kind: 'empty' };
      // A completed non-cancel write is history; it never authorizes a cancellation.
      if (!expectedRunId && !result.needsCheck && !isRecord(result.form.cloudCancel) && isRecord(result.run) &&
          result.run.state === 'succeeded' && result.run.failureClass === null && result.run.lastError === null) {
        return { kind: 'empty' };
      }
      if (!isRecord(result.run) || !isRecord(result.grant) || !isRecord(result.form.cloudCancel) ||
          typeof result.run.runId !== 'string' || !result.run.runId || typeof result.run.state !== 'string' ||
          typeof result.grant.grantId !== 'string' || !result.grant.grantId || result.grant.fingerprintMatches !== true ||
          result.form.action !== 'cancel' || typeof result.form.confirmation !== 'string' ||
          !/^\d+-\d+$/.test(result.form.confirmation) || typeof result.form.arrival !== 'string' ||
          !/^\d{4}-\d{2}-\d{2}$/.test(result.form.arrival) ||
          (expectedRunId && result.run.runId !== expectedRunId)) {
        throw new Error('state_changed');
      }
      const run = result.run, runId = run.runId as string;
      const uncertain = result.needsCheck || ['UNKNOWN', 'NEEDS_CHECK', 'LEASE_LOST'].includes(run.failureClass as string) ||
          run.lastError === 'cancel_penalty_pending' || run.lastError === 'cancel_unconfirmed' ||
          run.lastError === 'cancel_dispatch_unresolved';
      if (result.form.confirmation !== selected.confirmation || result.form.arrival !== selected.arrival) {
        // A completed cancellation for another booking is history, not this booking's outcome.
        if (!expectedRunId && result.form.confirmation !== selected.confirmation && run.state === 'succeeded' && !uncertain &&
            run.failureClass === null && run.lastError === null) {
          return { kind: 'empty' };
        }
        throw new Error('state_changed');
      }
      if (uncertain) {
        return { kind: 'done', runId, outcome: run.lastError === 'cancel_penalty_pending'
          ? 'cancel_penalty_pending' : 'cancel_unconfirmed' };
      }
      if (run.state === 'succeeded') return { kind: 'done', runId, outcome: 'cancelled',
        ...(run.cancelNotice === 'Cancellation Penalty of 0.00 may be added to account.' ? { notice: run.cancelNotice } : {}) };
      if (['queued', 'claimed', 'running', 'retry_wait'].includes(run.state as string)) return { kind: 'running', runId };
      return { kind: 'done', runId, outcome: 'cancel_unconfirmed' };
    },
  };
}

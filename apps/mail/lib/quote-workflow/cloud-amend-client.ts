import { z } from 'zod';
import { getMailCacheScope, inMailbox, subscribeMailCacheScope } from '@/lib/mail/mail-cache-scope';
import type { HmsApprovalClient, HmsWriteView } from './hms-write';

const sourceSchema = z.object({ threadId: z.string().min(1), messageId: z.string().min(1),
  sourceHash: z.string().regex(/^[a-f0-9]{64}$/) }).strict();
const changesSchema = z.object({ arrival: z.string().optional(), departure: z.string().optional(),
  adults: z.number().int().optional(), children: z.number().int().optional(), childAges: z.array(z.number().int()).optional(),
  roomType: z.string().min(1).optional(), ratePlan: z.string().min(1), retainRates: z.enum(['yes', 'no']),
  firstName: z.string().optional(), lastName: z.string().optional(), guestEmail: z.string().optional(),
  bookerName: z.string().optional(), bookerContact: z.string().optional(), cmsSend: z.boolean(),
  cmsMessageId: z.string(), cmsRecipient: z.string() }).strict();

const requestSchema = z.object({ workItemId: z.string().uuid(), source: sourceSchema,
  confirmation: z.string().min(1), arrival: z.string().min(1), changes: changesSchema,
  draft: z.object({ requestId: z.string().regex(/^[a-f0-9]{64}$/), stayId: z.string().regex(/^[A-Za-z0-9_-]{1,40}$/),
    expectedSeq: z.number().int().nonnegative().safe() }).strict().optional() }).strict();
const boundSchema = z.object({ status: z.literal('bound'), previewDigest: z.string().regex(/^[a-f0-9]{64}$/),
  formDigest: z.string().regex(/^[a-f0-9]{64}$/), readAt: z.string().datetime() }).strict();
export type CloudAmendRequest = z.infer<typeof requestSchema>;
export type CloudAmendSelection = Pick<CloudAmendRequest, 'workItemId' | 'source'>;

type MailOptions = NonNullable<ReturnType<typeof inMailbox>> & { signal: AbortSignal };
type Routes = {
  cloudAmendReady: { query(input: undefined, options: MailOptions): Promise<unknown> };
  bindCloudAmend: { mutate(input: CloudAmendRequest, options: MailOptions): Promise<unknown> };
  cloudAmendState: { query(input: { workItemId: string; source: CloudAmendRequest['source'] }, options: MailOptions): Promise<unknown> };
  approveCloudAmend: { mutate(input: { workItemId: string; source: CloudAmendRequest['source']; formDigest: string }, options: MailOptions): Promise<unknown> };
  reviewCloudAmend: { mutate(input: { workItemId: string; source: CloudAmendRequest['source']; runId: string;
    decision: 'ok' | 'flag'; note?: string }, options: MailOptions): Promise<unknown> };
  cloudAmendEvidence: { query(input: { workItemId: string; source: CloudAmendRequest['source']; eventId: string }, options: MailOptions): Promise<unknown> };
};

export type CloudAmendClient = { dispose(): void; prepare(draft?: CloudAmendRequest['draft']): Promise<boolean>;
  approval: HmsApprovalClient; resumeKey: string | null };

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
/** Pins all preparation and review calls to one selected message and mailbox. */
export async function cloudAmendClientFromTrpc(trpc: unknown, input: CloudAmendRequest | CloudAmendSelection, scope: {
  transportId: string; signal: AbortSignal; isCurrent: () => boolean; resume?: boolean;
}): Promise<CloudAmendClient | null> {
  const request = requestSchema.safeParse(input), initial = getMailCacheScope();
  const selected = requestSchema.pick({ workItemId: true, source: true }).safeParse({
    workItemId: input.workItemId, source: input.source,
  });
  if (!selected.success || (!scope.resume && !request.success) || !scope.transportId || !initial.userId || initial.activeTransportId !== scope.transportId ||
      scope.signal.aborted || typeof scope.isCurrent !== 'function') return null;
  const userId = initial.userId, mailbox = { ...inMailbox(scope.transportId)!, signal: scope.signal };
  let disposed = false, notify = () => {}, unsubscribe = () => {};
  const invalidated = new Promise<null>((resolve) => { notify = () => resolve(null); });
  const dispose = () => {
    if (disposed) return;
    disposed = true;
    unsubscribe();
    scope.signal.removeEventListener('abort', dispose);
    notify();
  };
  const current = () => {
    if (disposed) return false;
    const active = getMailCacheScope();
    try {
      if (scope.signal.aborted || active.userId !== userId || active.activeTransportId !== scope.transportId || !scope.isCurrent()) dispose();
    } catch { dispose(); }
    return !disposed;
  };
  try {
    unsubscribe = subscribeMailCacheScope(current);
    scope.signal.addEventListener('abort', dispose, { once: true });
    if (!current() || !trpc || (typeof trpc !== 'object' && typeof trpc !== 'function')) { dispose(); return null; }
    const routes = (trpc as { hmsApproval?: Partial<Routes> }).hmsApproval;
    if (!routes || typeof routes.cloudAmendReady?.query !== 'function' || typeof routes.bindCloudAmend?.mutate !== 'function' ||
        typeof routes.cloudAmendState?.query !== 'function' || typeof routes.approveCloudAmend?.mutate !== 'function' ||
        typeof routes.reviewCloudAmend?.mutate !== 'function' || typeof routes.cloudAmendEvidence?.query !== 'function') {
      dispose(); return null;
    }
    const complete = routes as Routes;
    const call = async (fn: () => Promise<unknown>) => {
      if (!current()) throw new Error('state_changed');
      const result = await Promise.race([fn(), invalidated]);
      if (result === null || !current()) throw new Error('state_changed');
      return result;
    };
    let data: CloudAmendRequest, digest: string | null = null, resumeKey: string | null = null;
    if (scope.resume) {
      // Resume is a source-scoped read, so it remains available even if the
      // write flag has since been turned off. Never invent choices from HMS.
      const state = await call(() => complete.cloudAmendState.query(selected.data, mailbox));
      if (!isRecord(state) || !isRecord(state.run) || typeof state.run.runId !== 'string' || !state.run.runId || !isRecord(state.form) ||
          !isRecord(state.form.cloudAmend) || state.form.cloudAmend.bound !== true ||
          typeof state.formDigest !== 'string' || !/^[a-f0-9]{64}$/.test(state.formDigest)) { dispose(); return null; }
      const restored = requestSchema.safeParse({ ...selected.data, confirmation: state.form.confirmation,
        arrival: state.form.arrival, changes: state.form.fields });
      if (!restored.success) { dispose(); return null; }
      data = restored.data;
      digest = state.formDigest;
      resumeKey = JSON.stringify([digest, state.run.runId]);
    } else {
      const ready = await call(() => complete.cloudAmendReady.query(undefined, mailbox));
      if (!isRecord(ready) || ready.ready !== true || !request.success) { dispose(); return null; }
      data = request.data;
    }
    let goUsed = Boolean(scope.resume), generation = 0;
    const prepare = async (draft?: CloudAmendRequest['draft']) => {
      const attempt = ++generation;
      digest = null;
      goUsed = true;
      if (draft) data = { ...data, draft };
      const response = boundSchema.safeParse(await call(() => complete.bindCloudAmend.mutate(data, mailbox)));
      if (!response.success || attempt !== generation) return null;
      digest = response.data.formDigest;
      goUsed = false;
      return response.data;
    };
    const validItem = (itemId: string) => itemId === data.workItemId && current();
    const approval: HmsApprovalClient = {
      async writeState({ workItemId }) {
        if (!validItem(workItemId) || !digest) throw new Error('state_changed');
        const result = await call(() => complete.cloudAmendState.query({ workItemId, source: data.source }, mailbox));
        if (!isRecord(result) || result.formDigest !== digest || !isRecord(result.form) ||
            result.form.action !== 'amend' || result.form.confirmation !== data.confirmation ||
            result.form.arrival !== data.arrival || !isRecord(result.form.cloudAmend) || result.form.cloudAmend.bound !== true) {
          throw new Error('state_changed');
        }
        // Bind returns the digest of the exact submitted fields. The public form
        // is card-masked, so comparing its text with raw input would reject it.
        return result as HmsWriteView;
      },
      async approve({ workItemId, formDigest }) {
        if (!validItem(workItemId) || !digest || formDigest !== digest || goUsed) throw new Error('state_changed');
        goUsed = true; // A lost response is not permission to submit the same Go again.
        return await call(() => complete.approveCloudAmend.mutate({ workItemId, source: data.source, formDigest }, mailbox)) as Awaited<ReturnType<HmsApprovalClient['approve']>>;
      },
      async review(input) {
        if (!validItem(input.workItemId) || !digest) throw new Error('state_changed');
        return await call(() => complete.reviewCloudAmend.mutate({ ...input, source: data.source }, mailbox)) as Awaited<ReturnType<HmsApprovalClient['review']>>;
      },
      async resolveNeedsCheck() { throw new Error('amend_reconciliation_required'); },
      async reread({ workItemId }) {
        if (!validItem(workItemId)) throw new Error('state_changed');
        if (scope.resume) return { status: 'refused', reason: 'amend_refresh_required' };
        const refreshed = await prepare();
        return refreshed ? { status: 'stored', readAt: refreshed.readAt }
          : { status: 'refused', reason: 'amend_refresh_required' };
      },
      async evidence({ workItemId, eventId }) {
        if (!validItem(workItemId) || !digest) throw new Error('state_changed');
        return await call(() => complete.cloudAmendEvidence.query({ workItemId, source: data.source, eventId }, mailbox)) as Awaited<ReturnType<HmsApprovalClient['evidence']>>;
      },
    };
    return { dispose, async prepare(draft) { try { return Boolean(await prepare(draft)); } catch { return false; } }, approval, resumeKey };
  } catch { dispose(); return null; }
}

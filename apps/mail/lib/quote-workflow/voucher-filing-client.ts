import { z } from 'zod';
import { getMailCacheScope, inMailbox, subscribeMailCacheScope } from '@/lib/mail/mail-cache-scope';

const id = z.string().min(1).max(200);
const selectionSchema = z.object({
  workItemId: id, messageId: id, attachmentId: id,
  expectedSessionId: id.nullable().optional(),
  kind: z.enum(['voucher', 'proof_of_payment']),
  stay: z.object({ confirmation: id, arrival: z.string().date(), lastName: z.string().trim().min(1).max(200) }).strict(),
}).strict();
const preparedSchema = z.object({
  status: z.literal('prepared'), workItemId: id, messageId: id, attachmentId: id,
  expectedSessionId: id.nullable(), kind: z.enum(['voucher', 'proof_of_payment']),
  filename: z.string().min(1).max(150),
  stay: z.object({ confirmation: id, arrival: z.string().date(), firstName: z.string().min(1).max(200),
    lastName: z.string().min(1).max(200) }).strict(),
  formDigest: z.string().regex(/^[a-f0-9]{64}$/),
}).strict();
const queuedSchema = z.object({ status: z.literal('queued'), operationId: id }).strict();
const readinessSchema = z.object({ status: z.literal('ready'), capability: z.literal('voucher-filing/v1'),
  messageId: id, transportId: id }).strict();

export type FilingSelection = z.infer<typeof selectionSchema>;
export type FilingPrepared = Readonly<Omit<z.infer<typeof preparedSchema>, 'stay'> & {
  stay: Readonly<z.infer<typeof preparedSchema>['stay']>;
}>;
type MailboxOptions = NonNullable<ReturnType<typeof inMailbox>> & { signal: AbortSignal };
type Routes = { readiness: { query(input: { messageId: string }, options: MailboxOptions): Promise<unknown> };
  prepare: { mutate(input: FilingSelection, options: MailboxOptions): Promise<unknown> };
  go: { mutate(input: { workItemId: string; messageId: string; formDigest: string; expectedSessionId: string | null }, options: MailboxOptions): Promise<unknown> } };
export type FilingPrepareClient = {
  /** The pane must dispose this client when its selection or component lifetime ends. */
  dispose(): void;
  prepare(input: FilingSelection): Promise<{ status: 'prepared'; value: FilingPrepared } | { status: 'unavailable' }>;
  go(prepared: FilingPrepared): Promise<{ status: 'queued'; operationId: string } | { status: 'needs_check' }>;
};

/** isCurrent tracks the selection epoch; signal must abort when the selection or pane lifetime ends. */
export type FilingClientScope = { transportId: string; messageId: string; isCurrent: () => boolean; signal: AbortSignal };

/**
 * The authenticated server must advertise readiness only when filing routes and policy are ready.
 * It must derive message and transport scope from authorized stored rows, not echo client input.
 * Readiness is not write authority: the server must authorize and fence every mutation separately.
 */
export async function filingPrepareClientFromTrpc(trpc: unknown, selection: FilingClientScope): Promise<FilingPrepareClient | null> {
  if (!selection || !id.safeParse(selection.transportId).success || !id.safeParse(selection.messageId).success ||
      typeof selection.isCurrent !== 'function' || !selection.signal ||
      typeof selection.signal.addEventListener !== 'function' || typeof selection.signal.removeEventListener !== 'function' ||
      selection.signal.aborted) return null;
  const { transportId, messageId, isCurrent, signal } = selection;
  const scope = getMailCacheScope();
  if (!scope.userId || scope.activeTransportId !== transportId) return null;
  const userId = scope.userId;
  let invalidated = false;
  let notifyInvalidated = () => {};
  const invalidation = new Promise<null>((resolve) => { notifyInvalidated = () => resolve(null); });
  let unsubscribe = () => {};
  const dispose = () => {
    if (invalidated) return;
    invalidated = true;
    unsubscribe();
    signal.removeEventListener('abort', dispose);
    notifyInvalidated();
  };
  // Subscribe before the first await so A→B→A cannot revive an old preparation.
  try {
    unsubscribe = subscribeMailCacheScope(() => {
      const current = getMailCacheScope();
      if (current.userId !== userId || current.activeTransportId !== transportId) dispose();
    });
    signal.addEventListener('abort', dispose, { once: true });
  } catch { dispose(); return null; }
  const currentScope = () => {
    if (invalidated) return false;
    const current = getMailCacheScope();
    try {
      if (signal.aborted || current.userId !== userId || current.activeTransportId !== transportId || isCurrent() !== true) dispose();
    } catch { dispose(); }
    return !invalidated;
  };
  const unavailable = () => { dispose(); return null; };
  if (!currentScope()) return unavailable();
  const mailbox = { ...inMailbox(transportId)!, signal };
  let prepare: Routes['prepare'], go: Routes['go'];
  try {
    if (!trpc || (typeof trpc !== 'object' && typeof trpc !== 'function')) return unavailable();
    const routes = (trpc as { voucherFiling?: Partial<Routes> }).voucherFiling;
    if (typeof routes?.readiness?.query !== 'function' || typeof routes.prepare?.mutate !== 'function' ||
        typeof routes.go?.mutate !== 'function') return unavailable();
    const readiness = readinessSchema.safeParse(await Promise.race([routes.readiness.query({ messageId }, mailbox), invalidation]));
    if (!readiness.success || readiness.data.messageId !== messageId ||
        readiness.data.transportId !== transportId || !currentScope()) return unavailable();
    prepare = routes.prepare;
    go = routes.go;
  } catch { return unavailable(); }
  // Local latch improves UX only. The server still owns approval, fencing and single dispatch.
  const issued = new WeakMap<object, { workItemId: string; messageId: string; formDigest: string; expectedSessionId: string | null; used: boolean }>();
  return {
    dispose,
    async prepare(input) {
      const selected = selectionSchema.safeParse(input);
      if (!selected.success || selected.data.messageId !== messageId || !currentScope()) return { status: 'unavailable' };
      try {
        const parsed = preparedSchema.safeParse(await Promise.race([prepare.mutate(selected.data, mailbox), invalidation]));
        if (!parsed.success || !currentScope()) return { status: 'unavailable' };
        const view = parsed.data, choice = selected.data;
        if (view.workItemId !== choice.workItemId || view.messageId !== choice.messageId ||
            view.attachmentId !== choice.attachmentId || view.kind !== choice.kind ||
            view.expectedSessionId !== (choice.expectedSessionId ?? null) ||
            view.stay.confirmation !== choice.stay.confirmation || view.stay.arrival !== choice.stay.arrival ||
            view.stay.lastName.trim().toLocaleLowerCase('en') !== choice.stay.lastName.toLocaleLowerCase('en')) {
          return { status: 'unavailable' };
        }
        const value = Object.freeze({ ...view, stay: Object.freeze({ ...view.stay }) });
        issued.set(value, { workItemId: view.workItemId, messageId: view.messageId, formDigest: view.formDigest,
          expectedSessionId: view.expectedSessionId, used: false });
        return { status: 'prepared', value };
      } catch { return { status: 'unavailable' }; }
    },
    async go(value) {
      const token = value && typeof value === 'object' ? issued.get(value) : undefined;
      if (!token || token.used || !currentScope()) return { status: 'needs_check' };
      token.used = true;
      try {
        const parsed = queuedSchema.safeParse(await Promise.race([go.mutate({ workItemId: token.workItemId,
          messageId: token.messageId, formDigest: token.formDigest, expectedSessionId: token.expectedSessionId }, mailbox), invalidation]));
        return parsed.success && currentScope() ? parsed.data : { status: 'needs_check' };
      } catch { return { status: 'needs_check' }; }
    },
  };
}

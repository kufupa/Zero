import { z } from 'zod';
import { getMailCacheScope, inMailbox } from '@/lib/mail/mail-cache-scope';

const id = z.string().min(1).max(200);
const selectionSchema = z.object({
  workItemId: id, messageId: id, attachmentId: id,
  expectedSessionId: id.nullable().optional(),
  kind: z.enum(['voucher', 'proof_of_payment']),
  stay: z.object({ confirmation: id, arrival: z.string().date(), lastName: z.string().trim().min(1).max(100) }).strict(),
}).strict();
const preparedSchema = z.object({
  status: z.literal('prepared'), workItemId: id, messageId: id, attachmentId: id,
  expectedSessionId: id.nullable(), kind: z.enum(['voucher', 'proof_of_payment']),
  filename: z.string().min(1).max(150),
  stay: z.object({ confirmation: id, arrival: z.string().date(), firstName: z.string().min(1).max(100),
    lastName: z.string().min(1).max(100) }).strict(),
  formDigest: z.string().regex(/^[a-f0-9]{64}$/),
}).strict();
const queuedSchema = z.object({ status: z.literal('queued'), operationId: id }).strict();
const readinessSchema = z.object({ status: z.literal('ready'), capability: z.literal('voucher-filing/v1'),
  messageId: id, transportId: id }).strict();

export type FilingSelection = z.infer<typeof selectionSchema>;
export type FilingPrepared = Readonly<Omit<z.infer<typeof preparedSchema>, 'stay'> & {
  stay: Readonly<z.infer<typeof preparedSchema>['stay']>;
}>;
type MailboxOptions = ReturnType<typeof inMailbox>;
type Routes = { readiness: { query(input: { messageId: string }, options: MailboxOptions): Promise<unknown> };
  prepare: { mutate(input: FilingSelection, options: MailboxOptions): Promise<unknown> };
  go: { mutate(input: { workItemId: string; messageId: string; formDigest: string; expectedSessionId: string | null }, options: MailboxOptions): Promise<unknown> } };
export type FilingPrepareClient = {
  prepare(input: FilingSelection): Promise<{ status: 'prepared'; value: FilingPrepared } | { status: 'unavailable' }>;
  go(prepared: FilingPrepared): Promise<{ status: 'queued'; operationId: string } | { status: 'needs_check' }>;
};

/** isCurrent must track the selection epoch and stay false after a selection changes. */
export type FilingClientScope = { transportId: string; messageId: string; isCurrent: () => boolean };

/**
 * The authenticated server must advertise readiness only when filing routes and policy are ready.
 * It must derive message and transport scope from authorized stored rows, not echo client input.
 * Readiness is not write authority: the server must authorize and fence every mutation separately.
 */
export async function filingPrepareClientFromTrpc(trpc: unknown, selection: FilingClientScope): Promise<FilingPrepareClient | null> {
  if (!selection || !id.safeParse(selection.transportId).success || !id.safeParse(selection.messageId).success ||
      typeof selection.isCurrent !== 'function') return null;
  const { transportId, messageId, isCurrent } = selection;
  const scope = getMailCacheScope();
  if (!scope.userId || scope.activeTransportId !== transportId) return null;
  let invalidated = false;
  const currentScope = () => {
    if (invalidated) return false;
    const current = getMailCacheScope();
    try { invalidated = current.userId !== scope.userId || current.activeTransportId !== transportId || isCurrent() !== true; }
    catch { invalidated = true; }
    return !invalidated;
  };
  if (!currentScope()) return null;
  const mailbox = inMailbox(transportId);
  if (!trpc || (typeof trpc !== 'object' && typeof trpc !== 'function')) return null;
  const routes = (trpc as { voucherFiling?: Partial<Routes> }).voucherFiling;
  if (typeof routes?.readiness?.query !== 'function' || typeof routes.prepare?.mutate !== 'function' ||
      typeof routes.go?.mutate !== 'function') return null;
  try {
    const readiness = readinessSchema.safeParse(await routes.readiness.query({ messageId }, mailbox));
    if (!readiness.success || readiness.data.messageId !== messageId ||
        readiness.data.transportId !== transportId || !currentScope()) return null;
  } catch { return null; }
  const prepare = routes.prepare, go = routes.go;
  // Local latch improves UX only. The server still owns approval, fencing and single dispatch.
  const issued = new WeakMap<object, { workItemId: string; messageId: string; formDigest: string; expectedSessionId: string | null; used: boolean }>();
  return {
    async prepare(input) {
      const selected = selectionSchema.safeParse(input);
      if (!selected.success || selected.data.messageId !== messageId || !currentScope()) return { status: 'unavailable' };
      try {
        const parsed = preparedSchema.safeParse(await prepare.mutate(selected.data, mailbox));
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
        const parsed = queuedSchema.safeParse(await go.mutate({ workItemId: token.workItemId,
          messageId: token.messageId, formDigest: token.formDigest, expectedSessionId: token.expectedSessionId }, mailbox));
        return parsed.success && currentScope() ? parsed.data : { status: 'needs_check' };
      } catch { return { status: 'needs_check' }; }
    },
  };
}

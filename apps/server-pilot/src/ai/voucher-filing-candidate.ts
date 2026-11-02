import { z } from 'zod';
import { voucherFilingFormSchema, type VoucherFilingForm } from './voucher-filing-contract.js';

const selectionSchema = z.object({
  workItemId: z.string().min(1).max(200),
  messageId: z.string().min(1).max(200),
  attachmentId: z.string().min(1).max(200),
  expectedSessionId: z.string().min(1).max(200).nullable().optional(),
  kind: z.enum(['voucher', 'proof_of_payment']),
  stay: z.object({
    confirmation: z.string().min(1).max(200),
    arrival: z.string().min(1).max(20),
    lastName: z.string().trim().min(1).max(100),
  }).strict(),
}).strict();

/** The pane supplies only a selection. Mailbox, property, bytes and guest identity come from trusted readers. */
export type VoucherFilingSelection = z.infer<typeof selectionSchema>;
type Source = VoucherFilingForm['payload']['source'];
type Stay = VoucherFilingForm['payload']['stay'];

type CandidateInput = {
  selection: unknown;
  /** Server-resolved work-item scope, never an untrusted pane field. */
  scope: { transportId: string; workItemId: string; messageId: string; propertyCode: string };
  /** Server-resolved attachment and stay, not display data from the pane. */
  source: Source;
  stay: Stay;
};

type CandidateResult =
  | { status: 'candidate'; form: VoucherFilingForm; expectedSessionId: string | null }
  | { status: 'refused'; reason: 'selection_invalid' | 'scope_mismatch' | 'source_mismatch' | 'stay_mismatch' | 'form_invalid' };

/**
 * Build a candidate only. This is not Prepare, a snapshot, approval, or authority to dispatch.
 * A separate atomic binder must authenticate and revalidate the mailbox/work item/source and
 * attach a complete, fresh HMS snapshot before staff can approve the displayed form digest.
 * The binder must also enforce the exact expected session under its lock.
 */
export function buildVoucherFilingCandidate(input: CandidateInput): CandidateResult {
  const selection = selectionSchema.safeParse(input.selection);
  if (!selection.success) return { status: 'refused', reason: 'selection_invalid' };
  const selected = selection.data;
  if (!input.scope.transportId || !input.scope.propertyCode || selected.workItemId !== input.scope.workItemId ||
      selected.messageId !== input.scope.messageId) return { status: 'refused', reason: 'scope_mismatch' };
  const form = voucherFilingFormSchema.safeParse({ executor: 'cloud-write/v1', action: 'attach_document',
    propertyCode: input.scope.propertyCode, payload: { source: input.source, stay: input.stay, kind: selected.kind } });
  if (!form.success || !/\.pdf$/i.test(form.data.payload.source.filename)) return { status: 'refused', reason: 'form_invalid' };
  const source = form.data.payload.source, stay = form.data.payload.stay;
  if (source.transportId !== input.scope.transportId || source.messageId !== input.scope.messageId ||
      source.attachmentId !== selected.attachmentId) return { status: 'refused', reason: 'source_mismatch' };
  if (stay.confirmation !== selected.stay.confirmation || stay.arrival !== selected.stay.arrival ||
      stay.lastName.toLocaleLowerCase('en') !== selected.stay.lastName.toLocaleLowerCase('en')) {
    return { status: 'refused', reason: 'stay_mismatch' };
  }
  return { status: 'candidate', form: form.data, expectedSessionId: selected.expectedSessionId ?? null };
}

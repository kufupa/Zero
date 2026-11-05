import { createHash } from 'node:crypto';
import { amendRequestId, validAmendRequestValue, type DraftSource } from './pane-amend-draft.js';
import type { MailExtractionPayload, MailKind } from './extraction/schema.js';

export type CancelField = 'target' | 'cancel.reason' | 'cancel.note';

export function parseCancelRequestField(path: string): { requestId: string; field: CancelField } | null {
  const match = /^requests\[([a-f0-9]{64})\]\.(target|cancel\.reason|cancel\.note)$/.exec(path);
  return match ? { requestId: match[1]!, field: match[2] as CancelField } : null;
}

export function validCancelRequestValue(field: CancelField, value: unknown): boolean {
  if (field === 'target') return validAmendRequestValue('target', value);
  if (value === null) return true;
  return typeof value === 'string' && value.length <= (field === 'cancel.reason' ? 120 : 200) &&
    !/[\p{Cc}]/u.test(value) && (field !== 'cancel.reason' || (value.trim().length > 0 && !value.startsWith('-')));
}

/** Only an unambiguous, source-backed cancellation can be prepared. */
export function projectCancelRequests(source: DraftSource, payload: MailExtractionPayload, state: Record<string, unknown>,
  ownerAction: unknown, kind: MailKind) {
  const meta: Record<string, { origin: 'staff' | 'email' | 'missing'; attributedTo: null;
    evidence: { messageId: string; excerpt: string } | null }> = {};
  const requests = payload.stays.flatMap((stay) => {
    const original = stay.action ?? (payload.stays.length === 1 ? payload.action ?? (kind === 'cancellation' ? 'cancel' : null) : null);
    const owner = payload.stays.length === 1 && typeof ownerAction === 'string' ? ownerAction : null;
    if ((owner ?? original) !== 'cancel' || (owner !== null && owner !== original) ||
        state[`stays[${stay.id}].removed`] === true ||
        (stay.rows.length > 0 && stay.rows.every((row) => state[`stays[${stay.id}].rows[${row.id}].removed`] === true))) return [];
    const requestId = amendRequestId(source, stay.id);
    const confirmations = [...new Set((stay.guests ?? []).flatMap((guest) => guest.confirmationNumber ? [guest.confirmationNumber] : []))];
    const confirmation = confirmations.length === 1 ? confirmations[0] : confirmations.length === 0 &&
      payload.stays.length === 1 && payload.confirmationNumbers.length === 1 ? payload.confirmationNumbers[0] : null;
    const path = `requests[${requestId}].target`;
    const target = Object.hasOwn(state, path) ? state[path] :
      confirmation && stay.booked?.arrival ? { confirmation, arrival: stay.booked.arrival } : null;
    meta[path] = { origin: Object.hasOwn(state, path) ? 'staff' : target ? 'email' : 'missing', attributedTo: null, evidence: null };
    const value = (field: CancelField) => {
      const key = `requests[${requestId}].${field}`;
      const edited = Object.hasOwn(state, key);
      const proposal = field === 'cancel.note' ? stay.workflowProposal?.cancelNote : undefined;
      meta[key] = { origin: edited ? 'staff' : proposal ? 'email' : 'missing', attributedTo: null,
        evidence: proposal ? { messageId: source.messageId, excerpt: proposal.excerpt } : null };
      return edited ? state[key] : proposal?.value ?? null;
    };
    const fields = { kind: 'cancel' as const, value: { target, reason: value('cancel.reason'),
      cancellationNote: value('cancel.note'), feeDecision: null } };
    const proposalDigest = createHash('sha256').update(JSON.stringify({ action: 'cancel', fields })).digest('hex');
    return [{ requestId, stayId: stay.id, slot: 'primary', action: 'cancel' as const, workflow: 'cancel' as const,
      status: 'pending' as const, proposalDigest, fields, issues: [], operations: [] }];
  });
  return { requests, meta };
}

import { randomUUID } from 'node:crypto';
import type { z } from 'zod';
import { acquisitionWithin, isPropertyReadLockDeadline, PANE_PROPERTY_LOCK_WAIT_MS } from '../hms/property-read-lock.js';
import { paneStayCreateTarget, paneStayPropertyLock } from './pane-stay-save.js';
import type { ReservationWorkflowV2Draft, reservationWorkflowV2SelectNativeInputSchema } from './reservation-workflow-v2-contract.js';
import { appendReservationWorkflowV2Observation, getReservationWorkflowV2Draft,
  markReservationWorkflowV2NativeActivity, type ReservationWorkflowV2Context } from './reservation-workflow-v2-state.js';
import { effectiveSubtree } from './reservation-workflow-v2-tools.js';
import { verifyNativeLead, type NativeLeadKind } from './reservation-workflow-v2-native-lead.js';

type Input = z.infer<typeof reservationWorkflowV2SelectNativeInputSchema>;
const rec = (value: unknown): Record<string, unknown> =>
  value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
const norm = (value: unknown): string => typeof value === 'string'
  ? value.normalize('NFKC').trim().replace(/\s+/gu, ' ').toLocaleLowerCase() : '';

/** Resolve only a single current field-bound lead, never a client-supplied native ID. */
function currentLead(draft: ReservationWorkflowV2Draft, input: Input) {
  const lead = draft.observations.find((row) => row.ref === input.observationRef);
  const request = draft.proposal.content.requests.find((row) => row.id === input.requestId);
  if (!lead || !request || !['guest_candidate', 'party_candidate'].includes(lead.kind) ||
      lead.status !== 'partial' || lead.coverage.complete || lead.generationId !== draft.generationId ||
      lead.propertyCode !== draft.propertyCode || lead.sourceMessageId !== draft.source.messageId ||
      lead.criteria.requestId !== request.id || lead.criteria.workflow !== request.kind ||
      !(lead.criteria.fieldPath === input.fieldPath ||
        (Array.isArray(lead.criteria.fieldPaths) && lead.criteria.fieldPaths.includes(input.fieldPath)))) return null;
  const rows = Array.isArray(lead.result.candidates) ? lead.result.candidates : [lead.result];
  if (rows.length !== 1) return null;
  const candidate = rec(rows[0]), nativeId = candidate.nativeId;
  if (typeof nativeId !== 'string' || !/^\d{1,30}$/.test(nativeId)) return null;
  const root = `/proposal/content/requests/${encodeURIComponent(request.id)}/body`;
  if (!input.fieldPath.startsWith(`${root}/`)) return null;
  const tail = input.fieldPath.slice(root.length), body = rec(effectiveSubtree(draft, request.body, root));
  const allocations = Array.isArray(body.allocations) ? body.allocations.map(rec) : [];
  if (request.kind === 'create' && lead.kind === 'guest_candidate') {
    const match = tail.match(/^\/allocations\/(\d+)\/guest\/nativeSelectionRef$/);
    const allocation = match ? allocations[Number(match[1])] : null, guest = rec(allocation?.guest), query = rec(lead.criteria.query);
    if (!allocation || lead.criteria.allocationId !== allocation.id || guest.profileIntent !== 'existing_or_unknown' ||
        query.field !== 'lastName' || !norm(query.value) || norm(query.value) !== norm(guest.lastName) ||
        norm(query.firstName) !== norm(guest.firstName) || norm(query.email) !== norm(guest.email)) return null;
    return { lead, nativeId, kind: 'guest' as const, name: undefined };
  }
  if (lead.kind !== 'party_candidate') return null;
  let role: string | undefined, kind: NativeLeadKind | undefined, party: Record<string, unknown> = {};
  if (request.kind === 'quote') {
    const match = tail.match(/^\/parties\/(company|agency)\/nativeSelectionRef$/);
    role = match?.[1];
    kind = role === 'company' ? 'organization' : role === 'agency' ? 'agency' : undefined;
    party = rec(rec(body.parties)[role ?? '']);
  } else if (request.kind === 'create') {
    const match = tail.match(/^\/(shared|dateSections\/\d+\/defaults|allocations\/\d+\/overrides)\/(bookingAgency|organization|arAccount)\/nativeSelectionRef$/);
    if (!match) return null;
    role = ({ bookingAgency: 'agency', organization: 'organization', arAccount: 'ar_account' } as const)[match[2] as 'bookingAgency' | 'organization' | 'arAccount'];
    kind = role as NativeLeadKind;
    const parts = match[1]!.split('/');
    let owner: Record<string, unknown>;
    if (parts[0] === 'shared') {
      if (!allocations.some((row) => row.id === lead.criteria.allocationId)) return null;
      owner = rec(body.shared);
    } else if (parts[0] === 'allocations') {
      const allocation = allocations[Number(parts[1])];
      if (!allocation || allocation.id !== lead.criteria.allocationId) return null;
      owner = rec(allocation.overrides);
    } else {
      const sections = Array.isArray(body.dateSections) ? body.dateSections.map(rec) : [];
      const section = sections[Number(parts[1])];
      if (!section || !allocations.some((row) => row.id === lead.criteria.allocationId && row.dateSectionId === section.id)) return null;
      owner = rec(section.defaults);
    }
    party = rec(owner[match[2]!]);
  }
  const query = typeof lead.criteria.query === 'string' ? lead.criteria.query : lead.criteria.searchName;
  if (!role || !kind || lead.criteria.role !== role || !norm(query) || norm(query) !== norm(party.name) ||
      typeof candidate.name !== 'string' || !candidate.name.trim()) return null;
  return { lead, nativeId, kind, name: candidate.name.trim() };
}

/** Staff verifies a lead; selecting the resulting observation is a separate action. */
export async function reservationWorkflowV2VerifyLead(ctx: ReservationWorkflowV2Context, input: Input, signal: AbortSignal) {
  if (signal.aborted) return { status: 'stale_revision' as const };
  const current = await getReservationWorkflowV2Draft(ctx, input);
  if (current.status !== 'ok') return current;
  if (current.revision !== input.expectedRevision || current.seq !== input.expectedSeq) return { status: 'stale_revision' as const };
  if (!currentLead(current.draft, input)) return { status: 'invalid_value' as const, issue: 'native_lead_not_current' };
  const marked = await markReservationWorkflowV2NativeActivity(ctx, input);
  if (marked.status !== 'ok') return marked;
  const resolved = currentLead(marked.draft, input);
  if (!resolved || signal.aborted) return { status: 'stale_revision' as const };
  const target = paneStayCreateTarget({ transportId: ctx.transportId, propertyCode: ctx.propertyCode });
  if (!target.ok || target.target.propertyCode !== 'HRCEN') return { status: 'wrong_property' as const };
  const lock = paneStayPropertyLock(target.target);
  if (!lock) return { status: 'unavailable' as const, issue: 'property_lock_unavailable' };
  let verified;
  try {
    verified = await lock.withLock(() => verifyNativeLead({ kind: resolved.kind, nativeId: resolved.nativeId,
      name: resolved.name, target: target.target, signal }), { ...acquisitionWithin(PANE_PROPERTY_LOCK_WAIT_MS), signal });
  } catch (error) {
    return { status: signal.aborted ? 'stale_revision' as const : 'unavailable' as const,
      issue: signal.aborted ? 'native_verification_cancelled' : isPropertyReadLockDeadline(error) ? 'property_lock_busy' : 'native_verification_failed' };
  }
  if (signal.aborted) return { status: 'stale_revision' as const };
  const row = rec(verified.match);
  if (verified.outcome !== 'matched' || verified.rowVerification.status !== 'verified' ||
      verified.coverage.closeOutcome !== 'closed_unsaved' || row.nativeId !== resolved.nativeId) {
    return { status: 'needs_input' as const, issue: verified.issue ?? verified.outcome,
      verification: { outcome: verified.outcome, coverage: verified.coverage } };
  }
  const observation = { ref: randomUUID(), generationId: marked.draft.generationId, kind: resolved.lead.kind,
    status: 'complete' as const, observedAt: new Date().toISOString(), propertyCode: marked.draft.propertyCode,
    sourceMessageId: marked.draft.source.messageId, sourceRefs: [resolved.lead.ref],
    criteria: { ...resolved.lead.criteria, kind: 'verified_native_row', fieldPath: input.fieldPath,
      fieldPaths: [input.fieldPath], leadObservationRef: resolved.lead.ref },
    coverage: { complete: true, notes: [] },
    result: { ...row, outcome: 'matched', rowVerification: verified.rowVerification, searchCoverage: verified.coverage } };
  return appendReservationWorkflowV2Observation(ctx, { workItemId: input.workItemId, source: input.source, observation,
    fence: { expectedRevision: input.expectedRevision, expectedSeq: input.expectedSeq,
      generationId: marked.draft.generationId, signal } });
}

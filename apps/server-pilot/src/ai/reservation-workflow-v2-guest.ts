import { createHash, randomUUID } from 'node:crypto';
import { z } from 'zod';
import { canonicalJson } from './draft-approval.js';
import { effectiveWorkflowPolicy } from '../../tooling/hms-cloud/hms-workflow-policy.mjs';
import { bindHmsMailboxProperty, guardCenturionHmsMailboxOrigin, loadThreadMailboxHmsOriginScan }
  from '../hms/mailbox-hms-origin-bind.js';
import { getPropertyRegistration } from '../../tooling/hms-cloud/property-registry.mjs';
import { hmsGuestProfileTargetKeys } from './hms-dispatch-target.js';
import { acquisitionWithin, createPostgresTargetAliasLock, PANE_PROPERTY_LOCK_WAIT_MS } from '../hms/property-read-lock.js';
import { effectiveSubtree, reviewed, type ReservationWorkflowV2ServerContext } from './reservation-workflow-v2-tools.js';
import {
  appendReservationWorkflowV2Observation, claimReservationWorkflowV2GuestProfile,
  dispatchReservationWorkflowV2GuestProfile, finishReservationWorkflowV2GuestProfile, getReservationWorkflowV2Draft,
} from './reservation-workflow-v2-state.js';
import type { ReservationWorkflowV2Draft, ReservationWorkflowV2Observation,
  reservationWorkflowV2GuestPrepareInputSchema, reservationWorkflowV2GuestCreateInputSchema } from './reservation-workflow-v2-contract.js';

type PrepareInput = z.infer<typeof reservationWorkflowV2GuestPrepareInputSchema>;
type CreateInput = z.infer<typeof reservationWorkflowV2GuestCreateInputSchema>;
export type ReservationWorkflowV2GuestNativeResult = { outcome?: string; issue?: string; nativeId?: string | null; dispatched?: boolean | null;
  previewDigest?: string; review?: unknown; businessFields?: unknown; readback?: Record<string, unknown>;
  reconciliation?: ReservationWorkflowV2GuestNativeResult; [key: string]: unknown };
export function guestProfileDefinitelyNotDispatched(native: ReservationWorkflowV2GuestNativeResult): boolean {
  return ['not_dispatched', 'review_required', 'needs_input', 'unsupported', 'unavailable'].includes(native.outcome ?? '') &&
    native.dispatched === false && native.noDispatchRecorded === true && !native.nativeId &&
    native.issue !== 'PROFILE_INTENT_HELD' && native.issue !== 'PROFILE_ATTEMPT_CHANGED';
}
type Runner = { prepareGuestProfile: (input: Record<string, unknown>) => Promise<ReservationWorkflowV2GuestNativeResult>;
  createGuestProfile: (input: Record<string, unknown>) => Promise<ReservationWorkflowV2GuestNativeResult>;
  inspectGuestProfileAttempt: (input: Record<string, unknown>) => Promise<ReservationWorkflowV2GuestNativeResult>;
  readGuestProfile: (input: Record<string, unknown>) => Promise<ReservationWorkflowV2GuestNativeResult>;
  listGuestProfileCreationOptions: (input: Record<string, unknown>) => Promise<ReservationWorkflowV2GuestNativeResult> };
const stateContext = (ctx: ReservationWorkflowV2ServerContext) => ({ db: ctx.db, transportId: ctx.transport.id,
  userId: ctx.user.id, propertyCode: ctx.property.propertyCode, recovery: ctx.recovery,
  writeRunFence: ctx.writeRunFence, signal: ctx.signal });
const text = (value: unknown) => typeof value === 'string' && value.trim() ? value.trim() : null;
const record = (value: unknown): Record<string, any> | null =>
  value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, any> : null;
const digest = (value: unknown) => createHash('sha256').update(canonicalJson(value)).digest('hex');
const fields = ['firstName', 'lastName', 'mobile', 'email', 'titleCode', 'phoneNumber', 'phoneTypeCode', 'emailTypeCode'] as const;

async function runner(options: Record<string, unknown> = {}): Promise<Runner> {
  const module = await import(new URL('../../tooling/hms-cloud/guest-profile-runner.mjs', import.meta.url).href) as {
    createGuestProfileRunner: (options: Record<string, unknown>) => Runner;
  };
  return module.createGuestProfileRunner(options);
}

function compile(draft: ReservationWorkflowV2Draft, input: PrepareInput) {
  const request = draft.proposal.content.requests.find((row) => row.id === input.requestId);
  if (!request || request.kind !== 'create') return { issue: 'create_request_not_found' } as const;
  const root = `/proposal/content/requests/${encodeURIComponent(request.id)}/body`;
  const body = record(effectiveSubtree(draft, request.body, root));
  const allocations = Array.isArray(body?.allocations) ? body.allocations : [];
  const index = allocations.findIndex((row: any) => row?.id === input.allocationId);
  // A synthetic array override must not redirect the durable selection to a different allocation.
  if (index < 0 || request.body.allocations[index]?.id !== input.allocationId) return { issue: 'allocation_not_found' } as const;
  const guest = record(allocations[index]?.guest);
  if (!guest) return { issue: 'guest_fields_incomplete' } as const;
  const path = `${root}/allocations/${index}/guest`;
  if (guest.profileIntent !== 'requested_new') return { issue: 'guest_profile_intent_requires_new',
    fields: [`${path}/profileIntent`] } as const;
  const businessGuest: Record<string, string> = {};
  const missing: string[] = [], pending: string[] = [];
  for (const field of fields) {
    const fieldPath = `${path}/${field}`, override = draft.fieldOverrides[fieldPath];
    if (override?.state === 'unknown') { missing.push(fieldPath); continue; }
    const raw = override?.state === 'set' ? override.value : override && ['none', 'clear'].includes(override.state) ? null : guest[field];
    const value = text(raw);
    if (!value) {
      if (['firstName', 'lastName', 'mobile'].includes(field)) missing.push(fieldPath);
      continue;
    }
    if (typeof raw !== 'string' || value.length > 200 || /[\p{Cc}]/u.test(value)) { missing.push(fieldPath); continue; }
    businessGuest[field] = value;
    const review = reviewed(draft, fieldPath, value);
    if (review) pending.push(review);
  }
  if (businessGuest.phoneTypeCode && !businessGuest.phoneNumber) missing.push(`${path}/phoneNumber`);
  if (businessGuest.emailTypeCode && !businessGuest.email) missing.push(`${path}/email`);
  // Native Save requires an email type whenever an address is present.
  if (businessGuest.email && !businessGuest.emailTypeCode) businessGuest.emailTypeCode = 'PRIM';
  if (missing.length) return { issue: 'guest_fields_incomplete', fields: missing } as const;
  if (pending.length) return { issue: 'guest_fields_require_review', fields: pending, needsReview: true } as const;
  const business = { propertyCode: draft.propertyCode, guest: businessGuest,
    confirmDuplicateName: input.confirmDuplicateName === true };
  return { business, path, semanticDigest: digest(business) } as const;
}

function prepared(draft: ReservationWorkflowV2Draft, input: PrepareInput & { prepareRef: string }) {
  const observation = draft.observations.find((row) => row.ref === input.prepareRef && row.kind === 'guest_candidate' &&
    row.status === 'complete' && row.coverage.complete && row.generationId === draft.generationId &&
    row.propertyCode === draft.propertyCode && row.sourceMessageId === draft.source.messageId &&
    row.criteria.workflow === 'guest_profile_prepare' && row.criteria.requestId === input.requestId &&
    row.criteria.allocationId === input.allocationId && row.criteria.draftRevision === input.expectedRevision &&
    row.criteria.draftSeq === input.expectedSeq);
  if (!observation) return null;
  const result = observation.result, business = record(result.business);
  if (!business || typeof result.previewDigest !== 'string' || !/^[a-f0-9]{64}$/.test(result.previewDigest) ||
      digest(business) !== observation.criteria.semanticDigest ||
      business.confirmDuplicateName !== (input.confirmDuplicateName === true)) return null;
  return { observation, business, previewDigest: result.previewDigest, review: result.review };
}

/** Reject deterministic runner preflight failures before creating a durable claim. */
async function validGuestPreview(preview: NonNullable<ReturnType<typeof prepared>>): Promise<boolean> {
  const native = await import(new URL('../../tooling/hms-cloud/guest-profile-create.mjs', import.meta.url).href) as {
    profileBusinessFields: (input: Record<string, unknown>) => Record<string, unknown> | null;
    hasExtendedProfileFields: (fields: Record<string, unknown>) => boolean;
    matchesProfileReview: (review: unknown, fields: Record<string, unknown>, confirm: boolean, propertyCode: string) => boolean;
    profileReviewDigest: (review: unknown) => string;
    profilePreviewDigest: (fields: Record<string, unknown>, confirm: boolean, propertyCode: string) => string;
  };
  const business = { ...preview.business, expectedPreviewDigest: preview.previewDigest,
    ...(preview.review ? { expectedReview: preview.review } : {}) };
  const fields = native.profileBusinessFields(business);
  if (!fields) return false;
  const confirmed = preview.business.confirmDuplicateName === true;
  const extended = native.hasExtendedProfileFields(fields);
  const propertyCode = text(preview.business.propertyCode);
  if (!propertyCode || (extended && !native.matchesProfileReview(preview.review, fields, confirmed, propertyCode))) return false;
  return preview.previewDigest === (extended ? native.profileReviewDigest(preview.review) : native.profilePreviewDigest(fields, confirmed, propertyCode));
}

function writeAllowed(business: Record<string, unknown>): boolean {
  const guest = record(business.guest);
  const propertyCode = business.propertyCode;
  const property = typeof propertyCode === 'string' ? getPropertyRegistration(propertyCode) : null;
  if (!guest || !property?.active) return false;
  const mode = effectiveWorkflowPolicy(process.env, property.propertyCode, 'guest_profile_create').admittedMode;
  const lab = guest.firstName === 'Proof' && guest.lastName === 'Labtest';
  return lab ? mode === 'lab' || mode === 'on' : mode === 'on';
}

// Match the runner's intent grouping; optional fields and duplicate decision
// do not permit bypassing an unresolved core-profile attempt.
function sameGuestProfileIntent(left: Record<string, any>, right: Record<string, any>): boolean {
  const first = record(left.guest), second = record(right.guest);
  if (!first || !second || left.propertyCode !== right.propertyCode) return false;
  const clean = (value: unknown) => typeof value === 'string' ? value.normalize('NFKC').trim().replace(/\s+/gu, ' ').toLowerCase() : '';
  return ['firstName', 'lastName', 'mobile', 'email'].every((key) => clean(first[key]) === clean(second[key]));
}

export async function reservationWorkflowV2GuestOptions(ctx: ReservationWorkflowV2ServerContext,
  input: PrepareInput & { field: 'title' | 'phoneType' | 'emailType' }) {
  const current = await getReservationWorkflowV2Draft(stateContext(ctx), input);
  if (current.status !== 'ok') return current;
  if (current.revision !== input.expectedRevision || current.seq !== input.expectedSeq) return { status: 'stale_revision' as const };
  const request = current.draft.proposal.content.requests.find((row) => row.id === input.requestId);
  if (request?.kind !== 'create' || !request.body.allocations.some((row) => row.id === input.allocationId)) return { status: 'not_found' as const };
  return (await runner({ propertyCode: ctx.property.propertyCode, transportId: ctx.transport.id, signal: ctx.signal })).listGuestProfileCreationOptions({ propertyCode: ctx.property.propertyCode, field: input.field });
}

export async function reservationWorkflowV2PrepareGuestProfile(ctx: ReservationWorkflowV2ServerContext, input: PrepareInput) {
  const current = await getReservationWorkflowV2Draft(stateContext(ctx), input);
  if (current.status !== 'ok') return current;
  if (current.revision !== input.expectedRevision || current.seq !== input.expectedSeq) return { status: 'stale_revision' as const };
  if (current.draft.operationResults.some((row) => row.workflow === 'guest_profile' && row.requestId === input.requestId &&
      row.allocationId === input.allocationId && (row.status === 'unknown' || row.status === 'succeeded'))) {
    return { status: 'needs_reconcile' as const, issue: 'guest_profile_already_claimed' };
  }
  const compiled = compile(current.draft, input);
  if ('issue' in compiled) return { status: 'needsReview' in compiled ? 'needs_review' as const : 'needs_input' as const,
    issue: compiled.issue, fields: 'fields' in compiled ? compiled.fields : [] };
  let native: ReservationWorkflowV2GuestNativeResult;
  try { native = await (await runner({ propertyCode: ctx.property.propertyCode, transportId: ctx.transport.id, signal: ctx.signal })).prepareGuestProfile(compiled.business); }
  catch { return { status: 'failed' as const, issue: 'guest_profile_prepare_failed' }; }
  if (native.outcome !== 'ready' || !native.previewDigest) return { status: 'needs_input' as const,
    issue: native.issue ?? 'guest_profile_prepare_incomplete', native };
  const observation: ReservationWorkflowV2Observation = { ref: `guest-prep-${randomUUID()}`,
    generationId: current.draft.generationId, kind: 'guest_candidate', status: 'complete', observedAt: new Date().toISOString(),
    propertyCode: current.draft.propertyCode, sourceMessageId: input.source.messageId, sourceRefs: [],
    criteria: { workflow: 'guest_profile_prepare', requestId: input.requestId, allocationId: input.allocationId,
      draftRevision: current.revision, draftSeq: current.seq, semanticDigest: compiled.semanticDigest },
    coverage: { complete: true, notes: [] }, result: { business: compiled.business,
      previewDigest: native.previewDigest, ...(native.review ? { review: native.review } : {}),
      businessFields: native.businessFields ?? null } };
  const saved = await appendReservationWorkflowV2Observation(stateContext(ctx), { ...input, observation });
  if (saved.status !== 'ok') return saved;
  return { status: 'prepared' as const, prepareRef: observation.ref, review: native.review ?? null,
    businessFields: native.businessFields ?? null, draft: saved.draft, revision: saved.revision, seq: saved.seq };
}

/** Bind profile approval to the exact server-prepared native profile and both duplicate aliases. */
export async function reservationWorkflowV2GuestProfilePreparation(ctx: ReservationWorkflowV2ServerContext,
  input: PrepareInput, prepareRef: string) {
  const current = await getReservationWorkflowV2Draft(stateContext(ctx), input);
  if (current.status !== 'ok' || current.revision !== input.expectedRevision || current.seq !== input.expectedSeq) return null;
  const scopedInput = { ...input, prepareRef };
  const preview = prepared(current.draft, scopedInput), compiled = compile(current.draft, input);
  if (!preview || 'issue' in compiled || compiled.semanticDigest !== preview.observation.criteria.semanticDigest ||
      !await validGuestPreview(preview)) return null;
  const guest = record(preview.business.guest), property = getPropertyRegistration(ctx.property.propertyCode);
  if (!guest || !property || typeof guest.firstName !== 'string' || typeof guest.lastName !== 'string' ||
      (guest.email !== undefined && typeof guest.email !== 'string')) return null;
  let targetAliases: string[];
  try { targetAliases = hmsGuestProfileTargetKeys({ propertyCode: property.propertyCode, firstName: guest.firstName,
    lastName: guest.lastName, ...(guest.email ? { email: guest.email } : {}) }); }
  catch { return null; }
  return { operation: 'create_guest_profile' as const, targetAliases,
    nativeObservation: { beforeDigest: preview.previewDigest, capturedAt: preview.observation.observedAt,
      price: null, warnings: preview.observation.coverage.notes },
    workflowContext: { endpoint: 'createGuestProfile' as const, input: scopedInput } };
}

export async function reservationWorkflowV2CreateGuestProfile(ctx: ReservationWorkflowV2ServerContext, input: CreateInput,
  inspectOnly = false) {
  const { sessionId, sessionProfile } = ctx.user;
  if (!sessionId || !sessionProfile) return { status: 'refused' as const, issue: 'authenticated_staff_session_required' };
  if (!inspectOnly && !ctx.writeRunFence) return { status: 'refused' as const, issue: 'staff_go_required' };
  const initial = await getReservationWorkflowV2Draft(stateContext(ctx), input);
  if (initial.status !== 'ok') return initial;
  const prior = initial.draft.operationResults.find((row) => row.id === input.idempotencyKey);
  if (prior && (prior.workflow !== 'guest_profile' || prior.requestId !== input.requestId || prior.allocationId !== input.allocationId ||
      !prior.observationRefs.includes(input.prepareRef))) return { status: 'refused' as const, issue: 'guest_attempt_mismatch' };
  if (inspectOnly && !prior) return { status: 'not_found' as const };
  const preview = prepared(initial.draft, input);
  if (!preview) return { status: 'needs_prepare' as const, issue: 'guest_profile_prepare_stale' };
  if (prior?.workflow === 'guest_profile' && prior.status === 'succeeded') return { status: 'succeeded' as const,
    operationId: prior.id, observationRefs: prior.observationRefs, draft: initial.draft, revision: initial.revision, seq: initial.seq };
  if (prior?.status === 'failed') return { status: 'failed' as const, operationId: prior.id, issue: prior.summary };
  if (!prior && !await validGuestPreview(preview)) return { status: 'needs_prepare' as const, issue: 'guest_profile_prepare_stale' };
  if (!prior && !writeAllowed(preview.business)) return { status: 'refused' as const, issue: 'guest_profile_write_flag_off' };
  const guest = record(preview.business.guest), property = getPropertyRegistration(ctx.property.propertyCode);
  const databaseUrl = process.env.DATABASE_URL;
  if (!guest || !property || !property.active || !databaseUrl || typeof guest.firstName !== 'string' ||
      typeof guest.lastName !== 'string' || (guest.email !== undefined && typeof guest.email !== 'string')) {
    return { status: 'refused' as const, issue: 'guest_profile_target_lock_unavailable' };
  }
  let targetAliases: string[];
  try { targetAliases = hmsGuestProfileTargetKeys({ propertyCode: property.propertyCode, firstName: guest.firstName,
    lastName: guest.lastName, ...(guest.email ? { email: guest.email } : {}) }); }
  catch { return { status: 'refused' as const, issue: 'guest_profile_target_lock_unavailable' }; }
  const targetLock = createPostgresTargetAliasLock({ tenantId: property.expectedTenant, propertyCode: property.propertyCode,
    targetAliases, databaseUrl });
  const claim = prior ? { ...initial, alreadyClaimed: true } :
    await claimReservationWorkflowV2GuestProfile(stateContext(ctx), input, (draft) => {
      const now = compile(draft, input);
      return !('issue' in now) && now.semanticDigest === preview.observation.criteria.semanticDigest &&
        prepared(draft, input)?.observation.ref === preview.observation.ref;
    });
  if (claim.status !== 'ok') return claim;
  const validate = (draft: ReservationWorkflowV2Draft) => {
    const operation = draft.operationResults.find((row) => row.id === input.idempotencyKey && row.workflow === 'guest_profile' &&
      row.status === 'unknown' && row.requestId === input.requestId && row.allocationId === input.allocationId &&
      row.observationRefs.includes(input.prepareRef));
    const current = compile(draft, input);
    return Boolean(writeAllowed(preview.business) && operation && !('issue' in current) &&
      current.semanticDigest === preview.observation.criteria.semanticDigest);
  };
  let activeSignal = ctx.signal;
  const callback = async () => {
    if (activeSignal?.aborted || !writeAllowed(preview.business)) return false;
    const source = { transportId: ctx.transport.id, threadId: input.source.threadId, messageId: input.source.messageId };
    if (property.group === 'centurion') {
      if (!(await guardCenturionHmsMailboxOrigin(source)).ok) return false;
    } else {
      const scan = await loadThreadMailboxHmsOriginScan(source);
      if (!scan.selectedFound || !scan.selected || !bindHmsMailboxProperty({ transportId: ctx.transport.id,
        propertyCode: property.propertyCode, origin: scan.selected }).ok) return false;
    }
    const live = await getReservationWorkflowV2Draft(stateContext(ctx), input);
    if (live.status !== 'ok' || live.revision !== input.expectedRevision || live.seq !== input.expectedSeq) return false;
    return validate(live.draft);
  };
  let native: ReservationWorkflowV2GuestNativeResult = { outcome: 'reconciliation_required', dispatched: null };
  let noDispatchBeforeJournal = false;
  try {
    await targetLock.withLock(async (_connection, lockSignal) => {
      activeSignal = ctx.signal ? AbortSignal.any([lockSignal, ctx.signal]) : lockSignal;
      const { withCloudCredentialLease } = await import('../../tooling/hms-cloud/cloud-session.mjs');
      await withCloudCredentialLease(property.propertyCode, async (credentialLease) => {
    let retryOfAttemptId: string | undefined;
    const nativeRunner = await runner({ propertyCode: property.propertyCode, transportId: ctx.transport.id,
      signal: activeSignal, credentialLease, authorizeStaffWrite: callback,
      dispatchStaffWrite: (context: unknown, proceed: () => Promise<unknown>) => {
        const dispatch = z.object({ propertyCode: z.literal(property.propertyCode),
          phase: z.enum(['initial', 'confirm_distinct']), writer: z.unknown() }).passthrough().parse(context);
        if (!dispatch.writer || (dispatch.phase === 'confirm_distinct' && preview.business.confirmDuplicateName !== true)) {
          throw new Error('guest_profile_dispatch_scope_invalid');
        }
        return dispatchReservationWorkflowV2GuestProfile({ ...stateContext(ctx), signal: activeSignal, userId: ctx.user.id, sessionId, sessionProfile },
          input, validate, proceed, dispatch.phase);
      },
      verifyNoCreate: async (proof: { attemptId: string; nextAttemptId: string; nextPreviewDigest: string;
        noDispatchRecorded: boolean; duplicateDeclined: boolean; result: ReservationWorkflowV2GuestNativeResult }) => {
        const noDispatch = proof.noDispatchRecorded &&
          guestProfileDefinitelyNotDispatched({ ...proof.result, noDispatchRecorded: true });
        const duplicateApproved = proof.duplicateDeclined && preview.business.confirmDuplicateName === true &&
          proof.result.outcome === 'confirmation_required' && proof.result.issue === 'PROFILE_NAME_ALREADY_EXISTS' &&
          proof.result.dispatched === true && !proof.result.nativeId;
        if (proof.attemptId !== retryOfAttemptId || proof.nextAttemptId !== input.idempotencyKey ||
            proof.nextPreviewDigest !== preview.previewDigest || !(noDispatch || duplicateApproved)) return null;
        return { outcome: 'no_create', evidenceDigest: digest({ attemptId: proof.attemptId,
          nextAttemptId: proof.nextAttemptId, nextPreviewDigest: proof.nextPreviewDigest,
          noDispatchRecorded: proof.noDispatchRecorded, duplicateDeclined: proof.duplicateDeclined, result: proof.result }) };
      } });
    if (!inspectOnly && !claim.alreadyClaimed) {
      const previous = [...claim.draft.operationResults].reverse().find((row) => row.workflow === 'guest_profile' &&
        row.status === 'failed' && row.requestId === input.requestId && row.allocationId === input.allocationId &&
        row.observationRefs.some((ref) => {
          const saved = claim.draft.observations.find((item) => item.ref === ref && item.criteria.workflow === 'guest_profile_prepare');
          const business = record(saved?.result.business);
          return business && sameGuestProfileIntent(business, preview.business);
        }));
      const oldPreview = previous && claim.draft.observations.find((item) => previous.observationRefs.includes(item.ref) &&
        item.criteria.workflow === 'guest_profile_prepare');
      const oldBusiness = record(oldPreview?.result.business);
      if (previous && oldPreview && oldBusiness && typeof oldPreview.result.previewDigest === 'string') {
        const inspected = await nativeRunner.inspectGuestProfileAttempt({ ...oldBusiness,
          expectedPreviewDigest: oldPreview.result.previewDigest,
          ...(oldPreview.result.review ? { expectedReview: oldPreview.result.review } : {}), attemptId: previous.id });
        if (guestProfileDefinitelyNotDispatched(inspected) || (inspected.duplicateDeclined === true &&
            preview.business.confirmDuplicateName === true && inspected.outcome === 'confirmation_required')) retryOfAttemptId = previous.id;
      }
    }
    native = inspectOnly || claim.alreadyClaimed
      ? await nativeRunner.inspectGuestProfileAttempt({ ...preview.business, expectedPreviewDigest: preview.previewDigest,
        ...(preview.review ? { expectedReview: preview.review } : {}), attemptId: input.idempotencyKey })
      : await nativeRunner.createGuestProfile({ ...preview.business, expectedPreviewDigest: preview.previewDigest,
        ...(preview.review ? { expectedReview: preview.review } : {}), attemptId: input.idempotencyKey,
        ...(retryOfAttemptId ? { retryOfAttemptId } : {}) });
    noDispatchBeforeJournal = !inspectOnly && !claim.alreadyClaimed && native.outcome === 'not_dispatched' &&
      native.issue === 'PROFILE_JOURNAL_UNAVAILABLE' && native.noDispatchBeforeJournal === true &&
      native.dispatched === false && native.nativeId == null;
    if (!inspectOnly && !claim.alreadyClaimed && native.dispatched === false && native.noDispatchRecorded !== true &&
        !noDispatchBeforeJournal && native.issue !== 'PROFILE_ATTEMPT_CHANGED' && native.issue !== 'PROFILE_INTENT_HELD') {
      const inspected = await nativeRunner.inspectGuestProfileAttempt({ ...preview.business, expectedPreviewDigest: preview.previewDigest,
        ...(preview.review ? { expectedReview: preview.review } : {}), attemptId: input.idempotencyKey });
      if (inspected.noDispatchRecorded === true) native = { ...native, noDispatchRecorded: true };
    }
    if (native.outcome === 'reconciliation_required' && text(native.nativeId)) {
      const read = await nativeRunner.readGuestProfile({ propertyCode: ctx.property.propertyCode,
        nativeId: native.nativeId, attemptId: input.idempotencyKey });
      if (read.reconciliation?.outcome === 'created') native = read.reconciliation;
    }
      }, { signal: activeSignal });
    }, { ...acquisitionWithin(PANE_PROPERTY_LOCK_WAIT_MS), signal: ctx.signal });
  } catch {
    noDispatchBeforeJournal = false;
    native = { outcome: 'reconciliation_required', issue: 'guest_profile_execution_unknown', dispatched: null };
  }
  const successful = native.outcome === 'created' && /^\d{1,30}$/.test(native.nativeId ?? '') && native.readback;
  const status = successful ? 'succeeded' as const : noDispatchBeforeJournal || guestProfileDefinitelyNotDispatched(native) ||
    (native.outcome === 'confirmation_required' && native.duplicateDeclined === true)
    ? 'failed' as const : 'unknown' as const;
  const request = claim.draft.proposal.content.requests.find((row) => row.id === input.requestId);
  const index = request?.kind === 'create' ? request.body.allocations.findIndex((row) => row.id === input.allocationId) : -1;
  const selectionPath = `/proposal/content/requests/${encodeURIComponent(input.requestId)}/body/allocations/${index}/guest/nativeSelectionRef`;
  const observation: ReservationWorkflowV2Observation | undefined = successful ? {
    ref: `guest-created-${input.idempotencyKey}`, generationId: claim.draft.generationId, kind: 'guest_candidate',
    status: 'complete', observedAt: new Date().toISOString(), propertyCode: claim.draft.propertyCode,
    sourceMessageId: input.source.messageId, sourceRefs: [], coverage: { complete: true, notes: ['Fresh exact-ID profile readback verified'] },
    criteria: { workflow: 'guest_profile_create', requestId: input.requestId, allocationId: input.allocationId,
      fieldPath: selectionPath, attemptId: input.idempotencyKey },
    result: { outcome: 'created', candidates: [{ nativeId: native.nativeId, firstName: native.readback!.firstName,
      lastName: native.readback!.lastName, email: native.readback!.email, mobile: native.readback!.mobile,
      name: `${native.readback!.firstName} ${native.readback!.lastName}` }] },
  } : native.nativeId ? { ref: `guest-pending-${input.idempotencyKey}`, generationId: claim.draft.generationId,
    kind: 'guest_candidate', status: 'partial', observedAt: new Date().toISOString(), propertyCode: claim.draft.propertyCode,
    sourceMessageId: input.source.messageId, sourceRefs: [], coverage: { complete: false, notes: ['Profile creation requires reconciliation'] },
    criteria: { workflow: 'guest_profile_create', requestId: input.requestId, allocationId: input.allocationId,
      attemptId: input.idempotencyKey }, result: { nativeId: native.nativeId, outcome: native.outcome, issue: native.issue } } : undefined;
  const summary = successful ? `Guest profile ${native.nativeId} created and verified` :
    `Guest profile ${status}: ${native.issue ?? native.outcome ?? 'unknown'}${native.nativeId ? `; native ID ${native.nativeId}` : ''}`;
  let saved;
  try {
    saved = await finishReservationWorkflowV2GuestProfile(stateContext(ctx), { ...input, operationId: input.idempotencyKey,
      status, summary, observation });
  } catch {
    return { status: 'needs_reconcile' as const, operationId: input.idempotencyKey,
      nativeId: native.nativeId ?? null, issue: 'guest_profile_result_persist_failed' };
  }
  if (saved.status !== 'ok') return { status: 'needs_reconcile' as const, operationId: input.idempotencyKey,
    nativeId: native.nativeId ?? null, issue: 'guest_profile_result_persist_failed' };
  const persistedStatus = saved.draft.operationResults.find((row) => row.id === input.idempotencyKey)?.status ?? 'unknown';
  return { status: persistedStatus === 'unknown' ? 'needs_reconcile' as const : persistedStatus, operationId: input.idempotencyKey,
    nativeId: native.nativeId ?? null, issue: native.issue ?? null,
    ...(persistedStatus === 'succeeded' && observation ? { observationRef: observation.ref } : {}),
    draft: saved.draft, revision: saved.revision, seq: saved.seq };
}

/** Reconcile an existing attempt using only the private journal and an exact-ID read. */
export async function reservationWorkflowV2ReconcileGuestProfile(ctx: ReservationWorkflowV2ServerContext,
  input: { workItemId: string; source: CreateInput['source']; expectedRevision: number; expectedSeq: number; operationId: string }) {
  const current = await getReservationWorkflowV2Draft(stateContext(ctx), input);
  if (current.status !== 'ok') return current;
  const operation = current.draft.operationResults.find((row) => row.id === input.operationId && row.workflow === 'guest_profile');
  if (!operation || !operation.allocationId) return { status: 'not_found' as const };
  const preview = current.draft.observations.find((row) => operation.observationRefs.includes(row.ref) &&
    row.criteria.workflow === 'guest_profile_prepare');
  const business = record(preview?.result.business);
  if (!preview || !business || typeof preview.criteria.draftRevision !== 'number' || typeof preview.criteria.draftSeq !== 'number') {
    return { status: 'needs_reconcile' as const, issue: 'guest_profile_prepare_missing', operationId: operation.id };
  }
  return reservationWorkflowV2CreateGuestProfile(ctx, { workItemId: input.workItemId, source: input.source,
    expectedRevision: preview.criteria.draftRevision, expectedSeq: preview.criteria.draftSeq,
    requestId: operation.requestId, allocationId: operation.allocationId, confirmDuplicateName: business.confirmDuplicateName === true,
    go: true, idempotencyKey: operation.id, prepareRef: preview.ref }, true);
}

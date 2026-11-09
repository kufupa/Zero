import { randomUUID } from 'node:crypto';
import type { z } from 'zod';
import type { ReservationWorkflowV2Draft, ReservationWorkflowV2Proposal } from './reservation-workflow-v2-contract.js';
import { reservationWorkflowV2ProposalSchema, type reservationWorkflowV2AddActionInputSchema,
  type reservationWorkflowV2ChangeRowsInputSchema, type reservationWorkflowV2SelectNativeInputSchema,
  type reservationWorkflowV2ReviewScopeInputSchema } from './reservation-workflow-v2-contract.js';
import { withLockedV2DraftMutation, reservationWorkflowV2SavedTargetLocked,
  type ReservationWorkflowV2Context } from './reservation-workflow-v2-state.js';
import { nativeStructureIsSafe, rebaseReservationV2Path, rebaseReservationV2Observations } from './work-item-revision.js';
import { sameGuestName } from './guest-name-match.js';
import { canonicalJson } from './draft-approval.js';
import { currentLead } from './reservation-workflow-v2-verify-lead.js';

const ptr = (...parts: (string | number)[]) => '/' + parts.map((part) => encodeURIComponent(String(part))).join('/');
const rec = (value: unknown): Record<string, any> => value && typeof value === 'object' && !Array.isArray(value)
  ? value as Record<string, any> : {};
const id = () => randomUUID();
const occupancy = () => ({ adults: null, childCount: null, childAges: null });
const hint = () => ({ id: id(), candidateRefs: [], suggestedRef: null, sourceRefs: [] });
const scope = () => ({ mode: 'explicit' as const, include: [hint()], exclude: [], sourceRefs: [] });
const section = () => ({ id: id(), arrival: null, departure: null, requestedRooms: 1,
  requestedTotals: occupancy(), defaults: {}, unassignedGuestNames: [] });
const allocation = (dateSectionId: string) => ({ id: id(), dateSectionId, overrides: {},
  guest: { firstName: null, lastName: null, email: null, mobile: null, profileIntent: 'existing_or_unknown' as const,
    candidateRefs: [], suggestedRef: null }, occupancy: occupancy(), priceObservationRefs: [] });
const group = () => ({ id: id(), arrival: null, departure: null, quantity: null, board: null, roomCodes: [],
  ratePlan: null, occupancy: { ...occupancy(), scope: 'unresolved' as const }, priceObservationRefs: [] });
const service = (requestId: string) => ({ id: id(), ownerRequestId: requestId, operation: 'add' as const,
  requestedText: '', code: null, itemCandidateRef: null, sharedFields: {}, requestedMoney: [], targets: [],
  quantityRequest: { value: null, scope: 'unresolved' as const, sourceRefs: [] }, sourceRefs: [] });
const document = (requestId: string) => ({ id: id(), ownerRequestId: requestId, documentSourceRef: `manual_${id()}`,
  kind: 'unclassified' as const, handling: 'filing_requested' as const, targetRefs: [], requestedName: null,
  requestedDescription: null, uploadArtifactRef: null, sourceRefs: [] });

function rebase(draft: ReservationWorkflowV2Draft, before: ReservationWorkflowV2Proposal,
  after: ReservationWorkflowV2Proposal, changedRoots: string[]): ReservationWorkflowV2Draft {
  // A ChangeList can exist only in an override. Include it in the path trees so
  // its child edits and reviews follow the same stay when target indexes move.
  const pathBefore = structuredClone(before), pathAfter = structuredClone(after);
  for (const request of pathBefore.content.requests) {
    if (request.kind !== 'amend') continue;
    const next = pathAfter.content.requests.find((row) => row.id === request.id);
    if (!next || next.kind !== 'amend') continue;
    const nextTargets = next.body.perTarget;
    request.body.perTarget.forEach((row, index) => {
      const path = `${ptr('proposal', 'content', 'requests', request.id)}/body/perTarget/${index}/changes`;
      const override = draft.fieldOverrides[path];
      if (override?.state !== 'set' || !Array.isArray(override.value)) return;
      row.changes = structuredClone(override.value) as typeof row.changes;
      const target = nextTargets.find((entry) => entry.hintId === row.hintId);
      if (target) target.changes = structuredClone(override.value) as typeof target.changes;
    });
  }
  const map = <T>(values: Record<string, T>, dropChangedParents = false): Record<string, T> => {
    const result: Record<string, T> = {};
    for (const [path, value] of Object.entries(values)) {
      if (dropChangedParents && changedRoots.includes(path)) continue;
      const rebased = rebaseReservationV2Path(path, pathBefore, pathAfter);
      if (rebased && !changedRoots.some((root) => path === root || root.startsWith(`${path}/`))) result[rebased] = value;
    }
    return result;
  };
  const paths = <T extends { path: string }>(rows: T[]) => rows.flatMap((row) => {
    const path = rebaseReservationV2Path(row.path, pathBefore, pathAfter); return path ? [{ ...row, path }] : [];
  });
  const observations = rebaseReservationV2Observations(draft, pathBefore, pathAfter);
  return { ...draft, proposal: { ...after, annotations: paths(after.annotations), issues: paths(after.issues),
    sourceClaims: paths(after.sourceClaims) }, fieldOverrides: map(draft.fieldOverrides, true),
    staffReviews: map(draft.staffReviews), fieldReviewRequirements: map(draft.fieldReviewRequirements), observations };
}

function safeStructure(current: ReservationWorkflowV2Draft, next: ReservationWorkflowV2Draft): boolean {
  return nativeStructureIsSafe({ reservationWorkflowV2: current }, { reservationWorkflowV2: next });
}

export function addReservationWorkflowV2Action(ctx: ReservationWorkflowV2Context,
  input: z.infer<typeof reservationWorkflowV2AddActionInputSchema>) {
  return withLockedV2DraftMutation(ctx, input, { fieldPath: '/proposal/content/requests', value: { kind: input.kind },
    apply: (draft) => {
      const requestId = id();
      const base = { id: requestId, requestText: '', sourceRefs: [], serviceRefs: [] as string[], documentRefs: [] as string[] };
      const proposal = structuredClone(draft.proposal);
      let request: ReservationWorkflowV2Proposal['content']['requests'][number];
      if (input.kind === 'create') {
        const date = section();
        request = { ...base, kind: 'create', body: { shared: { cmsSend: true }, dateSections: [date], allocations: [allocation(date.id)] } };
      } else if (input.kind === 'quote') request = { ...base, kind: 'quote', body: { groups: [group()], parties: {},
        salesStrategy: null, client: { attention: null, email: null, telephone: null }, requestedMoney: [], notes: null,
        outputIntent: { artifacts: ['email_quote'], evidenceRefs: [] }, provisionalBookingRequested: false } };
      else if (input.kind === 'amend') {
        const targets = scope(); request = { ...base, kind: 'amend', body: { targets, sharedChanges: [],
          perTarget: [{ hintId: targets.include[0]!.id, changes: [], rateHandling: null, currentObservationRefs: [] }] } };
      }
      else if (input.kind === 'cancel') request = { ...base, kind: 'cancel', body: { targets: scope(),
        reason: { text: null, candidateRefs: [], suggestedRef: null }, cancellationNote: null, previewObservationRefs: [] } };
      else if (input.kind === 'services') {
        const targets = scope(), row = service(requestId);
        row.targets.push({ target: { kind: 'saved_target', requestId, hintId: targets.include[0]!.id }, fields: {},
          savedRowCandidateRef: null, previewObservationRef: null } as never);
        proposal.content.services.push(row); base.serviceRefs.push(row.id);
        request = { ...base, kind: 'services', body: { targets } };
      } else {
        const targets = scope(), row = document(requestId);
        row.targetRefs.push({ kind: 'saved_target', requestId, hintId: targets.include[0]!.id } as never);
        proposal.content.documents.push(row); base.documentRefs.push(row.id);
        request = { ...base, kind: 'filing', body: { targets } };
      }
      proposal.content.requests.push(request);
      return { draft: { ...draft, proposal }, createdId: requestId };
    } });
}

export function changeReservationWorkflowV2Rows(ctx: ReservationWorkflowV2Context,
  input: z.infer<typeof reservationWorkflowV2ChangeRowsInputSchema>) {
  return withLockedV2DraftMutation(ctx, input, { fieldPath: '/proposal/content', value: input,
    apply: (original) => {
      const draft = structuredClone(original), proposal = draft.proposal;
      const request = proposal.content.requests.find((row) => row.id === input.requestId);
      if (!request) return null;
      const root = ptr('proposal', 'content', 'requests', request.id);
      const changedRoots: string[] = [];
      const targets = request.kind === 'amend' || request.kind === 'cancel' || request.kind === 'services' || request.kind === 'filing'
        ? request.body.targets : null;
      // Older Cancel/Filing editors can have an entire saved target array in an override.
      const targetRoot = `${root}/body/targets`, targetOverride = draft.fieldOverrides[targetRoot];
      if (targetOverride?.state === 'set' && targetOverride.value && typeof targetOverride.value === 'object') {
        if (request.kind !== 'amend' && request.kind !== 'cancel' && request.kind !== 'services' && request.kind !== 'filing') return null;
        request.body.targets = structuredClone(targetOverride.value) as any;
        delete draft.fieldOverrides[targetRoot];
      }
      const effectiveTargets = request.kind === 'amend' || request.kind === 'cancel' || request.kind === 'services' || request.kind === 'filing'
        ? request.body.targets : targets;
      const includeRoot = `${targetRoot}/include`, includeOverride = draft.fieldOverrides[includeRoot];
      if (effectiveTargets && includeOverride?.state === 'set' && Array.isArray(includeOverride.value)) {
        effectiveTargets.include = structuredClone(includeOverride.value) as typeof effectiveTargets.include;
        delete draft.fieldOverrides[includeRoot];
      }
      // A legacy editor can replace a whole array. Materialize it before changing
      // its structure so surviving row edits rebase against the effective rows.
      const materializeArray = (path: string): boolean => {
        const override = draft.fieldOverrides[path];
        if (!override) return true;
        if (override.state !== 'set' || !Array.isArray(override.value)) return false;
        const parts = path.slice('/proposal/'.length).split('/').map(decodeURIComponent);
        let parent: any = proposal;
        for (const part of parts.slice(0, -1)) parent = Array.isArray(parent)
          ? (/^\d+$/.test(part) ? parent[Number(part)] : parent.find((row) => rec(row).id === part)) : rec(parent)[part];
        if (!parent || typeof parent !== 'object') return false;
        parent[parts.at(-1)!] = structuredClone(override.value);
        delete draft.fieldOverrides[path];
        return true;
      };
      const paths = input.kind.includes('allocation') ? [`${root}/body/allocations`]
        : input.kind.includes('date_section') ? [`${root}/body/dateSections`, `${root}/body/allocations`]
        : input.kind.includes('quote_group') ? [`${root}/body/groups`]
        : input.kind.includes('target') ? [includeRoot, ...(request.kind === 'amend' ? [`${root}/body/perTarget`] : [])]
        : input.kind.includes('service') ? ['/proposal/content/services', `${root}/serviceRefs`]
        : input.kind.includes('document') ? ['/proposal/content/documents', `${root}/documentRefs`]
        : ['/proposal/content/requests', '/proposal/content/services', '/proposal/content/documents'];
      if (!paths.every(materializeArray)) return null;
      const before = structuredClone(proposal);
      let createdId: string | undefined;
      const changedDateIds = new Set<string>();
      const removeLinked = (kind: 'allocation' | 'quote_group' | 'saved_target', entityId: string) => {
        const matches = (ref: any) => ref?.kind === kind && ref.requestId === request.id &&
          (kind === 'allocation' ? ref.allocationId : kind === 'quote_group' ? ref.groupId : ref.hintId) === entityId;
        for (const row of proposal.content.services) row.targets = row.targets.filter((target) => !matches(target.target));
        for (const row of proposal.content.documents) row.targetRefs = row.targetRefs.filter((ref) => !matches(ref));
      };
      switch (input.kind) {
        case 'add_allocation': {
          if (request.kind !== 'create' || request.body.allocations.length >= 8) return null;
          const date = request.body.dateSections.find((row) => row.id === input.parentId) ??
            (!input.parentId && request.body.dateSections.length === 1 ? request.body.dateSections[0] : undefined);
          if (!date) return null;
          const row = allocation(date.id); request.body.allocations.push(row); createdId = row.id;
          date.requestedRooms = request.body.allocations.filter((entry) => entry.dateSectionId === date.id).length;
          changedDateIds.add(date.id);
          changedRoots.push(`${root}/body/allocations`); break;
        }
        case 'remove_allocation': {
          if (request.kind !== 'create' || request.body.allocations.length <= 1) return null;
          const row = request.body.allocations.find((entry) => entry.id === input.entityId);
          if (!row || request.body.allocations.filter((entry) => entry.dateSectionId === row.dateSectionId).length <= 1) return null;
          request.body.allocations = request.body.allocations.filter((entry) => entry.id !== row.id);
          const date = request.body.dateSections.find((entry) => entry.id === row.dateSectionId);
          if (date) date.requestedRooms = request.body.allocations.filter((entry) => entry.dateSectionId === date.id).length;
          changedDateIds.add(row.dateSectionId);
          removeLinked('allocation', row.id); changedRoots.push(`${root}/body/allocations`); break;
        }
        case 'move_allocation': {
          if (request.kind !== 'create') return null;
          const row = request.body.allocations.find((entry) => entry.id === input.entityId);
          const date = request.body.dateSections.find((entry) => entry.id === input.parentId);
          if (!row || !date || row.dateSectionId === date.id) return null;
          changedDateIds.add(row.dateSectionId); changedDateIds.add(date.id); row.dateSectionId = date.id;
          changedRoots.push(`${root}/body/allocations`); break;
        }
        case 'add_date_section': {
          if (request.kind !== 'create' || request.body.dateSections.length >= 100) return null;
          const date = section(); date.requestedRooms = 0; request.body.dateSections.push(date);
          changedDateIds.add(date.id);
          createdId = date.id; changedRoots.push(`${root}/body/dateSections`); break;
        }
        case 'remove_date_section': {
          if (request.kind !== 'create' || request.body.dateSections.length <= 1) return null;
          const date = request.body.dateSections.find((entry) => entry.id === input.entityId);
          if (!date) return null;
          const children = request.body.allocations.filter((row) => row.dateSectionId === date.id).map((row) => row.id);
          if (!input.childIds || children.length !== input.childIds.length || children.some((child) => !input.childIds!.includes(child)) ||
              request.body.allocations.length - children.length < 1) return null;
          request.body.dateSections = request.body.dateSections.filter((row) => row.id !== date.id);
          request.body.allocations = request.body.allocations.filter((row) => !children.includes(row.id));
          children.forEach((child) => removeLinked('allocation', child));
          changedRoots.push(`${root}/body/dateSections`, `${root}/body/allocations`); break;
        }
        case 'add_quote_group': {
          if (request.kind !== 'quote' || request.body.groups.length >= 100) return null;
          const row = group();
          const arrival = valueAt(draft, `${root}/body/groups/0/arrival`), departure = valueAt(draft, `${root}/body/groups/0/departure`);
          row.arrival = typeof arrival === 'string' ? arrival as never : null;
          row.departure = typeof departure === 'string' ? departure as never : null;
          request.body.groups.push(row); createdId = row.id; changedRoots.push(`${root}/body/groups`); break;
        }
        case 'remove_quote_group': {
          if (request.kind !== 'quote' || request.body.groups.length <= 1 || !request.body.groups.some((row) => row.id === input.entityId)) return null;
          request.body.groups = request.body.groups.filter((row) => row.id !== input.entityId); removeLinked('quote_group', input.entityId!);
          changedRoots.push(`${root}/body/groups`); break;
        }
        case 'add_target': {
          // Existing extracted hints may have no per-target change row. Set up
          // that exact included stay without replacing its scope or other rows.
          if (input.entityId) {
            if (request.kind !== 'amend' || !effectiveTargets || input.parentId || input.childIds ||
                request.body.perTarget.length >= 100 ||
                effectiveTargets.include.filter((entry) => entry.id === input.entityId).length !== 1 ||
                request.body.perTarget.some((entry) => entry.hintId === input.entityId)) return null;
            const excluded = valueAt(draft, `${targetRoot}/exclude`);
            if (!Array.isArray(excluded) || excluded.some((entry) => rec(entry).id === input.entityId)) return null;
            request.body.perTarget.push({ hintId: input.entityId, changes: [], rateHandling: null, currentObservationRefs: [] });
            createdId = input.entityId; changedRoots.push(`${root}/body/perTarget`); break;
          }
          if (!effectiveTargets || effectiveTargets.include.length >= 100) return null;
          const row = hint(); effectiveTargets.include.push(row); effectiveTargets.mode = 'explicit'; createdId = row.id;
          if (request.kind === 'amend') request.body.perTarget.push({ hintId: row.id, changes: [], rateHandling: null, currentObservationRefs: [] });
          changedRoots.push(includeRoot, ...(request.kind === 'amend' ? [`${root}/body/perTarget`] : [])); break;
        }
        case 'remove_target': {
          if (!effectiveTargets || effectiveTargets.include.length <= 1 || !effectiveTargets.include.some((row) => row.id === input.entityId)) return null;
          effectiveTargets.include = effectiveTargets.include.filter((row) => row.id !== input.entityId);
          if (request.kind === 'amend') request.body.perTarget = request.body.perTarget.filter((row) => row.hintId !== input.entityId);
          removeLinked('saved_target', input.entityId!);
          changedRoots.push(includeRoot, ...(request.kind === 'amend' ? [`${root}/body/perTarget`] : [])); break;
        }
        case 'add_service': {
          if (proposal.content.services.length >= 200) return null;
          const row = service(request.id);
          if (request.kind === 'create') {
            const target = request.body.allocations.find((entry) => entry.id === input.parentId);
            if (!target) return null;
            row.targets.push({ target: { kind: 'allocation', requestId: request.id, allocationId: target.id }, fields: {},
              savedRowCandidateRef: null, previewObservationRef: null } as never);
          } else {
            const target = effectiveTargets?.include.find((entry) => entry.id === input.parentId) ??
              (!input.parentId && effectiveTargets?.include.length === 1 ? effectiveTargets.include[0] : undefined);
            if (!target) return null;
            row.targets.push({ target: { kind: 'saved_target', requestId: request.id, hintId: target.id }, fields: {},
              savedRowCandidateRef: null, previewObservationRef: null } as never);
          }
          proposal.content.services.push(row); request.serviceRefs.push(row.id); createdId = row.id;
          changedRoots.push('/proposal/content/services'); break;
        }
        case 'remove_service': {
          if (!proposal.content.services.some((row) => row.id === input.entityId && row.ownerRequestId === request.id)) return null;
          proposal.content.services = proposal.content.services.filter((row) => row.id !== input.entityId);
          request.serviceRefs = request.serviceRefs.filter((ref) => ref !== input.entityId);
          changedRoots.push('/proposal/content/services'); break;
        }
        case 'add_document': {
          if (proposal.content.documents.length >= 200) return null;
          const row = document(request.id); proposal.content.documents.push(row); request.documentRefs.push(row.id); createdId = row.id;
          changedRoots.push('/proposal/content/documents'); break;
        }
        case 'remove_document': {
          if (!proposal.content.documents.some((row) => row.id === input.entityId && row.ownerRequestId === request.id)) return null;
          proposal.content.documents = proposal.content.documents.filter((row) => row.id !== input.entityId);
          request.documentRefs = request.documentRefs.filter((ref) => ref !== input.entityId);
          changedRoots.push('/proposal/content/documents'); break;
        }
        case 'remove_action': {
          proposal.content.requests = proposal.content.requests.filter((row) => row.id !== request.id);
          proposal.content.services = proposal.content.services.filter((row) => row.ownerRequestId !== request.id);
          proposal.content.documents = proposal.content.documents.filter((row) => row.ownerRequestId !== request.id);
          for (const row of proposal.content.services) row.targets = row.targets.filter((target) => target.target.requestId !== request.id);
          for (const row of proposal.content.documents) row.targetRefs = row.targetRefs.filter((target) => target.requestId !== request.id);
          changedRoots.push('/proposal/content/requests', '/proposal/content/services', '/proposal/content/documents'); break;
        }
      }
      if (!reservationWorkflowV2ProposalSchema.safeParse(proposal).success) return null;
      const next = rebase(draft, before, proposal, changedRoots);
      if (request.kind === 'create' && ['add_allocation', 'remove_allocation', 'move_allocation', 'add_date_section', 'remove_date_section'].includes(input.kind)) {
        request.body.dateSections.forEach((date, index) => {
          if (!changedDateIds.has(date.id)) return;
          date.requestedRooms = request.body.allocations.filter((row) => row.dateSectionId === date.id).length;
          const path = `${root}/body/dateSections/${index}/requestedRooms`;
          delete next.fieldOverrides[path]; delete next.staffReviews[path];
        });
      }
      if (!safeStructure(original, next)) return null;
      return { draft: next, createdId };
    } });
}

function valueAt(draft: ReservationWorkflowV2Draft, path: string): unknown {
  let current: unknown = draft;
  let prefix = '';
  for (const encoded of path.split('/').slice(1)) {
    let key: string;
    try { key = decodeURIComponent(encoded); } catch { return undefined; }
    prefix += `/${encoded}`;
    current = Array.isArray(current) ? (/^\d+$/.test(key) ? current[Number(key)] : current.find((row) => rec(row).id === key)) : rec(current)[key];
    const override = draft.fieldOverrides[prefix];
    if (override?.state === 'set') current = override.value;
    else if (override && override.state !== 'inherit') current = null;
  }
  return current;
}

// Older panes added rooms by overriding the allocation array. Move that exact
// effective array into the proposal without changing its indexed child paths.
function materializeCreateAllocations(draft: ReservationWorkflowV2Draft, requestId: string): ReservationWorkflowV2Draft | null {
  const request = draft.proposal.content.requests.find((row) => row.id === requestId);
  if (!request || request.kind !== 'create') return draft;
  const path = `${ptr('proposal', 'content', 'requests', requestId)}/body/allocations`;
  const override = draft.fieldOverrides[path];
  if (!override || override.state === 'inherit') return draft;
  if (override.state !== 'set' || !Array.isArray(override.value)) return null;
  const proposal = structuredClone(draft.proposal);
  const target = proposal.content.requests.find((row) => row.id === requestId);
  if (!target || target.kind !== 'create') return null;
  target.body.allocations = structuredClone(override.value) as typeof target.body.allocations;
  const parsed = reservationWorkflowV2ProposalSchema.safeParse(proposal);
  if (!parsed.success) return null;
  const fieldOverrides = { ...draft.fieldOverrides };
  delete fieldOverrides[path];
  const next = { ...draft, proposal: parsed.data, fieldOverrides };
  return safeStructure(draft, next) ? next : null;
}

/** A selectable reference must address one host-admitted row for this exact field and request. */
export function selectReservationWorkflowV2Native(ctx: ReservationWorkflowV2Context,
  input: z.infer<typeof reservationWorkflowV2SelectNativeInputSchema>) {
  return withLockedV2DraftMutation(ctx, input, { fieldPath: input.fieldPath,
    value: { requestId: input.requestId, observationRef: input.observationRef }, apply: (original) => {
      const draft = materializeCreateAllocations(original, input.requestId);
      if (!draft) return null;
      const request = draft.proposal.content.requests.find((row) => row.id === input.requestId);
      const root = ptr('proposal', 'content', 'requests', input.requestId);
      if (!request) return null;
      const serviceRefs = valueAt(draft, `${root}/serviceRefs`);
      const servicePath = input.fieldPath.match(/^\/proposal\/content\/services\/(\d+)\/itemCandidateRef$/);
      const savedServicePath = input.fieldPath.match(/^\/proposal\/content\/services\/(\d+)\/targets\/(\d+)\/savedRowCandidateRef$/);
      if (!input.fieldPath.startsWith(`${root}/body/`) && !servicePath && !savedServicePath) return null;
      const observation = draft.observations.find((row) => row.ref === input.observationRef);
      if (!observation || observation.status !== 'complete' || !observation.coverage.complete ||
          observation.generationId !== draft.generationId || observation.propertyCode !== draft.propertyCode ||
          observation.sourceMessageId !== draft.source.messageId || observation.criteria.requestId !== request.id) return null;
      if (observation.criteria.kind === 'verified_native_row') {
        const leadRef = observation.criteria.leadObservationRef;
        const current = typeof leadRef === 'string' ? currentLead(draft, { ...input, observationRef: leadRef }) : null;
        if (!current || current.nativeId !== rec(observation.result).nativeId || current.lead.kind !== observation.kind ||
            current.lead.criteria.role !== observation.criteria.role ||
            canonicalJson(current.lead.criteria.query) !== canonicalJson(observation.criteria.query)) return null;
      }
      const paths = [observation.criteria.fieldPath, observation.criteria.selectionPath,
        ...(Array.isArray(observation.criteria.fieldPaths) ? observation.criteria.fieldPaths : [])];
      const filingPath = request.kind === 'filing' && observation.kind === 'stay_candidate' &&
        observation.criteria.workflow === 'filing' && input.fieldPath.startsWith(`${root}/body/targets/include/`) &&
        input.fieldPath.endsWith('/suggestedRef');
      if (!paths.includes(input.fieldPath) && !filingPath) return null;
      const now = new Date().toISOString(), overrides = { ...draft.fieldOverrides }, reviews = { ...draft.staffReviews };
      let proposal = draft.proposal;
      const set = (path: string, value: unknown) => { overrides[path] = { state: 'set', value, updatedAt: now };
        for (const key of Object.keys(reviews)) if (key === path || key.startsWith(`${path}/`) || path.startsWith(`${key}/`)) delete reviews[key]; };
      if (savedServicePath && observation.kind === 'service_preview' && observation.criteria.workflow === 'services' &&
          observation.criteria.kind === 'saved_row_candidate') {
        const service = draft.proposal.content.services[Number(savedServicePath[1])];
        const target = service?.targets[Number(savedServicePath[2])], candidate = rec(observation.result.candidate);
        if (!service || !Array.isArray(serviceRefs) || !serviceRefs.includes(service.id) || service.id !== observation.criteria.serviceId || !target ||
            !['edit', 'remove'].includes(String(valueAt(draft, `/proposal/content/services/${savedServicePath[1]}/operation`))) ||
            canonicalJson(target.target) !== canonicalJson(observation.criteria.targetRef) || !candidate.nativeId) return null;
        const targetRef = rec(observation.criteria.targetRef), scopeMode = valueAt(draft, `${root}/body/targets/mode`);
        const rows = valueAt(draft, `${root}/body/targets/include`);
        const index = Array.isArray(rows) ? rows.findIndex((row) => rec(row).id === targetRef.hintId) : -1;
        if (scopeMode !== 'explicit' || index < 0 ||
            valueAt(draft, `${root}/body/targets/include/${index}/suggestedRef`) !== observation.criteria.targetObservationRef) return null;
        set(input.fieldPath, observation.ref);
      } else if (servicePath && observation.kind === 'service_preview' && observation.criteria.workflow === 'services' &&
          observation.criteria.kind === 'catalogue_candidate') {
        const row = draft.proposal.content.services[Number(servicePath[1])], candidate = rec(observation.result.candidate);
        if (!row || !Array.isArray(serviceRefs) || !serviceRefs.includes(row.id) || row.id !== observation.criteria.serviceId ||
            valueAt(draft, `/proposal/content/services/${servicePath[1]}/operation`) !== 'add' ||
            typeof candidate.code !== 'string' || !candidate.code.trim() || !candidate.itemId) return null;
        const bound = rec(observation.criteria.targetRef);
        if (bound.kind === 'saved_target') {
          const rows = valueAt(draft, `${root}/body/targets/include`);
          const index = Array.isArray(rows) ? rows.findIndex((entry) => rec(entry).id === bound.hintId) : -1;
          if (!row.targets.some((entry) => canonicalJson(entry.target) === canonicalJson(bound)) || index < 0 ||
              valueAt(draft, `${root}/body/targets/include/${index}/suggestedRef`) !== observation.criteria.targetObservationRef) return null;
        }
        set(`/proposal/content/services/${servicePath[1]}/code`, candidate.code); set(input.fieldPath, observation.ref);
      } else if (observation.kind === 'stay_candidate' && input.fieldPath.endsWith('/suggestedRef')) {
        if (!['amend', 'cancel', 'services', 'filing'].includes(request.kind)) return null;
        const match = input.fieldPath.match(/\/targets\/include\/([^/]+)\/suggestedRef$/);
        const targetMode = valueAt(draft, `${root}/body/targets/mode`);
        const rows = valueAt(draft, `${root}/body/targets/include`);
        const part = match ? decodeURIComponent(match[1]!) : '';
        const row = Array.isArray(rows) ? (/^\d+$/.test(part) ? rows[Number(part)] : rows.find((entry) => rec(entry).id === part)) : undefined;
        if (!row || rec(row).id !== (filingPath ? observation.criteria.targetHintId : observation.criteria.hintId) || targetMode !== 'explicit' ||
            reservationWorkflowV2SavedTargetLocked(draft, request.id, rec(row).id)) return null;
        const candidate = rec(observation.result.candidate ?? observation.result.preimage ?? observation.result.stay);
        if (!Object.keys(candidate).length) return null;
        const query = filingPath ? observation.criteria : rec(observation.criteria.query), targetPath = input.fieldPath.slice(0, -'/suggestedRef'.length);
        const hint = (entry: unknown) => typeof entry === 'string' ? entry.trim() || null : entry ?? null;
        for (const [field, queryField] of [['confirmation', 'confirmation'], ['guestName', 'guestName'],
          ['bookedArrival', 'bookedArrival'], ['bookedDeparture', 'bookedDeparture']] as const) {
          if (filingPath && field !== 'confirmation' && field !== 'bookedArrival') continue;
          const hintPath = `${targetPath}/${field}`;
          if (request.kind === 'amend' || request.kind === 'cancel') {
            let prefix = '';
            for (const part of hintPath.split('/').slice(1)) {
              prefix += `/${part}`;
              if (draft.fieldOverrides[prefix]?.state === 'unknown') return null;
            }
          }
          const expected = query[queryField] ?? (field === 'bookedArrival' ? query.arrival : field === 'bookedDeparture' ? query.departure : null) ?? null;
          let value = valueAt(draft, hintPath);
          if (filingPath && Array.isArray(rows)) {
            const override = draft.fieldOverrides[`${targetPath}/${field}`];
            if (!override || override.state === 'inherit') {
              const index = rows.indexOf(row);
              value = valueAt(draft, `${root}/body/targets/include/${index}/${field}`);
            }
          }
          if (request.kind === 'amend' || request.kind === 'cancel' ? hint(value) !== hint(expected) : (value || null) !== expected) return null;
        }
        set(input.fieldPath, observation.ref);
      } else if (observation.kind === 'guest_candidate' && request.kind === 'create' && input.fieldPath.endsWith('/guest/nativeSelectionRef')) {
        const parent = input.fieldPath.slice(0, -'/nativeSelectionRef'.length);
        const match = parent.match(/\/allocations\/(\d+)\/guest$/);
        const allocation = match ? request.body.allocations[Number(match[1])] : undefined;
        if (!allocation || observation.criteria.allocationId !== allocation.id) return null;
        const rows = Array.isArray(observation.result.candidates) ? observation.result.candidates : [observation.result];
        if (rows.length !== 1) return null;
        const candidate = rec(rows[0]);
        if (!/^\d{1,30}$/.test(String(candidate.nativeId ?? '')) || typeof candidate.firstName !== 'string' ||
            typeof candidate.lastName !== 'string' || !candidate.firstName.trim() || !candidate.lastName.trim()) return null;
        set(`${parent}/firstName`, candidate.firstName); set(`${parent}/lastName`, candidate.lastName);
        set(input.fieldPath, observation.ref);
        const emailPath = `${parent}/email`, email = valueAt(draft, emailPath);
        const issues = draft.proposal.issues.filter((issue) => !(issue.kind === 'guest_email_conflict' && issue.path === emailPath));
        if (typeof email === 'string' && email.trim() && typeof candidate.email === 'string' && candidate.email.trim() &&
            email.trim().toLowerCase() !== candidate.email.trim().toLowerCase()) issues.push({ path: emailPath, kind: 'guest_email_conflict',
          explanation: `Email in the request (${email}) differs from the selected Infor profile (${candidate.email}). Check which email belongs on this booking.`,
          evidenceRefs: [observation.ref] });
        proposal = { ...draft.proposal, issues };
      } else if (observation.kind === 'party_candidate' && input.fieldPath.endsWith('/nativeSelectionRef')) {
        const parent = input.fieldPath.slice(0, -'/nativeSelectionRef'.length);
        const field = parent.split('/').at(-1);
        const roles: Record<string, string> = { bookingAgency: 'agency', organization: 'organization', arAccount: 'ar_account',
          company: 'company', agency: 'agency' };
        if (!field || !roles[field] || observation.criteria.role !== roles[field] ||
            !((request.kind === 'create' && /\/body\/(shared|dateSections\/\d+\/defaults|allocations\/\d+\/overrides)\//.test(parent)) ||
              (request.kind === 'quote' && /\/body\/parties\//.test(parent)))) return null;
        const rows = Array.isArray(observation.result.candidates) ? observation.result.candidates : [observation.result];
        if (rows.length !== 1) return null;
        const candidate = rec(rows[0]);
        const nativeId = String(candidate.nativeId ?? '');
        if (!(request.kind === 'quote' ? /^[A-Za-z0-9._-]{1,64}$/ : /^\d{1,30}$/).test(nativeId) ||
            typeof candidate.name !== 'string' || !candidate.name.trim()) return null;
        for (const key of Object.keys(overrides)) if (key.startsWith(`${parent}/`)) delete overrides[key];
        set(parent, { name: candidate.name, candidateRefs: [], suggestedRef: null }); set(input.fieldPath, observation.ref);
      } else return null;
      return { draft: { ...draft, proposal, fieldOverrides: overrides, staffReviews: reviews } };
    } });
}

const NON_REVIEW_FIELDS = new Set(['id', 'sourceRefs', 'serviceRefs', 'documentRefs', 'candidateRefs',
  'priceObservationRefs', 'evidenceRefs', 'lookupResultRefs', 'previewObservationRefs']);

function reviewedGuestSelection(draft: ReservationWorkflowV2Draft, requestId: string, allocationId: string, guestPath: string): string | null {
  const guest = valueAt(draft, guestPath);
  if (!guest || typeof guest !== 'object' || Array.isArray(guest)) return null;
  const selectionPath = `${guestPath}/nativeSelectionRef`, override = draft.fieldOverrides[selectionPath];
  const selected = override?.state === 'set' ? override.value : override && override.state !== 'inherit' ? null
    : valueAt(draft, `${guestPath}/suggestedRef`);
  if (typeof selected !== 'string' || valueAt(draft, `${guestPath}/profileIntent`) !== 'existing_or_unknown') return null;
  const firstName = valueAt(draft, `${guestPath}/firstName`), lastName = valueAt(draft, `${guestPath}/lastName`);
  const email = valueAt(draft, `${guestPath}/email`);
  if (typeof firstName !== 'string' || !firstName.trim() || typeof lastName !== 'string' || !lastName.trim()) return null;
  const matches = draft.observations.filter((row) => row.ref === selected);
  if (matches.length !== 1) return null;
  const observation = matches[0]!;
  if (observation.kind !== 'guest_candidate' || observation.status !== 'complete' || !observation.coverage.complete ||
      observation.generationId !== draft.generationId || observation.propertyCode !== draft.propertyCode ||
      observation.sourceMessageId !== draft.source.messageId || observation.criteria.requestId !== requestId ||
      observation.criteria.allocationId !== allocationId || (observation.criteria.fieldPath !== selectionPath &&
        !(Array.isArray(observation.criteria.fieldPaths) && observation.criteria.fieldPaths.includes(selectionPath)))) return null;
  const pending: unknown[] = [observation.result], seen = new Set<object>(), candidates: Record<string, any>[] = [];
  while (pending.length) {
    const value = pending.shift();
    if (!value || typeof value !== 'object' || Array.isArray(value) || seen.has(value)) continue;
    seen.add(value);
    const row = rec(value);
    if (/^\d{1,30}$/.test(String(row.nativeId ?? ''))) candidates.push(row);
    for (const key of ['candidates', 'matches', 'guestCandidates', 'partyCandidates', 'results', 'result']) {
      if (Array.isArray(row[key])) pending.push(...row[key]);
      else if (row[key] && typeof row[key] === 'object') pending.push(row[key]);
    }
  }
  if (candidates.length !== 1) return null;
  const candidate = candidates[0]!;
  const normalize = (value: string) => value.normalize('NFKC').trim().replace(/\s+/gu, ' ').toLocaleLowerCase();
  if (typeof candidate.nativeId !== 'string' || !sameGuestName(candidate.firstName, firstName) || !sameGuestName(candidate.lastName, lastName) ||
      !sameGuestName(candidate.name ?? `${candidate.firstName} ${candidate.lastName}`, `${firstName} ${lastName}`) ||
      (typeof email === 'string' && email.trim() && (typeof candidate.email !== 'string' || normalize(candidate.email) !== normalize(email)))) return null;
  return selectionPath;
}

function reviewedPartySelection(draft: ReservationWorkflowV2Draft, requestId: string, workflow: 'create' | 'quote',
  partyPath: string, role: string, allocationIds: Set<string>): string | null {
  const party = valueAt(draft, partyPath);
  if (!party || typeof party !== 'object' || Array.isArray(party) || rec(party).kind === 'none') return null;
  const name = valueAt(draft, `${partyPath}/name`), path = `${partyPath}/nativeSelectionRef`;
  const override = draft.fieldOverrides[path];
  const selected = override?.state === 'set' ? override.value : override && override.state !== 'inherit' ? null
    : valueAt(draft, `${partyPath}/suggestedRef`);
  if (typeof name !== 'string' || !name.trim() || typeof selected !== 'string') return null;
  const matches = draft.observations.filter((row) => row.ref === selected);
  if (matches.length !== 1) return null;
  const observation = matches[0]!;
  if (observation.kind !== 'party_candidate' || observation.status !== 'complete' || !observation.coverage.complete ||
      observation.generationId !== draft.generationId || observation.propertyCode !== draft.propertyCode ||
      observation.sourceMessageId !== draft.source.messageId || observation.criteria.workflow !== workflow ||
      observation.criteria.requestId !== requestId || observation.criteria.role !== role ||
      (workflow === 'create' && (typeof observation.criteria.allocationId !== 'string' || !allocationIds.has(observation.criteria.allocationId))) ||
      (observation.criteria.fieldPath !== path && !(Array.isArray(observation.criteria.fieldPaths) && observation.criteria.fieldPaths.includes(path)))) return null;
  const result = rec(observation.result);
  const validId = (value: unknown) => typeof value === 'string' &&
    (workflow === 'quote' ? /^[A-Za-z0-9._-]{1,64}$/ : /^\d{1,30}$/).test(value);
  const pending: unknown[] = [result], seen = new Set<object>(), candidates: Record<string, any>[] = [];
  while (pending.length) {
    const value = pending.shift();
    if (!value || typeof value !== 'object' || Array.isArray(value) || seen.has(value)) continue;
    seen.add(value);
    const row = rec(value);
    if (Object.hasOwn(row, 'nativeId') && !validId(row.nativeId)) return null;
    if (validId(row.nativeId)) candidates.push(row);
    for (const key of ['candidates', 'matches', 'guestCandidates', 'partyCandidates', 'results', 'result']) {
      if (Array.isArray(row[key])) pending.push(...row[key]);
      else if (row[key] && typeof row[key] === 'object') pending.push(row[key]);
    }
  }
  const candidate = workflow === 'quote' ? result : candidates[0];
  const norm = (value: unknown) => typeof value === 'string' ? value.normalize('NFKC').trim().replace(/\s+/gu, ' ').toLocaleLowerCase() : '';
  if (!candidate || !validId(candidate.nativeId) ||
      !norm(candidate.name) || norm(candidate.name) !== norm(name) ||
      (workflow === 'create' && candidates.length !== 1) ||
      (workflow === 'quote' && (!candidates.length || candidates.some((row) =>
        String(row.nativeId) !== candidate.nativeId || norm(row.name) !== norm(candidate.name))))) return null;
  return path;
}

function reviewedFilingSelection(draft: ReservationWorkflowV2Draft, requestId: string, root: string): string | null {
  const request = draft.proposal.content.requests.find((row) => row.id === requestId);
  if (!request || request.kind !== 'filing') return null;
  const effective = (path: string, source: unknown) => {
    const override = draft.fieldOverrides[path];
    return !override || override.state === 'inherit' ? source : override.state === 'set' ? override.value : null;
  };
  const scope = { mode: valueAt(draft, `${root}/body/targets/mode`),
    include: valueAt(draft, `${root}/body/targets/include`), exclude: valueAt(draft, `${root}/body/targets/exclude`) };
  if (scope.mode !== 'explicit' || !Array.isArray(scope.include) || scope.include.length !== 1 ||
      !Array.isArray(scope.exclude) || scope.exclude.length) return null;
  const hint = { ...rec(scope.include[0]) };
  if (typeof hint.id !== 'string') return null;
  for (const field of ['confirmation', 'guestName', 'bookedArrival', 'bookedDeparture']) {
    const path = `${root}/body/targets/include/${encodeURIComponent(hint.id)}/${field}`;
    const value = effective(path, valueAt(draft, `${root}/body/targets/include/0/${field}`));
    if (value !== undefined && typeof value !== 'string') return null;
    hint[field] = value;
  }
  const refs = effective(`${root}/documentRefs`, request.documentRefs);
  if (!Array.isArray(refs)) return null;
  const documents = draft.proposal.content.documents.filter((row) => row.ownerRequestId === requestId && refs.includes(row.id));
  if (documents.length !== 1 || !documents[0]!.targetRefs.some((target) => target.kind === 'saved_target' &&
      target.requestId === requestId && target.hintId === hint.id)) return null;
  const path = `${root}/body/targets/include/${encodeURIComponent(hint.id)}/suggestedRef`;
  const selected = effective(path, hint.suggestedRef), matches = draft.observations.filter((row) => row.ref === selected);
  if (typeof selected !== 'string' || matches.length !== 1) return null;
  const observation = matches[0]!, stay = rec(observation.result.stay);
  const isoDay = (value: unknown): value is string => typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value) &&
    Number.isFinite(Date.parse(`${value}T00:00:00.000Z`)) && new Date(`${value}T00:00:00.000Z`).toISOString().slice(0, 10) === value;
  const arrival = typeof stay.arrival === 'string' ? stay.arrival.trim() : null;
  const departure = typeof stay.departure === 'string' ? stay.departure.trim() : null;
  if (observation.kind !== 'stay_candidate' || observation.status !== 'complete' || !observation.coverage.complete ||
      observation.generationId !== draft.generationId || observation.propertyCode !== draft.propertyCode ||
      observation.sourceMessageId !== draft.source.messageId || observation.criteria.workflow !== 'filing' ||
      observation.criteria.requestId !== requestId || observation.criteria.targetHintId !== hint.id || observation.result.outcome !== 'found' ||
      !['confirmation', 'arrival', 'departure', 'firstName', 'lastName', 'status'].every((key) => {
        const value = stay[key]; return typeof value === 'string' && value.trim();
      }) || !isoDay(arrival) || !isoDay(departure) || departure <= arrival ||
      (hint.confirmation && hint.confirmation !== stay.confirmation.trim()) || (hint.bookedArrival && hint.bookedArrival !== arrival) ||
      (hint.bookedDeparture && hint.bookedDeparture !== departure)) return null;
  const name = (value: string) => value.trim().replace(/\s+/g, ' ').toLocaleLowerCase();
  if (hint.guestName && (typeof hint.guestName !== 'string' || name(hint.guestName) !== name(`${stay.firstName} ${stay.lastName}`))) return null;
  return path;
}

export function reviewReservationWorkflowV2Scope(ctx: ReservationWorkflowV2Context,
  input: z.infer<typeof reservationWorkflowV2ReviewScopeInputSchema>) {
  return withLockedV2DraftMutation(ctx, input, { fieldPath: `/reviewScope/${input.requestId}`, eventType: 'field.accept',
    value: { requestId: input.requestId, scope: input.scope, ids: input.ids }, apply: (original) => {
      const draft = materializeCreateAllocations(original, input.requestId);
      if (!draft) return null;
      const request = draft.proposal.content.requests.find((row) => row.id === input.requestId);
      if (!request || new Set(input.ids).size !== input.ids.length) return null;
      const root = ptr('proposal', 'content', 'requests', request.id), ids = new Set(input.ids);
      const roots: Array<{ path: string; value: unknown }> = [];
      if (input.scope === 'request') {
        if (ids.size && (ids.size !== 1 || !ids.has(request.id))) return null;
        roots.push({ path: `${root}/body`, value: request.body });
        if (request.kind === 'filing') {
          const refs = valueAt(draft, `${root}/documentRefs`);
          const documents = Array.isArray(refs) ? draft.proposal.content.documents.filter((row) =>
            row.ownerRequestId === request.id && refs.includes(row.id)) : [];
          if (documents.length === 1) roots.push({ path: ptr('proposal', 'content', 'documents', documents[0]!.id), value: documents[0] });
        }
      } else if (input.scope === 'allocations') {
        if (request.kind !== 'create' || !ids.size || [...ids].some((id) => !request.body.allocations.some((row) => row.id === id))) return null;
        const sections = valueAt(draft, `${root}/body/dateSections`);
        if (!Array.isArray(sections)) return null;
        roots.push({ path: `${root}/body/shared`, value: request.body.shared });
        request.body.allocations.forEach((row, index) => {
          if (!ids.has(row.id)) return;
          roots.push({ path: `${root}/body/allocations/${index}`, value: row });
          const sectionIndex = sections.findIndex((section) => rec(section).id === row.dateSectionId);
          if (sectionIndex >= 0) roots.push({ path: `${root}/body/dateSections/${sectionIndex}`, value: sections[sectionIndex] });
        });
      } else if (input.scope === 'targets') {
        if (!('targets' in request.body) || !ids.size) return null;
        const scope = rec(valueAt(draft, `${root}/body/targets`)), rows = valueAt(draft, `${root}/body/targets/include`);
        if (!Array.isArray(rows) || [...ids].some((id) => !rows.some((row) => rec(row).id === id))) return null;
        roots.push({ path: `${root}/body/targets/mode`, value: scope.mode });
        rows.forEach((row, index) => { if (ids.has(rec(row).id)) roots.push({ path: `${root}/body/targets/include/${index}`, value: row }); });
        if (request.kind === 'amend') {
          roots.push({ path: `${root}/body/sharedChanges`, value: request.body.sharedChanges });
          const perTarget = valueAt(draft, `${root}/body/perTarget`);
          if (Array.isArray(perTarget)) perTarget.forEach((row, index) => {
            const hintId = rec(row).hintId, hintIndex = rows.findIndex((hint) => rec(hint).id === hintId);
            if (!ids.has(hintId) || hintIndex < 0) return;
            const selectionPath = `${root}/body/targets/include/${hintIndex}/suggestedRef`;
            const selected = valueAt(draft, selectionPath);
            if (!draft.observations.some((observation) => observation.ref === selected && observation.kind === 'stay_candidate' &&
                observation.status === 'complete' && observation.coverage.complete && observation.generationId === draft.generationId &&
                observation.propertyCode === draft.propertyCode && observation.sourceMessageId === draft.source.messageId &&
                observation.criteria.workflow === 'amend' && observation.criteria.requestId === request.id &&
                observation.criteria.hintId === hintId && observation.criteria.selectionPath === selectionPath)) return;
            roots.push({ path: `${root}/body/perTarget/${index}`, value: row });
          });
        }
      } else {
        const rows = input.scope === 'services' ? draft.proposal.content.services : draft.proposal.content.documents;
        const refs = valueAt(draft, `${root}/${input.scope === 'services' ? 'serviceRefs' : 'documentRefs'}`);
        if (!Array.isArray(refs) || !ids.size || [...ids].some((id) => !refs.includes(id) || !rows.some((row) => row.id === id))) return null;
        rows.forEach((row, index) => { if (ids.has(row.id)) roots.push({ path: ptr('proposal', 'content', input.scope,
          request.kind === 'filing' && input.scope === 'documents' ? row.id : index), value: row }); });
      }
      const reviews = { ...draft.staffReviews }, now = new Date().toISOString();
      const preparedQuote = request.kind === 'quote' && input.scope === 'request' && [...draft.operationResults].reverse().find((entry) =>
        entry.workflow === 'quote' && entry.requestId === request.id && entry.generationId === draft.generationId && entry.status === 'prepared');
      const hasPreparedExtras = preparedQuote && draft.observations.some((observation) => preparedQuote.observationRefs.includes(observation.ref) &&
        observation.kind === 'rate_availability' && observation.status === 'complete' && observation.coverage.complete &&
        observation.generationId === draft.generationId && observation.propertyCode === draft.propertyCode &&
        observation.sourceMessageId === draft.source.messageId && observation.criteria.workflow === 'quote' &&
        observation.criteria.requestId === request.id && Array.isArray(observation.result.extrasReviewItems) &&
        observation.result.extrasReviewItems.some((item) => typeof item === 'string' && item.trim()));
      const walk = (path: string, source: unknown) => {
        const last = decodeURIComponent(path.split('/').at(-1) ?? '');
        if (NON_REVIEW_FIELDS.has(last)) return;
        if (request.kind === 'create' && /\/body\/allocations\/\d+\/guest\/nativeSelectionRef$/.test(path)) return;
        if ((request.kind === 'create' || request.kind === 'quote') &&
            /\/(?:bookingAgency|organization|arAccount|company|agency)\/nativeSelectionRef$/.test(path)) return;
        const override = draft.fieldOverrides[path];
        if (override?.state === 'unknown') return;
        if (override?.state === 'none' || override?.state === 'clear') {
          reviews[path] = { status: 'accepted', note: null, at: now }; return;
        }
        const change = /\/(?:sharedChanges\/\d+|perTarget\/\d+\/changes\/\d+)$/.test(path);
        if (change && ['none', 'clear', 'unknown'].includes(draft.fieldOverrides[`${path}/op`]?.state ?? '')) return;
        const value = override?.state === 'set' ? override.value : source;
        const parent = path.slice(0, path.lastIndexOf('/'));
        const clearValue = last === 'value' && valueAt(draft, `${parent}/op`) === 'clear' &&
          ['guestEmail', 'bookerName', 'bookerContact', 'cmsSend', 'cmsMessageId', 'cmsRecipient'].includes(String(valueAt(draft, `${parent}/field`)));
        const reviewedEmpty = request.kind === 'quote' || (last === 'comment' && override?.state === 'set');
        if ((value === null || value === undefined || (value === '' && !reviewedEmpty)) && !clearValue) return;
        if (!(request.kind === 'quote' && input.scope === 'request' && path === `${root}/body` && !hasPreparedExtras))
          reviews[path] = { status: 'accepted', note: null, at: now };
        if (Array.isArray(value)) value.forEach((row, index) => walk(`${path}/${index}`, row));
        else if (typeof value === 'object') {
          const object = rec(value), keys = new Set(Object.keys(object));
          if (change && valueAt(draft, `${path}/op`) === 'clear') keys.add('value');
          for (const key of Object.keys(draft.fieldOverrides)) if (key.startsWith(`${path}/`)) {
            const child = key.slice(path.length + 1).split('/')[0]; if (child) keys.add(decodeURIComponent(child));
          }
          for (const key of keys) walk(`${path}/${encodeURIComponent(key)}`, object[key]);
        }
      };
      roots.forEach(({ path }) => walk(path, valueAt(draft, path)));
      if (request.kind === 'create' && input.scope === 'allocations') request.body.allocations.forEach((row, index) => {
        if (!ids.has(row.id)) return;
        const guestPath = `${root}/body/allocations/${index}/guest`;
        delete reviews[`${guestPath}/nativeSelectionRef`];
        const path = reviewedGuestSelection(draft, request.id, row.id, guestPath);
        if (path) reviews[path] = { status: 'accepted', note: null, at: now };
      });
      if (request.kind === 'create' && input.scope === 'allocations') {
        const all = request.body.allocations;
        const parties: Array<{ path: string; role: string; allocations: Set<string> }> = [];
        const add = (base: string, allocations: Set<string>) => {
          for (const [key, role] of [['bookingAgency', 'agency'], ['organization', 'organization'], ['arAccount', 'ar_account']] as const)
            parties.push({ path: `${base}/${key}`, role, allocations });
        };
        add(`${root}/body/shared`, new Set(all.map((row) => row.id)));
        const sections = valueAt(draft, `${root}/body/dateSections`);
        if (Array.isArray(sections)) sections.forEach((section, index) => {
          const sectionId = rec(section).id;
          if (all.some((row) => ids.has(row.id) && row.dateSectionId === sectionId))
            add(`${root}/body/dateSections/${index}/defaults`, new Set(all.filter((row) => row.dateSectionId === sectionId).map((row) => row.id)));
        });
        all.forEach((row, index) => { if (ids.has(row.id)) add(`${root}/body/allocations/${index}/overrides`, new Set([row.id])); });
        for (const party of parties) {
          delete reviews[`${party.path}/nativeSelectionRef`];
          const path = reviewedPartySelection(draft, request.id, 'create', party.path, party.role, party.allocations);
          if (path) reviews[path] = { status: 'accepted', note: null, at: now };
        }
      }
      if (request.kind === 'quote' && input.scope === 'request') for (const role of ['company', 'agency'] as const) {
        const party = `${root}/body/parties/${role}`;
        delete reviews[`${party}/nativeSelectionRef`];
        const path = reviewedPartySelection(draft, request.id, 'quote', party, role, new Set());
        if (path) reviews[path] = { status: 'accepted', note: null, at: now };
      }
      if (request.kind === 'filing' && input.scope === 'request') {
        const path = reviewedFilingSelection(draft, request.id, root);
        if (path) reviews[path] = { status: 'accepted', note: null, at: now };
      }
      return { draft: { ...draft, staffReviews: reviews } };
    } });
}

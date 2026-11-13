import { createHash, randomUUID } from 'node:crypto';
import { isVerifiedCreateFilingCandidate, verifyCreateAllocationDependency } from './reservation-workflow-v2-filing.js';
import { readResolvedHmsLabtestCreates } from './hms-labtest-dispatch.js';
import type { z } from 'zod';
import type { ReservationWorkflowV2Draft, ReservationWorkflowV2Proposal } from './reservation-workflow-v2-contract.js';
import { reservationWorkflowV2ProposalSchema, type reservationWorkflowV2AddActionInputSchema,
  type reservationWorkflowV2ChangeRowsInputSchema, type reservationWorkflowV2SelectNativeInputSchema,
  type reservationWorkflowV2ReviewScopeInputSchema } from './reservation-workflow-v2-contract.js';
import { withLockedV2DraftMutation, reservationWorkflowV2SavedTargetLocked, reservationWorkflowV2SavedTargetOperationLocks,
  type ReservationWorkflowV2Context } from './reservation-workflow-v2-state.js';
import { nativeStructureIsSafe, rebaseReservationV2Path, rebaseReservationV2Observations } from './work-item-revision.js';
import { sameGuestName } from './guest-name-match.js';
import { canonicalJson } from './draft-approval.js';
import { currentLead } from './reservation-workflow-v2-verify-lead.js';

const ptr = (...parts: (string | number)[]) => '/' + parts.map((part) => encodeURIComponent(String(part))).join('/');
const rec = (value: unknown): Record<string, any> => value && typeof value === 'object' && !Array.isArray(value)
  ? value as Record<string, any> : {};
const id = () => randomUUID();
type FilingRequest = Extract<ReservationWorkflowV2Draft['proposal']['content']['requests'][number], { kind: 'filing' }>;
type FilingTargetHint = NonNullable<FilingRequest['body']['targets']>['include'][number];
type CancelRequest = Extract<ReservationWorkflowV2Draft['proposal']['content']['requests'][number], { kind: 'cancel' }>;
type QuoteRequest = Extract<ReservationWorkflowV2Draft['proposal']['content']['requests'][number], { kind: 'quote' }>;
type QuoteDocument = ReservationWorkflowV2Proposal['content']['documents'][number];
const occupancy = () => ({ adults: null, childCount: null, childAges: null });
const hint = () => ({ id: id(), candidateRefs: [], suggestedRef: null, sourceRefs: [] });
const scope = () => ({ mode: 'explicit' as const, include: [hint()], exclude: [], sourceRefs: [] });
const section = () => ({ id: id(), arrival: null, departure: null, requestedRooms: 1,
  requestedTotals: occupancy(), defaults: {}, unassignedGuestNames: [] });
const allocation = (dateSectionId: string) => ({ id: id(), dateSectionId, overrides: {},
  guest: { firstName: null, lastName: null, email: null, mobile: null, profileIntent: 'existing_or_unknown' as const,
    candidateRefs: [], suggestedRef: null }, occupancy: occupancy(), priceObservationRefs: [] });
const group = () => ({ id: id(), arrival: null, departure: null, quantity: null, mealPlan: null, roomCodes: [],
  ratePlan: null, occupancy: { ...occupancy(), scope: 'unresolved' as const }, priceObservationRefs: [] });
const service = (requestId: string) => ({ id: id(), ownerRequestId: requestId, operation: 'add' as const,
  requestedText: '', code: null, itemCandidateRef: null, sharedFields: {}, requestedMoney: [], targets: [],
  quantityRequest: { value: null, scope: 'unresolved' as const, sourceRefs: [] }, sourceRefs: [] });
const document = (requestId: string) => ({ id: id(), ownerRequestId: requestId, documentSourceRef: `manual_${id()}`,
  kind: 'unclassified' as const, handling: 'filing_requested' as const, targetRefs: [], requestedName: null,
  requestedDescription: null, uploadArtifactRef: null, sourceRefs: [] });

/** Only exact, current-source context PDFs may be copied across split Quote actions. */
function quoteSplitContextDocuments(draft: ReservationWorkflowV2Draft, proposal: ReservationWorkflowV2Proposal,
  request: QuoteRequest): QuoteDocument[] | null {
  const requestRoot = ptr('proposal', 'content', 'requests', request.id);
  const effectiveRefs = valueAt(draft, `${requestRoot}/documentRefs`);
  if (!Array.isArray(effectiveRefs) || effectiveRefs.length !== request.documentRefs.length ||
      effectiveRefs.some((ref, index) => ref !== request.documentRefs[index]) ||
      new Set(request.documentRefs).size !== request.documentRefs.length) return null;

  const currentRefs = new Set(request.sourceRefs);
  const documents: QuoteDocument[] = [];
  const documentSources = new Set<string>();
  for (const documentId of request.documentRefs) {
    const matches = proposal.content.documents.filter((row) => row.id === documentId);
    if (matches.length !== 1) return null;
    const stored = matches[0]!;
    const effective = effectiveTree(draft, ptr('proposal', 'content', 'documents', stored.id), stored) as QuoteDocument;
    if (stored.ownerRequestId !== request.id || effective.id !== stored.id || effective.ownerRequestId !== request.id ||
        stored.handling !== 'context' || effective.handling !== 'context' || !Array.isArray(stored.targetRefs) ||
        !Array.isArray(effective.targetRefs) || stored.targetRefs.length || effective.targetRefs.length ||
        stored.uploadArtifactRef !== null || effective.uploadArtifactRef !== null ||
        effective.documentSourceRef !== stored.documentSourceRef ||
        JSON.stringify(effective.sourceRefs) !== JSON.stringify(stored.sourceRefs) ||
        !stored.sourceRefs.includes(stored.documentSourceRef) ||
        stored.sourceRefs.some((ref) => !currentRefs.has(ref)) || !currentRefs.has(stored.documentSourceRef) ||
        documentSources.has(stored.documentSourceRef)) return null;
    documentSources.add(stored.documentSourceRef);
    documents.push(effective);
  }
  return documents;
}

function duplicateQuoteDocumentState(draft: ReservationWorkflowV2Draft,
  copies: Array<{ fromId: string; toId: string }>): void {
  for (const { fromId, toId } of copies) {
    const from = ptr('proposal', 'content', 'documents', fromId), to = ptr('proposal', 'content', 'documents', toId);
    for (const key of ['annotations', 'issues', 'sourceClaims'] as const) {
      const rows = draft.proposal[key] as Array<{ path: string }>;
      const additional = rows.flatMap((row) => row.path === from || row.path.startsWith(`${from}/`)
        ? [{ ...row, path: `${to}${row.path.slice(from.length)}` }] : []);
      rows.push(...additional as typeof rows);
    }
    for (const key of ['fieldOverrides', 'staffReviews', 'fieldReviewRequirements'] as const) {
      const values = draft[key] as Record<string, unknown>;
      for (const [path, value] of Object.entries(values)) if (path === from || path.startsWith(`${from}/`))
        values[`${to}${path.slice(from.length)}`] = structuredClone(value);
    }
  }
}

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
    const path = rebaseReservationV2Path(row.path, pathBefore, pathAfter);
    const newRequest = /^\/proposal\/content\/requests\/([^/]+)/.exec(row.path)?.[1];
    const introduced = newRequest && !pathBefore.content.requests.some(request => request.id === decodeURIComponent(newRequest)) &&
      pathAfter.content.requests.some(request => request.id === decodeURIComponent(newRequest));
    return path ? [{ ...row, path }] : introduced ? [row] : [];
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
        outputIntent: { artifacts: ['email_quote', 'pdf_quote', 'xlsx_quote'], evidenceRefs: [] }, provisionalBookingRequested: false } };
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
    apply: async (original, tx) => {
      const draft = structuredClone(original), proposal = draft.proposal;
      const request = proposal.content.requests.find((row) => row.id === input.requestId);
      if (!request) return null;
      const root = ptr('proposal', 'content', 'requests', request.id);
      const changedRoots: string[] = [];
      const copiedQuoteDocumentIds: Array<{ fromId: string; toId: string }> = [];
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
      const paths = input.kind === 'separate_filing_target' ? ['/proposal/content/requests', '/proposal/content/documents', `${root}/documentRefs`]
        : input.kind === 'separate_cancel_target' ? ['/proposal/content/requests', includeRoot]
        : input.kind === 'link_created_addon_target' ? ['/proposal/content/requests', '/proposal/content/services',
          `${root}/serviceRefs`, `${root}/body/allocations`]
        : input.kind.includes('allocation') ? [`${root}/body/allocations`]
        : input.kind.includes('date_section') ? [`${root}/body/dateSections`, `${root}/body/allocations`]
        : input.kind.includes('quote_group') ? [`${root}/body/groups`]
        : input.kind.includes('target') ? [includeRoot, ...(request.kind === 'amend' ? [`${root}/body/perTarget`] : [])]
        : input.kind.includes('service') ? ['/proposal/content/services', `${root}/serviceRefs`]
        : input.kind.includes('document') ? ['/proposal/content/documents', `${root}/documentRefs`]
        : ['/proposal/content/requests', '/proposal/content/services', '/proposal/content/documents'];
      if (!paths.every(materializeArray)) return null;
      if (input.kind === 'separate_filing_target') {
        if (!input.targetHintId || !input.documentId || !input.targetDisposition) return null;
        const next = separateFilingTargetDraft(draft, input.requestId, input.documentId, input.targetHintId, input.targetDisposition);
        return next && safeStructure(original, next.draft) ? next : null;
      }
      if (input.kind === 'separate_cancel_target') {
        if (!input.entityId) return null;
        const next = separateCancelTargetDraft(draft, input.requestId, input.entityId);
        return next && safeStructure(original, next.draft) ? next : null;
      }
      if (input.kind === 'link_created_addon_target') {
        if (!input.allocationId || !input.serviceId) return null;
        const serviceIndex = proposal.content.services.findIndex(row => row.id === input.serviceId);
        if (serviceIndex < 0 || !materializeArray(`${ptr('proposal', 'content', 'services', serviceIndex)}/targets`)) return null;
        const target = { kind: 'allocation' as const, requestId: input.requestId, allocationId: input.allocationId };
        let receipts: Awaited<ReturnType<typeof readResolvedHmsLabtestCreates>>;
        try { receipts = await readResolvedHmsLabtestCreates(tx, input.workItemId); }
        catch { return null; }
        const resolution = verifyCreateAllocationDependency(draft, target, receipts, ctx.transportId);
        if (resolution.status !== 'succeeded') return null;
        const next = linkCreatedAddonTargetDraft(draft, input.requestId, input.allocationId, input.serviceId, resolution.proof);
        return next && safeStructure(original, next.draft) ? next : null;
      }
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
          if (!input.childIds || children.length !== input.childIds.length || children.some((child) => !input.childIds!.includes(child))) return null;
          request.body.dateSections = request.body.dateSections.filter((row) => row.id !== date.id);
          request.body.allocations = request.body.allocations.filter((row) => !children.includes(row.id));
          children.forEach((child) => removeLinked('allocation', child));
          changedRoots.push(`${root}/body/dateSections`, `${root}/body/allocations`); break;
        }
        case 'split_quote_dates': {
          if (request.kind !== 'quote' || request.serviceRefs.length ||
              draft.operationResults.some(row => row.requestId === request.id && ['succeeded', 'unknown'].includes(row.status))) return null;
          const contextDocuments = quoteSplitContextDocuments(draft, proposal, request);
          if (!contextDocuments) return null;
          if (request.body.requestedMoney.some((claim, index) => valueAt(draft, `${root}/body/requestedMoney/${index}/staffAllowanceType`) !== 'unsupported' || !proposal.content.requests.some(row => row.kind === 'other' &&
              row.body.separatedFrom?.requestId === request.id && row.body.separatedFrom.moneyId === claim.id))) return null;
          const groups = request.body.groups.map((row, index) => effectiveTree(draft, `${root}/body/groups/${index}`, row) as typeof row);
          const buckets = new Map<string, typeof groups>();
          for (const row of groups) {
            if (!row.arrival || !row.departure) return null;
            const key = `${row.arrival}:${row.departure}`;
            buckets.set(key, [...(buckets.get(key) ?? []), row]);
          }
          if (buckets.size < 2 || proposal.content.requests.length + buckets.size - 1 > 200) return null;
          if (proposal.content.documents.length + contextDocuments.length * (buckets.size - 1) > 200) return null;
          const effectiveBody = effectiveTree(draft, `${root}/body`, request.body) as typeof request.body;
          // Native party selections are staff-only evidence, not proposal fields.
          // Keep the original request's selection in its override; the split
          // requests get a fresh lookup rather than reusing a request-bound ref.
          for (const role of ['organization', 'bookingAgency'] as const) {
            const party = effectiveBody.parties[role] as (typeof effectiveBody.parties)[typeof role] & Record<string, unknown>;
            if (party && typeof party === 'object') delete party.nativeSelectionRef;
          }
          const dateGroups = [...buckets.values()];
          request.body = { ...effectiveBody, groups: dateGroups[0]! };
          dateGroups.slice(1).forEach(rows => {
            const requestId = id(); createdId ??= requestId;
            const splitBody = structuredClone(effectiveBody);
            for (const role of ['organization', 'bookingAgency'] as const) {
              const party = splitBody.parties[role];
              if (party && typeof party === 'object' && 'candidateRefs' in party && 'suggestedRef' in party) {
                party.candidateRefs = [];
                party.suggestedRef = null;
              }
            }
            const splitRequest = { ...structuredClone(request), id: requestId, documentRefs: [] as string[],
              body: { ...splitBody, groups: rows, requestedMoney: [] } };
            for (const sourceDocument of contextDocuments) {
              const documentId = id();
              proposal.content.documents.push({ ...structuredClone(sourceDocument), id: documentId, ownerRequestId: requestId });
              splitRequest.documentRefs.push(documentId);
              copiedQuoteDocumentIds.push({ fromId: sourceDocument.id, toId: documentId });
            }
            proposal.content.requests.push(splitRequest);
            const nextRoot = ptr('proposal', 'content', 'requests', requestId);
            const groupIds = new Set(rows.map(row => row.id));
            const remap = (path: string): string | null => {
              if (!path.startsWith(`${root}/`) || path.startsWith(`${root}/body/requestedMoney/`)) return null;
              const match = /\/groups\/(\d+)(?:\/|$)/.exec(path);
              if (!match) return path.replace(root, nextRoot);
              const groupId = groups[Number(match[1])]?.id;
              if (!groupId || !groupIds.has(groupId)) return null;
              return path.replace(root, nextRoot).replace(`/groups/${match[1]}`, `/groups/${rows.findIndex(row => row.id === groupId)}`);
            };
            for (const key of ['annotations', 'sourceClaims', 'issues'] as const) {
              const additional = before[key].flatMap(row => { const path = remap(row.path); return path ? [{ ...row, path }] : []; });
              (proposal[key] as Array<{ path: string }>).push(...additional);
            }
          });
          // The materialized bodies now own the staff values; old checks and reviews are invalidated.
          changedRoots.push(`${root}/body/groups`);
          for (const path of Object.keys(draft.fieldOverrides)) if (path.startsWith(`${root}/body/`) &&
              !path.endsWith('/staffAllowanceType') && !/^\/proposal\/content\/requests\/[^/]+\/body\/parties\/(?:organization|bookingAgency)\/nativeSelectionRef$/.test(path)) {
            delete draft.fieldOverrides[path];
          }
          break;
        }
        case 'separate_quote_money': {
          if (request.kind !== 'quote' || !input.entityId || !/^\d{1,3}$/.test(input.entityId)) return null;
          const index = Number(input.entityId), claim = request.body.requestedMoney[index];
          if (!claim) return null;
          const base = `${root}/body/requestedMoney/${index}`;
          const amount = valueAt(draft, `${base}/amount`), currency = valueAt(draft, `${base}/currency`),
            unit = valueAt(draft, `${base}/unit`);
          const existing = proposal.content.requests.find(row => row.kind === 'other' &&
            row.body.separatedFrom?.requestId === request.id && row.body.separatedFrom.moneyId === claim.id);
          if (!existing) {
            if (proposal.content.requests.length >= 200) return null;
            createdId = id();
            proposal.content.requests.push({ id: createdId, kind: 'other', requestText: request.requestText,
              sourceRefs: [...new Set([...request.sourceRefs, ...claim.sourceRefs])], serviceRefs: [], documentRefs: [],
              body: { supported: false, separatedFrom: { requestId: request.id, moneyId: claim.id },
                requestedText: `Handle separately from the room quote: ${[currency, amount, unit].filter(v => v != null && typeof v !== 'object').join(' ')}. ${request.requestText}`.slice(0, 2000) } });
          } else {
            createdId = existing.id;
            if (existing.kind === 'other') existing.body.requestedText = `Handle separately from the room quote: ${[currency, amount, unit].filter(v => v != null && typeof v !== 'object').join(' ')}. ${request.requestText}`.slice(0, 2000);
          }
          const path = `${base}/staffAllowanceType`;
          draft.fieldOverrides[path] = { state: 'set', value: 'unsupported', updatedAt: new Date().toISOString() };
          draft.staffReviews[path] = { status: 'accepted', at: new Date().toISOString(), note: 'Staff retained this request as a separate task.' };
          break;
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
      duplicateQuoteDocumentState(next, copiedQuoteDocumentIds);
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

/** Materialize effective field values before moving rows between action tabs. */
function effectiveTree(draft: ReservationWorkflowV2Draft, path: string, original: unknown): unknown {
  const current = valueAt(draft, path);
  const value = current === undefined ? original : current;
  if (Array.isArray(value)) return value.map((row, index) => effectiveTree(draft, `${path}/${index}`, row));
  if (!value || typeof value !== 'object') return value;
  const keys = new Set(Object.keys(value));
  for (const overridePath of Object.keys(draft.fieldOverrides)) {
    if (!overridePath.startsWith(`${path}/`)) continue;
    const child = overridePath.slice(path.length + 1).split('/')[0];
    if (child) keys.add(decodeURIComponent(child));
  }
  return Object.fromEntries([...keys].filter(key => key !== 'staffAllowanceType').map(key =>
    [key, effectiveTree(draft, `${path}/${encodeURIComponent(key)}`, (value as Record<string, unknown>)[key])]));
}

function stableRowId(prefix: string, ...parts: string[]): string {
  return `${prefix}_${createHash('sha256').update(parts.join('\u001f')).digest('hex').slice(0, 32)}`;
}

/** Move one exact included Cancel stay into its own action so native reason/fee/review stay per-target. */
export function separateCancelTargetDraft(draft: ReservationWorkflowV2Draft, requestId: string, targetHintId: string):
  { draft: ReservationWorkflowV2Draft; createdId: string } | null {
  const proposal = structuredClone(draft.proposal);
  const request = proposal.content.requests.find(row => row.id === requestId);
  if (!request || request.kind !== 'cancel' || draft.operationResults.some(row => row.requestId === requestId &&
      reservationWorkflowV2SavedTargetOperationLocks(draft, row))) return null;

  const requestRoot = ptr('proposal', 'content', 'requests', requestId);
  const effectiveBody = effectiveTree(draft, `${requestRoot}/body`, request.body) as CancelRequest['body'];
  const scope = effectiveBody.targets;
  if (!scope || scope.mode !== 'explicit' || !Array.isArray(scope.include) || !Array.isArray(scope.exclude)) return null;

  const newRequestId = stableRowId('cancel', draft.workItemId, requestId, targetHintId);
  const newHintId = stableRowId('cancel_target', newRequestId, targetHintId);
  const existing = proposal.content.requests.find(row => row.id === newRequestId);
  if (existing) {
    if (scope.include.some(row => row.id === targetHintId) || existing.kind !== 'cancel') return null;
    const currentScope = existing.body.targets;
    const currentHint = currentScope?.include.length === 1 ? currentScope.include[0] : undefined;
    const expectedExclusions = scope.exclude.map(row => ({ ...row, candidateRefs: [], suggestedRef: null }));
    const sameSplit = currentScope?.mode === 'explicit' && canonicalJson(currentScope.exclude) === canonicalJson(expectedExclusions) &&
      currentHint?.id === newHintId && currentHint.candidateRefs.length === 0 && currentHint.suggestedRef === null &&
      /^\d{6,10}-\d{1,2}$/.test(currentHint.confirmation ?? '') &&
      canonicalJson(existing.body.reason) === canonicalJson(effectiveBody.reason) &&
      existing.body.cancellationNote === effectiveBody.cancellationNote;
    return sameSplit ? { draft, createdId: newRequestId } : null;
  }
  if (scope.include.length < 2 || proposal.content.requests.length >= 200) return null;
  const selected = scope.include.filter(row => row.id === targetHintId);
  if (selected.length !== 1) return null;
  const sourceIndex = scope.include.findIndex(row => row.id === targetHintId);
  const sourceHint = effectiveTree(draft, `${requestRoot}/body/targets/include/${sourceIndex}`, scope.include[sourceIndex]) as FilingTargetHint;
  const confirmation = typeof sourceHint.confirmation === 'string' ? sourceHint.confirmation.trim() : '';
  if (sourceHint.id !== targetHintId || !/^\d{6,10}-\d{1,2}$/.test(confirmation) ||
      scope.include.some(row => row.id !== targetHintId && typeof row.confirmation === 'string' && row.confirmation.trim() === confirmation)) return null;

  const newHint = { ...sourceHint, id: newHintId, confirmation,
    candidateRefs: [], suggestedRef: null };
  const exclusions = scope.exclude.map(row => ({ ...row, candidateRefs: [], suggestedRef: null }));
  const exclusionSourceRefs = exclusions.flatMap(row => row.sourceRefs);
  const sourceRefs = [...new Set([...request.sourceRefs, ...scope.sourceRefs, ...newHint.sourceRefs, ...exclusionSourceRefs])];
  const targetSourceRefs = [...new Set([...scope.sourceRefs, ...newHint.sourceRefs, ...exclusionSourceRefs])];
  if (sourceRefs.length > 100 || targetSourceRefs.length > 100) return null;
  const before = structuredClone(proposal);
  const remainingTargets = { ...scope, mode: 'explicit' as const,
    include: scope.include.filter(row => row.id !== targetHintId) };
  request.body.targets = remainingTargets;
  request.body.reason = structuredClone(effectiveBody.reason);
  request.body.cancellationNote = effectiveBody.cancellationNote;
  request.body.previewObservationRefs = [];

  const splitRequest: CancelRequest = { ...request, id: newRequestId,
    requestText: `Cancel separately · ${confirmation}`,
    sourceRefs,
    serviceRefs: [], documentRefs: [],
    body: { ...effectiveBody, targets: { ...scope, mode: 'explicit', include: [newHint], exclude: exclusions, sourceRefs: targetSourceRefs },
      previewObservationRefs: [] } };
  proposal.content.requests.push(splitRequest);
  const next = rebase(draft, before, proposal, [`${requestRoot}/body/previewObservationRefs`]);
  return { draft: next, createdId: newRequestId };
}

/** Clone exactly one Filing PDF/target pair without changing the source action or its exclusions. */
export function separateFilingTargetDraft(draft: ReservationWorkflowV2Draft, requestId: string, documentId: string,
  targetHintId: string, disposition: 'included' | 'excluded'):
  { draft: ReservationWorkflowV2Draft; createdId: string } | null {
  const proposal = structuredClone(draft.proposal);
  const requestIndex = proposal.content.requests.findIndex(row => row.id === requestId && row.kind === 'filing');
  const request = proposal.content.requests[requestIndex];
  if (!request || request.kind !== 'filing' || draft.operationResults.some(row => row.workflow === 'filing' &&
      row.requestId === requestId && (row.status === 'succeeded' || row.status === 'unknown'))) return null;

  const requestRoot = ptr('proposal', 'content', 'requests', request.id);
  const references = effectiveTree(draft, `${requestRoot}/documentRefs`, request.documentRefs);
  if (!Array.isArray(references) || references.filter(ref => ref === documentId).length !== 1) return null;
  const sourceDocument = proposal.content.documents.find(row => row.id === documentId && row.ownerRequestId === request.id);
  if (!sourceDocument) return null;
  const documentRoot = ptr('proposal', 'content', 'documents', sourceDocument.id);
  const effectiveDocument = effectiveTree(draft, documentRoot, sourceDocument) as typeof sourceDocument;
  const effectiveScope = rec(effectiveTree(draft, `${requestRoot}/body/targets`, request.body.targets));
  const selectedRows = disposition === 'included' ? effectiveScope.include : effectiveScope.exclude;
  const otherRows = disposition === 'included' ? effectiveScope.exclude : effectiveScope.include;
  if (!Array.isArray(selectedRows) || !Array.isArray(otherRows) ||
      selectedRows.filter(row => rec(row).id === targetHintId).length !== 1 ||
      [...selectedRows, ...otherRows].filter(row => rec(row).id === targetHintId).length !== 1) return null;
  const sourceIndex = selectedRows.findIndex(row => rec(row).id === targetHintId);
  const sourceHintPath = `${requestRoot}/body/targets/${disposition === 'included' ? 'include' : 'exclude'}`;
  const indexedHint = effectiveTree(draft, `${sourceHintPath}/${sourceIndex}`, selectedRows[sourceIndex]) as Record<string, unknown>;
  const sourceHintValues = { ...indexedHint };
  const identityPath = `${sourceHintPath}/${encodeURIComponent(targetHintId)}`;
  for (const [path, override] of Object.entries(draft.fieldOverrides)) {
    if (!path.startsWith(`${identityPath}/`)) continue;
    const field = path.slice(identityPath.length + 1);
    if (!field || field.includes('/')) continue;
    const key = decodeURIComponent(field);
    if (override.state === 'set') sourceHintValues[key] = override.value;
    else if (override.state !== 'inherit') sourceHintValues[key] = null;
  }
  const sourceHint = sourceHintValues as unknown as FilingTargetHint;
  if (!sourceHint || sourceHint.id !== targetHintId) return null;

  const linkedAllocations = effectiveDocument.targetRefs.filter(ref => ref.kind === 'allocation');
  if (linkedAllocations.length > 1) return null;
  const bodyTargetPath = `${requestRoot}/body/allocationTarget`;
  const bodyTarget = rec(effectiveTree(draft, bodyTargetPath, request.body.allocationTarget));
  const hasBodyTarget = typeof bodyTarget.requestId === 'string' || typeof bodyTarget.allocationId === 'string';
  const bodyTargetOverride = draft.fieldOverrides[bodyTargetPath];
  if (bodyTargetOverride && bodyTargetOverride.state !== 'inherit' && bodyTargetOverride.state !== 'set') return null;
  if (bodyTargetOverride?.state === 'set' && !hasBodyTarget && linkedAllocations.length) return null;
  if (hasBodyTarget && (linkedAllocations.length !== 1 || bodyTarget.requestId !== linkedAllocations[0]!.requestId ||
      bodyTarget.allocationId !== linkedAllocations[0]!.allocationId)) return null;

  const newRequestId = stableRowId('filing', request.id, sourceDocument.id, targetHintId);
  const newHintId = stableRowId('hint', newRequestId, targetHintId);
  const newDocumentId = stableRowId('document', newRequestId, sourceDocument.id);
  const existingRequest = proposal.content.requests.find(row => row.id === newRequestId);
  if (existingRequest) {
    const existingDocument = proposal.content.documents.find(row => row.id === newDocumentId);
    const existingScope = existingRequest.kind === 'filing' ? rec(existingRequest.body.targets) : {};
    return existingRequest.kind === 'filing' && existingDocument?.ownerRequestId === newRequestId &&
      existingDocument.documentSourceRef === effectiveDocument.documentSourceRef &&
      Array.isArray(existingScope.include) && existingScope.include.length === 1 &&
      rec(existingScope.include[0]).id === newHintId && existingRequest.documentRefs.length === 1 &&
      existingRequest.documentRefs[0] === newDocumentId ? { draft, createdId: newRequestId } : null;
  }
  if (proposal.content.requests.length >= 200 || proposal.content.documents.length >= 200) return null;

  const newHint: FilingTargetHint = { ...sourceHint, id: newHintId, candidateRefs: [], suggestedRef: null };
  const savedTargetRef = { kind: 'saved_target' as const, requestId: newRequestId, hintId: newHintId };
  const selectedSourceTarget = effectiveDocument.targetRefs.some(ref => ref.kind === 'saved_target' &&
    ref.requestId === request.id && ref.hintId === targetHintId);
  const allocationTarget = linkedAllocations.length === 1 && selectedSourceTarget ? linkedAllocations[0] : undefined;
  const newDocument = { ...effectiveDocument, id: newDocumentId, ownerRequestId: newRequestId,
    targetRefs: [savedTargetRef, ...(allocationTarget ? [allocationTarget] : [])], uploadArtifactRef: null };
  const linkedRequest = { ...request, id: newRequestId, serviceRefs: [], documentRefs: [newDocumentId],
    body: { targets: { mode: 'explicit' as const, include: [newHint], exclude: [],
      sourceRefs: Array.isArray(effectiveScope.sourceRefs) ? effectiveScope.sourceRefs : [] },
      ...(allocationTarget ? { allocationTarget: { requestId: allocationTarget.requestId, allocationId: allocationTarget.allocationId } } : {}) } };
  const before = structuredClone(proposal);
  proposal.content.requests.push(linkedRequest);
  proposal.content.documents.push(newDocument);
  const next = rebase(draft, before, proposal, []);
  const staffReviews = { ...next.staffReviews }, fieldReviewRequirements = { ...next.fieldReviewRequirements };
  for (const field of ['documentSourceRef', 'kind', 'handling'] as const) {
    const sourcePath = `${documentRoot}/${field}`, targetPath = `${ptr('proposal', 'content', 'documents', newDocumentId)}/${field}`;
    const review = draft.staffReviews[sourcePath];
    if (review?.status === 'accepted') staffReviews[targetPath] = review;
    const requirement = draft.fieldReviewRequirements[sourcePath];
    if (requirement) fieldReviewRequirements[targetPath] = requirement;
  }
  return { draft: { ...next, staffReviews, fieldReviewRequirements }, createdId: newRequestId };
}

type CreatedAddonProof = { requestId: string; allocationId: string; operationId: string; observationRef: string;
  confirmation: string; arrival: string; departure: string };

/** Make a saved Add-On action only from one verified Create receipt and one exact allocation row. */
export function linkCreatedAddonTargetDraft(draft: ReservationWorkflowV2Draft, requestId: string, allocationId: string,
  serviceId: string, proof: CreatedAddonProof): { draft: ReservationWorkflowV2Draft; createdId: string } | null {
  if (proof.requestId !== requestId || proof.allocationId !== allocationId || !/^\d{6,10}-\d{1,2}$/.test(proof.confirmation)) return null;
  const proposal = structuredClone(draft.proposal);
  const createRequest = proposal.content.requests.find(row => row.id === requestId && row.kind === 'create');
  if (!createRequest || createRequest.kind !== 'create' ||
      createRequest.body.allocations.filter(row => row.id === allocationId).length !== 1) return null;
  const serviceIndex = proposal.content.services.findIndex(row => row.id === serviceId);
  const sourceService = proposal.content.services[serviceIndex];
  if (!sourceService || sourceService.operation !== 'add' ||
      (sourceService.ownerRequestId !== null && sourceService.ownerRequestId !== requestId) ||
      proposal.content.requests.some(row => row.id !== requestId && row.serviceRefs.includes(serviceId))) return null;
  const serviceRoot = ptr('proposal', 'content', 'services', serviceIndex);
  const effectiveService = effectiveTree(draft, serviceRoot, sourceService) as typeof sourceService;
  const targetRows = effectiveService.targets.flatMap((target, index) => target.target.kind === 'allocation' &&
    target.target.requestId === requestId && target.target.allocationId === allocationId ? [{ target, index }] : []);
  if (targetRows.length !== 1) return null;
  const { target: sourceTarget, index: targetIndex } = targetRows[0]!;
  const serviceTargetPath = `${serviceRoot}/targets/${targetIndex}`;
  const effectiveTarget = effectiveTree(draft, serviceTargetPath, sourceTarget) as typeof sourceTarget;
  if (effectiveTarget.target.kind !== 'allocation' || effectiveTarget.target.requestId !== requestId ||
      effectiveTarget.target.allocationId !== allocationId) return null;

  const sourceServiceResults = draft.operationResults.filter(result => result.workflow === 'services' &&
    result.requestId === requestId && result.allocationId === allocationId);
  if (sourceServiceResults.some(result => result.status === 'unknown')) return null;
  if (sourceServiceResults.some(result => result.status === 'succeeded' && result.observationRefs.some(ref =>
    draft.observations.some(observation => observation.ref === ref && observation.criteria.serviceId === serviceId)))) return null;

  const sourceQuantity = rec(effectiveService.quantityRequest);
  if (effectiveService.targets.length > 1 && sourceQuantity.scope === 'overall' &&
      effectiveService.targets.some((target) => {
        const quantity = rec(target.fields).quantity;
        return typeof quantity !== 'string' || !/^(?=.*[1-9])\d+(?:\.\d+)?$/.test(quantity.trim());
      })) return null;
  const rescopeOverallQuantity = effectiveService.targets.length > 1 && sourceQuantity.scope === 'overall';
  const quantityRequest = rescopeOverallQuantity
    ? { ...effectiveService.quantityRequest, scope: 'unresolved' as const }
    : effectiveService.quantityRequest;
  const hasOverallPrice = effectiveService.requestedMoney.some(row => row.scope === 'overall');
  const exactPrice = rec(effectiveTarget.fields).unitPrice;
  if (effectiveService.targets.length > 1 && hasOverallPrice &&
      (typeof exactPrice !== 'string' || !/^(?=.*[1-9])\d+(?:\.\d+)?$/.test(exactPrice.trim()))) return null;

  const newRequestId = stableRowId('services', draft.workItemId, requestId, allocationId, serviceId);
  const newHintId = stableRowId('saved', newRequestId, proof.operationId, proof.observationRef);
  const newServiceId = stableRowId('service', newRequestId, serviceId);
  const existingRequest = proposal.content.requests.find(row => row.id === newRequestId);
  if (existingRequest) {
    const existingService = proposal.content.services.find(row => row.id === newServiceId);
    const scope = existingRequest.kind === 'services' ? rec(existingRequest.body.targets) : {};
    return existingRequest.kind === 'services' && Array.isArray(scope.include) && scope.include.length === 1 &&
      rec(scope.include[0]).id === newHintId && rec(scope.include[0]).confirmation === proof.confirmation &&
      existingRequest.serviceRefs.length === 1 && existingRequest.serviceRefs[0] === newServiceId &&
      existingService?.ownerRequestId === newRequestId && existingService.targets.length === 1 &&
      existingService.targets[0]?.target.kind === 'saved_target' && existingService.targets[0].target.requestId === newRequestId &&
      existingService.targets[0].target.hintId === newHintId ? { draft, createdId: newRequestId } : null;
  }
  if (proposal.content.requests.length >= 200 || proposal.content.services.length >= 200) return null;
  const sourceRefs = [...new Set([...effectiveService.sourceRefs, proof.observationRef])];
  if (sourceRefs.length > 100) return null;
  const hint = { id: newHintId, confirmation: proof.confirmation, bookedArrival: proof.arrival,
    bookedDeparture: proof.departure, candidateRefs: [], suggestedRef: null,
    sourceRefs: [proof.observationRef] };
  const serviceTarget = { target: { kind: 'saved_target' as const, requestId: newRequestId, hintId: newHintId },
    fields: effectiveTarget.fields, savedRowCandidateRef: null, previewObservationRef: null };
  const linkedService = { ...effectiveService, id: newServiceId, ownerRequestId: newRequestId, itemCandidateRef: null,
    quantityRequest: structuredClone(quantityRequest), targets: [serviceTarget] };
  const linkedRequest = { id: newRequestId, kind: 'services' as const,
    requestText: effectiveService.requestedText || createRequest.requestText, sourceRefs,
    serviceRefs: [newServiceId], documentRefs: [],
    body: { targets: { mode: 'explicit' as const, include: [hint], exclude: [], sourceRefs: [proof.observationRef] } } };
  const before = structuredClone(proposal);
  const remainingTargets = effectiveService.targets.filter((_, index) => index !== targetIndex);
  if (remainingTargets.length) {
    sourceService.targets = structuredClone(remainingTargets);
    if (rescopeOverallQuantity) sourceService.quantityRequest = structuredClone(quantityRequest);
  }
  else {
    proposal.content.services.splice(serviceIndex, 1);
    createRequest.serviceRefs = createRequest.serviceRefs.filter(ref => ref !== serviceId);
  }
  proposal.content.requests.push(linkedRequest);
  proposal.content.services.push(linkedService);
  // Keep the proven Create Add-On route available until staff explicitly link it. Once linked,
  // transfer only this allocation so the same native charge cannot be saved through both rows.
  const changedRoots = remainingTargets.length ? [`${serviceRoot}/targets`,
    ...(rescopeOverallQuantity ? [`${serviceRoot}/quantityRequest/scope`] : [])] : [];
  const next = rebase(draft, before, proposal, changedRoots);
  return { draft: next, createdId: newRequestId };
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
          if (filingPath && field === 'confirmation' && !value && isVerifiedCreateFilingCandidate(draft, request.id, observation)) {
            set(hintPath, expected);
          } else if (request.kind === 'amend' || request.kind === 'cancel' ? hint(value) !== hint(expected) : (value || null) !== expected) return null;
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
        const amendPath = request.kind === 'amend' && /\/body\/(?:sharedChanges\/\d+|perTarget\/\d+\/changes\/\d+)\/value$/.test(parent);
        const field = amendPath ? valueAt(draft, `${parent.slice(0, -'/value'.length)}/field`) : parent.split('/').at(-1);
        const roles: Record<string, string> = { bookingAgency: request.kind === 'quote' ? 'bookingAgency' : 'agency',
          organization: 'organization', arAccount: 'ar_account' };
        if (typeof field !== 'string' || !roles[field] || observation.criteria.role !== roles[field] ||
            !((request.kind === 'create' && /\/body\/(shared|dateSections\/\d+\/defaults|allocations\/\d+\/overrides)\//.test(parent)) ||
              (request.kind === 'quote' && /\/body\/parties\//.test(parent)) || amendPath) ||
            observation.criteria.workflow !== request.kind) return null;
        if (amendPath) {
          const changePath = parent.slice(0, -'/value'.length), query = observation.criteria.query;
          const name = valueAt(draft, `${parent}/name`);
          const normalize = (value: unknown) => typeof value === 'string'
            ? value.normalize('NFKC').trim().replace(/\s+/gu, ' ').toLocaleLowerCase() : '';
          if (valueAt(draft, `${changePath}/op`) !== 'set' || !normalize(name) || normalize(name) !== normalize(query)) return null;
        }
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
  const mobile = valueAt(draft, `${guestPath}/mobile`);
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
      (typeof email === 'string' && email.trim() && (typeof candidate.email !== 'string' || normalize(candidate.email) !== normalize(email))) ||
      (typeof mobile === 'string' && mobile.trim() && (typeof candidate.phoneNumber !== 'string' ||
        !mobile.replace(/\D/g, '') || candidate.phoneNumber.replace(/\D/g, '') !== mobile.replace(/\D/g, '')))) return null;
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
            /\/(?:bookingAgency|organization|arAccount)\/nativeSelectionRef$/.test(path)) return;
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
          ['guestEmail', 'bookerName', 'bookerEmail', 'bookerMobile', 'reservationNote', 'billingReference', 'roomTypeForCharge', 'cmsSend', 'cmsMessageId', 'cmsRecipient', 'guestOptIn'].includes(String(valueAt(draft, `${parent}/field`)));
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
      if (request.kind === 'quote' && input.scope === 'request') for (const role of ['organization', 'bookingAgency'] as const) {
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

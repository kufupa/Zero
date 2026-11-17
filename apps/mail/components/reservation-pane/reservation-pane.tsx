
'use client';

import { useEffect, useRef, useState } from 'react';
import { attentionFieldPath, inputFieldLabel } from '@/lib/reservation-workflow/client';
import { knownFailureCopy, staffFailureCopy } from '@/lib/reservation-workflow/failure-copy';
import { derivePaneStage, quoteReplyLabel } from '@/lib/reservation-workflow/pane-stage';
import { getQuoteOutput } from '@/lib/reservation-workflow/quote-output';
import type { ReservationPaneSnapshot, ReservationSkippedSource, ReservationSourceContext, ReservationWorkflowClient, ReservationWorkflowKind } from '@/lib/reservation-workflow/types';
import { cancelChargeForSelection, effectiveAt, guestProfileReceipt, nativeChoices, record, requestPath, text, valueAt, type WorkbenchEditorProps } from '@/lib/reservation-workflow/views';
import { MailSourceNoActionCard } from '@/components/nava-pane/blocks/mail-source-no-action';
import { QuoteOutputPanel, type SaveQuoteOutput } from './quote-output-panel';
import { useReservationWorkbench } from './use-reservation-workbench';
import { CreateEditor, resolveCreateCmsRecipientDefault } from './editors/create-editor';
import { useCmsRecipientDefault } from './shared/cms-recipient-default';
import { QuoteEditor } from './editors/quote-editor';
import { createReadiness } from '../../../server-pilot/src/ai/reservation-workflow-v2-create-readiness';
import { AmendEditor, isExactConfirmation } from './editors/amend-editor';
import { CancelEditor } from './editors/cancel-editor';
import { AddonsEditor } from './editors/addons-editor';
import { FilingEditor } from './editors/filing-editor';
import styles from './reservation-pane.module.css';

export type ReservationPaneProps = {
  source: ReservationSourceContext; activeProperty: import('@/lib/reservation-workflow/types').PropertyConfiguration['propertyCode'] | undefined; configuration: import('@/lib/reservation-workflow/types').PropertyConfiguration | null; snapshot: ReservationPaneSnapshot | null; loadError: string | null;
  client: ReservationWorkflowClient; onSnapshot(snapshot: ReservationPaneSnapshot): void;
  skippedSource?: ReservationSkippedSource | null;
  onOpenEvidence?: (ref: string) => void; onOpenAttachment?: (ref: string) => void; preview?: boolean; onSaveQuoteOutput?: SaveQuoteOutput;
};
const labels: Record<ReservationWorkflowKind, string> = { create: 'Create', quote: 'Quote', amend: 'Amend', cancel: 'Cancel', services: 'Add-Ons', filing: 'Filing', other: 'Other' };
const editors = { create: CreateEditor, quote: QuoteEditor, amend: AmendEditor, cancel: CancelEditor, services: AddonsEditor, filing: FilingEditor };
const actionKinds = Object.keys(editors) as Array<Exclude<ReservationWorkflowKind, 'other'>>;
const createScopedFields = new Set(['requestedMealPlan', 'mealPlan', 'taCommission', 'roomType', 'roomTypeForCharge', 'ratePlan', 'guaranteeType', 'bookingAgency', 'organization', 'arAccount',
  'sourceOfBusiness', 'reasonForStay', 'billingReference', 'track', 'guestOptIn', 'bookerName', 'bookerEmail', 'bookerMobile', 'reservationNote', 'cmsSend', 'cmsMessageId', 'cmsRecipient']);
function issueText(issue: ReservationPaneSnapshot['issues'][number]) {
  const { kind, explanation } = issue;
  const failure = knownFailureCopy(kind) ?? knownFailureCopy(explanation);
  if (failure) return failure;
  const occupancyMissing = /occupancy|adult|children/i.test(explanation) && /missing|not supplied|not provided|required|unknown/i.test(explanation);
  if (kind === 'rate_availability_unavailable') return occupancyMissing
    ? 'Infor can’t price these rooms yet: adults and children are missing. Enter occupancy for each room, then check again.'
    : `${explanation} Check the dates, rooms and occupancy, then try again.`;
  const noGuestMatch = /no matching|no match|(?:found|returned) no .*profile/i.test(explanation);
  if (kind === 'ambiguous_guest_profile' || /guest/i.test(explanation) && /no matching profile|no match.*profile/i.test(explanation)) return noGuestMatch
    ? 'No Infor guest profile matches this guest. Search again, or create the guest profile, then check again.'
    : `${explanation} Choose the matching Infor guest profile, or create a new one.`;
  if (/organi[sz]ation/i.test(explanation) && /no native candidate|no match|no matching/i.test(explanation)) {
    const name = explanation.match(/no native candidate for (.+?)(?:\.\s|\.$|$)/i)?.[1]?.trim();
    return name ? `No Infor organisation matches ${name}. Search again, choose an organisation or leave it blank.`
      : `${explanation} Search again, choose an organisation or leave it blank.`;
  }
  if (/^Candidate read v2_[a-z0-9]+ failed\.$/i.test(explanation)) return 'An Infor search during email prefill failed. Search again to verify the details.';
  if (/^Candidate read v2_[a-z0-9]+ .+; coverage is not complete\.$/i.test(explanation)) return 'An Infor search during email prefill was incomplete. Search again to verify the details.';
  return explanation;
}

function attentionButtons(fields: string[], snapshot: ReservationPaneSnapshot, requestId: string, kind: ReservationWorkflowKind) {
  const buttons = fields.map(field => {
    const room = field.match(/\/allocations\/(\d+)(?:\/|:|$)/);
    const section = field.match(/\/dateSections\/(\d+)(?:\/|:|$)/);
    const group = field.match(/\/groups\/(\d+)(?:\/|:|$)/);
    const view = snapshot.preparationViews.find(row => row.requestId === requestId && row.issue && row.fields?.includes(field));
    const scope = room ? `Room ${Number(room[1]) + 1}` : section ? `Date section ${Number(section[1]) + 1}`
      : group ? `Room group ${Number(group[1]) + 1}` : kind !== 'create' ? 'Details' : 'All rooms';
    const label = /\/guest(?:\/|:|$)/.test(field) || field === 'guest' ? 'Guest' : inputFieldLabel(field);
    return { field, target: view?.allocationId, label: `${scope} · ${label.charAt(0).toUpperCase()}${label.slice(1)}` };
  });
  return [...new Map(buttons.map(button => [button.label, button])).values()];
}

function issueBelongsToRequest(snapshot: ReservationPaneSnapshot, requestId: string, path?: string): boolean {
  if (!path || path === '/') return true;
  const parts = path.replace(/^\/proposal\/content(?=\/)/, '').split('/');
  let key: string;
  try { key = decodeURIComponent(parts[2] ?? ''); } catch { return false; }
  const content = snapshot.session.draft.proposal.content;
  const byKey = <T extends { id: string }>(rows: T[]) => rows.find(row => row.id === key) ??
    (/^\d+$/.test(key) ? rows[Number(key)] : undefined);
  const request = content.requests.find(row => row.id === requestId);
  if (!request) return false;
  if (parts[1] === 'requests') return byKey(content.requests)?.id === requestId;
  if (parts[1] === 'services') {
    const service = byKey(content.services);
    return Boolean(service && (service.ownerRequestId === requestId || request.serviceRefs.includes(service.id) ||
      service.targets.some(target => target.target.requestId === requestId)));
  }
  if (parts[1] === 'documents') {
    const document = byKey(content.documents);
    return Boolean(document && (document.ownerRequestId === requestId || request.documentRefs.includes(document.id)));
  }
  return false;
}

function resolvedSourceIssue(snapshot: ReservationPaneSnapshot, issue: ReservationPaneSnapshot['issues'][number]): boolean {
  if (!issue.path) return false;
  const path = issue.path.startsWith('/proposal/content/') ? issue.path : `/proposal/content${issue.path}`;
  const parts = path.split('/');
  if (parts[3] !== 'requests') return false;
  let key: string;
  try { key = decodeURIComponent(parts[4] ?? ''); } catch { return false; }
  const requests = snapshot.session.draft.proposal.content.requests;
  const request = requests.find(row => row.id === key) ?? (/^\d+$/.test(key) ? requests[Number(key)] : undefined);
  if (!request) return false;
  const root = `${requestPath(request.id)}/body`;
  const edited = (target: string) => Object.entries(snapshot.session.draft.fieldOverrides).some(([key, value]) =>
    value.state === 'set' && (key === target || key.startsWith(`${target}/`) || target.startsWith(`${key}/`)));
  if (request.kind === 'quote' && ['quote_room_code_not_projected', 'quote_room_code_scope_ambiguous', 'quote_occupancy_scope_ambiguous'].includes(issue.kind)) {
    const groups = effectiveAt(snapshot, `${root}/groups`);
    if (!Array.isArray(groups) || !groups.length) return false;
    return groups.every((entry, index) => {
      const group = record(entry), groupPath = `${root}/groups/${index}`;
      if (issue.kind !== 'quote_occupancy_scope_ambiguous') {
        const roomPath = `${groupPath}/roomCodes`, codes = group.roomCodes;
        const available = new Set(nativeChoices(snapshot, roomPath, 'room_type').map(choice => choice.value));
        return edited(roomPath) && Array.isArray(codes) && codes.length > 0 &&
          codes.every(code => typeof code === 'string' && available.has(code));
      }
      const occupancy = record(group.occupancy), ages = occupancy.childAges;
      return edited(`${groupPath}/occupancy`) && occupancy.scope === 'per_room' &&
        Number.isInteger(occupancy.adults) && Number(occupancy.adults) >= 1 && Number(occupancy.adults) <= 6 &&
        Number.isInteger(occupancy.childCount) && Number(occupancy.childCount) >= 0 && Number(occupancy.childCount) <= 6 &&
        Array.isArray(ages) && ages.length === occupancy.childCount && ages.every(age => Number.isInteger(age) && age >= 0 && age <= 17);
    });
  }
  if (issue.kind === 'booker_contact_ambiguous' || issue.kind === 'source_value_not_projected') {
    const normalized = path.replace(`/requests/${parts[4]}`, `/requests/${encodeURIComponent(request.id)}`);
    const value = effectiveAt(snapshot, normalized);
    const field = normalized.split('/').at(-1);
    const limit = field === 'bookerName' ? 50 : field === 'telephone' || field === 'bookerMobile' ? 120 : field === 'attention' ? 300 : 320;
    return ['attention', 'email', 'telephone', 'bookerName', 'bookerEmail', 'bookerMobile'].includes(field ?? '') &&
      edited(normalized) && typeof value === 'string' && Boolean(value.trim()) && value.length <= limit &&
      (!['email', 'bookerEmail'].includes(field ?? '') || /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value));
  }
  if (issue.kind === 'ambiguous_party_role_source') {
    const normalized = path.replace(`/requests/${parts[4]}`, `/requests/${encodeURIComponent(request.id)}`);
    const selectionPath = `${normalized}/nativeSelectionRef`, selected = valueAt(snapshot, selectionPath);
    return typeof selected === 'string' && edited(selectionPath) &&
      nativeChoices(snapshot, selectionPath, 'party_candidate').some(choice => choice.ref === selected);
  }
  return false;
}

function actionLabel(snapshot: ReservationPaneSnapshot, request: ReservationPaneSnapshot['requests'][number]): string {
  if (request.kind !== 'quote') return labels[request.kind];
  const quotes = snapshot.requests.filter(row => row.kind === 'quote');
  if (quotes.length < 2) return labels.quote;
  const groups = effectiveAt(snapshot, `${requestPath(request.id)}/body/groups`);
  const rows = Array.isArray(groups) ? groups.map(record) : [];
  const dates = [...new Set(rows.map(row => [text(row.arrival), text(row.departure)].filter(Boolean).join('–')).filter(Boolean))];
  const total = rows.length && rows.every(row => Number.isInteger(row.quantity) && Number(row.quantity) > 0)
    ? rows.reduce((sum, row) => sum + Number(row.quantity), 0) : null;
  const detail = [dates.slice(0, 2).join(', ') + (dates.length > 2 ? '…' : ''), total ? `${total} ${total === 1 ? 'room' : 'rooms'}` : ''].filter(Boolean).join(' · ');
  return `Quote ${quotes.findIndex(row => row.id === request.id) + 1}${detail ? ` · ${detail}` : ''}`;
}

export function ReservationPane(props: ReservationPaneProps) {
  const workbench = useReservationWorkbench(props);
  const [checked, setChecked] = useState<string | null>(null);
  const [savedQuoteOperation, setSavedQuoteOperation] = useState<string | null>(null);
  const [checkedAmendReview, setCheckedAmendReview] = useState<string | null>(null);
  const [formReset, setFormReset] = useState(0);
  const [actionMenu, setActionMenu] = useState<string | null>(null);
  const [confirmRemove, setConfirmRemove] = useState(false);
  const [attention, setAttention] = useState<{ digest: string; message: string; original: string; fields: string[]; phase: 'check' | 'save' | 'review' } | null>(null);
  const paneRef = useRef<HTMLDivElement>(null);
  const submitting = useRef(false);
  const activeTarget = useRef<string | null>(null);
  const { source, preview = false } = props;
  const { snapshot, request, commands, busy } = workbench;
  const rememberedRecipient = useCmsRecipientDefault(snapshot?.session.draft.propertyCode).address;
  const createBlocked = source.selfPreStay && request?.kind === 'create';
  const capabilityKind = request?.kind === 'filing' ? 'attach' : request?.kind === 'services' ? 'addons' : request?.kind;
  const scopedConfiguration = props.configuration?.propertyCode === source.propertyId &&
    props.configuration.transportId === source.mailboxId ? props.configuration : null;
  const capability = capabilityKind && capabilityKind !== 'other' ? scopedConfiguration?.capabilities?.[capabilityKind] : undefined;
  const capabilityUnavailable = Boolean(capabilityKind && capabilityKind !== 'other' &&
    !(capability && ['prepare-only', 'lab', 'staff-enabled'].includes(capability.status)));
  const capabilitySaveUnavailable = capability?.status === 'prepare-only' && request?.kind !== 'quote';
  const prefill = snapshot?.session.draft.prefill;
  const directPrefillAbandoned = prefill?.status === 'running' && !prefill.jobRunId && prefill.startedAt
    && Date.now() - Date.parse(prefill.startedAt) >= 12 * 60_000;
  const editor: WorkbenchEditorProps | null = snapshot && request ? { source, activeProperty: props.activeProperty, configuration: props.configuration, snapshot, request,
    view: { busy, error: workbench.error, preview, saving: workbench.saving, blocked: workbench.blocked }, commands, onOpenEvidence: props.onOpenEvidence } : null;
  const body = snapshot && request ? record(effectiveAt(snapshot, `${requestPath(request.id)}/body`)) : {};
  const ids = request?.kind === 'create' ? (Array.isArray(body.allocations) ? body.allocations.map(row => text(record(row).id)) : [])
    : request?.kind === 'amend' || request?.kind === 'cancel' ? (Array.isArray(record(body.targets).include) ? (record(body.targets).include as unknown[]).map(row => text(record(row).id)) : []) : [];
  const digestFor = (current: ReservationPaneSnapshot | null) => {
    const draft = current?.session.draft;
    const priceRefs = new Set(request?.kind === 'amend' ? (draft?.operationResults ?? []).filter(row =>
      row.workflow === 'amend' && row.requestId === request.id && row.status === 'prepared').flatMap(row =>
      row.observationRefs.filter(ref => draft && draft.observations.some(observation => observation.ref === ref &&
        observation.kind === 'rate_availability' && observation.status === 'complete' && observation.coverage.complete &&
        observation.generationId === draft.generationId && observation.propertyCode === draft.propertyCode &&
        observation.sourceMessageId === draft.source.messageId && observation.criteria.workflow === 'amend' &&
        observation.criteria.requestId === request.id && observation.criteria.hintId === row.allocationId &&
        observation.criteria.stage === 'callback_price_review'))) : []);
    const currentBody = current && request ? record(effectiveAt(current, `${requestPath(request.id)}/body`)) : {};
    const perTarget = request?.kind === 'amend' && Array.isArray(currentBody.perTarget) ? currentBody.perTarget.map(value => {
      const row = record(value), refs = row.currentObservationRefs;
      return Array.isArray(refs) ? { ...row, currentObservationRefs: refs.filter(ref => !priceRefs.has(text(ref))) } : row;
    }) : currentBody.perTarget;
    const body = Object.fromEntries(Object.entries(currentBody).filter(([field]) => request?.kind !== 'cancel' || field !== 'previewObservationRefs'));
    if (request?.kind === 'amend' && perTarget !== undefined) body.perTarget = perTarget;
    const overrides = Object.fromEntries(Object.entries(draft?.fieldOverrides ?? {}).filter(([path, value]) => request &&
      (path === requestPath(request.id) || path.startsWith(`${requestPath(request.id)}/`)) &&
      (request.kind !== 'cancel' || !path.startsWith(`${requestPath(request.id)}/body/previewObservationRefs`)) &&
      !(request.kind === 'amend' && /\/body\/perTarget\/\d+\/currentObservationRefs\/\d+$/.test(path) &&
        value.state === 'set' && priceRefs.has(text(value.value)))).map(([path, value]) => [path, { state: value.state, value: value.value }]));
    return JSON.stringify({ generation: draft?.generationId, request: request?.id, body, overrides });
  };
  const digest = digestFor(snapshot);
  const amendPriceReviews = snapshot && request?.kind === 'amend' ? ids.flatMap((id, index) => {
    const draft = snapshot.session.draft, root = `${requestPath(request.id)}/body`;
    if (snapshot.operationResults.some(row => row.workflow === 'amend' && row.requestId === request.id &&
      row.allocationId === id && ['succeeded', 'unknown'].includes(text(row.status)))) return [];
    const selected = valueAt(snapshot, `${root}/targets/include/${index}/suggestedRef`);
    const operation = [...draft.operationResults].reverse().find(row => row.workflow === 'amend' && row.requestId === request.id &&
      row.allocationId === id && row.generationId === draft.generationId && row.status === 'prepared' && row.observationRefs.some(ref =>
        draft.observations.some(observation => observation.ref === ref && observation.criteria.stage === 'callback_price_review')));
    const observation = operation && draft.observations.find(row => operation.observationRefs.includes(row.ref) &&
      row.kind === 'rate_availability' && row.status === 'complete' && row.coverage.complete && row.generationId === draft.generationId &&
      row.propertyCode === draft.propertyCode && row.sourceMessageId === draft.source.messageId && row.criteria.workflow === 'amend' &&
      row.criteria.stage === 'callback_price_review' && row.criteria.requestId === request.id && row.criteria.hintId === id &&
      row.criteria.selectedRef === selected);
    const result = record(observation?.result), price = record(result.price), target = record(result.target);
    const approval = text(result.approvalDigest), total = text(price.totalCents), average = price.averageCents == null ? '' : text(price.averageCents);
    if (!observation || typeof selected !== 'string' || !selected || result.outcome !== 'callback_price_review' || result.ready !== true ||
      !/^[a-f0-9]{64}$/.test(approval) || !/^[a-f0-9]{64}$/.test(text(observation.criteria.baseDigest)) ||
      !/^[a-f0-9]{64}$/.test(text(observation.criteria.semanticDigest)) || price.version !== 2 ||
      !/^[A-Z]{3}$/.test(text(price.currency)) || typeof price.totalCents !== 'string' || !/^\d+$/.test(total) ||
      (price.averageCents != null && (typeof price.averageCents !== 'string' || !/^\d+$/.test(average))) ||
      !isExactConfirmation(target.confirmation) || !/^\d{4}-\d{2}-\d{2}$/.test(text(target.arrival)) ||
      !/^\d{4}-\d{2}-\d{2}$/.test(text(target.departure))) return [];
    const per = Array.isArray(body.perTarget) ? body.perTarget.map(record) : [], perIndex = per.findIndex(row => row.hintId === id);
    if (perIndex < 0) return [];
    const refsPath = `${root}/perTarget/${perIndex}/currentObservationRefs`, refs = effectiveAt(snapshot, refsPath);
    const existingPath = Object.entries(draft.fieldOverrides).find(([path, value]) => path.startsWith(`${refsPath}/`) &&
      /^\d+$/.test(path.slice(refsPath.length + 1)) && value.state === 'set' && value.value === observation.ref)?.[0];
    const refIndex = Array.isArray(refs) ? refs.indexOf(observation.ref) : -1;
    const path = existingPath ?? `${refsPath}/${refIndex < 0 ? Array.isArray(refs) ? refs.length : 0 : refIndex}`;
    const note = `amend-price:${observation.ref}:${approval}`, review = draft.staffReviews[path];
    const accepted = valueAt(snapshot, path) === observation.ref && review?.status === 'accepted' && review.note === note;
    return [{ id, operation, observation, result, price, target, path, note, accepted }];
  }) : [];
  const restoredAmendReview = useRef<string | null>(null);
  const completedReview = amendPriceReviews.find(review => snapshot?.session.workflowDispatches?.some(dispatch =>
    dispatch.endpoint === 'execute' && dispatch.status === 'needs_review' && dispatch.requestId === request?.id &&
    dispatch.allocationId === review.id && dispatch.operationId === review.operation.id));
  const reviewKey = completedReview ? `${snapshot?.session.draft.generationId}:${request?.id}:${completedReview.observation.ref}` : null;
  useEffect(() => {
    if (!reviewKey || !completedReview || restoredAmendReview.current === reviewKey) return;
    restoredAmendReview.current = reviewKey;
    setCheckedAmendReview(completedReview.observation.ref);
    setChecked(digest);
  }, [reviewKey, completedReview, digest]);
  const hasPendingAmendPrice = snapshot && request?.kind === 'amend' && snapshot.session.draft.operationResults.some(operation =>
    operation.workflow === 'amend' && operation.requestId === request.id && operation.status === 'prepared' &&
    operation.generationId === snapshot.session.draft.generationId &&
    !snapshot.operationResults.some(row => row.workflow === 'amend' && row.requestId === request.id &&
      row.allocationId === operation.allocationId && ['succeeded', 'unknown'].includes(text(row.status))) &&
    snapshot.session.draft.observations.some(row => operation.observationRefs.includes(row.ref) && row.kind === 'rate_availability' &&
      row.status === 'complete' && row.coverage.complete && row.generationId === snapshot.session.draft.generationId &&
      row.propertyCode === snapshot.session.draft.propertyCode && row.sourceMessageId === snapshot.session.draft.source.messageId &&
      row.criteria.workflow === 'amend' && row.criteria.stage === 'callback_price_review' &&
      row.criteria.requestId === request.id && row.criteria.hintId === operation.allocationId));
  const focusField = (field: string) => {
    const pane = paneRef.current;
    if (!pane || !request) return;
    let path = attentionFieldPath(field, requestPath(request.id));
    if (field.endsWith(':lunch_extra_price_required') && request.kind === 'quote') {
      const money = Array.isArray(body.requestedMoney) ? body.requestedMoney.map(record) : [];
      const lunchIndex = money.findIndex(row => row.staffAllowanceType === 'lunch');
      if (lunchIndex >= 0) path = `${requestPath(request.id)}/body/requestedMoney/${lunchIndex}/amount`;
    }
    if (path.endsWith('/occupancy') && field.endsWith(':known_child_count_and_ages_required')) path += '/childCount';
    const invalidDateRange = field.endsWith(':date_range_invalid');
    if (invalidDateRange && request.kind === 'create' && path === 'stay') {
      const failed = workbench.latestSnapshot()?.preparationViews.find(view => view.requestId === request.id && view.fields?.includes(field));
      const allocation = Array.isArray(body.allocations) ? body.allocations.map(record).find(row => row.id === failed?.allocationId) : undefined;
      const sections = Array.isArray(body.dateSections) ? body.dateSections.map(record) : [];
      const index = Math.max(0, sections.findIndex(section => section.id === allocation?.dateSectionId));
      path = `${requestPath(request.id)}/body/dateSections/${index}/arrival`;
    } else if (invalidDateRange && request.kind === 'quote') {
      path = path === 'stay' ? `${requestPath(request.id)}/body/groups/0/arrival` : `${path}/arrival`;
    }
    if (request.kind === 'create' && createScopedFields.has(path)) {
      const latest = workbench.latestSnapshot();
      if (!latest) return;
      const root = `${requestPath(request.id)}/body`;
      const currentBody = record(effectiveAt(latest, root));
      const failed = [...latest.preparationViews].reverse().find(view => view.requestId === request.id && view.fields?.includes(field)
        && (!activeTarget.current || view.allocationId === activeTarget.current));
      const allocations = Array.isArray(currentBody.allocations) ? currentBody.allocations.map(record) : [];
      const index = allocations.findIndex(row => row.id === (failed?.allocationId ?? activeTarget.current));
      const sections = Array.isArray(currentBody.dateSections) ? currentBody.dateSections.map(record) : [];
      const sectionIndex = sections.findIndex(row => row.id === allocations[index]?.dateSectionId);
      if (index >= 0 && sectionIndex >= 0) {
        const choices = [`${root}/allocations/${index}/overrides/${path}`, `${root}/dateSections/${sectionIndex}/defaults/${path}`, `${root}/shared/${path}`];
        path = choices.find((choice, i) => {
          const state = latest.session.draft.fieldOverrides[choice]?.state;
          if (i < choices.length - 1 && state === 'inherit') return false;
          const value = effectiveAt(latest, choice);
          return state === 'none' || state === 'clear' || state === 'unknown' || value !== undefined && value !== null;
        }) ?? choices[0]!;
      }
    }
    if (request.kind === 'amend' && (path === 'arrival' || path === 'departure' || path === 'requestedMealPlan')) {
      const root = `${requestPath(request.id)}/body`;
      const latest = workbench.latestSnapshot();
      if (!latest) return;
      const currentBody = record(effectiveAt(latest, root));
      const per = Array.isArray(currentBody.perTarget) ? currentBody.perTarget.map(record) : [];
      const index = per.findIndex(row => row.hintId === activeTarget.current);
      const changeRows = (value: unknown, base: string) => Array.isArray(value)
        ? value.map((row, i) => ({ change: record(row), path: `${base}/${i}` })) : [];
      const changes = [...changeRows(currentBody.sharedChanges, `${root}/sharedChanges`),
        ...changeRows(per[index]?.changes, `${root}/perTarget/${index}/changes`)].reverse();
      const changed = changes.find(row => row.change.op === 'set' && row.change.field === path)
        ?? (path !== 'requestedMealPlan' ? changes.find(row => row.change.op === 'set' && ['arrival', 'departure'].includes(text(row.change.field)))
          ?? changes.find(row => row.change.op === 'shift_dates' || row.change.op === 'shift_departure') : undefined);
      if (changed) path = `${changed.path}/${changed.change.op === 'set' ? 'value' : 'days'}`;
    }
    const candidates = Array.from(pane.querySelectorAll<HTMLElement>('[data-field-path]'));
    const target = candidates.find(node => node.dataset.fieldPath === path)
      ?? candidates.find(node => path.startsWith(`${node.dataset.fieldPath}/`))
      ?? candidates.find(node => node.dataset.fieldPath?.startsWith(`${path}/`))
      ?? candidates.find(node => !path.startsWith('/') && node.dataset.fieldPath?.endsWith(`/${path}`))
      ?? (invalidDateRange && request.kind === 'quote' ? candidates.find(node => node.dataset.fieldPath === `${requestPath(request.id)}/body/groups/0/arrival`) : undefined);
    const fallback = path.endsWith('/allocations') ? pane.querySelector<HTMLElement>('button[aria-label^="Add room"]') : null;
    const destination = target ?? fallback;
    if (!destination) return;
    for (let parent = destination.parentElement; parent && parent !== pane; parent = parent.parentElement) {
      if (parent instanceof HTMLDetailsElement) parent.open = true;
    }
    const control = destination.matches('button,input,select,textarea') ? destination
      : destination.querySelector<HTMLElement>('input:not(:disabled),select:not(:disabled),textarea:not(:disabled),button:not(:disabled)');
    control?.focus({ preventScroll: true });
    const content = pane.querySelector<HTMLElement>('main');
    if (content) content.scrollTop += destination.getBoundingClientRect().top - content.getBoundingClientRect().top - 16;
  };
  const showAttention = (message: string, fields: string[] = [], phase: 'check' | 'save' | 'review' = 'check') => {
    const reason = (knownFailureCopy(message) ?? message).replace(/^Infor check: (?:needs input|needs review|unsupported|failed|invalid state) — /, '');
    const fieldList = [...new Set(fields)];
    const fieldLabels = [...new Set(fieldList.map(inputFieldLabel))].join(', ');
    const display = fieldLabels ? reason.replace(` Review: ${fieldLabels}.`, '') : reason;
    setAttention({ digest: digestFor(workbench.latestSnapshot()), message: display, original: message, fields: fieldList, phase });
    requestAnimationFrame(() => { const content = paneRef.current?.querySelector<HTMLElement>('main'); if (content) content.scrollTop = 0; });
  };
  const showFailure = (failure: unknown, phase: 'check' | 'save' = 'check') => {
    const latest = workbench.latestSnapshot();
    const reply = record(latest?.workflowReply);
    const fields = Array.isArray(reply.fields) ? reply.fields.filter((field): field is string => typeof field === 'string')
      : latest?.preparationViews.filter(view => view.requestId === request?.id && view.issue).flatMap(view => view.fields ?? []) ?? [];
    const review = record(reply.financialReview), draft = latest?.session.draft;
    const observation = draft ? draft.observations.find(row => row.ref === review.observationRef && row.kind === 'rate_availability' &&
      row.status === 'complete' && row.coverage.complete && row.generationId === draft.generationId &&
      row.propertyCode === draft.propertyCode && row.sourceMessageId === draft.source.messageId && row.criteria.workflow === 'amend' &&
      row.criteria.stage === 'callback_price_review' && row.criteria.requestId === request?.id && row.criteria.hintId === activeTarget.current) : undefined;
    const result = record(observation?.result), approval = text(result.approvalDigest), price = record(result.price);
    const replyPrice = record(reply.price), target = record(result.target);
    const currentBody = latest && request ? record(effectiveAt(latest, `${requestPath(request.id)}/body`)) : {};
    const targets = Array.isArray(record(currentBody.targets).include) ? (record(currentBody.targets).include as unknown[]).map(record) : [];
    const targetIndex = targets.findIndex(row => row.id === activeTarget.current);
    const per = Array.isArray(currentBody.perTarget) ? currentBody.perTarget.map(record) : [];
    const perIndex = per.findIndex(row => row.hintId === activeTarget.current);
    const refsPath = request && perIndex >= 0 ? `${requestPath(request.id)}/body/perTarget/${perIndex}/currentObservationRefs/` : '';
    const reviewPath = text(review.reviewFieldPath);
    const selectedRef = targets[targetIndex]?.suggestedRef;
    const currentAmendReview = request?.kind === 'amend' && reply.status === 'needs_review' &&
      reply.issue === 'amend_applied_price_requires_second_go' && reply.requestId === request.id &&
      reply.allocationId === activeTarget.current && review.required === true && observation && targetIndex >= 0 &&
      typeof selectedRef === 'string' && selectedRef && observation.criteria.selectedRef === selectedRef &&
      !latest?.operationResults.some(row => row.workflow === 'amend' && row.requestId === request.id &&
        row.allocationId === activeTarget.current && ['succeeded', 'unknown'].includes(text(row.status))) &&
      result.outcome === 'callback_price_review' &&
      result.ready === true && /^[a-f0-9]{64}$/.test(approval) && review.approvalDigest === approval &&
      /^[a-f0-9]{64}$/.test(text(observation.criteria.baseDigest)) && /^[a-f0-9]{64}$/.test(text(observation.criteria.semanticDigest)) &&
      price.version === 2 && /^[A-Z]{3}$/.test(text(price.currency)) && typeof price.totalCents === 'string' && /^\d+$/.test(price.totalCents) &&
      (price.averageCents == null || typeof price.averageCents === 'string' && /^\d+$/.test(price.averageCents)) &&
      replyPrice.version === 2 && replyPrice.currency === price.currency && replyPrice.totalCents === price.totalCents && replyPrice.averageCents === price.averageCents &&
      isExactConfirmation(target.confirmation) && reply.confirmation === target.confirmation &&
      /^\d{4}-\d{2}-\d{2}$/.test(text(target.arrival)) && /^\d{4}-\d{2}-\d{2}$/.test(text(target.departure)) &&
      review.reviewNote === `amend-price:${observation.ref}:${approval}` && refsPath && reviewPath.startsWith(refsPath) &&
      /^\d+$/.test(reviewPath.slice(refsPath.length)) && draft && draft.operationResults.some(row => row.id === reply.operationId &&
        row.workflow === 'amend' && row.requestId === request.id && row.allocationId === activeTarget.current &&
        row.generationId === draft.generationId && row.status === 'prepared' && row.observationRefs.includes(observation.ref));
    if (currentAmendReview) setAttention(null);
    else showAttention(failure instanceof Error ? failure.message : 'Infor could not complete this step. Review the details and try again.', fields, phase);
    return currentAmendReview && observation ? observation.ref : null;
  };
  const createPriceBlocked = request?.kind === 'create' && snapshot?.preparationViews.some(view => view.requestId === request.id && record(record(view).priceComparison).blocksGo === true && !snapshot.operationResults.some(row => row.workflow === 'create' && row.requestId === request.id && row.allocationId === view.allocationId && row.status === 'succeeded'));
  const quotePrepared = request?.kind === 'quote' && snapshot ? [...snapshot.session.draft.operationResults].reverse().find(row => row.workflow === 'quote' && row.requestId === request.id && row.status === 'prepared') : null;
  const quoteObservation = quotePrepared && snapshot?.session.draft.observations.find(row => quotePrepared.observationRefs.includes(row.ref) && row.kind === 'rate_availability');
  const filingLocked = request?.kind === 'filing' && Boolean(snapshot?.session.draft.operationResults.some(row =>
    row.workflow === 'filing' && row.requestId === request.id && (row.status === 'succeeded' || row.status === 'unknown')));
  const amendCallbackTargets = snapshot && request?.kind === 'amend' ? ids.flatMap((id, index) => {
    if (snapshot.operationResults.some(row => row.workflow === 'amend' && row.requestId === request.id && row.allocationId === id &&
      ['succeeded', 'unknown'].includes(text(row.status))) || amendPriceReviews.some(row => row.id === id)) return [];
    const draft = snapshot.session.draft, root = `${requestPath(request.id)}/body`;
    const selected = valueAt(snapshot, `${root}/targets/include/${index}/suggestedRef`);
    const prepared = [...draft.observations].reverse().find(row => row.kind === 'rate_availability' && row.status === 'complete' &&
      row.coverage.complete && row.generationId === draft.generationId && row.propertyCode === draft.propertyCode &&
      row.sourceMessageId === draft.source.messageId && row.criteria.workflow === 'amend' && row.criteria.requestId === request.id &&
      row.criteria.hintId === id && row.criteria.selectedRef === selected && record(row.result).outcome === 'prepared');
    const result = record(prepared?.result), target = record(result.target);
    const parties = record(result.callbackPlan).parties;
    const agency = Array.isArray(parties) ? parties.map(record).find(row => row.kind === 'bookingAgency') : undefined;
    const nativeDefault = record(agency?.expectedEffects).ta1commission, requested = record(result.nativeChanges).taCommission;
    const validDefault = typeof nativeDefault === 'string' && /^(?:0|[1-9]\d?)(?:\.\d+)?$|^100(?:\.0+)?$/.test(nativeDefault);
    const validRequested = requested === undefined || typeof requested === 'number' && Number.isFinite(requested) && requested >= 0 && requested <= 100;
    const name = typeof agency?.name === 'string' ? agency.name.trim() : '';
    const commissionUnknown = nativeDefault !== undefined && (!validDefault || !validRequested || !name);
    const commission = typeof nativeDefault === 'string' && validDefault && validRequested && name
      ? { name, nativeDefault, requested: typeof requested === 'number' ? requested : null } : null;
    return typeof selected === 'string' && selected && result.callbackPriceReviewRequired === true &&
      isExactConfirmation(target.confirmation) && text(target.arrival) && text(target.departure)
      ? [{ id, target, commission, commissionUnknown }] : [];
  }) : [];
  const needsCheck = () => checked !== digest || request?.kind === 'amend' && (checkedAmendReview !== null || hasPendingAmendPrice) &&
    !amendPriceReviews.some(row => row.observation.ref === checkedAmendReview) || !hasPendingAmendPrice && Boolean(amendCallbackTargets[0]?.commissionUnknown) ||
    request?.kind === 'quote' && (!quoteObservation || !(Date.parse(text(record(quoteObservation.result).freshUntil)) > Date.now()));
  const readiness = snapshot && request?.kind === 'create'
    ? createReadiness(snapshot.session.draft, request.id, needsCheck() ? 'check' : 'execute') : [];
  const pendingAmendReview = amendPriceReviews.find(row => row.observation.ref === checkedAmendReview) ??
    amendPriceReviews.find(row => row.id === activeTarget.current) ?? amendPriceReviews[0];
  const quoteExtras = record(quoteObservation?.result).extrasReviewItems;
  const quoteReview = request && snapshot?.session.draft.staffReviews[`${requestPath(request.id)}/body`];
  const extrasNeedReview = Array.isArray(quoteExtras) && quoteExtras.some(item => typeof item === 'string' && item.trim()) &&
    !(quoteReview?.status === 'accepted' && Date.parse(quoteReview.at ?? '') >= Date.parse(quotePrepared?.updatedAt ?? '') && Date.parse(quoteReview.at ?? '') >= Date.parse(quoteObservation?.observedAt ?? ''));
  const check = async () => {
    if (!request || createBlocked) return;
    if (['create', 'amend', 'cancel'].includes(request.kind) && !ids.length) {
      showAttention(request.kind === 'create' ? 'Add at least one room and fill in its guest, occupancy and booking details.' : 'Choose at least one stay to check.',
        [`${requestPath(request.id)}/body/${request.kind === 'create' ? 'allocations' : 'targets'}`]);
      return;
    }
    setAttention(null);
    try {
      if (request.kind === 'create' && snapshot) {
        const root = `${requestPath(request.id)}/body`, shared = `${root}/shared`;
        const sections = Array.isArray(body.dateSections) ? body.dateSections.map(record) : [];
        const rooms = Array.isArray(body.allocations) ? body.allocations.map(record) : [];
        const needsRecipient = rooms.some((room, index) => {
          const sectionIndex = sections.findIndex(section => section.id === room.dateSectionId);
          const bases = [`${root}/allocations/${index}/overrides`, `${root}/dateSections/${sectionIndex}/defaults`, shared];
          const inherited = (key: string) => {
            for (const base of bases) {
              const path = `${base}/${key}`;
              if (base !== shared && snapshot.session.draft.fieldOverrides[path]?.state === 'inherit') continue;
              const value = effectiveAt(snapshot, path);
              if (value !== undefined && value !== null) return value;
            }
            return undefined;
          };
          return inherited('cmsSend') === true && !text(inherited('cmsRecipient')).trim();
        });
        const recipient = resolveCreateCmsRecipientDefault(snapshot, request.id, source.sender, rememberedRecipient);
        if (needsRecipient && recipient && !text(effectiveAt(snapshot, `${shared}/cmsRecipient`)).trim()) {
          await commands.edit(`${shared}/cmsRecipient`, recipient);
        }
      }
      await commands.review(request.kind === 'create' ? 'allocations' : request.kind === 'amend' || request.kind === 'cancel' ? 'targets' : 'request', ids);
      if (request.kind === 'create' || request.kind === 'amend' || request.kind === 'cancel') {
        for (const id of ids) {
          const prior = [...(workbench.latestSnapshot()?.operationResults ?? [])].reverse().find(row => row.workflow === request.kind && row.requestId === request.id && row.allocationId === id && ['succeeded', 'unknown'].includes(String(row.status)));
          if (prior?.status === 'succeeded') continue;
          if (prior?.status === 'unknown') throw new Error('Check the previous save outcome before checking this stay again.');
          if (request.kind === 'create' && workbench.latestSnapshot()?.preparationViews.some(view => view.requestId === request.id && view.allocationId === id && view.current)) continue;
          activeTarget.current = id;
          await commands.prepare(id);
        }
        if (request.kind === 'create') {
          const hasReceipt = () => {
            const views = ids.map(id => workbench.latestSnapshot()?.preparationViews.find(view => view.requestId === request.id && view.allocationId === id));
            const receipt = views[0]?.receipt;
            return Boolean(receipt && views.every(view => view?.current && view.receipt?.preparedRef === receipt.preparedRef));
          };
          if (!hasReceipt()) await commands.prepare(ids[ids.length - 1]);
          if (!hasReceipt()) throw new Error('Infor did not return a current approval for all rooms. Check their details and prices before saving.');
        }
      } else await commands.prepare();
      setCheckedAmendReview(null);
      setChecked(digestFor(workbench.latestSnapshot()));
    } catch (failure) {
      const reviewRef = showFailure(failure);
      setCheckedAmendReview(reviewRef);
      setChecked(reviewRef ? digestFor(workbench.latestSnapshot()) : null);
    }
  };
  const currentFeePreview = (current: ReservationPaneSnapshot | null) => {
    const reply = record(current?.workflowReply), review = record(reply.financialReview), draft = current?.session.draft;
    return Boolean(request?.kind === 'cancel' && reply.requestId === request.id && (reply.status === 'prepared' || reply.status === 'needs_review') &&
      review.required === true && draft && draft.operationResults.some(row => row.workflow === 'cancel' && row.requestId === request.id &&
        row.allocationId === activeTarget.current && row.generationId === draft.generationId && row.status === 'prepared' &&
        row.observationRefs.includes(text(review.observationRef))) && draft.observations.some(row =>
        row.ref === review.observationRef && row.generationId === draft.generationId && record(row.result).ready === true));
  };
  const save = async () => {
    if (!request || createBlocked || preview || capabilityUnavailable || filingLocked) return;
    const latest = workbench.latestSnapshot();
    if (request.kind === 'cancel' && latest && (cancelChargeForSelection(latest, request.id) || latest.operationResults.some(row =>
      row.workflow === 'cancel' && row.requestId === request.id && row.status === 'unknown'))) return;
    if (capabilitySaveUnavailable && !needsCheck()) return;
    if (request.kind === 'amend' && !workbench.readyForReply()) {
      setChecked(null);
      showAttention('Finish editing and check the current details before saving.', [], 'review');
      return;
    }
    if (needsCheck()) { await check(); return; }
    if (extrasNeedReview) { showAttention('Review the extra charges shown in the prepared quote before generating it.', [`${requestPath(request.id)}/body`], 'review'); return; }
    if (createPriceBlocked) { showAttention('Resolve the customer price and current Infor price before saving. Refresh the Infor price after correcting it.', [], 'review'); return; }
    setAttention(null);
    try {
      if (request.kind === 'amend' && pendingAmendReview) {
        if (!pendingAmendReview.accepted) {
          showAttention(`Review the Infor price for ${text(pendingAmendReview.target.confirmation)} before saving.`, [], 'review');
          return;
        }
        activeTarget.current = pendingAmendReview.id;
        await commands.execute(pendingAmendReview.id);
        setChecked(null);
        return;
      }
      if (request.kind === 'amend' && amendCallbackTargets[0]) {
        activeTarget.current = amendCallbackTargets[0].id;
        await commands.execute(amendCallbackTargets[0].id);
        setChecked(null);
        return;
      }
      if (request.kind === 'create') {
        await commands.execute();
      } else if (request.kind === 'amend' || request.kind === 'cancel') {
        for (const id of ids) {
          const result = [...(workbench.latestSnapshot()?.operationResults ?? [])].reverse().find(row => row.workflow === request.kind && row.requestId === request.id && row.allocationId === id && ['succeeded', 'unknown'].includes(String(row.status)));
          if (result?.status === 'succeeded') continue;
          if (result?.status === 'unknown') throw new Error('Check the previous save outcome before continuing.');
          activeTarget.current = id;
          await commands.execute(id);
          if (record(workbench.latestSnapshot()?.workflowReply).status === 'queued') {
            setChecked(null);
            return;
          }
        }
      } else await commands.execute();
      setChecked(null);
    } catch (failure) {
      const latest = workbench.latestSnapshot(), feePreview = record(latest?.workflowReply).status === 'needs_review' && currentFeePreview(latest);
      const currentAmendPreview = feePreview ? (setAttention(null), null) : showFailure(failure, 'save');
      setCheckedAmendReview(currentAmendPreview);
      setChecked(feePreview || currentAmendPreview ? digestFor(latest) : null);
    }
  };
  const submit = async (action: () => Promise<void>) => {
    if (submitting.current || busy) return;
    submitting.current = true;
    try {
      // Blur commits date/child controls before the command queue checks them.
      const focused = document.activeElement;
      if (focused instanceof HTMLElement && paneRef.current?.contains(focused)) focused.blur();
      await action();
    } finally { submitting.current = false; }
  };
  const Editor = request && request.kind !== 'other' ? editors[request.kind] : null;
  const sourceChanged = snapshot?.session.sourceChanged === true;
  const recoveryOnly = source.sourceRecoveryOnly === true;
  const editBlocked = sourceChanged || recoveryOnly;
  const pendingDispatch = snapshot?.preparationViews.find(view => view.dispatch)?.dispatch ??
    snapshot?.session.workflowDispatches?.find(dispatch => dispatch.status !== 'succeeded' && dispatch.status !== 'failed' && dispatch.status !== 'needs_review');
  // Grants arrive newest first. A later success retires failed warnings, never uncertain outcomes.
  const dispatchNotices = snapshot?.session.workflowDispatches?.filter((dispatch, index, dispatches) =>
    dispatch.requestId === request?.id && (dispatch.status === 'failed' || dispatch.status === 'needs_reconcile' || dispatch.failureClass) &&
    !(dispatch.status === 'failed' && dispatches.slice(0, index).some(newer => newer.status === 'succeeded' &&
      newer.endpoint === dispatch.endpoint && newer.requestId === dispatch.requestId &&
      newer.allocationId === dispatch.allocationId && newer.serviceId === dispatch.serviceId))) ?? [];
  const disabled = busy || !snapshot || workbench.blocked || workbench.conflict || editBlocked || capabilityUnavailable || Boolean(pendingDispatch);
  const actionLocked = snapshot?.operationResults.some(row => row.requestId === request?.id && ['succeeded', 'unknown'].includes(text(row.status))) ||
    Boolean(pendingDispatch) || hasPendingAmendPrice || (request?.kind === 'create' && ids.some(id => Boolean(commands.guestProfilePending(id))));
  const scopedIssues = snapshot?.issues.filter(issue => issue.kind !== 'source_changed' &&
    (!request || issueBelongsToRequest(snapshot, request.id, issue.path))) ?? [];
  const allRoomsSaved = request?.kind === 'create' && ids.length > 0 && ids.every(id => snapshot?.operationResults.some(row =>
    row.workflow === 'create' && row.requestId === request.id && row.allocationId === id && row.status === 'succeeded'));
  const isEarlierIssue = (issue: typeof scopedIssues[number]) => !issue.path || issue.path === '/' || Boolean(snapshot && resolvedSourceIssue(snapshot, issue)) || Boolean(allRoomsSaved &&
    ['ambiguous_guest_profile', 'rate_availability_unavailable', 'mail_candidate_read_failed'].includes(issue.kind));
  const earlierIssues = scopedIssues.filter(isEarlierIssue);
  const currentIssues = scopedIssues.filter(issue => !isEarlierIssue(issue));
  const reviewOnlyEmpty = Boolean(snapshot && !request && !sourceChanged && (
    snapshot.session.draft.disposition?.decision === 'uncertain' ||
    snapshot.session.draft.status === 'partial' ||
    snapshot.session.draft.status === 'prefill_failed' ||
    snapshot.session.draft.prefill?.status === 'failed' ||
    (snapshot.session.draft.extraction?.issues?.length ?? 0) > 0 ||
    scopedIssues.length > 0 ||
    snapshot.session.draft.errors.length > 0));
  const currentAttention = attention?.digest === digest ? attention : null;
  const reviewButtons = snapshot && request && currentAttention ? attentionButtons(currentAttention.fields, snapshot, request.id, request.kind) : [];
  const output = request?.kind === 'quote' && snapshot ? getQuoteOutput(source, snapshot, request.id, scopedConfiguration) : null;
  const quoteOutput = output && !output.stale && output.issues.length === 0
    ? { operationId: output.operationId, inventoryDecline: output.inventoryDecline, hasCover: Boolean(output.cover),
      hasFiles: output.artifacts.length > 0, saveLabel: quoteReplyLabel(output) } : null;
  const feeReview = currentFeePreview(snapshot);
  const blockedReason = capabilityUnavailable ? capability?.reason || 'This action is not available for this hotel yet.'
    : capabilitySaveUnavailable && !needsCheck() ? capability?.reason || 'Saving is not available for this hotel yet.'
    : preview ? 'Save is disabled in this interactive preview.'
    : sourceChanged ? 'Review the changed email and attachments before continuing.'
    : pendingDispatch ? pendingDispatch.status === 'needs_reconcile' ? staffFailureCopy('UNKNOWN', true) : 'Saving in Infor. Waiting for the confirmed outcome.'
    : null;
  const visibleError = workbench.error && (!currentAttention || workbench.conflict ||
    !(currentAttention.original.includes(workbench.error) || currentAttention.message.includes(workbench.error))) ? workbench.error : null;
  const stage = snapshot && request && request.kind !== 'services' && request.kind !== 'other'
    ? derivePaneStage({ snapshot, request: { ...request, kind: request.kind }, needsCheck: needsCheck(),
      pendingAmendReview: Boolean(pendingAmendReview), amendCallback: amendCallbackTargets.length > 0,
      cancelFeeReview: feeReview, createPriceBlocked: Boolean(createPriceBlocked), extrasNeedReview, quoteDecline: record(quoteObservation?.result).failureKind === 'proven_shortage',
      quoteOutput, savedQuoteOperation, blockedReason }) : null;
  const hadWrite = snapshot?.operationResults.some(row => row.requestId === request?.id && row.workflow === request?.kind &&
    ['succeeded', 'unknown'].includes(text(row.status))) || Boolean(pendingAmendReview);
  const cancelHeld = request?.kind === 'cancel' && snapshot && (cancelChargeForSelection(snapshot, request.id) ||
    snapshot.operationResults.some(row => row.workflow === 'cancel' && row.requestId === request.id && row.status === 'unknown'));

  return <div ref={paneRef} className={styles.pane} data-reservation-pane>
    <header className={styles.header}><div><strong>Nava</strong><span>{preview ? 'Interactive preview · Save disabled' : workbench.saving ? 'Saving changes…' : busy ? 'Checking Infor…' : 'Saved draft'}</span></div>
      <div className={styles.history}><button type="button" aria-label="Undo draft change" disabled={disabled || !snapshot?.session.revision} onClick={() => { void workbench.undo().catch(() => {}); }}>↶</button><button type="button" aria-label="Redo draft change" disabled={disabled || snapshot?.session.revision === snapshot?.session.revisionHead} onClick={() => { void workbench.redo().catch(() => {}); }}>↷</button></div>
    </header>
    <nav className={styles.actionNav} aria-label="Reservation actions"><div className={styles.actionBar}><div className={styles.tabs}>
      {snapshot?.requests.filter(row => !source.selfPreStay || row.kind !== 'create').map(row => <span className={styles.tabGroup} key={row.id}>
        <button type="button" className={row.id === request?.id ? styles.activeTab : ''} onClick={() => { workbench.setActiveId(row.id); setChecked(null); setActionMenu(null); setConfirmRemove(false); }}>{actionLabel(snapshot, row)}</button>
        {row.id === request?.id && <button type="button" className={styles.tabChevron} aria-label={`Options for ${labels[row.kind]}`} aria-expanded={actionMenu === row.id}
          onClick={() => { setActionMenu(current => current === row.id ? null : row.id); setConfirmRemove(false); }}>▾</button>}
      </span>)}
      </div><select className={styles.actionAdd} aria-label="Add action" value="" disabled={!snapshot || busy || editBlocked || Boolean(pendingDispatch)} onChange={event => { const kind = event.target.value as Exclude<ReservationWorkflowKind, 'other'>; if (kind && !editBlocked && !(source.selfPreStay && kind === 'create')) { setActionMenu(null); void workbench.addAction(kind).catch(() => {}); } }}><option value="">+ Action</option>{actionKinds.filter(kind => !(source.selfPreStay && kind === 'create')).map(kind => <option key={kind} value={kind}>{labels[kind]}</option>)}</select>
    </div>
    {request && actionMenu === request.id && <div className={styles.actionMenu}>
      {actionLocked ? <p>This action has an Infor result and must stay in the draft.</p> : confirmRemove ? <>
        <p>Remove this draft action? Its unsaved details will be removed. Infor is unchanged.</p>
        <div className={styles.actionMenuButtons}><button type="button" onClick={() => setConfirmRemove(false)}>Keep action</button>
          <button type="button" disabled={disabled} onClick={() => { void commands.changeRows({ kind: 'remove_action', requestId: request.id })
            .then(() => { setActionMenu(null); setConfirmRemove(false); setChecked(null); }).catch(() => {}); }}>Remove action</button></div>
      </> : <button type="button" disabled={disabled} onClick={() => setConfirmRemove(true)}>Remove this action</button>}
    </div>}</nav>
    <div className={styles.sources}>{source.attachments.map(file => <button type="button" key={file.sourceRef} onClick={() => props.onOpenAttachment?.(file.sourceRef)}>{file.name}</button>)}</div>
    <main className={`${styles.content} nava-pane-scroll`}>
    {(props.loadError || visibleError || workbench.conflict) && <div className={styles.error} role="alert">{[...new Set([props.loadError, visibleError].filter((error): error is string => Boolean(error)))].map(error => <p key={error}>{knownFailureCopy(error) ?? error}</p>)}{workbench.conflict && <>
      {workbench.unresolvedPending.length > 0 && <div><p>These edits need to be entered again. Copy the values before discarding:</p>
        {workbench.unresolvedPending.map(edit => <p key={edit.path}><strong>{edit.label}:</strong> {edit.value || '(empty)'}</p>)}</div>}
      <div><button type="button" disabled={editBlocked || busy || !workbench.applicablePendingCount} onClick={() => { void workbench.applyPending().catch(() => {}); }}>Apply my edits</button><button type="button" onClick={() => { workbench.discardPending(); setFormReset(value => value + 1); }}>Discard pending edits</button></div></>}</div>}
    {sourceChanged && snapshot && <div className={styles.notice}>
      <p>The email or attachments changed. Review the updated evidence; previous Infor checks will need to be repeated.</p>
      <details><summary>Review updated email</summary><div className={styles.changedSourceText}>{source.sourceText || 'Open this email in Outlook to review it.'}</div></details>
      {source.attachments.map(file => <button type="button" key={file.sourceRef} onClick={() => props.onOpenAttachment?.(file.sourceRef)}>Open {file.name}</button>)}
      {snapshot.operationResults.some(row => row.status === 'unknown')
        ? <><p>Check earlier save outcomes before continuing.</p>{snapshot.operationResults.filter(row => row.status === 'unknown').map(row =>
          <div key={text(row.id)}>{row.workflow === 'guest_profile' ? 'Guest profile outcome unknown.' : text(row.summary) || text(row.workflow)} <button type="button" disabled={busy} onClick={() => { void commands.reconcile(text(row.id)).catch(() => {}); }}>Check outcome</button></div>)}</>
        : !recoveryOnly && <button type="button" disabled={busy || preview || Boolean(pendingDispatch)} onClick={() => { void workbench.reconcileSource().then(() => setChecked(null)).catch(() => {}); }}>I reviewed the updated evidence</button>}
    </div>}
    {recoveryOnly && snapshot?.session.workflowDispatches?.some(d => d.status === 'needs_reconcile' || d.status === 'failed') &&
      <div className={styles.notice} role="status">{staffFailureCopy('UNKNOWN', true)}</div>}
      {currentAttention && <div className={styles.notice} role="alert">
        <strong>{currentAttention.phase === 'review' ? 'Review needed before continuing.'
          : currentAttention.phase === 'save' ? request?.kind === 'quote' ? 'Quote generation didn’t finish — check the result before trying again.' : 'Save didn’t finish — check the outcome in Infor before trying again.'
          : hadWrite ? 'Check didn’t finish — review the details below.' : 'Check didn’t finish — no booking, stay or file was saved by this check.'}</strong>
        <p>{currentAttention.message}</p>
        {[...new Set(currentIssues.map(issueText))].map(reason => <p key={reason}>{reason}</p>)}
        {reviewButtons.length > 0 && <div>{reviewButtons.map(({ field, label, target }) => <button type="button" key={label} onClick={() => { if (target) activeTarget.current = target; focusField(field); }}>{label}</button>)}</div>}
      </div>}
      {props.skippedSource ? (props.skippedSource.kind === 'channel' || props.skippedSource.kind === 'system') && props.skippedSource.source
        ? <MailSourceNoActionCard kind={props.skippedSource.kind} source={props.skippedSource.source} />
        : <div className={styles.notice} role="status"><p>Nava takes no action on this email.</p></div>
      : null}
      {source.selfPreStay && <div className={styles.notice} role="status">
        <p>This pre-stay email describes an existing reservation. It cannot create a new booking.</p>
      </div>}
      {!snapshot ? (props.skippedSource ? null : <div className={styles.empty}>{props.loadError ? 'This email could not be opened.' : 'Opening your email draft…'}</div>)
        : reviewOnlyEmpty ? <div className={styles.empty}><h2>Needs review</h2><p>Nava could not confirm what this email needs.{snapshot.session.draft.disposition?.reason ? ` ${snapshot.session.draft.disposition.reason}` : ''} Check the email and decide if it needs work.</p>{[...new Set(earlierIssues.map(issueText))].map(reason => <p key={reason} className={styles.notice}>{reason}</p>)}<p className={styles.small}>If this email needs work, use + Action above.</p></div>
        : !request && !sourceChanged && snapshot.session.draft.disposition?.decision === 'no_action' && snapshot.session.draft.status === 'ready' && Boolean(snapshot.session.draft.extraction) && snapshot.session.draft.extractionGenerationId === snapshot.session.draft.generationId ? <div className={styles.empty}><h2>No action needed</h2><p>Nava checked this email and its attachments and found nothing for staff to do.{snapshot.session.draft.disposition.reason ? ` ${snapshot.session.draft.disposition.reason}` : ''}</p><p className={styles.small}>If this email does need work, use + Action above.</p></div>
        : !request ? (() => {
          const needsReview = prefill?.status === 'failed' || snapshot.session.draft.status === 'prefill_failed' || (snapshot.session.draft.status === 'partial' && ['complete', 'failed', 'superseded'].includes(prefill?.status ?? ''));
          return <div className={styles.empty}><h2>{needsReview ? 'Needs review' : 'What does this email need?'}</h2><p>{needsReview ? 'No automatic action was extracted. Add an action to begin, or retry prefill.' : 'Add an action to begin. Prefill will appear here when ready; your edits are saved.'}</p>{!source.selfPreStay && <button type="button" disabled={editBlocked} onClick={() => { void workbench.addAction('create').catch(() => {}); }}>New booking</button>}</div>;
        })()
        : createBlocked ? <div className={styles.empty}>This pre-stay email describes an existing reservation. Choose another action.</div>
        : Editor && editor ? <fieldset className={styles.sourceFieldset} disabled={editBlocked || Boolean(pendingDispatch)}><Editor key={`${source.messageId}:${source.sourceHash}:${source.selectionEpoch}:${request.id}:${formReset}`} {...editor} />{(request.kind === 'create' || request.kind === 'amend') && snapshot.session.draft.proposal.content.services.some(service => service.ownerRequestId === request.id || request && snapshot.session.draft.proposal.content.requests.find(row => row.id === request.id)?.serviceRefs.includes(service.id)) && <AddonsEditor key={`addons:${source.messageId}:${source.sourceHash}:${source.selectionEpoch}:${request.id}:${formReset}`} {...editor} />}</fieldset>
        : <div className={styles.empty}><h2>What does this email need?</h2>
          <p>{text(body.requestedText) || 'No supported task was identified. If this email needs work, choose an action to open its fields.'}</p>{Boolean(body.separatedFrom) && <p>This request is retained for staff to handle separately. It is excluded from the room quote.</p>}
          <div className={styles.otherActions} aria-label="Choose an email action">
            {actionKinds.filter(kind => !(source.selfPreStay && kind === 'create')).map(kind => <button type="button" key={kind}
              disabled={disabled} onClick={() => { void workbench.addAction(kind).catch(() => {}); }}>{labels[kind]}</button>)}
          </div></div>}
      {hasPendingAmendPrice && amendPriceReviews.length === 0 && <p className={styles.notice}>
        An earlier price review no longer matches the selected stay. Restore the selection and check again before saving.
      </p>}
      {amendPriceReviews.map(review => {
        const total = text(review.price.totalCents).padStart(3, '0'), average = text(review.price.averageCents).padStart(3, '0');
        const effects = record(review.result.callbackState).effects;
        const previous = snapshot && [...snapshot.session.draft.observations].reverse().find(row => row.kind === 'rate_availability' &&
          row.status === 'complete' && row.generationId === snapshot.session.draft.generationId && row.criteria.workflow === 'amend' &&
          row.propertyCode === snapshot.session.draft.propertyCode && row.sourceMessageId === snapshot.session.draft.source.messageId &&
          row.criteria.requestId === request?.id && row.criteria.hintId === review.id &&
          row.criteria.selectedRef === review.observation.criteria.selectedRef &&
          row.criteria.baseDigest === review.observation.criteria.baseDigest && record(row.result).outcome === 'prepared');
        const previousPrice = record(record(previous?.result).approvedPrices), previousTotal = text(previousPrice.totalCents);
        const changed = previousPrice.currency === review.price.currency && /^\d+$/.test(previousTotal) &&
          previousTotal.replace(/^0+(?=\d)/, '') !== text(review.price.totalCents).replace(/^0+(?=\d)/, '');
        const oldTotal = previousTotal.padStart(3, '0');
        const labels: Record<string, string> = { guaranteeType: 'Guarantee', organization: 'Organization',
          bookingAgency: 'Booking Agency', arAccount: 'A/R Account', childAges: 'Child ages' };
        return <section className={styles.priceBlock} key={review.observation.ref}>
          <div className={styles.notice}><strong>Step 1: details may already have changed in Infor.</strong>
            <p>Review this price before saving the stay.</p></div>
          <p>{text(review.target.confirmation)} · {text(review.target.arrival)} → {text(review.target.departure)}</p>
          {Array.isArray(effects) && effects.map(value => {
            const effect = record(value), label = labels[text(effect.field)];
            const requested = Array.isArray(effect.requested) ? effect.requested.map(text).join(', ') : text(effect.requested);
            return label ? <p key={label}>Requested {label}: {requested || 'See change above'}</p> : null;
          })}
          {!needsCheck() && !disabled && !workbench.saving && <>
            {typeof review.result.requestedMealPlan === 'string' && review.result.requestedMealPlan.trim() && <p>Requested Meal Plan: {review.result.requestedMealPlan}</p>}
            {Object.hasOwn(record(review.result.applied), 'mealPlan') && <p>Infor Meal Plan: {text(record(review.result.applied).mealPlan) || 'Not returned'}</p>}
          </>}
          <div className={styles.price}><span>Current Infor total</span><strong>{text(review.price.currency)} {total.slice(0, -2)}.{total.slice(-2)}</strong></div>
          {review.price.averageCents != null && <small className={styles.small}>Infor average: {text(review.price.currency)} {average.slice(0, -2)}.{average.slice(-2)}</small>}
          {changed && <p className={styles.notice}>Infor total changed from {text(review.price.currency)} {oldTotal.slice(0, -2)}.{oldTotal.slice(-2)}.</p>}
          {needsCheck() ? <p className={styles.notice}>Check the current details again before reviewing this price.</p>
            : review.accepted ? <p className={styles.small}>Price reviewed for this stay.</p>
            : <button type="button" disabled={disabled || workbench.saving || preview || pendingAmendReview?.id !== review.id}
              onClick={() => { if (workbench.readyForReply()) void commands.acceptFinancialReview(review.path, review.note, review.observation.ref).then(() => setAttention(null)).catch(() => {}); }}>I reviewed this Infor price</button>}
        </section>;
      })}
      {request?.kind === 'quote' && snapshot && <QuoteOutputPanel output={output} snapshot={snapshot} requestId={request.id} save={props.onSaveQuoteOutput} latestSnapshot={workbench.latestSnapshot} readyForReply={workbench.readyForReply} onSaved={setSavedQuoteOperation} blocked={busy || workbench.saving || workbench.blocked || workbench.conflict || editBlocked} />}
      {request?.kind === 'create' && snapshot?.preparationViews.filter(view => view.requestId === request.id && !snapshot.operationResults.some(row => row.workflow === 'create' && row.requestId === request.id && row.allocationId === view.allocationId && ['succeeded','unknown'].includes(text(row.status)))).map(view => {
        const comparison = record(record(view).priceComparison), requested = record(comparison.requested);
        const hasSourcePrice = !['', 'not_requested', 'not_applicable'].includes(text(comparison.status));
        const observedAt = text(record(view).observedAt);
        return <div key={view.allocationId} className={styles.priceBlock}>
          <div className={styles.price}><span>Room {ids.indexOf(view.allocationId) + 1} · Infor total</span><strong>{view.price ? [view.price.currency, view.price.totalRate].filter(value => value != null).join(' ') : 'Check price in Infor'}</strong></div>
          {view.price && <small className={styles.small}>{text(view.price.currency)} {text(view.price.averageRate)} per night{observedAt ? ` · Read ${new Date(observedAt).toLocaleTimeString([], {hour:'2-digit',minute:'2-digit'})}` : ''}</small>}
          {hasSourcePrice && <><div className={styles.price}><span>Voucher / customer price</span><strong>{[requested.currency, requested.nightlyRate != null ? `${text(requested.nightlyRate)} per night` : '', requested.total != null ? `total ${text(requested.total)}` : ''].filter(Boolean).join(' ') || 'Amount or currency unresolved'}</strong></div>
            <p className={comparison.status === 'mismatch' || comparison.blocksGo === true ? styles.notice : styles.small}>{comparison.status === 'mismatch' && text(requested.currency).toUpperCase() === 'ZAR' ? 'ZAR price differs. ' : ''}{text(comparison.explanation)}</p></>}
          <button type="button" disabled={disabled || preview} onClick={() => { setChecked(null); void commands.prepare(view.allocationId).catch(() => {}); }}>Refresh Infor price</button>
        </div>;
      })}
      {snapshot?.operationResults.filter(row => row.requestId === request?.id && row.status !== 'prepared').map(row => {
        const guest = row.workflow === 'guest_profile';
        const receipt = guestProfileReceipt(row);
        const missingReceipt = guest && row.status === 'succeeded' && !receipt;
        const summary = guest && (row.status === 'unknown' || missingReceipt) ? 'Guest profile'
          : receipt ? `Guest profile ${receipt.nativeId} created` : text(row.summary) || labels[request?.kind ?? 'other'];
        return <div className={styles.receipt} key={text(row.id)}>{summary} · {missingReceipt ? 'Needs confirmation' : text(row.status)}{!guest && row.confirmation ? ` · ${text(row.confirmation)}` : ''}{row.status === 'unknown' && <button type="button" onClick={() => { void commands.reconcile(text(row.id)).catch(() => {}); }}>Check outcome</button>}</div>;
      })}
      {dispatchNotices.map(dispatch =>
        <p key={dispatch.grantId} className={styles.notice} role="status">{staffFailureCopy(dispatch.failureClass, true)}</p>)}
      {pendingDispatch && !dispatchNotices.some(dispatch => dispatch.grantId === pendingDispatch.grantId) &&
        <p className={styles.notice} role="status">{pendingDispatch.status === 'needs_reconcile'
          ? staffFailureCopy('UNKNOWN', true) : 'Saving in Infor. Waiting for the confirmed outcome.'}</p>}
      {['queued', 'running'].includes(prefill?.status ?? '') && <p className={styles.small}>{prefill?.status === 'queued' ? 'Prefill is queued.' : prefill?.phase === 'native_checks' ? 'Checking the extracted details in Infor.' : 'Reading the email and attachments.'} You can start editing now.</p>}
      {directPrefillAbandoned && prefill.attemptCount < 2 && <p className={styles.small}>Prefill appears interrupted. Your edits are kept. <button type="button" disabled={disabled || workbench.saving} onClick={() => { void workbench.retryPrefill().catch(() => {}); }}>Retry prefill</button></p>}
      {prefill?.status === 'failed' && <p className={styles.small}>Prefill did not finish. Your form still works. {(prefill.phase === 'native_checks' || prefill.attemptCount < 2 || prefill.jobRunId) && <button type="button" disabled={disabled || workbench.saving} onClick={() => { void workbench.retryPrefill().catch(() => {}); }}>Retry prefill</button>}</p>}
      {!currentAttention && currentIssues.map((issue, index) => <p className={styles.notice} key={index}>{issueText(issue)}</p>)}
      {earlierIssues.length > 0 && !reviewOnlyEmpty && <details className={styles.earlierChecks}>
        <summary>Earlier email checks · {earlierIssues.length} notices</summary>
        {earlierIssues.map((issue, index) => <p className={styles.notice} key={index}>{issueText(issue)}</p>)}
      </details>}
    </main>
    {request && !createBlocked && !cancelHeld && request.kind !== 'services' && request.kind !== 'other' && request.kind !== 'filing' && <footer className={styles.footer}>
      {checked === digest && !pendingAmendReview && amendCallbackTargets[0]?.commissionUnknown && <div className={styles.notice}>
        Infor's agency commission could not be verified. Check the agency again before applying changes.
      </div>}
      {readiness.length > 0 && <div className={styles.notice} role="status">
        <strong>Complete before {needsCheck() ? 'checking' : 'saving'} the booking:</strong>
        <ul>{readiness.map((item, index) => <li key={`${item.code}:${item.path}:${index}`}>
          <button type="button" onClick={() => focusField(item.path)}>{item.message}</button>
        </li>)}</ul>
      </div>}
      {!needsCheck() && !pendingAmendReview && amendCallbackTargets[0] && <div className={styles.notice}>
        For {text(amendCallbackTargets[0].target.confirmation)} · {text(amendCallbackTargets[0].target.arrival)} → {text(amendCallbackTargets[0].target.departure)}.
        {amendCallbackTargets[0].commission && <><br />Agency {amendCallbackTargets[0].commission.name}: Infor selection default TA commission {amendCallbackTargets[0].commission.nativeDefault}%.
          {amendCallbackTargets[0].commission.requested !== null && <> Requested final TA commission: {amendCallbackTargets[0].commission.requested}%.</>}</>}
        <br />Infor details may change when you check the price. Review that price before saving.
      </div>}
      {stage && <div className={styles.stage} aria-label="Workflow progress">
        <ol>{stage.steps.map((step, index) => <li key={`${index}:${step.label}`} data-state={step.state} aria-current={step.state === 'current' ? 'step' : undefined} aria-label={`${index + 1}. ${step.label}: ${step.state}`}>{index + 1}. {step.label}</li>)}</ol>
        <p><strong>Now / Next:</strong> {currentAttention ? `Fix ${reviewButtons.length || 'the'} ${reviewButtons.length === 1 ? 'item' : 'items'} above. ` : ''}{stage.now}</p>
        {stage.showOutcomes && <><p><strong>You get:</strong> {stage.youGet}</p>
        <p><strong>Guest gets:</strong> {stage.guestGets}</p></>}
      </div>}
      <div className={styles.actions}>
        <button type="button" className={styles.primary} disabled={busy || !snapshot || workbench.conflict || editBlocked || preview || capabilityUnavailable || Boolean(pendingDispatch) || readiness.length > 0 || (capabilitySaveUnavailable && !needsCheck()) || filingLocked || request.kind === 'amend' && (workbench.saving || workbench.blocked)} onMouseDown={event => event.preventDefault()} onClick={() => { void submit(save); }}>{stage?.button}</button></div>
      {!currentAttention && (workbench.blocked || request.kind === 'amend' && workbench.saving) && <small>Finish editing or choose a selection before checking.</small>}
    </footer>}
  </div>;
}

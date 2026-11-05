import { createHash } from 'node:crypto';
import { MAIL_ACTIONS, type MailAction } from '../mail/action-labels.js';
import { projectAmendRequests, type DraftSource } from './pane-amend-draft.js';
import type { AttachmentRead } from './extraction/extract.js';
import type { MailExtractionPayload, MailKind } from './extraction/schema.js';
import { parseRequestField, requestFieldApplies, sourceRequests } from './work-item-fields.js';

type State = Record<string, unknown>;
type FieldMeta = { origin: 'staff' | 'email' | 'missing'; attributedTo: string | null;
  evidence: { messageId: string; excerpt: string; source?: { kind: 'message' | 'attachment_text' | 'attachment_vision';
    id: string; page?: number; digest?: string; reviewRequired?: boolean } } | null };
type Issue = { code: 'missing' | 'unsupported' | 'conflict'; fieldPath: string | null; message: string;
  blocksPrepare: boolean; blocksGo: boolean };
type Workflow = 'quote' | 'create' | 'amend' | 'cancel';
export type EffectiveRequest = { requestId: string; stayId: string; slot: string; action: MailAction;
  workflow: Workflow | null; status: 'pending' | 'blocked'; proposalDigest: string;
  fields: { kind: Workflow; value: unknown } | null; issues: Issue[]; operations: never[] };

const actionOf = (value: unknown): MailAction | null =>
  typeof value === 'string' && (MAIL_ACTIONS as readonly string[]).includes(value) ? value as MailAction : null;
const WORKFLOW: Partial<Record<MailAction, Workflow>> = {
  quote_availability: 'quote', new_booking: 'create', amend: 'amend',
};
const LEGACY: Partial<Record<MailKind, MailAction>> = {
  quote: 'quote_availability', booking: 'new_booking', amendment: 'amend', cancellation: 'cancel', voucher_pop: 'payment_proof',
};
const digest = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');

/** One action per stay; a source-level decision cannot be assigned across ambiguous stays. */
export function effectiveActions(source: DraftSource, payload: MailExtractionPayload, state: State,
  ownerAction: unknown, kind: MailKind, attachments: AttachmentRead[] | null, sourceStayCount = payload.stays.length) {
  const unique = sourceStayCount === 1;
  const requests = sourceRequests(source, payload, attachments);
  return requests.map((request) => {
    const original = actionOf(request.stay.action) ?? (unique ? actionOf(payload.action) ?? LEGACY[kind] ?? null : null);
    const staff = actionOf(state[`requests[${request.requestId}].action`]);
    const owner = unique ? actionOf(ownerAction) : null;
    const action = staff ?? owner ?? original;
    return { ...request, action, corrected: action !== original && (staff !== null || owner !== null) };
  });
}

export function pendingEffectiveActions(source: DraftSource, payload: MailExtractionPayload, state: State,
  ownerAction: unknown, kind: MailKind, attachments: AttachmentRead[] | null, sourceStayCount = payload.stays.length) {
  const entries = effectiveActions(source, payload, state, ownerAction, kind, attachments, sourceStayCount);
  return entries.filter(({ stay, action }) =>
    state[`stays[${stay.id}].removed`] !== true &&
    !(stay.rows.length > 0 && stay.rows.every((row) => state[`stays[${stay.id}].rows[${row.id}].removed`] === true)) &&
    action !== 'no_action');
}

/** Additive projection; action-specific dispatch still requires its own source/request guard. */
export function projectEffectiveWork(source: DraftSource, payload: MailExtractionPayload, state: State,
  ownerAction: unknown, kind: MailKind, attachments: AttachmentRead[] | null, sourceStayCount = payload.stays.length) {
  const meta: Record<string, FieldMeta> = {};
  const requests: EffectiveRequest[] = [];
  const entries = pendingEffectiveActions(source, payload, state, ownerAction, kind, attachments, sourceStayCount);
  for (const entry of entries) {
    const { stay, requestId, slot } = entry;
    const action = entry.action ?? 'other_actionable';
    const workflow = WORKFLOW[action] ?? null;
    const issues: Issue[] = [];
    if (!entry.action) issues.push({ code: 'conflict', fieldPath: null, message: 'Choose the request for this stay.', blocksPrepare: true, blocksGo: true });
    if (!workflow) issues.push({ code: 'unsupported', fieldPath: null, message: 'This request needs staff review.', blocksPrepare: true, blocksGo: true });
    if (entry.corrected) issues.push({ code: 'unsupported', fieldPath: null,
      message: 'This corrected action needs review before it can be prepared.', blocksPrepare: true, blocksGo: true });
    const value = (field: string, proposalKey?: keyof NonNullable<typeof stay.workflowProposal>) => {
      const path = `requests[${requestId}].${field}`;
      const proposal = proposalKey ? stay.workflowProposal?.[proposalKey] : undefined;
      const proposalSource = (proposal as (typeof proposal & { source?: NonNullable<FieldMeta['evidence']>['source'] }))?.source;
      const edited = Object.hasOwn(state, path);
      meta[path] = { origin: edited ? 'staff' : proposal ? 'email' : 'missing',
        attributedTo: proposal?.attributedTo ?? null,
        evidence: proposal ? { messageId: source.messageId, excerpt: proposal.excerpt,
          ...(proposalSource ? { source: proposalSource } : {}) } : null };
      if (edited) return state[path];
      return proposal ? field === 'cms.recipient' ? { mode: 'custom', address: proposal.value } : proposal.value : null;
    };
    const targetPath = `requests[${requestId}].target`;
    const confirmations = [...new Set((stay.guests ?? []).flatMap((guest) => guest.confirmationNumber ? [guest.confirmationNumber] : []))];
    const confirmation = confirmations.length === 1 ? confirmations[0] : confirmations.length === 0 &&
      payload.stays.length === 1 && payload.confirmationNumbers.length === 1 ? payload.confirmationNumbers[0] : null;
    const target = Object.hasOwn(state, targetPath) ? state[targetPath] :
      confirmation && stay.booked?.arrival ? { confirmation, arrival: stay.booked.arrival } : null;
    meta[targetPath] = { origin: Object.hasOwn(state, targetPath) ? 'staff' : target ? 'email' : 'missing', attributedTo: null, evidence: null };
    let fields: EffectiveRequest['fields'] = null;
    if (workflow === 'quote') {
      const stayValue = (name: 'arrival' | 'departure') => {
        const path = `stays[${stay.id}].requested.${name}`;
        return Object.hasOwn(state, path) ? state[path] : stay.requested[name];
      };
      const rows = stay.rows.filter((row) => state[`stays[${stay.id}].rows[${row.id}].removed`] !== true).map((row) => {
        const structural = (field: string, fallback: unknown) => {
          const path = `stays[${stay.id}].rows[${row.id}].${field}`;
          return Object.hasOwn(state, path) ? state[path] : fallback;
        };
        const selected = (field: string, fallback: unknown) => {
          const path = `requests[${requestId}].rows[${row.id}].${field}`;
          return Object.hasOwn(state, path) ? state[path] : fallback;
        };
        return { rowId: row.id, rooms: structural('count', row.rooms),
          requestedRoomType: structural('roomType', row.roomType), roomTypeCode: selected('roomTypeCode', null),
          adults: structural('adults', row.adultsPerRoom), childAges: structural('childAges', row.childAges),
          board: structural('board', row.board), ratePlan: selected('ratePlan', value('ratePlan', 'ratePlan')) };
      });
      fields = { kind: 'quote', value: { stayId: stay.id, arrival: stayValue('arrival'), departure: stayValue('departure'),
        rows, bookingAgency: value('parties.agency'), organization: value('parties.organization'),
        selectedOfferIds: value('quote.selectedOfferIds'), amountOverride: value('quote.amountOverride') } };
      if (Object.hasOwn(state, `requests[${requestId}].quote.selectedOfferIds`) ||
          Object.hasOwn(state, `requests[${requestId}].quote.amountOverride`)) {
        issues.push({ code: 'unsupported', fieldPath: null, message: 'Check the selected quote before preparing it.',
          blocksPrepare: true, blocksGo: true });
      }
    } else if (workflow === 'amend') {
      const amendPayload = { ...payload, stays: payload.stays.map((candidate) => ({ ...candidate,
        action: candidate.id === stay.id ? 'amend' as const : 'no_action' as const })) };
      const amend = projectAmendRequests(source, amendPayload, state);
      Object.assign(meta, amend.meta);
      fields = amend.requests[0]?.fields ?? null;
    } else if (workflow === 'create') {
      const date = (key: 'arrival' | 'departure') => Object.hasOwn(state, `stays[${stay.id}].requested.${key}`)
        ? state[`stays[${stay.id}].requested.${key}`] : stay.requested[key];
      const common = { guestProfile: value('guest.profile'), firstName: value('firstName', 'firstName'),
        lastName: value('lastName', 'lastName'), guestEmail: value('guestEmail', 'guestEmail'),
        guestMobile: value('guestMobile', 'guestMobile'), arrival: date('arrival'), departure: date('departure'),
        ratePlan: value('ratePlan', 'ratePlan'), bookingAgency: value('parties.agency'), organization: value('parties.organization'),
        sourceOfBusiness: value('sourceOfBusiness', 'sourceOfBusiness'), track: value('track', 'track'),
        guaranteeType: value('guaranteeType', 'guaranteeType'), reservationNote: value('reservationNote', 'reservationNote'),
        bookerName: value('bookerName', 'bookerName'), bookerEmail: value('bookerEmail', 'bookerEmail'),
        cms: { send: value('cms.send', 'cmsSend'), messageId: value('cms.messageId', 'cmsMessageId'),
          recipient: value('cms.recipient', 'cmsRecipient') } };
      const sourceRows = stay.rows.length ? stay.rows : [{ id: `${stay.id}_row`, roomType: null, rooms: null,
        adultsPerRoom: null, childAges: null, board: null }];
      const rooms = sourceRows.flatMap((row) => {
        const countPath = `stays[${stay.id}].rows[${row.id}].count`;
        const count = Object.hasOwn(state, countPath) ? state[countPath] : row.rooms ??
          (stay.rows.length === 1 ? stay.totalRooms : null);
        if (state[`stays[${stay.id}].rows[${row.id}].removed`] === true ||
            (count !== null && (typeof count !== 'number' || !Number.isInteger(count) || count < 1 || count > 8))) return [];
        if (count === null) issues.push({ code: 'missing', fieldPath: countPath,
          message: 'Choose the number of rooms for this stay.', blocksPrepare: true, blocksGo: true });
        const rowField = (field: string, fallback: unknown) => {
          const path = `stays[${stay.id}].rows[${row.id}].${field}`;
          return Object.hasOwn(state, path) ? state[path] : fallback;
        };
        const rowValue = (field: string, fallback: unknown) => {
          const path = `requests[${requestId}].rows[${row.id}].${field}`;
          return Object.hasOwn(state, path) ? state[path] : fallback;
        };
        return Array.from({ length: count ?? 1 }, (_, roomIndex) => {
          const roomValue = (field: string, fallback: unknown) => {
            const path = `requests[${requestId}].rows[${row.id}].rooms[${roomIndex}].${field}`;
            return Object.hasOwn(state, path) ? state[path] : fallback;
          };
          return { ...common, rowId: row.id, roomIndex,
            guestProfile: roomValue('guest.profile', common.guestProfile),
            firstName: roomValue('firstName', common.firstName), lastName: roomValue('lastName', common.lastName),
            guestEmail: roomValue('guestEmail', common.guestEmail), guestMobile: roomValue('guestMobile', common.guestMobile),
            arrival: roomValue('arrival', common.arrival), departure: roomValue('departure', common.departure),
            adults: roomValue('adults', rowField('adults', row.adultsPerRoom)),
            childAges: roomValue('childAges', rowField('childAges', row.childAges)),
            roomType: roomValue('roomTypeCode', rowValue('roomTypeCode', null)),
            ratePlan: roomValue('ratePlan', rowValue('ratePlan', common.ratePlan)),
            bookingAgency: roomValue('parties.agency', common.bookingAgency),
            organization: roomValue('parties.organization', common.organization),
            sourceOfBusiness: roomValue('sourceOfBusiness', common.sourceOfBusiness), track: roomValue('track', common.track),
            guaranteeType: roomValue('guaranteeType', common.guaranteeType),
            reservationNote: roomValue('reservationNote', common.reservationNote),
            bookerName: roomValue('bookerName', common.bookerName), bookerEmail: roomValue('bookerEmail', common.bookerEmail),
            cms: { send: roomValue('cms.send', common.cms.send), messageId: roomValue('cms.messageId', common.cms.messageId),
              recipient: roomValue('cms.recipient', common.cms.recipient) } };
        });
      });
      fields = { kind: 'create', value: rooms };
      if (!rooms.length) issues.push({ code: 'missing', fieldPath: null, message: 'Choose the rooms for this stay.', blocksPrepare: true, blocksGo: true });
    }
    if (!fields && workflow) issues.push({ code: 'unsupported', fieldPath: null, message: 'This request needs staff review.', blocksPrepare: true, blocksGo: true });
    requests.push({ requestId, stayId: stay.id, slot, action, workflow,
      status: issues.some((issue) => issue.blocksPrepare && issue.code !== 'missing') ? 'blocked' : 'pending', proposalDigest: digest({ action, fields }),
      fields, issues, operations: [] });
  }
  const identities = new Map(effectiveActions(source, payload, state, ownerAction, kind, attachments, sourceStayCount)
    .map((entry) => [entry.requestId, entry.action]));
  const visible = new Set(entries.map((entry) => entry.requestId));
  const unappliedEdits: Array<{ fieldPath: string; value: unknown;
    reason: 'request_removed' | 'identity_changed' | 'unsupported_field' }> = [];
  for (const [fieldPath, value] of Object.entries(state)) {
    const parsed = parseRequestField(fieldPath);
    if (parsed && !identities.has(parsed.requestId)) unappliedEdits.push({ fieldPath, value, reason: 'identity_changed' });
    else if (parsed && !visible.has(parsed.requestId) && parsed.field !== 'action')
      unappliedEdits.push({ fieldPath, value, reason: 'request_removed' });
    else if (parsed && !requestFieldApplies(parsed, identities.get(parsed.requestId) ?? null))
      unappliedEdits.push({ fieldPath, value, reason: 'unsupported_field' });
    else if (!parsed && /^requests\[[a-f0-9]{64}\]\./.test(fieldPath)) unappliedEdits.push({ fieldPath, value, reason: 'unsupported_field' });
  }
  return { requests, meta, unappliedEdits };
}

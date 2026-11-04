import { createHash } from 'node:crypto';
import type { ExtractionStay, MailExtractionPayload } from './extraction/schema.js';

export type DraftSource = { threadId: string; messageId: string; sourceHash: string };
export type AmendField =
  | 'target' | 'ratePlan' | 'retainRates' | 'firstName' | 'lastName' | 'guestEmail'
  | 'bookerName' | 'bookerContact' | 'cms.send' | 'cms.messageId' | 'cms.recipient';
type State = Record<string, unknown>;

const FIELDS = new Set<AmendField>([
  'target', 'ratePlan', 'retainRates', 'firstName', 'lastName', 'guestEmail',
  'bookerName', 'bookerContact', 'cms.send', 'cms.messageId', 'cms.recipient',
]);

/** The id identifies the source ask, not its editable action or values. */
export function amendRequestId(source: DraftSource, stayId: string): string {
  return createHash('sha256').update(JSON.stringify({
    messageId: source.messageId, sourceHash: source.sourceHash, stayId, slot: 'primary',
  })).digest('hex');
}

export function parseAmendRequestField(path: string): { requestId: string; field: AmendField } | null {
  const match = /^requests\[([a-f0-9]{64})\]\.(.+)$/.exec(path);
  if (!match || !FIELDS.has(match[2] as AmendField)) return null;
  return { requestId: match[1]!, field: match[2] as AmendField };
}

function plainRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function text(value: unknown, max: number): boolean {
  return typeof value === 'string' && value.length <= max && !/[\p{Cc}]/u.test(value);
}

function date(value: unknown): boolean {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const parsed = new Date(`${value}T00:00:00Z`);
  return Number.isFinite(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
}

/** Validate the exact field, not arbitrary nested JSON supplied by a client. */
export function validAmendRequestValue(field: AmendField, value: unknown): boolean {
  if (value === null) return true;
  switch (field) {
    case 'target':
      return plainRecord(value) && Object.keys(value).every((key) => key === 'confirmation' || key === 'arrival') &&
        typeof value.confirmation === 'string' && /^\d{6,}-\d+$/.test(value.confirmation) && date(value.arrival);
    case 'ratePlan': return typeof value === 'string' && /^[A-Z0-9]{1,12}$/.test(value);
    case 'retainRates': return value === 'yes' || value === 'no';
    case 'cms.send': return typeof value === 'boolean';
    case 'cms.messageId': return text(value, 8);
    case 'cms.recipient':
      return plainRecord(value) && Object.keys(value).every((key) => key === 'mode' || key === 'address') &&
        ['self', 'client', 'custom'].includes(String(value.mode)) && text(value.address, 255);
    default: return text(value, 1000);
  }
}

type Proposal = NonNullable<ExtractionStay['amendProposal']>;
const PROPOSAL_KEYS: Partial<Record<AmendField, keyof Proposal>> = {
  ratePlan: 'ratePlan', retainRates: 'retainRates', firstName: 'firstName', lastName: 'lastName',
  guestEmail: 'guestEmail', bookerName: 'bookerName', bookerContact: 'bookerContact',
  'cms.send': 'cmsSend', 'cms.messageId': 'cmsMessageId', 'cms.recipient': 'cmsRecipient',
};

export function amendEmailValue(stay: ExtractionStay, field: AmendField): unknown {
  const key = PROPOSAL_KEYS[field];
  const proposed = key ? stay.amendProposal?.[key] : undefined;
  if (!proposed) return null;
  if (field === 'cms.recipient') return { mode: 'custom', address: proposed.value };
  return proposed.value;
}

export function amendStayForRequest(
  source: DraftSource, payload: MailExtractionPayload, requestId: string,
): ExtractionStay | undefined {
  return payload.stays.find((stay) => (stay.action ?? payload.action ?? 'amend') === 'amend' &&
    amendRequestId(source, stay.id) === requestId);
}

/** First Amend projection. HMS baseline is deliberately resolved by the existing lookup. */
export function projectAmendRequests(source: DraftSource, payload: MailExtractionPayload, state: State) {
  const meta: Record<string, {
    origin: 'staff' | 'email' | 'missing'; attributedTo: string | null;
    evidence: { messageId: string; excerpt: string } | null;
  }> = {};
  const requests = payload.stays.flatMap((stay) => {
    if ((stay.action ?? payload.action ?? 'amend') !== 'amend') return [];
    const requestId = amendRequestId(source, stay.id);
    const valueOf = (field: AmendField): unknown => {
      const path = `requests[${requestId}].${field}`;
      const key = PROPOSAL_KEYS[field];
      const proposal = key ? stay.amendProposal?.[key] : undefined;
      const edited = Object.hasOwn(state, path);
      meta[path] = {
        origin: edited ? 'staff' : proposal ? 'email' : 'missing',
        attributedTo: proposal?.attributedTo ?? null,
        evidence: proposal ? { messageId: source.messageId, excerpt: proposal.excerpt } : null,
      };
      return edited ? state[path] : amendEmailValue(stay, field);
    };
    const confirmations = [...new Set((stay.guests ?? []).flatMap((guest) =>
      guest.confirmationNumber ? [guest.confirmationNumber] : []))];
    const confirmation = confirmations.length === 1 ? confirmations[0] :
      confirmations.length === 0 && payload.stays.length === 1 && payload.confirmationNumbers.length === 1
        ? payload.confirmationNumbers[0] : undefined;
    const targetPath = `requests[${requestId}].target`;
    const target = Object.hasOwn(state, targetPath) ? state[targetPath] :
      confirmation && stay.booked?.arrival ? { confirmation, arrival: stay.booked.arrival } : null;
    meta[targetPath] = { origin: Object.hasOwn(state, targetPath) ? 'staff' : target ? 'email' : 'missing',
      attributedTo: null, evidence: null };
    const stayValue = (field: 'arrival' | 'departure') => {
      const path = `stays[${stay.id}].requested.${field}`;
      return Object.hasOwn(state, path) ? state[path] : stay.requested[field];
    };
    const adultPath = `stays[${stay.id}].totalAdults`;
    const childPath = `stays[${stay.id}].totalChildren`;
    const singleRow = stay.rows.length === 1 ? stay.rows[0] : undefined;
    const agesPath = singleRow ? `stays[${stay.id}].rows[${singleRow.id}].childAges` : '';
    const fields = {
      target, arrival: stayValue('arrival'), departure: stayValue('departure'),
      adults: Object.hasOwn(state, adultPath) ? state[adultPath] : stay.totalAdults ?? null,
      children: Object.hasOwn(state, childPath) ? state[childPath] : stay.totalChildren ?? null,
      childAges: agesPath && Object.hasOwn(state, agesPath) ? state[agesPath] : singleRow?.childAges ?? null,
      roomType: null, ratePlan: valueOf('ratePlan'), retainRates: valueOf('retainRates'),
      firstName: valueOf('firstName'), lastName: valueOf('lastName'), guestEmail: valueOf('guestEmail'),
      bookerName: valueOf('bookerName'), bookerContact: valueOf('bookerContact'),
      cms: { send: valueOf('cms.send'), messageId: valueOf('cms.messageId'), recipient: valueOf('cms.recipient') },
    };
    const proposalDigest = createHash('sha256').update(JSON.stringify({ action: 'amend', fields })).digest('hex');
    return [{ requestId, stayId: stay.id, slot: 'primary', action: 'amend' as const,
      workflow: 'amend' as const, status: 'pending' as const, proposalDigest,
      fields: { kind: 'amend' as const, value: fields }, issues: [], operations: [] }];
  });
  const ids = new Set(requests.map((request) => request.requestId));
  const unappliedEdits = Object.entries(state).flatMap(([fieldPath, value]) => {
    const path = parseAmendRequestField(fieldPath);
    if (path && !ids.has(path.requestId)) return [{ fieldPath, value, reason: 'identity_changed' as const }];
    return [];
  });
  return { requests, meta, unappliedEdits };
}

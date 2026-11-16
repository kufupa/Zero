import { createHash } from 'node:crypto';
import { MAIL_ACTIONS, type MailAction } from '../mail/action-labels.js';
import { validAmendRequestValue, type AmendField, type DraftSource } from './pane-amend-draft.js';
import { validCancelRequestValue, type CancelField } from './pane-cancel-draft.js';
import { validIsoDate } from './quote-workflow-llm.js';
import type { ExtractionStay, MailExtractionPayload } from './extraction/schema.js';
import type { AttachmentRead } from './extraction/extract.js';

const BASE_FIELDS = new Set([
  'action', 'target', 'roomType', 'roomTypeForCharge', 'childAges', 'ratePlan', 'retainRates', 'guest.profile',
  'firstName', 'lastName',
  'guestEmail', 'guestMobile', 'bookerName', 'bookerEmail', 'bookerContact', 'parties.bookingAgency', 'parties.organization',
  'sourceOfBusiness', 'track', 'guaranteeType', 'reservationNote', 'billingReference', 'cms.send', 'cms.messageId', 'cms.recipient',
  'quote.selectedOfferIds', 'quote.amountOverride', 'cancel.reason', 'cancel.note',
]);
const ROOM_FIELDS = new Set([
  'guest.profile', 'firstName', 'lastName', 'guestEmail', 'guestMobile', 'bookerName', 'bookerEmail', 'bookerContact',
  'ratePlan', 'roomTypeCode', 'parties.bookingAgency', 'parties.organization', 'sourceOfBusiness', 'track', 'guaranteeType',
  'reservationNote', 'cms.send', 'cms.messageId', 'cms.recipient',
  'arrival', 'departure', 'adults', 'childAges',
]);

export type RequestField = { requestId: string; field: string; rowId: string | null; roomIndex: number | null };

export function requestIdFor(source: DraftSource, stayId: string, slot: string): string {
  return createHash('sha256').update(JSON.stringify({ messageId: source.messageId, sourceHash: source.sourceHash,
    stayId, slot })).digest('hex');
}

export type SourceRequest = { requestId: string; stay: ExtractionStay; slot: string; attachmentId: string | null;
  documentKind: 'voucher' | 'proof_of_payment' | null };

/** One source-bound request per extracted or staff-added stay. */
export function sourceRequests(source: DraftSource, payload: MailExtractionPayload, _attachments: AttachmentRead[] | null): SourceRequest[] {
  const requests: SourceRequest[] = [];
  for (const stay of payload.stays) {
    requests.push({ requestId: requestIdFor(source, stay.id, 'primary'), stay, slot: 'primary', attachmentId: null, documentKind: null });
  }
  return requests;
}

export function parseRequestField(path: string): RequestField | null {
  const match = /^requests\[([a-f0-9]{64})\]\.(.+)$/.exec(path);
  if (!match) return null;
  const requestId = match[1]!, suffix = match[2]!;
  if (BASE_FIELDS.has(suffix)) return { requestId, field: suffix, rowId: null, roomIndex: null };
  const row = /^rows\[([A-Za-z0-9_-]{1,40})\]\.(ratePlan|roomTypeCode)$/.exec(suffix);
  if (row) return { requestId, field: row[2]!, rowId: row[1]!, roomIndex: null };
  const room = /^rows\[([A-Za-z0-9_-]{1,40})\]\.rooms\[(0|[1-7])\]\.(.+)$/.exec(suffix);
  return room && ROOM_FIELDS.has(room[3]!)
    ? { requestId, rowId: room[1]!, roomIndex: Number(room[2]), field: room[3]! } : null;
}

/** A valid path is still unusable when it belongs to a different workflow. */
export function requestFieldApplies(request: RequestField, action: MailAction | null): boolean {
  if (request.field === 'action') return request.rowId === null;
  if (request.rowId !== null) {
    if (request.roomIndex !== null) return action === 'new_booking' && request.field !== 'bookerContact';
    return action === 'new_booking' || action === 'quote_availability';
  }
  const fields: Partial<Record<MailAction, readonly string[]>> = {
    amend: ['target', 'roomType', 'roomTypeForCharge', 'childAges', 'ratePlan', 'retainRates', 'firstName', 'lastName',
      'guestEmail', 'bookerName', 'bookerContact', 'reservationNote', 'billingReference',
      'cms.send', 'cms.messageId', 'cms.recipient'],
    quote_availability: ['ratePlan', 'parties.bookingAgency', 'parties.organization', 'quote.selectedOfferIds', 'quote.amountOverride'],
    new_booking: ['guest.profile', 'firstName', 'lastName', 'guestEmail', 'guestMobile', 'bookerName', 'bookerEmail',
      'parties.bookingAgency', 'parties.organization', 'ratePlan', 'sourceOfBusiness', 'track', 'guaranteeType',
      'reservationNote', 'cms.send', 'cms.messageId', 'cms.recipient'],
    cancel: ['target', 'cancel.reason', 'cancel.note'],
  };
  return action !== null && (fields[action]?.includes(request.field) ?? false);
}

const isObject = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);
const text = (value: unknown, max: number, required = false): boolean => typeof value === 'string' &&
  value.length <= max && (!required || value.trim().length > 0) && !/[\p{Cc}]/u.test(value);
const keys = (value: Record<string, unknown>, allowed: string[]) => Object.keys(value).every((key) => allowed.includes(key));

/** Field-specific, closed value contracts. IDs remain selections, not proof of native eligibility. */
export function validRequestValue(field: string, value: unknown): boolean {
  if (field === 'action') return typeof value === 'string' && (MAIL_ACTIONS as readonly string[]).includes(value);
  if (field === 'cms.send') return typeof value === 'boolean';
  if (field === 'cancel.reason' || field === 'cancel.note') return validCancelRequestValue(field as CancelField, value);
  if (value === null) return true;
  if (field === 'target' || field === 'roomType' || field === 'roomTypeForCharge' || field === 'childAges' ||
      field === 'ratePlan' || field === 'retainRates' || field === 'reservationNote' || field === 'billingReference' ||
      field === 'cms.messageId' || field === 'cms.recipient') {
    return validAmendRequestValue(field as AmendField, value);
  }
  switch (field) {
    case 'arrival':
    case 'departure': return typeof value === 'string' && validIsoDate(value) !== undefined;
    case 'adults': return Number.isInteger(value) && Number(value) >= 1 && Number(value) <= 9;
    case 'roomTypeCode': return typeof value === 'string' && /^[A-Z0-9]{1,12}$/.test(value);
    case 'guest.profile':
      return isObject(value) && keys(value, ['nativeId', 'firstName', 'lastName']) &&
        typeof value.nativeId === 'string' && /^\d{1,40}$/.test(value.nativeId) &&
        text(value.firstName, 100, true) && text(value.lastName, 100, true);
    case 'parties.bookingAgency':
    case 'parties.organization':
      return isObject(value) && keys(value, ['nativeId', 'name', 'code']) && text(value.nativeId, 40, true) &&
        text(value.name, 200, true) && (value.code === undefined || text(value.code, 80, true));
    case 'quote.selectedOfferIds':
      return Array.isArray(value) && value.length <= 40 && value.every((id) => text(id, 200, true)) &&
        new Set(value).size === value.length;
    case 'quote.amountOverride':
      return isObject(value) && keys(value, ['amountMinor', 'currency', 'reason', 'offerId']) &&
        Number.isSafeInteger(value.amountMinor) && Number(value.amountMinor) >= 0 && Number(value.amountMinor) <= 100_000_000 &&
        typeof value.currency === 'string' && /^[A-Z]{3}$/.test(value.currency) &&
        (value.reason === null || text(value.reason, 1000)) && text(value.offerId, 200, true);
    case 'bookerName': return text(value, 50);
    case 'bookerEmail': return text(value, 80);
    case 'sourceOfBusiness':
    case 'track':
    case 'guaranteeType': return text(value, 80);
    case 'firstName':
    case 'lastName':
    case 'guestEmail':
    case 'guestMobile':
    case 'bookerContact': return text(value, 1000);
    default: return false;
  }
}

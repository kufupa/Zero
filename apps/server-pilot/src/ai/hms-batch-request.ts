import { z } from 'zod';
import { isGuestSurname } from './pane-stay-lookup.js';
import { extractVoucherGuest } from './voucher-find.js';

const HMS_CONFIRMATION = /^\d{6,10}-\d{1,2}$/;
const CONFIRMATION_IN_TEXT = /(?<![\d-])\d{6,10}-\d{1,2}(?![\d-])/g;
const ISO_DAY = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const PREFETCH_PER_MAIL_MAX = 3;

/** The only read requests supported by Needs You HMS runs. */
export const HMS_NEEDS_YOU_KINDS = ['booking', 'amendment', 'cancellation', 'voucher_pop'] as const;

export type HmsBatchRequest =
  | { kind: 'find'; confirmation: string; arrival?: string }
  | { kind: 'search_guest'; lastName: string; arrival: string; departure?: string };

/** Confirmation numbers in mail text, validated and de-duplicated. Only the first few per mail. */
export function extractHmsConfirmations(text: string): string[] {
  const found: string[] = [];
  for (const match of text.matchAll(CONFIRMATION_IN_TEXT)) {
    const value = match[0];
    if (HMS_CONFIRMATION.test(value) && !found.includes(value)) found.push(value);
    if (found.length === PREFETCH_PER_MAIL_MAX) break;
  }
  return found;
}

/** A surname from an explicit guest label, never the extraction's sender/booker contact. */
export function explicitGuestSurname(subject: string | null, textBody: string | null): string | null {
  return extractVoucherGuest({
    subject: subject ?? '',
    bodyText: (textBody ?? '').slice(0, 4_000),
    attachmentTexts: [],
  }).lastName;
}

function extractionConfirmations(payload: unknown): string[] {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return [];
  const values = (payload as { confirmationNumbers?: unknown }).confirmationNumbers;
  if (!Array.isArray(values)) return [];
  return values.filter((value): value is string => typeof value === 'string' && HMS_CONFIRMATION.test(value));
}

/** Reads only when every valid matching stay resolves to one arrival; ambiguous/missing dates are not auto-searched. */
export function extractUniqueArrivalForHmsPrefetch(kind: string, payload: unknown): string | null {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return null;
  const stays = (payload as { stays?: unknown }).stays;
  if (!Array.isArray(stays) || stays.length === 0) return null;
  const arrivals = new Set<string>();
  for (const value of stays) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
    const stay = value as { requested?: unknown; booked?: unknown };
    const range = kind === 'booking' ? stay.requested : stay.booked;
    if (!range || typeof range !== 'object' || Array.isArray(range)) return null;
    const arrival = (range as { arrival?: unknown }).arrival;
    if (typeof arrival !== 'string' || !ISO_DAY.safeParse(arrival).success) return null;
    const date = new Date(`${arrival}T00:00:00.000Z`);
    if (Number.isNaN(date.getTime()) || date.toISOString().slice(0, 10) !== arrival) return null;
    arrivals.add(arrival);
  }
  return arrivals.size === 1 ? [...arrivals][0]! : null;
}

export function prefetchConfirmations(payload: unknown, subject: string | null, textBody: string | null): string[] {
  const text = extractHmsConfirmations(`${subject ?? ''}\n${textBody ?? ''}`);
  return [...new Set([...extractionConfirmations(payload), ...text])].slice(0, PREFETCH_PER_MAIL_MAX);
}

export function selectHmsBatchRequest(input: {
  kind: string | null;
  payload: unknown;
  subject: string | null;
  textBody: string | null;
}): { request: HmsBatchRequest } | { skipped: 'insufficient_data' } {
  const confirmation = prefetchConfirmations(input.payload, input.subject, input.textBody)[0];
  if (confirmation) return { request: { kind: 'find', confirmation } };

  const lastName = explicitGuestSurname(input.subject, input.textBody);
  const arrival = extractUniqueArrivalForHmsPrefetch(input.kind ?? '', input.payload);
  if (lastName && isGuestSurname(lastName) && arrival) {
    return { request: { kind: 'search_guest', lastName, arrival } };
  }
  return { skipped: 'insufficient_data' };
}

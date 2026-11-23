import { z } from 'zod';

const booking = z.object({
  id: z.string().min(1),
  property_code: z.string().nullable(),
  reservation_id: z.string().nullable(),
  current_state: z.record(z.unknown()).nullable(),
  fields: z.record(z.unknown()),
}).strict();

const action = z.object({
  id: z.string().min(1),
  type: z.string(),
  booking_ids: z.array(z.string()),
  details: z.unknown(),
}).strict();

export const prepareInput = z.object({ workflow: z.literal('create'), booking, action }).strict();
const stagedPrice = z.object({ averageRate: z.string().min(1), totalRate: z.string().min(1), currency: z.string().min(1) }).strict();
const savedSibling = z.object({
  confirmation:z.string(),nativeStayId:z.string(),approvedRequest:z.record(z.unknown()),requestDigest:z.string(),
  ratePlanAvailability:stagedPrice,checkedPricing:z.unknown().optional(),arProfileId:z.string().optional(),
}).strict();
export const saveInput = prepareInput.extend({ executionId: z.string().min(1).max(200), expectedPrice: stagedPrice.optional(),
  priorRooms:z.array(savedSibling).max(7).optional() }).strict();
export type CreateInput = z.infer<typeof prepareInput>;

/** Human labels for email extras shown in pane warnings / note lines. Not an allowlist gate. */
export const createStaffNoteLabels: Readonly<Record<string,string>> = {
  guest_name:'Guest name from email', guest_phone:'Guest phone', booker_email:'Booker email', booker_phone:'Booker phone',
  title:'Guest title from email', passport_number:'Passport number', board:'Requested meal plan (set by the rate)',
};
export function isCreateRateCode(value: unknown): value is string {
  return typeof value === 'string' && /^[A-Z0-9]{1,12}$/.test(value);
}
export const createNoteAliases = ['reservation_note','special_requests','staff_context'] as const;
/** @deprecated Empty — extras use the universal non-blocking rule in createExtraContext. Kept for proposal-fields import. */
export const createNonNativeFields = [] as const;

const scrub = (value: string) => value.trim().replace(/\r\n?/g, '\n').replace(/[\x00-\x09\x0b-\x1f\x7f]/g, ' ');
const humanize = (key: string) => createStaffNoteLabels[key] ?? key.replace(/_/g, ' ');

/** Native booking keys that map to HMS NativeRequest paths (see tools/create/index.ts fieldPaths). */
export const createNativeFieldKeys = new Set([
  'guest_profile_id', 'first_name', 'last_name', 'guest_email', 'arrival_date', 'departure_date', 'adults',
  'children', 'child_count', 'child_ages', 'room_type', 'room_type_for_charge', 'rate_plan', 'guarantee_type',
  'source_of_business', 'reason_for_stay', 'track', 'market_segment', 'guest_opt_in', 'billing_reference',
  'commission_percent', 'organization_id', 'organization_name', 'agency_id', 'agency_name', 'ar_account_id',
  'ar_account_name', 'booker_name', 'booker_contact', 'cms_send', 'cms_message_id', 'cms_recipient', 'price',
  'confirmation_recipient',
]);

const metaSkip = (field: string, value: unknown) =>
  field === 'room_count' || field.startsWith('profile_') || value === null || value === undefined || value === '' ||
  (field === 'quantity' && value === 1);

/**
 * Universal boundary: known native keys stay out; every other non-empty email field becomes
 * non-blocking extraContext — short staff-relevant text/bool/number → reservation note,
 * structured/long values → unmapped_context for pane display. Never blocks prepare/save.
 */
export function createExtraContext(fields: Record<string, unknown>): {
  note: string | null;
  unmapped_context: Record<string, unknown>;
  extra_context: Record<string, unknown>;
} {
  const noteParts: string[] = [];
  const unmapped_context: Record<string, unknown> = {};
  const extra_context: Record<string, unknown> = {};
  const noteKeys = new Set<string>(['note', ...createNoteAliases]);

  for (const [field, value] of Object.entries(fields)) {
    if (metaSkip(field, value) || createNativeFieldKeys.has(field)) continue;
    if (field === 'rate_plan') continue; // invalid codes skipped by buildRequest; valid ones are native
    if (field === 'note' || noteKeys.has(field)) {
      if (typeof value === 'string' && value.trim()) noteParts.push(scrub(value));
      if (field !== 'note') extra_context[field] = value;
      continue;
    }
    // Staff-label fields (board, title, passport, …) stay pane-visible extras — not HMS note lines.
    if (Object.hasOwn(createStaffNoteLabels, field)) {
      extra_context[field] = value;
      continue;
    }
    extra_context[field] = value;
    if (value === true) {
      noteParts.push(`${humanize(field)} requested`);
      continue;
    }
    if (value === false) continue;
    if (typeof value === 'string' && value.trim()) {
      const text = scrub(value);
      if (text.length <= 240) {
        noteParts.push(`${humanize(field)}: ${text}`);
        continue;
      }
      unmapped_context[field] = text;
      continue;
    }
    if (typeof value === 'number' && Number.isFinite(value)) {
      noteParts.push(`${humanize(field)}: ${value}`);
      continue;
    }
    unmapped_context[field] = value;
  }

  const note = noteParts.length ? [...new Set(noteParts)].join('\n') : null;
  return { note, unmapped_context, extra_context };
}

export function createReservationNote(fields: Record<string, unknown>): string | null {
  return createExtraContext(fields).note;
}

const nullableString = { anyOf: [{ type: 'string' }, { type: 'null' }] };
export const prepareDefinition = {
  name: 'hms_prepare',
  description: 'Stage one create request in HMS without saving. Returns native observations and unresolved fields.',
  input_schema: {
    type: 'object' as const,
    properties: {
      workflow: { type: 'string', enum: ['create'] },
      booking: {
        type: 'object',
        properties: {
          id: { type: 'string' }, property_code: nullableString, reservation_id: nullableString,
          current_state: { anyOf: [{ type: 'object' }, { type: 'null' }] }, fields: { type: 'object' },
        },
        required: ['id', 'property_code', 'reservation_id', 'current_state', 'fields'],
        additionalProperties: false,
      },
      action: {
        type: 'object',
        properties: { id: { type: 'string' }, type: { type: 'string' }, booking_ids: { type: 'array', items: { type: 'string' } }, details: {} },
        required: ['id', 'type', 'booking_ids', 'details'],
        additionalProperties: false,
      },
    },
    required: ['workflow', 'booking', 'action'],
    additionalProperties: false,
  },
};

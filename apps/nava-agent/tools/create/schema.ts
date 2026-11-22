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

export const createStaffNoteLabels: Readonly<Record<string,string>> = {
  guest_phone:'Guest phone', booker_email:'Booker email', booker_phone:'Booker phone',
  passport_number:'Passport number', board:'Requested meal plan (set by the rate)',
};
export function isCreateRateCode(value: unknown): value is string {
  return typeof value === 'string' && /^[A-Z0-9]{1,12}$/.test(value);
}
export const createNoteAliases = ['reservation_note','special_requests','staff_context'] as const;
export function createReservationNote(fields: Record<string,unknown>): string | null {
  const extra = createNoteAliases.flatMap(key => {
    const value = fields[key];
    return typeof value === 'string' && value.trim() ? [value.trim().replace(/\r\n?/g,'\n').replace(/[\x00-\x09\x0b-\x1f\x7f]/g,' ')] : [];
  });
  const note = typeof fields.note === 'string' ? fields.note : null;
  return extra.length ? [...new Set([...(note ? [note] : []), ...extra])].join('\n') : note;
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

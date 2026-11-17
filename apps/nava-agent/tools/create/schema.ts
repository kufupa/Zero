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
export const saveInput = prepareInput.extend({ executionId: z.string().min(1).max(200) }).strict();
export type CreateInput = z.infer<typeof prepareInput>;

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

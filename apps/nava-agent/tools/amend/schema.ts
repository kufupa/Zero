import { z } from 'zod';

const id = z.string().min(1).max(200);
const confirmation = z.string().regex(/^\d{6,10}(?:-\d{1,10})?$/);
export const day = z.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine(value => {
  const date = new Date(value + 'T00:00:00Z');
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value;
});
const code = z.string().regex(/^[A-Z0-9]{1,12}$/);
const text = (max: number) => z.string().max(max).regex(/^[^\p{Cc}]*$/u);

export const patch = z.object({
  arrival_date: day.optional(),
  departure_date: day.optional(),
  adults: z.number().int().min(1).max(16).optional(),
  room_type: code.optional(),
  rate_plan: code.optional(),
  first_name: text(100).min(1).optional(),
  last_name: text(100).min(1).optional(),
  booker_name: text(200).optional(),
  booker_contact: text(200).optional(),
  reservation_note: text(2000).optional(),
}).strict();

export const prepareEnvelope = z.object({
  workflow: z.literal('amend'),
  booking: z.object({
    id,
    property_code: z.string().regex(/^[A-Z][A-Z0-9]{1,15}$/),
    reservation_id: z.string().regex(/^\d{1,100}$/).nullable(),
    current_state: z.record(z.unknown()).nullable(),
    fields: z.record(z.unknown()),
  }).strict(),
  action: z.object({
    id,
    type: z.literal('amend'),
    booking_ids: z.tuple([id]),
    details: z.object({
      confirmation_number: confirmation,
      retain_rates: z.boolean().optional(),
    }).strict(),
  }).strict(),
}).strict();

// Shared hms_prepare routes here by workflow; no separate Amend tool name.
export const prepareManifest = {
  name: 'hms_prepare',
  description: 'Stage an amendment on one exact HMS stay without saving.',
  input_schema: {
    type: 'object' as const,
    properties: {
      workflow: { type: 'string', enum: ['amend'] },
      booking: {
        type: 'object',
        description: 'Booking envelope. fields contains only requested changes; reservation_id is the native stay ID or null.',
      },
      action: {
        type: 'object',
        description: 'Amend action for that booking. details.confirmation_number is required; details.retain_rates is optional.',
      },
    },
    required: ['workflow', 'booking', 'action'],
    additionalProperties: false,
  },
};

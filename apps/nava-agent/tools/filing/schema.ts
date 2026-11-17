import { z } from 'zod';

const text = (max: number) => z.string().min(1).max(max).refine(value => value === value.trim() && !/\p{Cc}/u.test(value));
const id = text(256);

export const filingBooking = z.object({
  id,
  property_code: z.string().regex(/^[A-Z0-9]{1,20}$/),
  reservation_id: text(128).nullable(),
  current_state: z.record(z.unknown()).nullable(),
  fields: z.record(z.unknown()),
}).strict();

export const filingPrepare = z.object({
  workflow: z.literal('filing'),
  booking: filingBooking,
  action: z.object({
    id,
    type: z.enum(['filing', 'attach_document', 'voucher_submission', 'payment_proof_submission']),
    booking_ids: z.tuple([id]),
    details: z.object({
      message_id: id,
      attachment_id: id,
      description: text(200).optional(),
    }).strict(),
  }).strict(),
}).strict();

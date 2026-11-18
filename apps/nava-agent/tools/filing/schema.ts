import { z } from 'zod';

const text = (max: number) => z.string().min(1).max(max).refine(value => value === value.trim() && !/\p{Cc}/u.test(value));
const id = text(256);
const nativeDescriptionLimit = 80;
export const filingDescription = z.string().min(1).refine(value => value === value.trim() && !/\p{Cc}/u.test(value))
  .transform(value => value.slice(0, nativeDescriptionLimit).replace(/[\uD800-\uDBFF]$/, '').trimEnd());

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
      description: filingDescription.optional(),
    }).strict(),
  }).strict(),
}).strict();

export const filingPrepared = z.object({
  outcome: z.literal('prepared'), unsaved: z.literal(true), booking_id: id,
  target: z.object({
    property_code: id, confirmation: id, reservation_id: id, reservation_stay_id: id, native_status: id,
    native_stay: z.object({
      propertyCode: id, confirmation: id, firstName: text(200), lastName: text(200),
      arrival: z.string().date(), departure: z.string().date(), nativeGuestId: id, nativeStayId: id,
      allowRealGuest: z.boolean(),
    }).strict(),
    native_snapshot: z.object({ cmsSend: z.boolean() }).strict(),
  }).passthrough(),
  source: z.object({ message_id: id, attachment_id: id }).strict(),
  document: z.object({
    name: text(150), mime_type: z.literal('application/pdf'), sha256: z.string().regex(/^[a-f0-9]{64}$/),
    document_code: z.string().regex(/^NAVA[A-Z2-7]{25}[AEIMQUY4]$/), upload_name: text(150), description: text(200),
  }).strict(),
}).passthrough();

export const filingSave = filingPrepare.extend({ executionId: id, prepared: filingPrepared.optional() }).strict();

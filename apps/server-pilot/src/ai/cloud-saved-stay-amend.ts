import { z } from 'zod';

const calendarDay = z.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine((day) => {
  const date = new Date(`${day}T00:00:00Z`);
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === day;
});
/** Untrusted staff proposal; this schema does not approve or authorise any HMS action. */
export const cloudSavedStayAmendPayloadSchema = z.object({
  source: z.object({
    threadId: z.string().trim().min(1).max(512),
    messageId: z.string().trim().min(1).max(512),
    mailboxEmail: z.string().trim().min(3).max(320),
    sourceHash: z.string().regex(/^[a-f0-9]{64}$/),
  }).strict(),
  preimageRef: z.string().trim().min(1).max(512),
  proposal: z.object({
    confirmation: z.string().regex(/^\d{6,10}-\d{1,2}$/),
    changes: z.object({
      arrival: calendarDay.optional(), departure: calendarDay.optional(),
      adults: z.number().int().min(1).max(16).optional(),
      children: z.number().int().min(0).max(9).optional(),
      childAges: z.array(z.number().int().min(0).max(17)).max(9).optional(),
      ratePlan: z.string().trim().min(1).max(64).optional(),
    }).strict().superRefine((changes, ctx) => {
      if (!Object.values(changes).some((value) => value !== undefined))
        ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'A change is required.' });
      if (changes.arrival && changes.departure && changes.arrival >= changes.departure)
        ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'Departure must follow arrival.' });
      if ((changes.children !== undefined || changes.childAges !== undefined) &&
          (changes.children === undefined || !changes.childAges || changes.childAges.length !== changes.children))
        ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'Exact child count and ages are required.' });
    }),
    retainRates: z.enum(['yes', 'no']).optional(),
  }).strict(),
}).strict();

export type CloudSavedStayAmendPayload = z.infer<typeof cloudSavedStayAmendPayloadSchema>;
export const cloudSavedStayAmendEnvelopeSchema = z.object({
  executor: z.literal('cloud-write/v1'), action: z.literal('amend'),
  propertyCode: z.string().regex(/^[A-Z0-9]{2,20}$/),
  payload: cloudSavedStayAmendPayloadSchema,
}).strict();
export type CloudSavedStayAmendEnvelope = z.infer<typeof cloudSavedStayAmendEnvelopeSchema>;

/** No native date/occupancy save is currently verified. Never treat this as approval or dispatch. */
export function checkCloudSavedStayAmendHold(input: unknown): { outcome: 'input_gap' | 'not_dispatched'; issue: string } {
  if (!cloudSavedStayAmendEnvelopeSchema.safeParse(input).success) return { outcome: 'input_gap', issue: 'AMEND_INPUT_INVALID' };
  return { outcome: 'not_dispatched', issue: 'NATIVE_AMEND_SAVE_NOT_VERIFIED' };
}

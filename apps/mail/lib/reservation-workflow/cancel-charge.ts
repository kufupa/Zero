import { z } from 'zod';

export const cancelChargeSchema = z.union([
  z.object({ status: z.literal('none') }),
  z.object({
    status: z.enum(['pending', 'approved', 'uncertain', 'submitted', 'declined', 'expired']),
    challengeId: z.string().uuid(),
    dialogDigest: z.string().regex(/^[a-f0-9]{64}$/),
    penaltyText: z.string().min(1),
    timing: z.enum(['before_save', 'after_save']),
    matchesReviewed: z.boolean(),
    expiresAt: z.string().datetime(),
  }),
]);

export type CancelCharge = z.infer<typeof cancelChargeSchema>;

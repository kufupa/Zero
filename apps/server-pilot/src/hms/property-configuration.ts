import { z } from 'zod';
import { propertyCodeSchema } from './property-registry.js';

const rateSchema = z.object({
  code: z.string(), name: z.string(),
  mealPlan: z.enum(['room_only', 'bed_breakfast', 'dinner_bed_breakfast', 'unknown']),
  contract: z.boolean().optional(), government: z.boolean().optional(), event: z.boolean().optional(),
});
const choiceSchema = z.object({ code: z.string(), meaning: z.string() });
const capabilitySchema = z.object({
  status: z.enum(['unavailable', 'prepare-only', 'lab', 'staff-enabled']),
  reason: z.string().nullable(),
});
const coverageSchema = z.enum(['complete', 'partial', 'unknown']);
export const propertyConfigurationSchema = z.object({
  transportId: z.string(), propertyCode: propertyCodeSchema, tenantId: z.string(),
  rates: z.array(rateSchema), ratePlans: z.array(rateSchema),
  roomTypes: z.array(z.object({ code: z.string(), label: z.string() })),
  mealPlans: z.array(z.enum(['room_only', 'bb', 'dinner_bb'])),
  nativeMealMappings: z.array(z.object({ label: z.string(), mealPlan: z.enum(['room_only', 'bb', 'dinner_bb']) })),
  salesStrategies: z.array(z.object({
    code: z.enum(['BAR', 'PROMO', 'PRESET', 'WS', 'NC', 'GOV', 'AIR', 'DOML', 'OTHER']),
    label: z.string(), requestValue: z.enum(['BAR', 'PROMO', 'PRESET', 'WS', 'NC', 'GOV', 'AIR', 'DOML', 'OTHER', 'Government']),
  })),
  overrideRateCodes: z.array(z.string()), eventRateCodes: z.array(z.string()),
  shuttle: z.object({ provider: z.string(), to: z.array(z.string()) }).nullable().optional(),
  formPolicy: z.object({
    requiredFields: z.array(z.string()),
    guestOptIn: z.enum(['unknown', 'unsupported', 'optional', 'required']),
    cancellation: z.enum(['unknown', 'supported']),
    guaranteeChoices: z.array(choiceSchema.extend({ ready: z.boolean(), reason: z.string().nullable() })),
    cmsChoices: z.array(choiceSchema), childCategoryPolicy: z.literal('discover_active'),
    marketSegmentChoices: z.array(choiceSchema).optional(),
    childCategories: z.array(z.object({ field: z.string(), label: z.string(), minimumAge: z.number().int(),
      maximumAge: z.number().int(), visible: z.boolean() })).optional(),
  }),
  capabilities: z.object({
    reads: capabilitySchema, quote: capabilitySchema, create: capabilitySchema, amend: capabilitySchema,
    cancel: capabilitySchema, attach: capabilitySchema, addons: capabilitySchema, guest_profile_create: capabilitySchema,
  }),
  catalogue: z.object({
    identity: z.string().nullable(), capturedAt: z.string().nullable(), expiresAt: z.string().nullable(),
    coverage: z.object({ rates: coverageSchema, roomTypes: coverageSchema, mealPlans: coverageSchema }),
  }),
});
export type PropertyConfiguration = z.infer<typeof propertyConfigurationSchema>;

import { z } from 'zod';
import {
  readFactSchema,
  readAdmissionSchema,
  readLocalDateSchema,
  readMoneySchema,
  readPageSchema,
  readRefSchema,
  readResultSchema,
  readSectionAvailableSchema,
  readSectionUnavailableSchema,
  readTimestampSchema,
  type ReadFact,
  type ReadResult,
  type ReadSection,
} from './read-service-contracts.js';

export const RESERVATION_CONTEXT_SCHEMA_VERSION = 'reservation-context/1';
export const RESERVATION_FIND_SCHEMA_VERSION = 'reservation-find/1';

export const reservationContextSections = [
  'core',
  'stay',
  'rates',
  'policies',
  'operations',
] as const;
export type ReservationContextSection = (typeof reservationContextSections)[number];
export const reservationContextSectionSchema = z.enum(reservationContextSections);

export const reservationDetailSchema = z.enum(['summary', 'detail']);
export type ReservationDetail = z.infer<typeof reservationDetailSchema>;

export const reservationContextRequestSchema = z
  .object({
    toolId: z.literal('hms_read_reservation'),
    reservationRef: readRefSchema,
    /** Optional exact candidate binding used by the worker re-derivation path. */
    candidateId: readRefSchema.optional(),
    sections: z
      .array(reservationContextSectionSchema)
      .min(1)
      .max(5)
      .refine((sections) => new Set(sections).size === sections.length, 'sections must be unique')
      .default(['core', 'stay']),
    detail: reservationDetailSchema.default('summary'),
    admission: readAdmissionSchema.optional(),
  })
  .strict();
export type ReservationContextRequest = z.infer<typeof reservationContextRequestSchema>;

export const reservationFindRequestSchema = z
  .object({
    toolId: z.literal('hms_find_reservation'),
    candidateId: readRefSchema,
    admission: readAdmissionSchema.optional(),
  })
  .strict();
export type ReservationFindRequest = z.infer<typeof reservationFindRequestSchema>;

export const reservationCoreSchema = z
  .object({
    confirmation: readFactSchema,
    externalReference: readFactSchema,
    status: readFactSchema,
    guestRefs: readFactSchema,
    organizationRef: readFactSchema,
    agencyRef: readFactSchema,
    groupRef: readFactSchema,
  })
  .strict();
export type ReservationCore = {
  confirmation: ReadFact<string>;
  externalReference: ReadFact<string>;
  status: ReadFact<string>;
  guestRefs: ReadFact<string[]>;
  organizationRef: ReadFact<string>;
  agencyRef: ReadFact<string>;
  groupRef: ReadFact<string>;
};

export const reservationStaySchema = z
  .object({
    arrival: readFactSchema,
    departure: readFactSchema,
    roomType: readFactSchema,
    roomQuantity: readFactSchema,
    adults: readFactSchema,
    childAges: readFactSchema,
    additionalGuests: readFactSchema,
  })
  .strict();
export type ReservationStay = {
  arrival: ReadFact<string>;
  departure: ReadFact<string>;
  roomType: ReadFact<string>;
  roomQuantity: ReadFact<number>;
  adults: ReadFact<number>;
  childAges: ReadFact<number[]>;
  additionalGuests: ReadFact<string[]>;
};

export const nightlyRateSchema = z
  .object({
    night: readLocalDateSchema,
    roomType: readFactSchema,
    ratePlan: readFactSchema,
    price: readFactSchema,
    inventory: readFactSchema,
    restrictions: readFactSchema,
    inclusions: readFactSchema,
    taxes: readFactSchema,
    fees: readFactSchema,
  })
  .strict();

export const reservationRateListSchema = z
  .object({ items: z.array(nightlyRateSchema).max(50), page: readPageSchema.nullable() })
  .strict();

export const reservationPoliciesSchema = z
  .object({
    guarantee: readFactSchema,
    deposit: readFactSchema,
    cancellation: readFactSchema,
    policyVersion: readFactSchema,
  })
  .strict();

export const reservationOperationObservationSchema = z
  .object({
    kind: readFactSchema,
    permittedText: readFactSchema,
    dueAt: readFactSchema,
    sourceStatus: readFactSchema,
  })
  .strict();

export const reservationOperationListSchema = z
  .object({
    items: z.array(reservationOperationObservationSchema).max(50),
    page: readPageSchema.nullable(),
  })
  .strict();

export const reservationContextDataSchema = z
  .object({
    core: z.union([
      readSectionAvailableSchema.extend({ data: reservationCoreSchema }),
      readSectionUnavailableSchema,
    ]),
    stay: z.union([
      readSectionAvailableSchema.extend({ data: reservationStaySchema }),
      readSectionUnavailableSchema,
    ]),
    rates: z.union([
      readSectionAvailableSchema.extend({ data: reservationRateListSchema }),
      readSectionUnavailableSchema,
    ]),
    policies: z.union([
      readSectionAvailableSchema.extend({ data: reservationPoliciesSchema }),
      readSectionUnavailableSchema,
    ]),
    operations: z.union([
      readSectionAvailableSchema.extend({ data: reservationOperationListSchema }),
      readSectionUnavailableSchema,
    ]),
  })
  .strict();
export type ReservationContextData = {
  core: ReadSection<ReservationCore>;
  stay: ReadSection<ReservationStay>;
  rates: ReadSection<z.infer<typeof reservationRateListSchema>>;
  policies: ReadSection<z.infer<typeof reservationPoliciesSchema>>;
  operations: ReadSection<z.infer<typeof reservationOperationListSchema>>;
};

export const reservationMatchSchema = z
  .object({
    reservationRef: readRefSchema.nullable(),
    label: readFactSchema,
    referenceKind: readFactSchema,
    status: readFactSchema,
    arrival: readFactSchema,
    departure: readFactSchema,
    roomType: readFactSchema,
    matchEvidenceRefs: z.array(readRefSchema).max(8),
  })
  .strict();
export type ReservationMatch = {
  reservationRef: string | null;
  label: ReadFact<string>;
  referenceKind: ReadFact<'confirmation' | 'external'>;
  status: ReadFact<string>;
  arrival: ReadFact<string>;
  departure: ReadFact<string>;
  roomType: ReadFact<string>;
  matchEvidenceRefs: string[];
};

export const reservationFindDataSchema = z
  .object({
    matches: z.array(reservationMatchSchema).max(20),
    matchCount: z.number().int().nonnegative(),
    capped: z.boolean(),
  })
  .strict();
export type ReservationFindData = z.infer<typeof reservationFindDataSchema>;

export const reservationContextReadResultSchema = readResultSchema.extend({
  schemaVersion: z.literal(RESERVATION_CONTEXT_SCHEMA_VERSION),
  data: reservationContextDataSchema.nullable(),
});
export type ReservationContextReadResult = ReadResult<ReservationContextData>;

export const reservationFindResultSchema = readResultSchema.extend({
  schemaVersion: z.literal(RESERVATION_FIND_SCHEMA_VERSION),
  data: reservationFindDataSchema.nullable(),
});
export type ReservationFindResult = ReadResult<ReservationFindData>;

// Keep these exports close to the U8 contract for callers that want to build
// reservation facts without knowing the shared contract module's internals.
export { readFactSchema, readMoneySchema, readTimestampSchema };

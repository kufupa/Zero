/**
 * Source-bound result shapes for the linked company, group, event, and notes
 * reads. These are deliberately separate from the older fixture kernels: the
 * normal executor returns field-level facts and independent section outcomes.
 */
import {
  readFactSchema,
  readPageSchema,
  readRefSchema,
  readSectionAvailableSchema,
  readSectionUnavailableSchema,
  type ReadFact,
} from './read-service-contracts.js';
import { z } from 'zod';

const sectionIssueSchema = z
  .object({
    code: z.string().min(1),
    retryable: z.boolean(),
    safeNextAction: z.enum(['retry_same_read', 'request_input', 'manual_review', 'none']),
  })
  .strict();

const availableSection = <T extends z.ZodTypeAny>(data: T) =>
  readSectionAvailableSchema.extend({ data });

const boundedReadRefSchema = readRefSchema;

export const companyAccountContextDataSchema = z
  .object({
    companyRef: readFactSchema,
    billingMode: readFactSchema,
    paymentTerms: readFactSchema,
    requiredPaperwork: readFactSchema,
    billingReference: readFactSchema,
    arAccountRef: readFactSchema,
    organizationRef: readFactSchema,
    agencyRef: readFactSchema,
    negotiatedRateRefs: readFactSchema,
    restrictions: readFactSchema,
    audience: readFactSchema,
  })
  .strict();
export type CompanyAccountContextData = z.infer<typeof companyAccountContextDataSchema>;

export const groupBlockSummaryDataSchema = z
  .object({
    groupRef: readFactSchema,
    status: readFactSchema,
    startDate: readFactSchema,
    endDate: readFactSchema,
    releasePolicy: readFactSchema,
    billingRef: readFactSchema,
  })
  .strict();

export const groupBlockRowDataSchema = z
  .object({
    night: readFactSchema,
    roomType: readFactSchema,
    contracted: readFactSchema,
    blocked: readFactSchema,
    pickedUp: readFactSchema,
    remaining: readFactSchema,
    sourceFieldMapping: readFactSchema,
  })
  .strict();

export const groupBlockRowsDataSchema = z
  .object({
    items: z.array(groupBlockRowDataSchema).max(100),
    page: readPageSchema.nullable(),
  })
  .strict();

export const groupDelegateDataSchema = z
  .object({
    delegateRef: boundedReadRefSchema,
    reservationRef: readFactSchema,
    arrival: readFactSchema,
    departure: readFactSchema,
    roomQuantity: readFactSchema,
    roomType: readFactSchema,
    billingRef: readFactSchema,
  })
  .strict();

export const groupDelegatesDataSchema = z
  .object({
    items: z.array(groupDelegateDataSchema).max(100),
    page: readPageSchema.nullable(),
  })
  .strict();

const groupSummarySectionSchema = z.union([
  availableSection(groupBlockSummaryDataSchema),
  readSectionUnavailableSchema,
]);
const groupBlocksSectionSchema = z.union([
  availableSection(groupBlockRowsDataSchema),
  readSectionUnavailableSchema,
]);
const groupDelegatesSectionSchema = z.union([
  availableSection(groupDelegatesDataSchema),
  readSectionUnavailableSchema,
]);

export const groupBlockContextDataSchema = z
  .object({
    summary: groupSummarySectionSchema,
    blocks: groupBlocksSectionSchema,
    delegates: groupDelegatesSectionSchema,
  })
  .strict();
export type GroupBlockContextData = z.infer<typeof groupBlockContextDataSchema>;

export const eventContextDataSchema = z
  .object({
    eventRef: readFactSchema,
    source: readFactSchema,
    masterRef: readFactSchema,
    status: readFactSchema,
    startAt: readFactSchema,
    endAt: readFactSchema,
    layout: readFactSchema,
    persons: readFactSchema,
    setup: readFactSchema,
    lines: z.union([readFactSchema, readSectionUnavailableSchema]),
    quotedAmount: readFactSchema,
    contractedAmount: readFactSchema,
    depositAmount: readFactSchema,
    depositReceived: readFactSchema,
    depositDueDate: readFactSchema,
    linkedRefs: readFactSchema,
  })
  .strict();
export type EventContextData = z.infer<typeof eventContextDataSchema>;

export const notesTraceItemSchema = z
  .object({
    noteRef: boundedReadRefSchema,
    resourceRef: boundedReadRefSchema,
    sourceKind: readFactSchema,
    permittedText: readFactSchema,
    audience: readFactSchema,
    customerPrintable: readFactSchema,
    status: readFactSchema,
    dueAt: readFactSchema,
    deliveredAt: readFactSchema,
    method: readFactSchema,
    authorLabel: readFactSchema,
    createdAt: readFactSchema,
  })
  .strict();
export type NotesTraceItem = z.infer<typeof notesTraceItemSchema>;

export const notesTracesListDataSchema = z
  .object({
    items: z.array(notesTraceItemSchema).max(50),
    page: readPageSchema.nullable(),
  })
  .strict();

export const notesTracesContextDataSchema = z
  .object({
    notes: z.union([
      availableSection(notesTracesListDataSchema),
      readSectionUnavailableSchema,
      notesTracesListDataSchema,
    ]),
  })
  .strict();
export type NotesTracesContextData = z.infer<typeof notesTracesContextDataSchema>;

export type ContextReadData =
  | CompanyAccountContextData
  | GroupBlockContextData
  | EventContextData
  | NotesTracesContextData;

function knownAudience(value: unknown): string | null {
  if (!value || typeof value !== 'object') return null;
  const fact = value as Partial<ReadFact<unknown>>;
  return fact.state === 'known' && typeof fact.value === 'string' ? fact.value : null;
}

function knownBoolean(value: unknown): boolean | null {
  if (!value || typeof value !== 'object') return null;
  const fact = value as Partial<ReadFact<unknown>>;
  return fact.state === 'known' && typeof fact.value === 'boolean' ? fact.value : null;
}

/**
 * Customer-facing reads must filter before the durable result is returned.
 * Unknown audience/printability is not disclosure permission, so it is
 * excluded rather than guessed safe.
 */
export function filterNotesForAudience(
  data: NotesTracesContextData,
  audience: 'staff' | 'customer',
): NotesTracesContextData {
  if (audience === 'staff') {
    return data;
  }
  if (!('state' in data.notes)) {
    return {
      ...data,
      notes: {
        ...data.notes,
        items: data.notes.items.filter((item) => {
          return (
            knownAudience(item.audience) === 'customer_disclosable' &&
            knownBoolean(item.customerPrintable) === true
          );
        }),
      },
    };
  }
  if (data.notes.state === 'unavailable' || data.notes.state === 'not_requested') {
    return data;
  }
  if (!data.notes.data) return data;
  return {
    ...data,
    notes: {
      ...data.notes,
      data: {
        ...data.notes.data,
        items: data.notes.data.items.filter((item) => {
          return (
            knownAudience(item.audience) === 'customer_disclosable' &&
            knownBoolean(item.customerPrintable) === true
          );
        }),
      },
    },
  };
}

export const contextReadSectionIssueSchema = sectionIssueSchema;

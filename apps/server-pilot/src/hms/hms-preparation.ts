import { createHash } from 'node:crypto';
import { and, eq } from 'drizzle-orm';
import { z } from 'zod';
import type { DB } from '../db/client.js';
import { workEvent } from '../db/schema/work.js';
import { canonicalJson } from '../ai/draft-approval.js';
import { propertyCodeSchema, resolvedPropertyScopeSchema, type ResolvedPropertyScope } from './property-registry.js';
import type { PropertyConfiguration } from './property-configuration.js';
import { reservationWorkflowV2PrepareInputSchema, reservationWorkflowV2GuestPrepareInputSchema } from '../ai/reservation-workflow-v2-contract.js';
import { effectiveWorkflowPolicy } from '../../tooling/hms-cloud/hms-workflow-policy.mjs';

const serviceId = z.string().min(1).max(80);
export const hmsPreparedWorkflowContextSchema = z.discriminatedUnion('endpoint', [
  z.object({ endpoint: z.literal('execute'), input: reservationWorkflowV2PrepareInputSchema }).strict(),
  z.object({ endpoint: z.literal('createGuestProfile'), input: reservationWorkflowV2GuestPrepareInputSchema.extend({
    prepareRef: z.string().min(1).max(160),
  }).strict() }).strict(),
  z.object({ endpoint: z.literal('executeServices'), input: reservationWorkflowV2PrepareInputSchema.extend({
    allocationId: serviceId, serviceId, reviewedPrepareRef: z.string().min(1).max(160).optional(),
  }).strict() }).strict(),
  z.object({ endpoint: z.literal('executeSavedServices'), input: reservationWorkflowV2PrepareInputSchema.extend({
    serviceId, targetRef: z.object({ kind: z.literal('saved_target'), requestId: serviceId, hintId: serviceId }).strict(),
    allocationId: z.never().optional(), reviewedPrepareRef: z.string().min(1).max(160),
  }).strict() }).strict(),
]);
export type HmsPreparedWorkflowContext = z.infer<typeof hmsPreparedWorkflowContextSchema>;

const identifier = z.string().trim().min(1).max(512);
const digest = z.string().regex(/^[a-f0-9]{64}$/);
export const staffSessionSchema = z.object({ actorUserId: identifier, sessionId: identifier,
  sessionProfile: z.enum(['legacy', 'remote']) }).strict();
export type StaffSession = z.infer<typeof staffSessionSchema>;
export const hmsPreparedSourceSchema = z.object({ transportId: identifier, threadId: identifier,
  sourceMessageId: identifier, sourceHash: digest,
  attachment: z.object({ attachmentId: identifier, sha256: digest }).strict().optional() }).strict();
export const hmsOperationSchema = z.enum(['create', 'amend', 'cancel', 'attach_document', 'create_guest_profile', 'add_on']);

// The durable boundary accepts JSON business data, never a live browser or credential.
const businessFields = z.record(z.string(), z.unknown()).superRefine((value, ctx) => {
  const visit = (entry: unknown): void => {
    if (Array.isArray(entry)) { entry.forEach(visit); return; }
    if (entry === null || typeof entry !== 'object') return;
    for (const [key, child] of Object.entries(entry)) {
      if (/^(password|cookie|cookies|storageState|authorization|accessToken|bearerToken|apiKey|cardNumber|cvv|rawRequestBody|postData|page|browser)$/i.test(key)) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'hms_preparation_private_data' });
      }
      visit(child);
    }
  };
  visit(value);
  try { canonicalJson(JSON.parse(JSON.stringify(value))); }
  catch { ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'hms_preparation_non_json' }); }
});
export const hmsPreparationSchema = z.object({
  version: z.literal(2), preparedRef: z.string().uuid(), workItemId: z.string().uuid(),
  scope: resolvedPropertyScopeSchema, session: staffSessionSchema, source: hmsPreparedSourceSchema,
  generationId: identifier, revision: z.number().int().nonnegative().safe(), operation: hmsOperationSchema,
  targetAliases: z.array(identifier).min(1), businessFields,
  businessDigest: digest, targetDigest: digest,
  nativeObservation: z.object({ beforeDigest: digest, capturedAt: z.string().datetime(),
    price: z.unknown(), warnings: z.array(z.string()) }).strict(),
  policyIdentity: identifier, catalogueIdentity: identifier,
  capturedAt: z.string().datetime(), expiresAt: z.string().datetime(),
  allocations: z.array(z.object({ allocationId: identifier, businessDigest: digest,
    observationRef: identifier.optional() }).strict()).min(1).max(8).optional(),
  workflowContext: hmsPreparedWorkflowContextSchema.optional(),
}).strict().superRefine((value, ctx) => {
  if (value.scope.transportId !== value.source.transportId ||
      value.businessDigest !== preparationDigest(value.businessFields) ||
      value.targetDigest !== preparationDigest(value.targetAliases) ||
      Date.parse(value.expiresAt) <= Date.parse(value.capturedAt) ||
      Date.parse(value.expiresAt) - Date.parse(value.nativeObservation.capturedAt) > 30 * 60 * 1000 ||
      (value.operation === 'create' && !value.allocations)) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'hms_preparation_binding_invalid' });
  }
  const context = value.workflowContext;
  if (value.allocations && new Set(value.allocations.map(allocation => allocation.allocationId)).size !== value.allocations.length) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'hms_preparation_duplicate_allocation' });
  }
  if (context && value.operation === 'create' && value.allocations?.some(allocation => !allocation.observationRef)) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'hms_preparation_allocation_observation_required' });
  }
  if (context && (context.input.workItemId !== value.workItemId || context.input.expectedRevision !== value.revision ||
      context.input.source.threadId !== value.source.threadId || context.input.source.messageId !== value.source.sourceMessageId ||
      context.input.source.sourceHash !== value.source.sourceHash ||
      (context.input.source.propertyId === undefined ? value.scope.propertyCode !== 'HRCEN' : context.input.source.propertyId !== value.scope.propertyCode) ||
      (context.endpoint === 'createGuestProfile' && value.operation !== 'create_guest_profile') ||
      (['executeServices', 'executeSavedServices'].includes(context.endpoint) && value.operation !== 'add_on'))) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'hms_preparation_workflow_binding_invalid' });
  }
});
export type HmsPreparation = z.infer<typeof hmsPreparationSchema>;
export const preparedSummarySchema = hmsPreparationSchema.transform((prepared) => ({
  preparedRef: prepared.preparedRef, propertyCode: prepared.scope.propertyCode,
  businessDigest: prepared.businessDigest, targetDigest: prepared.targetDigest,
  generationId: prepared.generationId, revision: prepared.revision,
  stagedFields: prepared.businessFields, price: prepared.nativeObservation.price,
  warnings: prepared.nativeObservation.warnings, expiresAtIso: prepared.expiresAt,
}));
export type PreparedSummary = z.infer<typeof preparedSummarySchema>;
export const hmsWriteGrantV2Schema = z.object({
  version: z.literal(2), grantId: z.string().uuid(), preparedRef: z.string().uuid(),
  workItemId: z.string().uuid(), actorUserId: identifier, sessionId: identifier,
  sessionProfile: z.enum(['legacy', 'remote']), transportId: identifier,
  threadId: identifier, sourceMessageId: identifier, sourceHash: digest,
  attachment: hmsPreparedSourceSchema.shape.attachment,
  propertyCode: propertyCodeSchema, tenantId: identifier, operation: hmsOperationSchema,
  generationId: identifier, expectedRevision: z.number().int().nonnegative().safe(),
  businessDigest: digest, targetDigest: digest,
  // Explicit v2 mapping for retained writer and recovery readers.
  formDigest: digest, hmsBeforeDigest: digest, hmsReadAt: z.string().datetime(),
  issuedAt: z.string().datetime(), expiresAt: z.string().datetime(),
}).strict().refine((value) => value.businessDigest === value.formDigest &&
  Date.parse(value.issuedAt) < Date.parse(value.expiresAt));
export type HmsWriteGrantV2 = z.infer<typeof hmsWriteGrantV2Schema>;

export function preparationDigest(value: unknown): string {
  return createHash('sha256').update(canonicalJson(JSON.parse(JSON.stringify(value)))).digest('hex');
}

export function hmsConfigurationIdentities(scope: ResolvedPropertyScope, configuration: PropertyConfiguration,
  operation: HmsPreparation['operation']) {
  const workflow = hmsWorkflowForOperation(operation);
  return {
    policyIdentity: preparationDigest({ scope, formPolicy: configuration.formPolicy,
      workflowPolicy: effectiveWorkflowPolicy(process.env, scope.propertyCode, workflow) }),
    catalogueIdentity: preparationDigest({ catalogue: configuration.catalogue, ratePlans: configuration.ratePlans,
      roomTypes: configuration.roomTypes, nativeMealMappings: configuration.nativeMealMappings }),
  };
}

export function hmsWorkflowForOperation(operation: HmsPreparation['operation']) {
  return operation === 'create_guest_profile' ? 'guest_profile_create'
    : operation === 'attach_document' ? 'attach' : operation === 'add_on' ? 'addons' : operation;
}

/** Call only from the authenticated prepare transaction after native staging has closed. */
export async function recordHmsPreparation(db: DB, raw: HmsPreparation): Promise<HmsPreparation> {
  const prepared = hmsPreparationSchema.parse(JSON.parse(JSON.stringify(raw)));
  await db.insert(workEvent).values({ id: prepared.preparedRef, workItemId: prepared.workItemId,
    actorKind: 'user', actorUserId: prepared.session.actorUserId, type: 'hms.prepared',
    at: new Date(prepared.capturedAt), expiresAt: new Date(prepared.expiresAt),
    payloadHash: preparationDigest(prepared), value: prepared });
  return prepared;
}

export async function loadHmsPreparation(db: DB, preparedRef: string, workItemId: string): Promise<HmsPreparation> {
  const [row] = await db.select().from(workEvent).where(and(eq(workEvent.id, preparedRef),
    eq(workEvent.workItemId, workItemId), eq(workEvent.type, 'hms.prepared'))).limit(1).for('share');
  const parsed = hmsPreparationSchema.safeParse(row?.value);
  if (!parsed.success || row?.payloadHash !== preparationDigest(parsed.data) ||
      row.actorKind !== 'user' || row.actorUserId !== parsed.data.session.actorUserId ||
      row.expiresAt?.getTime() !== Date.parse(parsed.data.expiresAt) ||
      parsed.data.preparedRef !== preparedRef || parsed.data.workItemId !== workItemId) {
    throw new Error('hms_preparation_invalid');
  }
  return parsed.data;
}

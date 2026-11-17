import { randomUUID } from 'node:crypto';
import { z } from 'zod';

// Kept local so the private context contract can be imported by the public
// request contracts without introducing a read-service-contracts cycle.
const readRefSchema = z
  .string()
  .regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/, 'expected opaque read reference');
const readTimestampSchema = z.string().datetime({ offset: true });

/** U15 context capabilities that may be minted from a trusted source row. */
export const linkedContextReferenceKindSchema = z.enum(['company', 'group', 'event', 'notes']);
export type LinkedContextReferenceKind = z.infer<typeof linkedContextReferenceKindSchema>;

/**
 * Private server-side mapping for one context capability.  `reference` is
 * the only value allowed into a queued request; `sourceRef` remains in the
 * parent run's trusted metrics and is resolved again by the worker.
 */
export const linkedContextReferenceSchema = z
  .object({
    reference: readRefSchema,
    kind: linkedContextReferenceKindSchema,
    sourceRef: readRefSchema,
    parentReadResultRef: readRefSchema,
    propertyCode: readRefSchema,
    requestBranchId: z.string().min(1).max(128),
    sourceRevision: z.string().min(1).max(256),
    issuedAt: readTimestampSchema,
    expiresAt: readTimestampSchema,
  })
  .strict();
export type LinkedContextReference = z.infer<typeof linkedContextReferenceSchema>;

/**
 * Client/tool-facing projection of a linked context capability.  Source refs,
 * parent bindings, property, branch, and source revision remain server-only
 * fields in the durable parent metrics and are never returned in a receipt.
 */
export const linkedContextReferencePublicSchema = z
  .object({
    reference: readRefSchema,
    kind: linkedContextReferenceKindSchema,
    expiresAt: readTimestampSchema,
  })
  .strict();
export type LinkedContextReferencePublic = z.infer<typeof linkedContextReferencePublicSchema>;

/** Context capabilities never outlive the bounded admission policy window. */
export const LINKED_CONTEXT_REFERENCE_MAX_TTL_MS = 5 * 60_000;

export function mintLinkedContextReference(input: {
  kind: LinkedContextReferenceKind;
  sourceRef: string;
  parentReadResultRef: string;
  propertyCode: string;
  requestBranchId: string;
  sourceRevision: string;
  issuedAt: Date;
  expiresAt: Date | string;
}): LinkedContextReference {
  const issuedAt = input.issuedAt;
  const expiresAt = input.expiresAt instanceof Date ? input.expiresAt : new Date(input.expiresAt);
  if (
    !Number.isFinite(issuedAt.getTime()) ||
    !Number.isFinite(expiresAt.getTime()) ||
    expiresAt.getTime() <= issuedAt.getTime()
  ) {
    throw new Error('linked context reference window is invalid');
  }
  const boundedExpiry = new Date(
    Math.min(expiresAt.getTime(), issuedAt.getTime() + LINKED_CONTEXT_REFERENCE_MAX_TTL_MS),
  );
  return linkedContextReferenceSchema.parse({
    reference: randomUUID(),
    kind: input.kind,
    sourceRef: input.sourceRef,
    parentReadResultRef: input.parentReadResultRef,
    propertyCode: input.propertyCode,
    requestBranchId: input.requestBranchId,
    sourceRevision: input.sourceRevision,
    issuedAt: issuedAt.toISOString(),
    expiresAt: boundedExpiry.toISOString(),
  });
}

/** Fail closed when a persisted mapping is stale, cross-scope, or altered. */
export function assertLinkedContextReference(input: {
  binding: unknown;
  reference: string;
  kind: LinkedContextReferenceKind;
  parentReadResultRef: string;
  propertyCode: string;
  requestBranchId: string;
  sourceRevision: string;
  now: Date;
  maximumExpiry?: string;
}): LinkedContextReference {
  const parsed = linkedContextReferenceSchema.safeParse(input.binding);
  if (!parsed.success) throw new Error('linked context reference is malformed');
  const binding = parsed.data;
  const issuedAt = Date.parse(binding.issuedAt);
  const expiresAt = Date.parse(binding.expiresAt);
  const now = input.now.getTime();
  const maximumExpiry = input.maximumExpiry ? Date.parse(input.maximumExpiry) : Infinity;
  if (
    binding.reference !== input.reference ||
    binding.kind !== input.kind ||
    binding.parentReadResultRef !== input.parentReadResultRef ||
    binding.propertyCode !== input.propertyCode ||
    binding.requestBranchId !== input.requestBranchId ||
    binding.sourceRevision !== input.sourceRevision ||
    !Number.isFinite(issuedAt) ||
    !Number.isFinite(expiresAt) ||
    !Number.isFinite(now) ||
    issuedAt > now ||
    expiresAt <= now ||
    expiresAt > maximumExpiry
  ) {
    throw new Error('linked context reference binding is stale or mismatched');
  }
  return binding;
}

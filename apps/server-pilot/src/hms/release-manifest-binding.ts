import { requestPolicyManifestSchema, type RequestPolicyManifest } from './contracts.js';
import { createHash } from 'node:crypto';
import { z } from 'zod';

const reviewedManifestEnvelopeSchema = z
  .object({
    schemaVersion: z.number().int().positive(),
    toolId: z.string().min(1),
    toolVersion: z.string().min(1),
    discoveryOperationId: z.string().min(1),
    manifest: requestPolicyManifestSchema,
  })
  .passthrough();

export type ReviewedManifestIdentity = {
  toolId: string;
  toolVersion: string;
  discoveryOperationId: string;
};

/**
 * Read the same request-policy payload that runtime authorization serializes.
 * The release envelope itself is metadata and is intentionally not hashed.
 */
export function parseReviewedManifestEnvelope(
  raw: string,
  expected: ReviewedManifestIdentity,
): RequestPolicyManifest {
  const envelope = reviewedManifestEnvelopeSchema.parse(JSON.parse(raw));
  if (
    envelope.toolId !== expected.toolId ||
    envelope.toolVersion !== expected.toolVersion ||
    envelope.discoveryOperationId !== expected.discoveryOperationId
  ) {
    throw new Error('reviewed manifest envelope identity mismatch');
  }
  return envelope.manifest;
}

export function reviewedManifestSha256FromPayload(manifest: RequestPolicyManifest): string {
  return createHash('sha256').update(JSON.stringify(manifest)).digest('hex');
}

export function reviewedManifestSha256(raw: string, expected: ReviewedManifestIdentity): string {
  return reviewedManifestSha256FromPayload(parseReviewedManifestEnvelope(raw, expected));
}

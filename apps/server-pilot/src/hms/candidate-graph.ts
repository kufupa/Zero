import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { ReadToolId, ReservationContextToolId } from './read-tools.js';

const childToolSchema = z.enum([
  'hms_list_documents',
  'hms_sent_email_audit',
  'hms_read_folio',
  'hms_company_account_read',
  'hms_read_reservation',
]);

export const readCandidateChildSchema = z
  .object({
    id: z.string().uuid(),
    sessionId: z.string().uuid(),
    parentEvidenceId: z.string().uuid(),
    toolId: childToolSchema,
    requestBranchId: z.string().min(1),
    propertyCode: z.string().min(1).max(32),
    scopeHash: z.string().regex(/^[a-f0-9]{64}$/),
    expiresAt: z.string().datetime(),
  })
  .strict();

export type ReadCandidateChild = z.infer<typeof readCandidateChildSchema>;

export function mintReadCandidateChildren(input: {
  sessionId: string;
  parentEvidenceId: string;
  tools: Array<{
    toolId: ReadToolId | ReservationContextToolId;
    requestBranchId: string;
  }>;
  propertyCode: string;
  scopeHash: string;
  expiresAt: Date;
}): ReadCandidateChild[] {
  if (input.tools.length === 0) {
    throw new Error('candidate child tools must be unique and nonempty');
  }
  const toolIds = input.tools.map((t) => t.toolId);
  if (new Set(toolIds).size !== toolIds.length) {
    throw new Error('candidate child tools must be unique and nonempty');
  }
  // Reservation followups are capped at two; mint refuses larger sets.
  if (input.tools.length > 2) {
    throw new Error('candidate child tools exceed max reservation followups (2)');
  }
  return input.tools.map(({ toolId, requestBranchId }) =>
    readCandidateChildSchema.parse({
      id: randomUUID(),
      sessionId: input.sessionId,
      parentEvidenceId: input.parentEvidenceId,
      toolId,
      requestBranchId,
      propertyCode: input.propertyCode,
      scopeHash: input.scopeHash,
      expiresAt: input.expiresAt.toISOString(),
    }),
  );
}

export function resolveReadCandidateChild(input: {
  candidates: readonly ReadCandidateChild[];
  id: string;
  sessionId: string;
  parentEvidenceId: string;
  toolId: ReadToolId | ReservationContextToolId;
  requestBranchId: string;
  propertyCode: string;
  scopeHash: string;
  now?: Date;
}): ReadCandidateChild {
  const matches = input.candidates.filter((candidate) => candidate.id === input.id);
  if (matches.length !== 1) throw new Error('candidate child cardinality invalid');
  const child = readCandidateChildSchema.parse(matches[0]);
  if (
    child.sessionId !== input.sessionId ||
    child.parentEvidenceId !== input.parentEvidenceId ||
    child.toolId !== input.toolId ||
    child.requestBranchId !== input.requestBranchId ||
    child.propertyCode !== input.propertyCode ||
    child.scopeHash !== input.scopeHash
  ) {
    throw new Error('candidate child binding mismatch');
  }
  if (Date.parse(child.expiresAt) <= (input.now ?? new Date()).getTime()) {
    throw new Error('candidate child expired');
  }
  return child;
}

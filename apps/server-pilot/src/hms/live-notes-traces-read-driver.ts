/**
 * Live notes/traces adapter. The current approved HMS release has no verified
 * bounded notes source, so this adapter emits a typed unavailable section and
 * never turns note text into an action or an authorization.
 */
import {
  NOTES_TRACES_READ_MAX_ROWS,
  NOTES_TRACES_READ_SURFACE_BLOCKER,
  type NotesTracesReadData,
} from './notes-traces-read-contract.js';
import { readRefSchema, readResultSchema } from './read-service-contracts.js';
import type { HmsSessionAuthorization } from './release-kernel.js';
import type { ReadResult } from './read-service-contracts.js';
import { createHash, randomUUID } from 'node:crypto';
import { HmsRuntimeError } from './runtime.js';
import { z } from 'zod';

export const notesTracesReadInputSchema = z
  .object({
    resourceRef: readRefSchema,
    states: z
      .array(z.enum(['open', 'completed']))
      .min(1)
      .max(2),
    limit: z.number().int().min(1).max(NOTES_TRACES_READ_MAX_ROWS),
    cursor: readRefSchema.optional(),
    audience: z.enum(['staff', 'customer']),
  })
  .strict();
export type NotesTracesReadInput = z.infer<typeof notesTracesReadInputSchema>;

type NotesSessionAuthorization = Omit<
  HmsSessionAuthorization,
  'toolId' | 'discoveryOperationId'
> & {
  toolId: 'hms_read_notes_traces';
  discoveryOperationId: 'notes_traces_list';
};

function assertNotesAuthorization(authorization: NotesSessionAuthorization): void {
  if (authorization.toolId !== 'hms_read_notes_traces') {
    throw new HmsRuntimeError('ROLE_SCOPE_INVALID', 'authorization toolId denied for notes reader');
  }
  if (authorization.requestBranchId !== 'notes_traces_list') {
    throw new HmsRuntimeError(
      'ROLE_SCOPE_INVALID',
      'authorization requestBranchId denied for notes reader',
    );
  }
  if (authorization.discoveryOperationId !== 'notes_traces_list') {
    throw new HmsRuntimeError(
      'ROLE_SCOPE_INVALID',
      'authorization discoveryOperationId denied for notes reader',
    );
  }
  if (Date.parse(authorization.expiresAt) <= Date.now()) {
    throw new HmsRuntimeError('ROLE_PROOF_EXPIRED', 'authorization expired');
  }
}

export async function observeNotesTraces(
  authorization: NotesSessionAuthorization,
  rawInput: NotesTracesReadInput,
  signal: AbortSignal,
): Promise<ReadResult<NotesTracesReadData>> {
  if (signal.aborted) {
    const err = new Error('notes trace observe aborted');
    err.name = 'AbortError';
    throw err;
  }
  assertNotesAuthorization(authorization);
  const input = notesTracesReadInputSchema.parse(rawInput);
  const observedAt = new Date();
  const expiresAt = new Date(observedAt.getTime() + 5 * 60_000);
  const evidenceRef = `notes-${randomUUID()}`;
  const data = {
    notes: {
      state: 'unavailable' as const,
      data: null,
      reasonCode: 'SOURCE_UNAVAILABLE' as const,
      issues: [
        {
          code: 'SOURCE_UNAVAILABLE',
          retryable: false,
          safeNextAction: 'manual_review' as const,
        },
      ],
    },
  } satisfies NotesTracesReadData;
  return readResultSchema.parse({
    toolId: 'hms_read_notes_traces',
    schemaVersion: 'hms-notes/1',
    status: 'manual_required',
    data,
    completeness: 'unknown',
    unavailableSections: [{ section: 'notes', reasonCode: 'SOURCE_UNAVAILABLE' }],
    scopeRef: input.resourceRef,
    evidence: [
      {
        evidenceRef,
        sourceSystem: 'hms' as const,
        sourceSurface: 'notes-traces',
        requestBranchId: authorization.requestBranchId,
        observedAt: observedAt.toISOString(),
        sourceUpdatedAt: null,
        expiresAt: expiresAt.toISOString(),
        scopeVerified: true,
        artifactRef: null,
        sourceHash: createHash('sha256').update(NOTES_TRACES_READ_SURFACE_BLOCKER).digest('hex'),
      },
    ],
    page: { returnedCount: 0, hasMore: false, nextCursor: null },
    issues: [
      {
        code: 'SOURCE_UNAVAILABLE',
        retryable: false,
        safeNextAction: 'manual_review',
      },
    ],
  }) as ReadResult<NotesTracesReadData>;
}

export function createLiveNotesTracesReadDriver(): {
  observeNotesTraces: typeof observeNotesTraces;
} {
  return { observeNotesTraces };
}

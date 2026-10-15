/**
 * Live event list-summary observer (Task 17).
 * View-only Group Sales menu lacks Events / Event Reservation; heuristic
 * function opens return 400. Fail closed — never open detail or contact tabs.
 * Observations never emit recipientClass/inquiryClass, contacts, or notes.
 */
import { createHash, randomUUID } from 'node:crypto';
import type { ToolResult } from '../ai/draft-evidence.js';
import {
  EVENT_READ_SURFACE_BLOCKER,
  type EventReadData,
} from './event-read-contract.js';
import type { EventReadCandidate } from './event-read-candidate.js';
import type { HmsSessionAuthorization } from './release-kernel.js';
import { HRCEN_PROPERTY_CODE } from './property-registry.js';
import { HmsRuntimeError } from './runtime.js';

export { EVENT_READ_SURFACE_BLOCKER };

function sha256Hex(input: string): string {
  return createHash('sha256').update(input).digest('hex');
}

function assertEventAuth(
  authorization: HmsSessionAuthorization,
  candidate: EventReadCandidate,
): void {
  if (authorization.toolId !== 'hms_event_read') {
    throw new HmsRuntimeError(
      'ROLE_SCOPE_INVALID',
      'authorization toolId denied for event observer',
    );
  }
  if (authorization.discoveryOperationId !== 'event_list') {
    throw new HmsRuntimeError(
      'ROLE_SCOPE_INVALID',
      'authorization discoveryOperationId mismatch',
    );
  }
  if (authorization.requestBranchId !== 'event_list') {
    throw new HmsRuntimeError(
      'ROLE_SCOPE_INVALID',
      'authorization requestBranchId denied for event observer',
    );
  }
  if (Date.parse(authorization.expiresAt) <= Date.now()) {
    throw new HmsRuntimeError('ROLE_PROOF_EXPIRED', 'authorization expired');
  }
  if (candidate.kind !== 'event_summary') {
    throw new HmsRuntimeError(
      'ROLE_SCOPE_INVALID',
      'candidate kind denied for event observer',
    );
  }
  const recomputed = sha256Hex(`event_ref:${candidate.exactEventReference}`);
  if (recomputed !== candidate.exactEventReferenceHash) {
    throw new HmsRuntimeError(
      'ROLE_SCOPE_INVALID',
      'candidate reference hash mismatch',
    );
  }
}

/**
 * Live event list summary — blocked until Event Reservation list is on the
 * view-only role menu and required summary fields exist list-only.
 */
export async function observeEventListSummary(
  authorization: HmsSessionAuthorization,
  candidate: EventReadCandidate,
  signal: AbortSignal,
  propertyCode = HRCEN_PROPERTY_CODE,
): Promise<ToolResult<EventReadData>> {
  if (signal.aborted) {
    const err = new Error('event observe aborted');
    err.name = 'AbortError';
    throw err;
  }
  assertEventAuth(authorization, candidate);
  const observedAt = new Date().toISOString();
  return {
    status: 'manual_required',
    draftReady: false,
    data: {} as EventReadData,
    unresolvedFields: [EVENT_READ_SURFACE_BLOCKER],
    evidence: {
      kind: 'hms',
      id: randomUUID(),
      toolId: 'hms_event_read',
      toolVersion: '1.0.0',
      propertyCode,
      observedAt,
      expiresAt: new Date(Date.parse(observedAt) + 60 * 60 * 1000).toISOString(),
      claimKeys: [],
      sourceHash: sha256Hex(EVENT_READ_SURFACE_BLOCKER),
    },
  };
}

export function createLiveEventReadDriver(
  propertyCode = HRCEN_PROPERTY_CODE,
): {
  observeEventListSummary: typeof observeEventListSummary;
} {
  return {
    observeEventListSummary: (authorization, candidate, signal) =>
      observeEventListSummary(authorization, candidate, signal, propertyCode),
  };
}

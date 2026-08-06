/**
 * Live group-block aggregate observer (Task 17).
 * GSGRPB.LST proven for exact ref/status/dates, but con/blk/pickup/remaining
 * rows require BLK/detail load (empty without selected record). Fail closed.
 * Observations never emit recipientClass/inquiryClass, contacts, or rooming IDs.
 */
import { createHash, randomUUID } from 'node:crypto';
import type { ToolResult } from '../ai/draft-evidence.js';
import {
  GROUP_BLOCK_AGGREGATE_COUNTS_BLOCKER,
  type GroupBlockReadData,
} from './group-block-read-contract.js';
import type { GroupReadCandidate } from './group-read-candidate.js';
import type { HmsSessionAuthorization } from './release-kernel.js';
import { HmsRuntimeError } from './runtime.js';

export { GROUP_BLOCK_AGGREGATE_COUNTS_BLOCKER };

function sha256Hex(input: string): string {
  return createHash('sha256').update(input).digest('hex');
}

function assertGroupAuth(
  authorization: HmsSessionAuthorization,
  candidate: GroupReadCandidate,
): void {
  if (authorization.toolId !== 'hms_group_block_read') {
    throw new HmsRuntimeError(
      'ROLE_SCOPE_INVALID',
      'authorization toolId denied for group observer',
    );
  }
  if (authorization.discoveryOperationId !== 'group_block_list') {
    throw new HmsRuntimeError(
      'ROLE_SCOPE_INVALID',
      'authorization discoveryOperationId mismatch',
    );
  }
  if (authorization.requestBranchId !== 'group_block_list') {
    throw new HmsRuntimeError(
      'ROLE_SCOPE_INVALID',
      'authorization requestBranchId denied for group observer',
    );
  }
  if (Date.parse(authorization.expiresAt) <= Date.now()) {
    throw new HmsRuntimeError('ROLE_PROOF_EXPIRED', 'authorization expired');
  }
  if (candidate.kind !== 'group_block') {
    throw new HmsRuntimeError(
      'ROLE_SCOPE_INVALID',
      'candidate kind denied for group observer',
    );
  }
  const recomputed = sha256Hex(`group_ref:${candidate.exactGroupReference}`);
  if (recomputed !== candidate.exactGroupReferenceHash) {
    throw new HmsRuntimeError(
      'ROLE_SCOPE_INVALID',
      'candidate reference hash mismatch',
    );
  }
}

/**
 * Live group aggregate read — structurally blocked until list-only
 * con/blk/pickup/remaining/restriction rows exist without detail navigation.
 */
export async function observeGroupBlockAggregate(
  authorization: HmsSessionAuthorization,
  candidate: GroupReadCandidate,
  signal: AbortSignal,
): Promise<ToolResult<GroupBlockReadData>> {
  if (signal.aborted) {
    const err = new Error('group observe aborted');
    err.name = 'AbortError';
    throw err;
  }
  assertGroupAuth(authorization, candidate);
  const observedAt = new Date().toISOString();
  return {
    status: 'manual_required',
    draftReady: false,
    data: {} as GroupBlockReadData,
    unresolvedFields: [GROUP_BLOCK_AGGREGATE_COUNTS_BLOCKER],
    evidence: {
      kind: 'hms',
      id: randomUUID(),
      toolId: 'hms_group_block_read',
      toolVersion: '1.0.0',
      propertyCode: 'HRCEN',
      observedAt,
      expiresAt: new Date(Date.parse(observedAt) + 60 * 60 * 1000).toISOString(),
      claimKeys: [],
      sourceHash: sha256Hex(GROUP_BLOCK_AGGREGATE_COUNTS_BLOCKER),
    },
  };
}

export function createLiveGroupBlockDriver(): {
  observeGroupBlockAggregate: typeof observeGroupBlockAggregate;
} {
  return { observeGroupBlockAggregate };
}

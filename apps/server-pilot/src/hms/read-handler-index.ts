/**
 * Static trusted handler index keyed by (toolId, implementationSha256).
 * No plugin loader — behavior-changing releases add versioned factory entries.
 * Keep exactly active + immediate-predecessor entries while registry-referenced.
 */
import type {
  HmsPortfolioToolReleaseV2,
  HmsSessionAuthorization,
  MailArtifactAuthorization,
} from './release-kernel.js';
import { reviewedManifestSha256FromPayload } from './release-manifest-binding.js';
import type { ToolResult } from '../ai/draft-evidence.js';
import type { ReadToolId } from './read-tools.js';
import { createHash } from 'node:crypto';

export type CandidateReadHandler = {
  toolId: ReadToolId;
  implementationSha256: string;
  execute(candidateId: string, signal: AbortSignal): Promise<ToolResult<unknown>>;
};

export type ReadHandlerFactory = (
  release: HmsPortfolioToolReleaseV2,
  authorization: HmsSessionAuthorization | MailArtifactAuthorization,
) => CandidateReadHandler;

/** Deterministic seed digests for find@1.2.0 and mail@2 first live releases. */
export function seedImplementationDigest(toolId: ReadToolId, versionLabel: string): string {
  return createHash('sha256').update(`phase-b-handler:${toolId}@${versionLabel}`).digest('hex');
}

export const FIND_RESERVATION_IMPL_V1 = seedImplementationDigest(
  'hms_find_reservation',
  '1.2.0:v1',
);
export const FIND_RESERVATION_IMPL_V2 = seedImplementationDigest(
  'hms_find_reservation',
  '1.2.0:v2',
);
export const MAIL_ARTIFACT_IMPL_V1 = seedImplementationDigest('mail_read_artifact', '2:v1');

export const QUOTE_STAY_IMPL_V1 = seedImplementationDigest('hms_quote_stay', '2.0.0:v1');

export const SENT_EMAIL_AUDIT_IMPL_V1 = seedImplementationDigest(
  'hms_sent_email_audit',
  '1.0.0:v1',
);

export const LIST_DOCUMENTS_IMPL_V1 = seedImplementationDigest('hms_list_documents', '1.0.0:v1');

export const FOLIO_READ_IMPL_V1 = seedImplementationDigest('hms_read_folio', '1.0.0:v1');

function stubResult(
  toolId: ReadToolId,
  status: ToolResult<unknown>['status'] = 'manual_required',
): ToolResult<unknown> {
  const now = new Date().toISOString();
  return {
    status,
    draftReady: false,
    data: {},
    unresolvedFields: ['handler_stub'],
    evidence:
      toolId === 'mail_read_artifact'
        ? {
            kind: 'mail_attachment',
            id: '00000000-0000-4000-8000-000000000001',
            toolId: 'mail_read_artifact',
            toolVersion: '2',
            attachmentId: 'stub',
            observedAt: now,
            claimKeys: [],
            sourceHash: '0'.repeat(64),
          }
        : {
            kind: 'hms',
            id: '00000000-0000-4000-8000-000000000002',
            toolId: toolId as Exclude<ReadToolId, 'mail_read_artifact'>,
            toolVersion: '1',
            propertyCode: 'HRCEN',
            observedAt: now,
            expiresAt: now,
            claimKeys: [],
            sourceHash: '0'.repeat(64),
          },
  };
}

function assertAuthMatchesRelease(
  release: HmsPortfolioToolReleaseV2,
  authorization: HmsSessionAuthorization | MailArtifactAuthorization,
): void {
  if (authorization.releaseId !== release.releaseId) {
    throw new Error('authorization releaseId mismatch');
  }
  if (authorization.runtimeFingerprintSha256 !== release.runtimeFingerprintSha256) {
    throw new Error('authorization runtime fingerprint mismatch');
  }
  if (authorization.privateDigestKeyVersion !== release.privateDigestKeyVersion) {
    throw new Error('authorization digest key version mismatch');
  }
  if (authorization.sourceRevision !== release.sourceRevision) {
    throw new Error('authorization sourceRevision mismatch');
  }
  if (release.evidenceKind === 'mail') {
    if (!('grantPolicySha256' in authorization)) {
      throw new Error('mail release requires MailArtifactAuthorization');
    }
    if (authorization.grantPolicySha256 !== release.grantPolicySha256) {
      throw new Error('mail grantPolicySha256 mismatch');
    }
    if (authorization.s3IdentitySha256 !== release.s3IdentitySha256) {
      throw new Error('mail s3IdentitySha256 mismatch');
    }
    return;
  }
  if ('grantPolicySha256' in authorization) {
    throw new Error('HMS release rejects MailArtifactAuthorization');
  }
  if (authorization.toolId !== release.toolId) {
    throw new Error('HMS authorization toolId mismatch');
  }
  if (authorization.credentialVersionHmacSha256 !== release.credentialVersionHmacSha256) {
    throw new Error('credential version HMAC mismatch');
  }
  const branch = release.requestBranches.find((b) => b.id === authorization.requestBranchId);
  if (!branch) {
    throw new Error('request branch not enabled on release');
  }
  if (branch.manifestSha256 !== authorization.manifestSha256) {
    throw new Error('branch manifest digest mismatch');
  }
  const computedManifestSha256 = reviewedManifestSha256FromPayload(authorization.manifest);
  if (computedManifestSha256 !== authorization.manifestSha256) {
    throw new Error('authorization manifest payload digest mismatch');
  }
  if (authorization.roleProofSha256 !== release.roleProofSha256) {
    throw new Error('role proof digest mismatch');
  }
  if (authorization.discoveryOperationId !== branch.discoveryOperationId) {
    throw new Error('discoveryOperationId mismatch for branch');
  }
}

function makeFactory(toolId: ReadToolId, implementationSha256: string): ReadHandlerFactory {
  return (release, authorization) => {
    if (release.toolId !== toolId) {
      throw new Error(`handler index tool mismatch: expected ${toolId}`);
    }
    if (release.implementationSha256 !== implementationSha256) {
      throw new Error('handler index implementation digest mismatch');
    }
    assertAuthMatchesRelease(release, authorization);
    return {
      toolId,
      implementationSha256,
      async execute(_candidateId, signal) {
        if (signal.aborted) {
          const err = new Error('handler aborted');
          err.name = 'AbortError';
          throw err;
        }
        // Seed handlers defer live I/O to existing drivers; index proves binding only.
        return stubResult(toolId, 'manual_required');
      },
    };
  };
}

/** Closed static index — add versioned entries on behavior-changing releases. */
const HANDLER_INDEX: ReadonlyMap<string, ReadHandlerFactory> = new Map([
  [
    `hms_find_reservation:${FIND_RESERVATION_IMPL_V1}`,
    makeFactory('hms_find_reservation', FIND_RESERVATION_IMPL_V1),
  ],
  [
    `hms_find_reservation:${FIND_RESERVATION_IMPL_V2}`,
    makeFactory('hms_find_reservation', FIND_RESERVATION_IMPL_V2),
  ],
  [
    `mail_read_artifact:${MAIL_ARTIFACT_IMPL_V1}`,
    makeFactory('mail_read_artifact', MAIL_ARTIFACT_IMPL_V1),
  ],
  [`hms_quote_stay:${QUOTE_STAY_IMPL_V1}`, makeFactory('hms_quote_stay', QUOTE_STAY_IMPL_V1)],
  [
    `hms_sent_email_audit:${SENT_EMAIL_AUDIT_IMPL_V1}`,
    makeFactory('hms_sent_email_audit', SENT_EMAIL_AUDIT_IMPL_V1),
  ],
  [
    `hms_list_documents:${LIST_DOCUMENTS_IMPL_V1}`,
    makeFactory('hms_list_documents', LIST_DOCUMENTS_IMPL_V1),
  ],
  [`hms_read_folio:${FOLIO_READ_IMPL_V1}`, makeFactory('hms_read_folio', FOLIO_READ_IMPL_V1)],
]);

export function handlerIndexKey(toolId: ReadToolId, implementationSha256: string): string {
  return `${toolId}:${implementationSha256}`;
}

export function listHandlerIndexEntries(): ReadonlyArray<{
  toolId: ReadToolId;
  implementationSha256: string;
}> {
  return [...HANDLER_INDEX.keys()].map((key) => {
    const [toolId, implementationSha256] = key.split(':') as [ReadToolId, string];
    return { toolId, implementationSha256 };
  });
}

export function hasHandlerFor(toolId: ReadToolId, implementationSha256: string): boolean {
  return HANDLER_INDEX.has(handlerIndexKey(toolId, implementationSha256));
}

export function createReadToolHandler(
  release: HmsPortfolioToolReleaseV2,
  authorization: HmsSessionAuthorization | MailArtifactAuthorization,
): CandidateReadHandler {
  const factory = HANDLER_INDEX.get(handlerIndexKey(release.toolId, release.implementationSha256));
  if (!factory) {
    throw new Error(`no handler for ${release.toolId}@${release.implementationSha256}`);
  }
  return factory(release, authorization);
}

/**
 * Exhaustive coverage check: every active + immediate-predecessor
 * (toolId, implementationSha256) must resolve in the static index.
 */
export function assertHandlerIndexCovers(input: {
  active: ReadonlyMap<ReadToolId, { implementationSha256: string }>;
  immediatePredecessor: ReadonlyMap<ReadToolId, { implementationSha256: string }>;
}): void {
  for (const [toolId, release] of input.active) {
    if (!hasHandlerFor(toolId, release.implementationSha256)) {
      throw new Error(`handler missing for active ${toolId}`);
    }
  }
  for (const [toolId, release] of input.immediatePredecessor) {
    if (!hasHandlerFor(toolId, release.implementationSha256)) {
      throw new Error(`handler missing for predecessor ${toolId}`);
    }
    const active = input.active.get(toolId);
    if (active && active.implementationSha256 === release.implementationSha256) {
      throw new Error(`immediate predecessor for ${toolId} must differ from active implementation`);
    }
  }
}

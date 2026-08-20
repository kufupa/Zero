import { createHash } from 'node:crypto';
import {
  evaluateCenturionThreadAuditSnapshotStaleness,
  parseSealedCenturionThreadAuditSnapshotBytes,
  sealCenturionThreadAuditSnapshot,
  serializeSealedCenturionThreadAuditSnapshot,
  type CenturionThreadAuditTrustStatus,
  type SealedCenturionThreadAuditSnapshot,
} from './centurion-thread-audit-snapshot.js';

export {
  sealCenturionThreadAuditSnapshot,
  serializeSealedCenturionThreadAuditSnapshot,
};

export type CenturionThreadAuditCurrentHeader = {
  publicationIncarnationId: string;
  publicationRevisionToken: string;
  sourceIdentityDigest: string;
  payloadDigest: string;
  sealedEnvelopeDigest: string;
  trustStatus: CenturionThreadAuditTrustStatus;
};

export type CenturionThreadAuditPublicationDisposition =
  | 'PUBLISHED'
  | 'PUBLISHED_RECOVERED'
  | 'NOOP_SAME_PAYLOAD'
  | 'NOOP_INCOMPLETE'
  | 'REJECTED_PAYLOAD_MISMATCH'
  | 'REJECTED_STALE_SOURCE'
  | 'REJECTED_UNSUPPORTED_VERSION'
  | 'REJECTED_RECOVERY_SUPERSEDED';

export type CenturionThreadAuditPublicationDecision = {
  disposition: CenturionThreadAuditPublicationDisposition;
  trustStatus: CenturionThreadAuditTrustStatus | null;
};

export type CenturionThreadAuditPublicationReceipt = {
  disposition: CenturionThreadAuditPublicationDisposition;
  trustStatus: CenturionThreadAuditTrustStatus | null;
  publicationIncarnationId: string | null;
  sourceIdentityDigest: string;
  payloadDigest: string;
  sealedEnvelopeDigest: string;
  componentCount: number | null;
};

export function classifyCenturionThreadAuditPublication(input: {
  current: CenturionThreadAuditCurrentHeader | null;
  candidate: SealedCenturionThreadAuditSnapshot;
  now?: Date;
}): CenturionThreadAuditPublicationDecision {
  if (input.now) {
    const staleness = evaluateCenturionThreadAuditSnapshotStaleness({
      envelope: input.candidate,
      now: input.now,
    });
    if (staleness.stale) {
      return { disposition: 'REJECTED_STALE_SOURCE', trustStatus: null };
    }
  }
  if (!input.current) {
    return { disposition: 'PUBLISHED', trustStatus: input.candidate.trustStatus };
  }
  if (input.current.sourceIdentityDigest !== input.candidate.sourceIdentityDigest) {
    return { disposition: 'PUBLISHED', trustStatus: input.candidate.trustStatus };
  }
  if (input.current.payloadDigest !== input.candidate.payloadDigest) {
    return { disposition: 'REJECTED_PAYLOAD_MISMATCH', trustStatus: null };
  }
  if (
    input.current.trustStatus === 'incomplete' &&
    input.current.sealedEnvelopeDigest !== input.candidate.sealedEnvelopeDigest
  ) {
    return { disposition: 'REJECTED_PAYLOAD_MISMATCH', trustStatus: null };
  }
  if (input.current.trustStatus === 'valid') {
    return { disposition: 'NOOP_SAME_PAYLOAD', trustStatus: 'valid' };
  }
  if (input.candidate.trustStatus === 'valid') {
    return { disposition: 'PUBLISHED_RECOVERED', trustStatus: 'valid' };
  }
  return { disposition: 'NOOP_INCOMPLETE', trustStatus: 'incomplete' };
}

export type CenturionThreadAuditPublisherStore = {
  withTransportLock<T>(
    transportId: string,
    work: (current: CenturionThreadAuditCurrentHeader | null) => Promise<T>,
  ): Promise<T>;
  replaceCurrent(input: {
    envelope: SealedCenturionThreadAuditSnapshot;
    publicationIncarnationId: string;
    publicationRevisionToken: string;
  }): Promise<void>;
  replaceCurrentWithIncompleteAfterFailure(input: {
    envelope: SealedCenturionThreadAuditSnapshot;
    expectedPublicationIncarnationId: string;
    publicationIncarnationId: string;
    publicationRevisionToken: string;
  }): Promise<boolean>;
};

export type CenturionThreadAuditPublisherDependencies = {
  now?: () => Date;
  issueOpaqueId?: (kind: 'incarnation' | 'revision') => string;
};

function fail(code: string): never {
  throw new Error(code);
}

function issueOpaqueId(
  kind: 'incarnation' | 'revision',
  issue: NonNullable<CenturionThreadAuditPublisherDependencies['issueOpaqueId']>,
): string {
  const value = issue(kind);
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/u.test(value)) {
    fail('CENTURION_THREAD_AUDIT_PUBLISHER_OPAQUE_ID_INVALID');
  }
  return value;
}

function issuePublicationRevisionToken(input: {
  envelope: SealedCenturionThreadAuditSnapshot;
  publicationIncarnationId: string;
}): string {
  const token = createHash('sha256')
    .update(
      JSON.stringify({
        sourceIdentityDigest: input.envelope.sourceIdentityDigest,
        payloadDigest: input.envelope.payloadDigest,
        publicationIncarnationId: input.publicationIncarnationId,
      }),
    )
    .digest('hex');
  return `revision_${token}`;
}

function receipt(input: {
  decision: CenturionThreadAuditPublicationDecision;
  envelope: SealedCenturionThreadAuditSnapshot;
  publicationIncarnationId?: string | null;
}): CenturionThreadAuditPublicationReceipt {
  return {
    disposition: input.decision.disposition,
    trustStatus: input.decision.trustStatus,
    publicationIncarnationId: input.publicationIncarnationId ?? null,
    sourceIdentityDigest: input.envelope.sourceIdentityDigest,
    payloadDigest: input.envelope.payloadDigest,
    sealedEnvelopeDigest: input.envelope.sealedEnvelopeDigest,
    componentCount:
      input.decision.trustStatus === 'valid' &&
      input.envelope.trustStatus === 'valid'
        ? input.envelope.componentCount
        : null,
  };
}

/**
 * Publishes only an already-sealed candidate. A store owns its database
 * transaction and transport-row lock, which keeps this function DB-free.
 */
export async function publishCenturionThreadAuditSnapshot(input: {
  envelopeBytes: string;
  store: CenturionThreadAuditPublisherStore;
  dependencies?: CenturionThreadAuditPublisherDependencies;
}): Promise<CenturionThreadAuditPublicationReceipt> {
  const envelope = parseSealedCenturionThreadAuditSnapshotBytes(input.envelopeBytes);
  const canonicalBytes = serializeSealedCenturionThreadAuditSnapshot(envelope);
  if (canonicalBytes !== input.envelopeBytes) {
    fail('CENTURION_THREAD_AUDIT_PUBLISHER_ENVELOPE_BYTES_INVALID');
  }
  const now = input.dependencies?.now?.() ?? new Date();
  const issue =
    input.dependencies?.issueOpaqueId ??
    (() => fail('CENTURION_THREAD_AUDIT_PUBLISHER_OPAQUE_ID_REQUIRED'));
  let recovery:
    | {
        expectedPublicationIncarnationId: string;
        publicationIncarnationId: string;
        publicationRevisionToken: string;
      }
    | undefined;

  try {
    return await input.store.withTransportLock(envelope.transportId, async (current) => {
      const decision = classifyCenturionThreadAuditPublication({
        current,
        candidate: envelope,
        now,
      });
      if (
        decision.disposition === 'NOOP_SAME_PAYLOAD' ||
        decision.disposition === 'NOOP_INCOMPLETE' ||
        decision.disposition === 'REJECTED_PAYLOAD_MISMATCH' ||
        decision.disposition === 'REJECTED_STALE_SOURCE' ||
        decision.disposition === 'REJECTED_UNSUPPORTED_VERSION'
      ) {
        return receipt({
          decision,
          envelope,
          publicationIncarnationId: current?.publicationIncarnationId,
        });
      }
      const publicationIncarnationId = issueOpaqueId('incarnation', issue);
      const publicationRevisionToken = issuePublicationRevisionToken({
        envelope,
        publicationIncarnationId,
      });
      recovery =
        current?.trustStatus === 'valid'
          ? {
              expectedPublicationIncarnationId: current.publicationIncarnationId,
              publicationIncarnationId,
              publicationRevisionToken,
            }
          : undefined;
      await input.store.replaceCurrent({
        envelope,
        publicationIncarnationId,
        publicationRevisionToken,
      });
      return receipt({ decision, envelope, publicationIncarnationId });
    });
  } catch {
    if (!recovery) {
      fail('CENTURION_THREAD_AUDIT_PUBLISHER_MATERIALIZATION_FAILED');
    }
    let recovered: boolean;
    try {
      recovered = await input.store.replaceCurrentWithIncompleteAfterFailure({
        envelope,
        ...recovery,
      });
    } catch {
      fail('CENTURION_THREAD_AUDIT_PUBLISHER_RECOVERY_FAILED');
    }
    if (!recovered) {
      return receipt({
        decision: {
          disposition: 'REJECTED_RECOVERY_SUPERSEDED',
          trustStatus: null,
        },
        envelope,
      });
    }
    return receipt({
      decision: { disposition: 'PUBLISHED', trustStatus: 'incomplete' },
      envelope,
      publicationIncarnationId: recovery.publicationIncarnationId,
    });
  }
}

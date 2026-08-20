import { and, eq, sql } from 'drizzle-orm';
import { getDb, type DB } from '../db/client.js';
import {
  threadAuditSnapshot,
  threadAuditSnapshotComponent,
  threadAuditSnapshotComponentThread,
} from '../db/schema/mail.js';
import type { SealedCenturionThreadAuditSnapshot } from './centurion-thread-audit-snapshot.js';
import type {
  CenturionThreadAuditCurrentHeader,
  CenturionThreadAuditPublisherStore,
} from './centurion-thread-audit-publisher.js';

type Transaction = Parameters<Parameters<DB['transaction']>[0]>[0];

type ActiveScope = {
  tx: Transaction;
  transportId: string;
} | null;

function fail(code: string): never {
  throw new Error(code);
}

function currentHeader(
  row:
    | {
        publicationIncarnationId: string;
        publicationRevisionToken: string;
        sourceIdentityDigest: string;
        payloadDigest: string;
        sealedEnvelopeDigest: string;
        trustStatus: 'valid' | 'incomplete';
      }
    | undefined,
): CenturionThreadAuditCurrentHeader | null {
  return row ?? null;
}

async function lockTransport(tx: Transaction, transportId: string): Promise<void> {
  const rows = await tx.execute(
    sql`SELECT "id" FROM "mailbox_transport" WHERE "id" = ${transportId} FOR UPDATE`,
  );
  if (rows.length !== 1) {
    fail('CENTURION_THREAD_AUDIT_PUBLISHER_TRANSPORT_NOT_FOUND');
  }
}

async function loadCurrentHeader(
  tx: Transaction,
  transportId: string,
): Promise<CenturionThreadAuditCurrentHeader | null> {
  const [row] = await tx
    .select({
      publicationIncarnationId: threadAuditSnapshot.publicationIncarnationId,
      publicationRevisionToken: threadAuditSnapshot.publicationRevisionToken,
      sourceIdentityDigest: threadAuditSnapshot.sourceIdentityDigest,
      payloadDigest: threadAuditSnapshot.payloadDigest,
      sealedEnvelopeDigest: threadAuditSnapshot.sealedEnvelopeDigest,
      trustStatus: threadAuditSnapshot.trustStatus,
    })
    .from(threadAuditSnapshot)
    .where(eq(threadAuditSnapshot.transportId, transportId))
    .limit(1);
  return currentHeader(row);
}

export function centurionThreadAuditSnapshotHeaderValues(input: {
  envelope: SealedCenturionThreadAuditSnapshot;
  publicationIncarnationId: string;
  publicationRevisionToken: string;
  forceIncomplete?: boolean;
}) {
  const common = {
    id: input.publicationIncarnationId,
    publicationIncarnationId: input.publicationIncarnationId,
    transportId: input.envelope.transportId,
    sourceManifestDigest: input.envelope.sourceManifestDigest,
    sourceIdentityDigest: input.envelope.sourceIdentityDigest,
    payloadDigest: input.envelope.payloadDigest,
    sealedEnvelopeDigest: input.envelope.sealedEnvelopeDigest,
    publicationRevisionToken: input.publicationRevisionToken,
    sourceSchemaVersion: input.envelope.sourceSchemaVersion,
    identityRulesVersion: input.envelope.identityRulesVersion,
    classifierVersion: input.envelope.classifierVersion,
    metricDefinitionVersion: input.envelope.metricDefinitionVersion,
    sourceEventCutoffAt: new Date(input.envelope.sourceEventCutoffAt),
    sourceIngestCutoffAt: new Date(input.envelope.sourceIngestCutoffAt),
    verifiedAt: new Date(input.envelope.verifiedAt),
    attemptedAt: new Date(input.envelope.attemptedAt),
    publishedAt: new Date(input.envelope.publishedAt),
  };
  if (input.envelope.trustStatus === 'valid' && !input.forceIncomplete) {
    return {
      ...common,
      trustStatus: 'valid' as const,
      trustReasonCode: 'verified' as const,
      messageCount: input.envelope.messageCount,
      componentCount: input.envelope.componentCount,
      persistedThreadCount: input.envelope.persistedThreadCount,
      parserExceptionCount: input.envelope.parserExceptionCount,
      coverageExceptionCount: input.envelope.coverageExceptionCount,
      metricsAndInsights: {
        metrics: input.envelope.metrics,
        insights: input.envelope.insights,
      },
    };
  }
  return {
    ...common,
    trustStatus: 'incomplete' as const,
    trustReasonCode: input.forceIncomplete
      ? ('source_not_ready' as const)
      : input.envelope.trustReasonCode,
    messageCount: null,
    componentCount: null,
    persistedThreadCount: null,
    parserExceptionCount: null,
    coverageExceptionCount: null,
    metricsAndInsights: null,
  };
}

async function recheckValidMaterialization(input: {
  tx: Transaction;
  envelope: Extract<SealedCenturionThreadAuditSnapshot, { trustStatus: 'valid' }>;
  snapshotId: string;
}): Promise<void> {
  const [header] = await input.tx
    .select({
      trustStatus: threadAuditSnapshot.trustStatus,
      sourceIdentityDigest: threadAuditSnapshot.sourceIdentityDigest,
      payloadDigest: threadAuditSnapshot.payloadDigest,
      sealedEnvelopeDigest: threadAuditSnapshot.sealedEnvelopeDigest,
      messageCount: threadAuditSnapshot.messageCount,
      componentCount: threadAuditSnapshot.componentCount,
      persistedThreadCount: threadAuditSnapshot.persistedThreadCount,
      parserExceptionCount: threadAuditSnapshot.parserExceptionCount,
      coverageExceptionCount: threadAuditSnapshot.coverageExceptionCount,
    })
    .from(threadAuditSnapshot)
    .where(
      and(
        eq(threadAuditSnapshot.id, input.snapshotId),
        eq(threadAuditSnapshot.transportId, input.envelope.transportId),
      ),
    )
    .limit(1);
  if (
    !header ||
    header.trustStatus !== 'valid' ||
    header.sourceIdentityDigest !== input.envelope.sourceIdentityDigest ||
    header.payloadDigest !== input.envelope.payloadDigest ||
    header.sealedEnvelopeDigest !== input.envelope.sealedEnvelopeDigest ||
    header.messageCount !== input.envelope.messageCount ||
    header.componentCount !== input.envelope.componentCount ||
    header.persistedThreadCount !== input.envelope.persistedThreadCount ||
    header.parserExceptionCount !== input.envelope.parserExceptionCount ||
    header.coverageExceptionCount !== input.envelope.coverageExceptionCount
  ) {
    fail('CENTURION_THREAD_AUDIT_PUBLISHER_MATERIALIZATION_RECHECK_FAILED');
  }

  const components = await input.tx
    .select({
      componentId: threadAuditSnapshotComponent.componentId,
      initialMappingCount: threadAuditSnapshotComponent.initialMappingCount,
    })
    .from(threadAuditSnapshotComponent)
    .where(
      and(
        eq(threadAuditSnapshotComponent.snapshotId, input.snapshotId),
        eq(threadAuditSnapshotComponent.transportId, input.envelope.transportId),
      ),
    );
  const expectedComponents = [...input.envelope.components]
    .map((component) => `${component.componentId}\u0000${component.initialMappingCount}`)
    .sort();
  const actualComponents = components
    .map((component) => `${component.componentId}\u0000${component.initialMappingCount}`)
    .sort();
  if (
    expectedComponents.length !== actualComponents.length ||
    expectedComponents.some((value, index) => value !== actualComponents[index])
  ) {
    fail('CENTURION_THREAD_AUDIT_PUBLISHER_MATERIALIZATION_RECHECK_FAILED');
  }

  const mappings = await input.tx
    .select({
      componentId: threadAuditSnapshotComponentThread.componentId,
      threadId: threadAuditSnapshotComponentThread.threadId,
      sourceMembershipRank:
        threadAuditSnapshotComponentThread.sourceMembershipRank,
      isPrimary: threadAuditSnapshotComponentThread.isPrimary,
    })
    .from(threadAuditSnapshotComponentThread)
    .where(
      and(
        eq(threadAuditSnapshotComponentThread.snapshotId, input.snapshotId),
        eq(
          threadAuditSnapshotComponentThread.transportId,
          input.envelope.transportId,
        ),
      ),
    );
  const expectedMappings = input.envelope.components
    .flatMap((component) =>
      component.mappings.map(
        (mapping) =>
          `${component.componentId}\u0000${mapping.threadId}\u0000${mapping.sourceMembershipRank}\u0000${mapping.isPrimary}`,
      ),
    )
    .sort();
  const actualMappings = mappings
    .map(
      (mapping) =>
        `${mapping.componentId}\u0000${mapping.threadId}\u0000${mapping.sourceMembershipRank}\u0000${mapping.isPrimary}`,
    )
    .sort();
  if (
    expectedMappings.length !== actualMappings.length ||
    expectedMappings.some((value, index) => value !== actualMappings[index])
  ) {
    fail('CENTURION_THREAD_AUDIT_PUBLISHER_MATERIALIZATION_RECHECK_FAILED');
  }
}

async function replaceCurrentInScope(input: {
  scope: Exclude<ActiveScope, null>;
  envelope: SealedCenturionThreadAuditSnapshot;
  publicationIncarnationId: string;
  publicationRevisionToken: string;
}): Promise<void> {
  const { tx, transportId } = input.scope;
  if (transportId !== input.envelope.transportId) {
    fail('CENTURION_THREAD_AUDIT_PUBLISHER_TRANSPORT_SCOPE_INVALID');
  }
  await tx
    .delete(threadAuditSnapshot)
    .where(eq(threadAuditSnapshot.transportId, input.envelope.transportId));
  await tx
    .insert(threadAuditSnapshot)
    .values(
      centurionThreadAuditSnapshotHeaderValues({
        envelope: input.envelope,
        publicationIncarnationId: input.publicationIncarnationId,
        publicationRevisionToken: input.publicationRevisionToken,
      }),
    );
  if (input.envelope.trustStatus === 'incomplete') return;

  const snapshotId = input.publicationIncarnationId;
  if (input.envelope.components.length > 0) {
    await tx.insert(threadAuditSnapshotComponent).values(
      input.envelope.components.map((component) => ({
        snapshotId,
        componentId: component.componentId,
        transportId: input.envelope.transportId,
        finalState: component.finalState,
        reasonCodes: [...component.reasonCodes],
        limitationCodes: [...component.limitationCodes],
        evidenceTier: component.evidenceTier,
        impactClass: component.impactClass,
        ageBucket: component.ageBucket,
        handoffState: component.handoffState,
        nextHumanCheck: component.nextHumanCheck,
        exampleSelectionReason: component.exampleSelectionReason,
        latestActionAt: component.latestActionAt
          ? new Date(component.latestActionAt)
          : null,
        initialMappingCount: component.initialMappingCount,
        sortGroup: component.sortGroup,
        sortRank: component.sortRank,
      })),
    );
  }
  const mappings = input.envelope.components.flatMap((component) =>
    component.mappings.map((mapping) => ({
      snapshotId,
      componentId: component.componentId,
      transportId: input.envelope.transportId,
      threadId: mapping.threadId,
      sourceMembershipRank: mapping.sourceMembershipRank,
      isPrimary: mapping.isPrimary,
    })),
  );
  if (mappings.length > 0) {
    await tx.insert(threadAuditSnapshotComponentThread).values(mappings);
  }
  await recheckValidMaterialization({
    tx,
    envelope: input.envelope,
    snapshotId,
  });
}

/**
 * Creates the production publisher store. It is invoked only by explicit CLI
 * apply; dry-run stays DB-free. Each mutation uses one transaction and locks
 * the target mailbox row before reading or replacing its current snapshot.
 */
export async function createCenturionThreadAuditDatabaseStore(): Promise<CenturionThreadAuditPublisherStore> {
  const db = getDb();
  let activeScope: ActiveScope = null;

  return {
    withTransportLock: async <T>(
      transportId: string,
      work: (current: CenturionThreadAuditCurrentHeader | null) => Promise<T>,
    ): Promise<T> =>
      db.transaction(async (tx) => {
        await lockTransport(tx, transportId);
        const current = await loadCurrentHeader(tx, transportId);
        if (activeScope) {
          fail('CENTURION_THREAD_AUDIT_PUBLISHER_NESTED_TRANSACTION');
        }
        activeScope = { tx, transportId };
        try {
          return await work(current);
        } finally {
          activeScope = null;
        }
      }),
    replaceCurrent: async (input) => {
      if (!activeScope) {
        fail('CENTURION_THREAD_AUDIT_PUBLISHER_TRANSACTION_REQUIRED');
      }
      await replaceCurrentInScope({
        scope: activeScope,
        ...input,
      });
    },
    replaceCurrentWithIncompleteAfterFailure: async (input) =>
      db.transaction(async (tx) => {
        await lockTransport(tx, input.envelope.transportId);
        const current = await loadCurrentHeader(tx, input.envelope.transportId);
        if (
          !current ||
          current.publicationIncarnationId !== input.expectedPublicationIncarnationId
        ) {
          return false;
        }
        await tx
          .delete(threadAuditSnapshot)
          .where(eq(threadAuditSnapshot.transportId, input.envelope.transportId));
        await tx.insert(threadAuditSnapshot).values(
          centurionThreadAuditSnapshotHeaderValues({
            envelope: input.envelope,
            publicationIncarnationId: input.publicationIncarnationId,
            publicationRevisionToken: input.publicationRevisionToken,
            forceIncomplete: true,
          }),
        );
        const [recovered] = await tx
          .select({
            trustStatus: threadAuditSnapshot.trustStatus,
            messageCount: threadAuditSnapshot.messageCount,
            metricsAndInsights: threadAuditSnapshot.metricsAndInsights,
          })
          .from(threadAuditSnapshot)
          .where(eq(threadAuditSnapshot.transportId, input.envelope.transportId))
          .limit(1);
        const [remainingComponent] = await tx
          .select({ componentId: threadAuditSnapshotComponent.componentId })
          .from(threadAuditSnapshotComponent)
          .where(
            eq(
              threadAuditSnapshotComponent.transportId,
              input.envelope.transportId,
            ),
          )
          .limit(1);
        const [remainingMapping] = await tx
          .select({ threadId: threadAuditSnapshotComponentThread.threadId })
          .from(threadAuditSnapshotComponentThread)
          .where(
            eq(
              threadAuditSnapshotComponentThread.transportId,
              input.envelope.transportId,
            ),
          )
          .limit(1);
        if (
          !recovered ||
          recovered.trustStatus !== 'incomplete' ||
          recovered.messageCount !== null ||
          recovered.metricsAndInsights !== null ||
          remainingComponent ||
          remainingMapping
        ) {
          fail('CENTURION_THREAD_AUDIT_PUBLISHER_MATERIALIZATION_RECHECK_FAILED');
        }
        return true;
      }),
  };
}

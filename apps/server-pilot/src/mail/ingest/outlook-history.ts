import {
  findCanonicalCandidate,
  lockCanonicalMailbox,
  type CanonicalEvidence,
  corroboratedMessageId,
  newCanonicalAttachments,
} from './canonical-identity.js';
import {
  LINKED_ATTACHMENT_SCOPES_KEY,
  LINKED_OPTIONAL_MISSING_KEY,
  UNAVAILABLE_ROLE,
  mergeLinkedAttachmentEvidence,
  optionalMissingItems,
  persistedOwnAttachmentSuffixes,
  type AttachmentScopeEvidence,
} from './attachment-evidence.js';
import { attachment, mailboxTransport, mailThread, message } from '../../db/schema/mail.js';
import { canonicalMessageId, buildReferenceChain } from './message-id.js';
import { refreshThreadSearchVector } from '../search/search-vector.js';
import { sanitizeHtmlBodyForStorage } from '../sanitize-email-html.js';
import { createHash, randomUUID } from 'node:crypto';
import { and, eq, inArray } from 'drizzle-orm';
import type { DB } from '../../db/client.js';

export type OutlookHistoryInput = Omit<CanonicalEvidence, 'attachments'> & {
  transportId: string;
  sourceId?: string;
  sourceObservationId: string;
  semanticVersion: string;
  subject: string | null;
  inReplyTo: string | null;
  references: string[];
  bccAddresses: string[];
  sentAt: Date | null;
  originalMsgKey: string;
  attachments: {
    sourceAttachmentId: string;
    filename: string;
    mimeType: string;
    sizeBytes: number;
    sha256: string;
    s3Key: string;
    contentId: string | null;
    isInline: boolean;
  }[];
  sourceProvenance: Record<string, unknown>;
};
/** History only inserts/enriches searchable evidence; operational clocks/state and queues stay untouched. */
export async function persistOutlookHistory(
  db: DB,
  input: OutlookHistoryInput,
): Promise<{ messageId: string; threadId: string; linked: boolean; attention: boolean }> {
  if (
    !input.originalMsgKey.startsWith('outlook-sync-originals/v1/') ||
    input.attachments.some(
      (a) =>
        !Number.isSafeInteger(a.sizeBytes) ||
        a.sizeBytes < 0 ||
        !a.s3Key.startsWith('outlook-sync-originals/v1/'),
    )
  )
    throw new Error('Invalid sealed history artifact');
  return db.transaction(async (tx) => {
    const scoped = tx as unknown as DB;
    await lockCanonicalMailbox(scoped, input.transportId);
    const [transport] = await tx
      .select({ id: mailboxTransport.id })
      .from(mailboxTransport)
      .where(and(eq(mailboxTransport.id, input.transportId), eq(mailboxTransport.isActive, true)))
      .limit(1);
    if (!transport) throw new Error('Inactive history mailbox');
    const digest = createHash('sha256')
      .update(
        JSON.stringify([
          input.transportId,
          input.sourceId ?? input.originalMsgKey,
          input.sourceObservationId,
        ]),
      )
      .digest('hex');
    const observationMessageId = `${digest.slice(0, 8)}-${digest.slice(8, 12)}-4${digest.slice(13, 16)}-8${digest.slice(17, 20)}-${digest.slice(20, 32)}`;
    const [prior] = await tx
      .select()
      .from(message)
      .where(and(eq(message.transportId, input.transportId), eq(message.id, observationMessageId)))
      .limit(1);
    // Attachment roles live inside this observation's own manifest scope;
    // suffixes it verifiably persisted are the artifact set selected for it.
    const incomingRequiredRoles = (
      input.sourceProvenance.evidence as { requiredArtifactRoles?: unknown } | null | undefined
    )?.requiredArtifactRoles;
    const incomingScope: AttachmentScopeEvidence | null = input.sourceId
      ? {
          sourceId: input.sourceId,
          sourceObservationId: input.sourceObservationId,
          semanticVersion: input.semanticVersion,
          enumerated:
            Array.isArray(incomingRequiredRoles) &&
            !incomingRequiredRoles.includes(UNAVAILABLE_ROLE),
          missing: input.sourceProvenance.optionalMissing,
          persisted: input.attachments.map((a) => a.sourceAttachmentId),
        }
      : null;
    const candidate = prior
      ? { kind: 'unique' as const, message: prior }
      : await findCanonicalCandidate(scoped, input.transportId, input);
    let messageId: string, threadId: string;
    const attention =
      candidate.kind === 'ambiguous' ||
      (candidate.kind === 'unique' &&
        candidate.message.sourceProvenance?.attention === 'AMBIGUOUS_IDENTITY');
    const linked = candidate.kind === 'unique';
    const priorAttachments =
      candidate.kind === 'unique'
        ? await tx.select().from(attachment).where(eq(attachment.messageId, candidate.message.id))
        : [];
    const additions = newCanonicalAttachments(priorAttachments, input.attachments);
    if (candidate.kind === 'unique') {
      messageId = candidate.message.id;
      threadId = candidate.message.threadId;
      const provenance = candidate.message.sourceProvenance ?? {};
      const previousVersion = candidate.message.sourceProvenance?.canonicalContentVersion;
      const incomingVersion = /^\d+$/.test(input.semanticVersion)
        ? BigInt(input.semanticVersion)
        : null;
      const newerOwnedHistory = Boolean(
        prior &&
          prior.historyOnly &&
          incomingVersion !== null &&
          (typeof previousVersion !== 'string' ||
            (/^\d+$/.test(previousVersion) && incomingVersion > BigInt(previousVersion))),
      );
      // A repaired export for this same Outlook observation enriches its evidence
      // without replacing a live message's body or another producer's provenance.
      const sameObservation = candidate.message.sourceProvenance?.sourceId === input.sourceId &&
        candidate.message.sourceProvenance?.sourceObservationId === input.sourceObservationId;
      // Versions are comparable only within one Outlook source observation. A slower
      // old drain must not add old attachments or remove newer missing-evidence flags.
      if (sameObservation && incomingVersion !== null && typeof previousVersion === 'string' &&
          /^\d+$/.test(previousVersion) && incomingVersion < BigInt(previousVersion)) {
        return { messageId, threadId, linked, attention };
      }
      // A different device observes the same canonical message under another
      // sourceId/sourceObservationId, so its declared-but-missing attachment
      // roles never reach `optionalMissing`. Merge them into a canonical gap
      // list instead of letting the link read as confirmed-empty. Attachment
      // roles are scoped to the observing lineage: `attachment:1` inside one
      // observation's manifest is unrelated to `attachment:1` inside another's,
      // so a missing role may resolve only against artifacts that same
      // observation verifiably persisted, and a discovery
      // `attachment:unavailable` placeholder survives until that same
      // observation later enumerates concrete roles.
      const ownRequiredRoles = (
        provenance.evidence as { requiredArtifactRoles?: unknown } | null | undefined
      )?.requiredArtifactRoles;
      const ownScope: AttachmentScopeEvidence | null =
        typeof provenance.sourceId === 'string' &&
        typeof provenance.sourceObservationId === 'string'
          ? {
              sourceId: provenance.sourceId,
              sourceObservationId: provenance.sourceObservationId,
              semanticVersion:
                typeof previousVersion === 'string'
                  ? previousVersion
                  : typeof provenance.semanticVersion === 'number' ||
                      typeof provenance.semanticVersion === 'string'
                    ? String(provenance.semanticVersion)
                    : null,
              enumerated:
                Array.isArray(ownRequiredRoles) &&
                !ownRequiredRoles.includes(UNAVAILABLE_ROLE),
              missing: provenance.optionalMissing,
              persisted: persistedOwnAttachmentSuffixes(provenance, priorAttachments),
            }
          : null;
      const evidence = mergeLinkedAttachmentEvidence({
        scopes: provenance[LINKED_ATTACHMENT_SCOPES_KEY],
        legacyLinked: provenance[LINKED_OPTIONAL_MISSING_KEY],
        own: ownScope,
        incoming: incomingScope,
        incomingMissing: incomingScope ? undefined : input.sourceProvenance.optionalMissing,
      });
      // A provably older export of a linked lineage must neither add old
      // attachments nor replace that lineage's newer missing evidence; older
      // manifests may reuse a role for a different part.
      if (evidence.stale) return { messageId, threadId, linked, attention };
      const linkedMissing = evidence.gaps;
      const evidenceChanged =
        evidence.scopesChanged ||
        JSON.stringify(optionalMissingItems(linkedMissing)) !==
          JSON.stringify(optionalMissingItems(provenance[LINKED_OPTIONAL_MISSING_KEY]));
      await tx
        .update(message)
        .set({
          originalMsgS3Key: candidate.message.originalMsgS3Key ?? input.originalMsgKey,
          textBody:
            newerOwnedHistory && input.textBody !== null
              ? input.textBody
              : (candidate.message.textBody ?? input.textBody),
          htmlBody:
            newerOwnedHistory && input.htmlBody !== null
              ? sanitizeHtmlBodyForStorage(input.htmlBody)
              : (candidate.message.htmlBody ?? sanitizeHtmlBodyForStorage(input.htmlBody)),
          ...(newerOwnedHistory || sameObservation || evidenceChanged
            ? {
                sourceProvenance: {
                  ...provenance,
                  ...(newerOwnedHistory || sameObservation ? { canonicalContentVersion: input.semanticVersion } : {}),
                  ...(sameObservation ? {
                    observationId: input.sourceProvenance.observationId,
                    semanticVersion: input.sourceProvenance.semanticVersion,
                    artifactOrigin: input.sourceProvenance.artifactOrigin,
                    optionalMissing: input.sourceProvenance.optionalMissing,
                    evidence: input.sourceProvenance.evidence,
                    artifacts: input.sourceProvenance.artifacts,
                  } : {}),
                  ...(evidence.scopes.length
                    ? {
                        [LINKED_ATTACHMENT_SCOPES_KEY]: evidence.scopes,
                        [LINKED_OPTIONAL_MISSING_KEY]: linkedMissing,
                      }
                    : {}),
                },
              }
            : {}),
        })
        .where(eq(message.id, messageId));
    } else {
      messageId = observationMessageId;
      const chain = buildReferenceChain(input.inReplyTo, input.references);
      let parentThread: string | undefined;
      // Reused/missing references never force grouping. No subject fallback.
      for (const ref of [...chain].reverse()) {
        if (!corroboratedMessageId(ref)) continue;
        const parents = await tx
          .select({ threadId: message.threadId })
          .from(message)
          .where(and(eq(message.transportId, input.transportId), eq(message.messageIdHeader, ref)))
          .limit(2);
        if (parents.length === 1) {
          parentThread = parents[0]!.threadId;
          break;
        }
        if (parents.length > 1) break;
      }
      threadId = parentThread ?? randomUUID();
      if (!parentThread)
        await tx.insert(mailThread).values({
          id: threadId,
          transportId: input.transportId,
          threadRootId: `outlook:${messageId}`,
          subject: input.subject,
          snippet: input.textBody?.slice(0, 160),
          historyOnly: true,
          isRead: true,
          latestMessageAt: input.authoredAt,
        });
      await tx.insert(message).values({
        id: messageId,
        transportId: input.transportId,
        threadId,
        direction: input.direction,
        historyOnly: true,
        isRead: true,
        messageIdHeader: canonicalMessageId(input.internetMessageId),
        inReplyTo: canonicalMessageId(input.inReplyTo),
        references: chain,
        fromAddress: input.fromAddress,
        toAddresses: input.toAddresses,
        ccAddresses: input.ccAddresses,
        bccAddresses: input.bccAddresses,
        subject: input.subject,
        textBody: input.textBody,
        htmlBody: sanitizeHtmlBodyForStorage(input.htmlBody),
        receivedAt: input.authoredAt,
        sentAt: input.sentAt,
        originalMsgS3Key: input.originalMsgKey,
        sourceProvenance: {
          ...input.sourceProvenance,
          canonicalContentVersion: input.semanticVersion,
          ...(incomingScope ? { [LINKED_ATTACHMENT_SCOPES_KEY]: [incomingScope] } : {}),
          ...(attention ? { attention: 'AMBIGUOUS_IDENTITY' } : {}),
        },
      });
    }
    for (let start = 0; start < additions.length; start += 100) {
      await tx
        .insert(attachment)
        .values(
          additions.slice(start, start + 100).map((a) => ({ id: randomUUID(), messageId, ...a })),
        );
    }
    // Late parent arrival may repair only wholly historical child threads.
    const header = corroboratedMessageId(input.internetMessageId);
    if (header) {
      const parents = await tx
        .select({ id: message.id })
        .from(message)
        .where(and(eq(message.transportId, input.transportId), eq(message.messageIdHeader, header)))
        .limit(2);
      if (parents.length === 1) {
        const children = await tx
          .select({ id: message.id, threadId: message.threadId, inReplyTo: message.inReplyTo })
          .from(message)
          .innerJoin(mailThread, eq(message.threadId, mailThread.id))
          .where(
            and(
              eq(message.transportId, input.transportId),
              eq(message.historyOnly, true),
              eq(mailThread.historyOnly, true),
              eq(message.inReplyTo, header),
            ),
          );
        for (const child of children)
          if (child.threadId !== threadId) {
            const members = await tx
              .select({ id: message.id, historyOnly: message.historyOnly })
              .from(message)
              .where(eq(message.threadId, child.threadId));
            if (members.every((m) => m.historyOnly)) {
              await tx
                .update(message)
                .set({ threadId })
                .where(
                  inArray(
                    message.id,
                    members.map((m) => m.id),
                  ),
                );
              await tx
                .delete(mailThread)
                .where(and(eq(mailThread.id, child.threadId), eq(mailThread.historyOnly, true)));
            }
          }
      }
    }
    await refreshThreadSearchVector(scoped, threadId);
    return { messageId, threadId, linked, attention };
  });
}

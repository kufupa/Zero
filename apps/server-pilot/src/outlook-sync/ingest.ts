import type {
  outlookSyncArtifact,
  outlookSyncObservation,
  outlookSyncSource,
} from '../db/schema/outlook-sync.js';
import type { SyncSealedArtifact, SyncUploadSession, OutlookSyncStorage } from './storage.js';
import type { OutlookHistoryInput } from '../mail/ingest/outlook-history.js';
import { syncObservationV1, type SyncObservationV1 } from './contracts.js';
import { reusableContent } from './content.js';

export type SyncIngestionStorage = Pick<OutlookSyncStorage, 'verifyReceipt' | 'readSealedBounded'>;
export type IngestionSource = typeof outlookSyncSource.$inferSelect;
export type IngestionObservation = typeof outlookSyncObservation.$inferSelect;
export type IngestionArtifact = typeof outlookSyncArtifact.$inferSelect;
export class SyncIngestionGap extends Error {
  constructor(readonly code: string) {
    super(code);
    this.name = 'SyncIngestionGap';
  }
}
export function requiredArtifacts(
  observation: IngestionObservation,
  artifacts: IngestionArtifact[],
) {
  if (!observation.requiredArtifactRoles.length)
    throw new SyncIngestionGap('MISSING_REQUIRED_ARTIFACT');
  const selected: IngestionArtifact[] = [];
  for (const role of observation.requiredArtifactRoles) {
    const candidates = artifacts
      .filter((a) => a.role === role)
      .sort((a, b) => b.version - a.version);
    const newest = candidates[0];
    if (
      !newest ||
      !newest.sealedKey ||
      !newest.acceptedAt ||
      !newest.verifiedReceipt ||
      !newest.uploadSession
    )
      throw new SyncIngestionGap('MISSING_REQUIRED_ARTIFACT');
    selected.push(newest);
  }
  return selected;
}
/** Builds plain verified DTOs before taking canonical/receipt locks. Never parse Outlook MSG on the server. */
export async function buildOutlookHistoryInput(
  storage: SyncIngestionStorage,
  source: IngestionSource,
  observation: IngestionObservation,
  artifacts: IngestionArtifact[],
  origin?: IngestionObservation,
): Promise<{ input: OutlookHistoryInput; evidence: SyncObservationV1 }> {
  const parsed = syncObservationV1.safeParse(observation.evidence);
  if (!parsed.success) throw new SyncIngestionGap('INVALID_OBSERVATION');
  const evidence = parsed.data;
  if (!evidence.semanticReady) throw new SyncIngestionGap('METADATA_NOT_ENRICHED');
  if (observation.availability !== 'available') throw new SyncIngestionGap('CONTENT_UNAVAILABLE');
  if (evidence.direction === 'unknown' || evidence.direction !== observation.direction)
    throw new SyncIngestionGap('UNKNOWN_DIRECTION');
  const date =
    evidence.direction === 'outbound' ? evidence.timestamps.sentAt : evidence.timestamps.receivedAt;
  if (!date || !Number.isFinite(Date.parse(date))) throw new SyncIngestionGap('UNKNOWN_DATE');
  if (
    observation.artifactOrigin &&
    (!origin ||
      observation.artifactOrigin.sourceId !== source.id ||
      origin.sourceId !== source.id ||
      observation.artifactOrigin.observationId !== origin.id ||
      origin.artifactOrigin ||
      origin.sourceObservationId !== observation.sourceObservationId ||
      !reusableContent(observation.evidence, origin.evidence))
  )
    throw new SyncIngestionGap('ARTIFACT_ORIGIN_MISMATCH');
  if (!observation.artifactOrigin && origin) throw new SyncIngestionGap('ARTIFACT_ORIGIN_MISMATCH');
  const artifactObservationId = origin?.id ?? observation.id;
  const selected = requiredArtifacts(observation, artifacts);
  if (!selected.some((a) => a.role === 'original-msg'))
    throw new SyncIngestionGap('MISSING_ORIGINAL_MSG');
  const projections = new Map<string, string>();
  const receipts: { role: string; artifactId: string; receipt: SyncSealedArtifact }[] = [];
  for (const artifact of selected) {
    const session = artifact.uploadSession as unknown as SyncUploadSession;
    const supplied = artifact.verifiedReceipt as unknown as SyncSealedArtifact;
    if (
      session.sourceId !== source.id ||
      artifact.observationId !== artifactObservationId ||
      session.observationId !== artifactObservationId ||
      session.artifactId !== artifact.id ||
      session.expectedBytes !== artifact.expectedBytes ||
      session.sha256 !== artifact.sha256 ||
      supplied.key !== artifact.sealedKey ||
      supplied.bytes !== artifact.expectedBytes ||
      supplied.sha256 !== artifact.sha256
    )
      throw new SyncIngestionGap('ARTIFACT_SCOPE_MISMATCH');
    const receipt = await storage.verifyReceipt(session, supplied);
    receipts.push({ role: artifact.role, artifactId: artifact.id, receipt });
    if (['body-text', 'body-html', 'transport-headers'].includes(artifact.role)) {
      if (receipt.bytes > 16 * 1024 * 1024) throw new SyncIngestionGap('PROJECTION_TOO_LARGE');
      const bytes = await storage.readSealedBounded(receipt, 16 * 1024 * 1024);
      try {
        projections.set(artifact.role, new TextDecoder('utf-8', { fatal: true }).decode(bytes));
      } catch {
        throw new SyncIngestionGap('INVALID_PROJECTION_UTF8');
      }
    }
  }
  const original = selected.find((a) => a.role === 'original-msg')!;
  return {
    evidence,
    input: {
      transportId: source.transportId,
      sourceId: source.id,
      sourceObservationId: observation.sourceObservationId,
      semanticVersion: String(observation.semanticVersion),
      internetMessageId: evidence.semantic.internetMessageId,
      direction: evidence.direction,
      fromAddress: evidence.semantic.sender?.address || evidence.semantic.from,
      toAddresses: evidence.semantic.to,
      ccAddresses: evidence.semantic.cc.map((a) => a.address),
      bccAddresses: evidence.semantic.bcc.map((a) => a.address),
      subject: evidence.semantic.subject,
      inReplyTo: evidence.semantic.inReplyTo,
      references: evidence.semantic.references,
      authoredAt: new Date(date),
      sentAt: evidence.timestamps.sentAt ? new Date(evidence.timestamps.sentAt) : null,
      textBody: projections.get('body-text') ?? null,
      htmlBody: projections.get('body-html') ?? null,
      originalMsgKey: original.sealedKey!,
      attachments: selected
        .filter((a) => a.role.startsWith('attachment:'))
        .map((a) => ({
          sourceAttachmentId: a.role.slice(11),
          filename: typeof a.metadata?.fileName === 'string' ? a.metadata.fileName : 'attachment',
          mimeType: a.contentType,
          sizeBytes: a.expectedBytes,
          sha256: a.sha256,
          s3Key: a.sealedKey!,
          contentId: typeof a.metadata?.contentId === 'string' ? a.metadata.contentId : null,
          isInline: a.metadata?.inline === true,
        })),
      sourceProvenance: {
        version: 1,
        sourceId: source.id,
        observationId: observation.id,
        artifactOrigin: observation.artifactOrigin ?? null,
        sourceObservationId: observation.sourceObservationId,
        semanticVersion: observation.semanticVersion,
        evidence,
        transportHeaders:
          projections.get('transport-headers') ?? evidence.semantic.transportHeaders,
        artifacts: receipts,
      },
    },
  };
}

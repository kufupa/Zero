import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import type { attachment, message } from '../db/schema/mail.js';
import type { mailExtraction, workEvent } from '../db/schema/work.js';
import { canonicalJson } from './draft-approval.js';

type SourceMessage = Pick<typeof message.$inferSelect,
  'id' | 'transportId' | 'threadId' | 'direction' | 'historyOnly' | 'ownerHeaderValue' |
  'messageIdHeader' | 'inReplyTo' | 'references' | 'fromAddress' | 'toAddresses' |
  'ccAddresses' | 'bccAddresses' | 'subject' | 'textBody' | 'htmlBody' | 'originalMsgS3Key' |
  'rawMimeS3Key' | 'sourceProvenance' | 'receivedAt' | 'sentAt' | 'createdAt'>;
type SourceExtraction = Pick<typeof mailExtraction.$inferSelect,
  'id' | 'messageId' | 'extractorVersion' | 'status' | 'kind' | 'language' | 'payload' |
  'translation' | 'attachments'>;
type SourceAttachment = Pick<typeof attachment.$inferSelect,
  'id' | 'messageId' | 'filename' | 'mimeType' | 'sizeBytes' | 'sha256' | 'sourceAttachmentId' |
  's3Key' | 'contentId' | 'isInline'>;

type CorrectionEvent = Pick<typeof workEvent.$inferSelect,
  'id' | 'workItemId' | 'actorKind' | 'actorUserId' | 'type' | 'fieldPath' | 'value' | 'aiValue' | 'aiSource' | 'evidence'>;
export type HistoricalCorrection = { event: CorrectionEvent; extraction: SourceExtraction };

export type CreateSourceSnapshot = {
  source: SourceMessage;
  extraction: SourceExtraction;
  attachments: SourceAttachment[];
  /** Server-loaded correction provenance, never pane-supplied IDs or values. */
  historicalCorrections: HistoricalCorrection[];
};

function boundExtraction(extraction: SourceExtraction) {
  return {
    id: extraction.id, messageId: extraction.messageId, extractorVersion: extraction.extractorVersion,
    status: extraction.status, kind: extraction.kind, language: extraction.language, payload: extraction.payload,
    translation: extraction.translation, attachments: extraction.attachments,
  };
}

function boundCorrection(correction: HistoricalCorrection, sourceId: string) {
  const { event, extraction } = correction;
  const evidence = event.evidence;
  if (!event.id || !event.workItemId || event.actorKind !== 'user' || !event.actorUserId ||
      !['field.edit', 'field.reject'].includes(event.type) || !event.fieldPath ||
      !evidence || typeof evidence !== 'object' || Array.isArray(evidence) ||
      extraction.status !== 'succeeded' || extraction.messageId !== sourceId || event.aiSource !== extraction.extractorVersion) {
    throw new Error('create_source_mismatch');
  }
  const proof = evidence as Record<string, unknown>;
  const paneState = proof.paneState;
  if (proof.extractionId !== extraction.id || typeof proof.paneSeq !== 'number' ||
      !Number.isSafeInteger(proof.paneSeq) || proof.paneSeq < 1 ||
      !paneState || typeof paneState !== 'object' || Array.isArray(paneState) ||
      !Object.hasOwn(paneState, event.fieldPath) ||
      !isDeepStrictEqual((paneState as Record<string, unknown>)[event.fieldPath], event.value)) {
    throw new Error('create_source_mismatch');
  }
  return {
    event: {
      id: event.id, workItemId: event.workItemId, actorKind: event.actorKind, actorUserId: event.actorUserId,
      type: event.type, fieldPath: event.fieldPath, value: event.value, aiValue: event.aiValue,
      aiSource: event.aiSource, evidence: event.evidence,
    },
    extraction: boundExtraction(extraction),
  };
}

/**
 * Fingerprint the approved message, extraction and linked attachment metadata.
 * Keys and stored hashes do not prove the current object-store bytes. This is
 * not approval, byte verification or a row lock. Callers must load the fields
 * on the server, never from pane or tool input.
 */
export function createSourceSnapshotDigest(snapshot: CreateSourceSnapshot): string {
  const { source, extraction } = snapshot;
  if (!Array.isArray(snapshot.historicalCorrections)) throw new Error('create_source_mismatch');
  if (source.direction !== 'inbound' || extraction.status !== 'succeeded' ||
      extraction.messageId !== source.id || snapshot.attachments.some((row) => row.messageId !== source.id)) {
    throw new Error('create_source_mismatch');
  }
  const attachments = snapshot.attachments.map((row) => ({
    id: row.id, messageId: row.messageId, filename: row.filename, mimeType: row.mimeType,
    sizeBytes: row.sizeBytes, sha256: row.sha256, sourceAttachmentId: row.sourceAttachmentId,
    s3Key: row.s3Key, contentId: row.contentId, isInline: row.isInline,
  })).sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
  if (attachments.some((row, index) => index > 0 && attachments[index - 1]?.id === row.id)) {
    throw new Error('create_source_mismatch');
  }
  const historicalCorrections = snapshot.historicalCorrections
    .map((correction) => boundCorrection(correction, source.id))
    .sort((a, b) => a.event.id < b.event.id ? -1 : a.event.id > b.event.id ? 1 : 0);
  if (historicalCorrections.some((row, index) => index > 0 && historicalCorrections[index - 1]?.event.id === row.event.id)) {
    throw new Error('create_source_mismatch');
  }
  const bound = {
    version: 'pane-create-source/v2',
    source: {
      id: source.id, transportId: source.transportId, threadId: source.threadId,
      direction: source.direction, historyOnly: source.historyOnly, ownerHeaderValue: source.ownerHeaderValue,
      messageIdHeader: source.messageIdHeader, inReplyTo: source.inReplyTo, references: source.references,
      fromAddress: source.fromAddress, toAddresses: source.toAddresses, ccAddresses: source.ccAddresses,
      bccAddresses: source.bccAddresses, subject: source.subject, textBody: source.textBody, htmlBody: source.htmlBody,
      originalMsgS3Key: source.originalMsgS3Key, rawMimeS3Key: source.rawMimeS3Key,
      sourceProvenance: source.sourceProvenance,
      receivedAt: source.receivedAt?.toISOString() ?? null, sentAt: source.sentAt?.toISOString() ?? null,
      createdAt: source.createdAt.toISOString(),
    },
    extraction: boundExtraction(extraction),
    attachments,
    historicalCorrections,
  };
  return createHash('sha256').update(canonicalJson(bound)).digest('hex');
}

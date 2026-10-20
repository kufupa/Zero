/**
 * Persist one extra mailbox copy per named hotel transport.
 *
 * Each copy uses UIDL `<uidl>#t:<transportId>` everywhere (receipt, message
 * row, attachment-key ownership, UIDL claim, pending-cleanup check). The raw
 * UIDL is never passed to a copy call. Claim the copy UIDL and skip parse
 * when cleanup is pending, so attachments are not uploaded under an unclaimed
 * key. `fanoutCopy: true` never inserts quarantine.
 */
import {
  claimIngestUidl,
  hasPendingCandidateAttachmentCleanup,
  persistInboundMessage,
  releaseIngestUidlClaim,
  type IngestMeta,
  type PersistFailCode,
  type PersistFailedResult,
  type PersistResult,
} from './store.js';
import {
  candidateMessageIdForPop3Uidl,
  parseRawMessage,
  uploadedAttachmentsFromParseFailure,
} from './parse-message.js';
import type { DB } from '../../db/client.js';
import type { S3Storage } from '../../storage/s3.js';

export function fanoutCopyPop3Uidl(pop3Uidl: string, transportId: string): string {
  return `${pop3Uidl}#t:${transportId}`;
}

export type FanoutCopyOutcome = {
  transportId: string;
  result: PersistResult;
};

export type PersistFanoutCopiesResult = {
  results: FanoutCopyOutcome[];
};

const COPY_SUCCESS = new Set(['stored', 'duplicate', 'reconciled']);

export function fanoutCopiesSucceeded(results: FanoutCopyOutcome[]): boolean {
  return results.every((copy) => COPY_SUCCESS.has(copy.result.kind));
}

function failedCopy(
  code: PersistFailCode,
  uploadedAttachmentKeys: string[] = [],
): PersistFailedResult {
  return { kind: 'failed', code, uploadedAttachmentKeys: [...new Set(uploadedAttachmentKeys)] };
}

export async function persistFanoutCopies(args: {
  db: DB;
  storage: S3Storage;
  raw: Buffer;
  meta: IngestMeta;
  transportIds: string[];
  ingestSource?: 'live-pop3';
  skipAiEnqueue?: boolean;
  activeIngestUidlClaimToken?: string;
}): Promise<PersistFanoutCopiesResult> {
  const results: FanoutCopyOutcome[] = [];
  const rawMimeS3Key = args.meta.rawMimeS3Key;
  for (const transportId of [...args.transportIds].sort()) {
    const copyUidl = fanoutCopyPop3Uidl(args.meta.pop3Uidl, transportId);
    const copyScope = {
      ingestMailboxId: args.meta.ingestMailboxId,
      pop3Uidl: copyUidl,
    };
    const messageId = candidateMessageIdForPop3Uidl(copyScope.ingestMailboxId, copyUidl);
    const copyMeta: IngestMeta = {
      ...copyScope,
      messageId,
      rawMimeS3Key,
    };
    if (await hasPendingCandidateAttachmentCleanup(args.db, copyScope)) {
      results.push({ transportId, result: failedCopy('pending_cleanup') });
      continue;
    }
    let claimToken: string | null = null;
    try {
      claimToken = await claimIngestUidl(args.db, copyScope);
    } catch {
      results.push({ transportId, result: failedCopy('claim_pending') });
      continue;
    }
    if (!claimToken) {
      results.push({ transportId, result: failedCopy('claim_pending') });
      continue;
    }
    if (await hasPendingCandidateAttachmentCleanup(args.db, copyScope)) {
      await releaseIngestUidlClaim(args.db, copyScope, claimToken).catch(() => undefined);
      results.push({ transportId, result: failedCopy('pending_cleanup') });
      continue;
    }
    const uploadedAttachmentKeys: string[] = [];
    try {
      const parsed = await parseRawMessage(args.raw, {
        messageId,
        storage: args.storage,
      });
      uploadedAttachmentKeys.push(
        ...parsed.attachments.map((attachment) => attachment.s3Key).filter(Boolean),
      );
      const result = await persistInboundMessage(parsed, args.raw, copyMeta, {
        db: args.db,
        storage: args.storage,
        transportOverride: transportId,
        fanoutCopy: true,
        ingestSource: args.ingestSource,
        skipAiEnqueue: args.skipAiEnqueue,
        activeIngestUidlClaimToken: claimToken,
      });
      if (result.kind === 'failed') {
        results.push({
          transportId,
          result: failedCopy(result.code, [
            ...result.uploadedAttachmentKeys,
            ...uploadedAttachmentKeys,
          ]),
        });
      } else {
        results.push({ transportId, result });
      }
    } catch (error) {
      const uploaded = uploadedAttachmentsFromParseFailure(error);
      results.push({
        transportId,
        result: failedCopy('parse_failure', [
          ...uploadedAttachmentKeys,
          ...uploaded.map((attachment) => attachment.s3Key),
        ]),
      });
    } finally {
      await releaseIngestUidlClaim(args.db, copyScope, claimToken).catch(() => undefined);
    }
  }
  return { results };
}

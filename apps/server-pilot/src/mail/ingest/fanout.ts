/**
 * Persist one extra mailbox copy per named hotel transport.
 *
 * Each copy uses UIDL `<uidl>#t:<transportId>` everywhere (receipt, message
 * row, attachment-key ownership). The raw UIDL is never passed to a copy
 * call. Each copy is its own persist transaction with `fanoutCopy: true`
 * (never quarantines) and `transportOverride` for that hotel transport.
 */
import { persistInboundMessage, type IngestMeta, type PersistResult } from './store.js';
import { candidateMessageIdForPop3Uidl, parseRawMessage } from './parse-message.js';
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
    const messageId = candidateMessageIdForPop3Uidl(args.meta.ingestMailboxId, copyUidl);
    const copyMeta: IngestMeta = {
      ingestMailboxId: args.meta.ingestMailboxId,
      pop3Uidl: copyUidl,
      messageId,
      rawMimeS3Key,
    };
    try {
      const parsed = await parseRawMessage(args.raw, {
        messageId,
        storage: args.storage,
      });
      const result = await persistInboundMessage(parsed, args.raw, copyMeta, {
        db: args.db,
        storage: args.storage,
        transportOverride: transportId,
        fanoutCopy: true,
        ingestSource: args.ingestSource,
        skipAiEnqueue: args.skipAiEnqueue,
        activeIngestUidlClaimToken: args.activeIngestUidlClaimToken,
      });
      results.push({ transportId, result });
    } catch {
      results.push({ transportId, result: { kind: 'failed' } });
    }
  }
  return { results };
}

import type { DB } from '../db/client.js';
import { readPanePop3Attachment } from './artifacts/pane-pop3-attachment.js';
import { OutlookSyncStorage } from '../outlook-sync/storage.js';
import type { S3Storage } from '../storage/s3.js';
import { readVoucherDiscoverySource } from '../ai/voucher-filing-source.js';

type PaneSource = { transportId: string; messageId: string; attachmentId: string;
  filename: string; sha256: string; snapshotDigest: string };

/** Preserve POP3's existing digest; sealed Outlook bytes use their accepted receipt digest. */
export async function readPaneFilingAttachment(input: {
  db: DB; s3: S3Storage; transportId: string; messageId: string; attachmentId: string;
  signal: AbortSignal; checkAuthority: () => Promise<boolean>; expected?: PaneSource;
}): Promise<{ source: PaneSource; bytes: Buffer } | null> {
  const pop3 = await readPanePop3Attachment(input);
  if (pop3) return pop3;
  try {
    const storage = new OutlookSyncStorage({ bucket: input.s3.bucket });
    return await readVoucherDiscoverySource(input, { db: input.db, storage, signal: input.signal,
      checkAuthority: input.checkAuthority }, input.expected ? { ...input.expected, mimeType: 'application/pdf' } : undefined);
  } catch { return null; }
}

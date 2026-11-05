import { createHash } from 'node:crypto';
import { paneSourceSelectionSchema, type PaneSourceSelection } from '../../mail/pane-source-selection.js';

/** A failed observation changes after every actual retry; it cannot authorize a different observation. */
export function failedReadFingerprint(row: {
  id: string; extractorVersion: string; status: string;
  usage: Record<string, unknown> | null; attachments: Record<string, unknown>[] | null;
}): string {
  return createHash('sha256').update(JSON.stringify([
    row.id, row.extractorVersion, row.status, row.usage, row.attachments,
  ])).digest('hex');
}

export type FailedReadRetry = {
  failedId: string;
  extractorVersion: string;
  fingerprint: string;
  sourceHash: string;
  selectionHash: string;
  attachmentHash: string;
  actorId: string;
  internetMessageId: string;
  selection: PaneSourceSelection;
};

export function failedReadRetryOf(metrics: unknown): FailedReadRetry | null {
  const value = (metrics as { failedReadRetry?: Partial<FailedReadRetry> } | null)?.failedReadRetry;
  const selection = paneSourceSelectionSchema.safeParse(value?.selection);
  if (!value || typeof value.failedId !== 'string' || typeof value.actorId !== 'string' ||
      typeof value.internetMessageId !== 'string' || typeof value.extractorVersion !== 'string' || !selection.success ||
      ![value.fingerprint, value.sourceHash, value.selectionHash, value.attachmentHash].every((s) => typeof s === 'string' && /^[a-f0-9]{64}$/.test(s))) return null;
  return { ...value, selection: selection.data } as FailedReadRetry;
}

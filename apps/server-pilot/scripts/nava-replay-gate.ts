/** Fail-closed checks for one replay fixture. Observations must come from the actual pane. */
import { readFileSync, statSync } from 'node:fs';

export type ReplayExpectation = {
  threadId: string;
  messageId: string;
  readAs: string;
  requireDraft: boolean;
  requireAttachment: boolean;
  /** Filing fixtures require metadata for an attachment on the exact current inbound. */
  requireSourceAttachment: boolean;
};

export type ReplayDraftEvidence = {
  messageId: string;
  location: { entryId: string; storeId: string; folderEntryId: string };
  attachments: Array<{ fileName: string; base64Data: string }>;
};

export type ReplayObservation = {
  threadId: string;
  messageId: string;
  /** Proved by the current mailbox read, not copied from the historical fixture. */
  synchronized: boolean;
  outcome: string;
  readAs: string | null;
  drafts: ReplayDraftEvidence[];
  /** Every batch the request guard rejected, including individual procedure names. */
  forbiddenBatches: string[][];
  /** Includes blocked origins, unreviewed endpoints, other pages and WebSockets. */
  forbiddenNetwork: string[];
  forbiddenBridgeActions: string[];
  /** Metadata only, not proof of source bytes or a successful HMS filing. */
  sourceAttachmentMetadata: { threadId: string; messageId: string; id: string; filename: string; mimeType: string; sizeBytes: number } | null;
  screenshotPaths: string[];
};

function pngFile(path: string): boolean {
  try {
    const size = statSync(path).size;
    if (!path || !statSync(path).isFile() || size < 57 || size > 32 * 1024 * 1024) return false;
    const data = readFileSync(path);
    if (!data.subarray(0, 8).equals(Buffer.from('89504e470d0a1a0a', 'hex'))) return false;
    let offset = 8, first = true, hasImageData = false;
    while (offset + 12 <= data.length) {
      const length = data.readUInt32BE(offset);
      const end = offset + 12 + length;
      if (end > data.length) return false;
      const type = data.toString('ascii', offset + 4, offset + 8);
      if (first) {
        if (type !== 'IHDR' || length !== 13 || !data.readUInt32BE(offset + 8) || !data.readUInt32BE(offset + 12)) return false;
        first = false;
      } else if (type === 'IHDR') return false;
      if (type === 'IDAT' && length > 0) hasImageData = true;
      if (type === 'IEND') return length === 0 && hasImageData && end === data.length;
      offset = end;
    }
    return false;
  } catch { return false; }
}

/** Missing synchronization or evidence is a failure, never an implied success. */
export function replayGateFailures(expected: ReplayExpectation, observed: ReplayObservation): string[] {
  const failures: string[] = [];
  if (!expected.threadId || !expected.messageId || observed.threadId !== expected.threadId ||
    observed.messageId !== expected.messageId) failures.push('selected_message_mismatch');
  if (!observed.synchronized) failures.push('fixture_unsynced');
  if (observed.outcome !== 'intent') failures.push('pane_not_ready');
  if (!expected.readAs || observed.readAs !== expected.readAs) failures.push('wrong_outcome');
  if (!Array.isArray(observed.forbiddenBatches) || observed.forbiddenBatches.length) failures.push('forbidden_batch');
  if (!Array.isArray(observed.forbiddenNetwork) || observed.forbiddenNetwork.length) failures.push('forbidden_network');
  if (!Array.isArray(observed.forbiddenBridgeActions) || observed.forbiddenBridgeActions.length) failures.push('forbidden_bridge_action');
  const source = observed.sourceAttachmentMetadata;
  if (expected.requireSourceAttachment && (!source || source.messageId !== expected.messageId ||
    source.threadId !== expected.threadId || !source.id || !source.filename || !source.mimeType ||
    !Number.isSafeInteger(source.sizeBytes) || source.sizeBytes <= 0)) failures.push('missing_source_attachment_metadata');
  const drafts = observed.drafts.filter((draft) => draft.messageId === expected.messageId &&
    Boolean(draft.location?.entryId && draft.location?.storeId && draft.location?.folderEntryId));
  if ((expected.requireDraft || expected.requireAttachment) && !drafts.length) failures.push('missing_draft');
  if (expected.requireAttachment && !drafts.some((draft) => draft.attachments.some((attachment) =>
    Boolean(attachment.fileName && attachment.base64Data &&
      /^[A-Za-z0-9+/]+={0,2}$/.test(attachment.base64Data) &&
      Buffer.from(attachment.base64Data, 'base64').length > 0)))) failures.push('missing_attachment');
  if (observed.screenshotPaths.length < 2 || new Set(observed.screenshotPaths).size < 2 ||
    observed.screenshotPaths.some((path) => !pngFile(path)))
    failures.push('missing_screenshot');
  return failures;
}

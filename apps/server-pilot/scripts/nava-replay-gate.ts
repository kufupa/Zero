/** Fail-closed checks for one replay fixture. Observations must come from the actual pane. */
import { closeSync, openSync, readSync, statSync } from 'node:fs';

export type ReplayExpectation = {
  threadId: string;
  messageId: string;
  readAs: string;
  requireDraft: boolean;
  requireAttachment: boolean;
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
  screenshotPaths: string[];
};

function pngFile(path: string): boolean {
  let fd: number | undefined;
  try {
    if (!path || !statSync(path).isFile() || statSync(path).size <= 8) return false;
    fd = openSync(path, 'r');
    const signature = Buffer.alloc(8);
    return readSync(fd, signature, 0, 8, 0) === 8 && signature.equals(Buffer.from('89504e470d0a1a0a', 'hex'));
  } catch { return false; }
  finally { if (fd !== undefined) closeSync(fd); }
}

/** Missing synchronization or evidence is a failure, never an implied success. */
export function replayGateFailures(expected: ReplayExpectation, observed: ReplayObservation): string[] {
  const failures: string[] = [];
  if (!expected.threadId || !expected.messageId || observed.threadId !== expected.threadId ||
    observed.messageId !== expected.messageId) failures.push('selected_message_mismatch');
  if (!observed.synchronized) failures.push('fixture_unsynced');
  if (observed.outcome !== 'intent') failures.push('pane_not_ready');
  if (!expected.readAs || observed.readAs !== expected.readAs) failures.push('wrong_outcome');
  if (observed.forbiddenBatches.length) failures.push('forbidden_batch');
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

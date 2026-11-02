import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { replayGateFailures, type ReplayExpectation, type ReplayObservation } from '../scripts/nava-replay-gate';

let dir: string;
let expected: ReplayExpectation;
let observed: ReplayObservation;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'nava-replay-gate-'));
  const pane = join(dir, 'pane.png');
  const page = join(dir, 'page.png');
  const png = Buffer.from('89504e470d0a1a0a00', 'hex');
  writeFileSync(pane, png);
  writeFileSync(page, png);
  expected = { threadId: 'thread-a', messageId: 'message-a', readAs: 'quote', requireDraft: true, requireAttachment: true };
  observed = {
    threadId: 'thread-a', messageId: 'message-a', synchronized: true, outcome: 'intent', readAs: 'quote',
    drafts: [{ messageId: 'message-a', location: { entryId: 'draft', storeId: 'store', folderEntryId: 'drafts' },
      attachments: [{ fileName: 'quote.pdf', base64Data: 'UERG' }] }],
    forbiddenBatches: [], screenshotPaths: [pane, page],
  };
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe('replay evidence gate', () => {
  it('accepts a matching synchronized pane with required artifacts', () => {
    expect(replayGateFailures(expected, observed)).toEqual([]);
  });
  it('fails an unsynchronized or different selected message and wrong outcome', () => {
    observed.messageId = 'message-b'; observed.synchronized = false; observed.readAs = 'new_booking';
    expect(replayGateFailures(expected, observed)).toEqual(expect.arrayContaining([
      'selected_message_mismatch', 'fixture_unsynced', 'wrong_outcome',
    ]));
  });
  it('fails a forbidden mixed batch and a pane timeout', () => {
    observed.forbiddenBatches = [['workstation.bridgeTicket', 'quoteWorkflow.commitStay']]; observed.outcome = 'timeout';
    expect(replayGateFailures(expected, observed)).toEqual(expect.arrayContaining(['forbidden_batch', 'pane_not_ready']));
  });
  it('requires a draft bound to the selected message and a nonempty attachment', () => {
    observed.drafts[0]!.messageId = 'message-b';
    expect(replayGateFailures(expected, observed)).toEqual(expect.arrayContaining(['missing_draft', 'missing_attachment']));
    observed.drafts[0]!.messageId = 'message-a'; observed.drafts[0]!.attachments[0]!.base64Data = '';
    expect(replayGateFailures(expected, observed)).toContain('missing_attachment');
  });
  it('requires actual nonempty screenshots', () => {
    writeFileSync(observed.screenshotPaths[0]!, '');
    expect(replayGateFailures(expected, observed)).toContain('missing_screenshot');
  });
});

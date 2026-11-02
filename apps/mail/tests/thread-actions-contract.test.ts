import { beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { listThreadSelection } from '../config/workflow-folders';
import {
  buildThreadFilingSnapshots,
  fileThreadsTo,
  isActionAvailable,
  moveThreadsTo,
} from '../lib/thread-actions';
import { trpcClient } from '../providers/query-provider';

vi.mock('../providers/query-provider', () => ({
  trpcClient: {
    mail: {
      moveThreads: { mutate: vi.fn() },
      modifyLabels: { mutate: vi.fn() },
      fileThreads: { mutate: vi.fn() },
    },
  },
}));

describe('thread action contract', () => {
  it('carries the next workflow row source after a reader move', () => {
    const rows = [{ id: 'next', workflowSourceMessageId: 'exact-next' }, { id: 'missing' }];
    expect(listThreadSelection('next', true, rows)).toEqual({ threadId: 'next', sourceMessageId: 'exact-next' });
    expect(listThreadSelection('missing', true, rows)).toEqual({ threadId: 'missing', sourceMessageId: '' });
    expect(listThreadSelection('next', false, rows)).toEqual({ threadId: 'next', sourceMessageId: null });
    const display = readFileSync(fileURLToPath(new URL('../components/mail/thread-display.tsx', import.meta.url)), 'utf8');
    expect(display).toContain('setThreadSelection(listThreadSelection(nextThread.id, workflowScoped, items))');
  });

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('uses moveThreads mutation for system folder moves', async () => {
    await moveThreadsTo({
      threadIds: ['thread-1'],
      currentFolder: 'inbox',
      destination: 'spam',
    });

    expect(trpcClient.mail.moveThreads.mutate).toHaveBeenCalledWith({
      threadIds: ['thread-1'],
      destination: 'spam',
    });
    expect(trpcClient.mail.modifyLabels.mutate).not.toHaveBeenCalled();
  });

  it('fileThreadsTo calls mail.fileThreads.mutate with threadIds + labelId', async () => {
    await fileThreadsTo({
      threadIds: ['thread-1', 'thread-2'],
      labelId: 'label-uuid',
    });

    expect(trpcClient.mail.fileThreads.mutate).toHaveBeenCalledWith({
      threadIds: ['thread-1', 'thread-2'],
      labelId: 'label-uuid',
    });
    expect(trpcClient.mail.moveThreads.mutate).not.toHaveBeenCalled();
    expect(trpcClient.mail.modifyLabels.mutate).not.toHaveBeenCalled();
  });

  it('buildThreadFilingSnapshots copies prior labelIds and folder flags', () => {
    expect(
      buildThreadFilingSnapshots(
        ['t1', 't2'],
        'spam',
        [
          { id: 't1', labelIds: ['IMPORTANT', 'old-user'] },
          { id: 't2', labelIds: [] },
        ],
      ),
    ).toEqual([
      {
        threadId: 't1',
        labelIds: ['IMPORTANT', 'old-user'],
        isArchived: false,
        isSpam: true,
        isTrashed: false,
      },
      {
        threadId: 't2',
        labelIds: [],
        isArchived: false,
        isSpam: true,
        isTrashed: false,
      },
    ]);
  });

  it('isActionAvailable treats Quarantine UUID like spam for inbox/bin', () => {
    const quarantineId = 'a1b2c3d4-e5f6-7890-abcd-ef1234567890';
    const reserved = new Set([quarantineId]);
    expect(isActionAvailable(quarantineId, 'inbox', reserved)).toBe(true);
    expect(isActionAvailable(quarantineId, 'bin', reserved)).toBe(true);
    expect(isActionAvailable(quarantineId, 'spam', reserved)).toBe(false);
    expect(isActionAvailable(quarantineId, 'archive', reserved)).toBe(false);
  });

  it('buildThreadFilingSnapshots marks Quarantine UUID as spam not archived', () => {
    const quarantineId = 'a1b2c3d4-e5f6-7890-abcd-ef1234567890';
    const reserved = new Set([quarantineId]);
    expect(
      buildThreadFilingSnapshots(['t1'], quarantineId, [{ id: 't1', labelIds: [quarantineId] }], reserved),
    ).toEqual([
      {
        threadId: 't1',
        labelIds: [quarantineId],
        isArchived: false,
        isSpam: true,
        isTrashed: false,
      },
    ]);
  });

  it('isActionAvailable treats My folders UUID like archive for inbox/bin', () => {
    const labelId = 'a1b2c3d4-e5f6-7890-abcd-ef1234567890';
    expect(isActionAvailable(labelId, 'inbox')).toBe(true);
    expect(isActionAvailable(labelId, 'bin')).toBe(true);
    expect(isActionAvailable(labelId, 'spam')).toBe(false);
    expect(isActionAvailable(labelId, 'archive')).toBe(false);
  });

  it('buildThreadFilingSnapshots marks My folders UUID as archived', () => {
    const labelId = 'a1b2c3d4-e5f6-7890-abcd-ef1234567890';
    expect(
      buildThreadFilingSnapshots(['t1'], labelId, [{ id: 't1', labelIds: [labelId] }]),
    ).toEqual([
      {
        threadId: 't1',
        labelIds: [labelId],
        isArchived: true,
        isSpam: false,
        isTrashed: false,
      },
    ]);
  });
});

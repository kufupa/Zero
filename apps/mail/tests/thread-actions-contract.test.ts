import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  buildThreadFilingSnapshots,
  fileThreadsTo,
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
});

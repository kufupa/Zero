import { describe, expect, it, vi } from 'vitest';
import { moveThreadsTo } from '../lib/thread-actions';
import { trpcClient } from '../providers/query-provider';

vi.mock('../providers/query-provider', () => ({
  trpcClient: {
    mail: {
      moveThreads: { mutate: vi.fn() },
      modifyLabels: { mutate: vi.fn() },
    },
  },
}));

describe('thread action contract', () => {
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
});

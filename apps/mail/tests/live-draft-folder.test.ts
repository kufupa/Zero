import { describe, expect, it } from 'vitest';
import { selectLiveThreadListQuery } from '../lib/mail/thread-list-query-policy';

describe('live draft folder query policy', () => {
  it('uses drafts.list for live Drafts folder', () => {
    expect(selectLiveThreadListQuery({ folder: 'draft', demoMode: false, listEnabled: true })).toEqual({
      useDraftsList: true,
      useMailListThreads: false,
    });
    expect(selectLiveThreadListQuery({ folder: 'inbox', demoMode: false, listEnabled: true })).toEqual({
      useDraftsList: false,
      useMailListThreads: true,
    });
    expect(selectLiveThreadListQuery({ folder: 'draft', demoMode: true, listEnabled: true })).toEqual({
      useDraftsList: false,
      useMailListThreads: false,
    });
  });
});

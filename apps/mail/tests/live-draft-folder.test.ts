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

  it('uses resolved all-folder policy for live mail list', () => {
    expect(
      selectLiveThreadListQuery({
        folder: 'all',
        demoMode: false,
        listEnabled: true,
        useDraftsList: false,
      }),
    ).toEqual({ useDraftsList: false, useMailListThreads: true });
  });

  it('honors resolved non-draft policy over draft route', () => {
    expect(
      selectLiveThreadListQuery({
        folder: 'draft',
        demoMode: false,
        listEnabled: true,
        useDraftsList: false,
      }),
    ).toEqual({ useDraftsList: false, useMailListThreads: true });
  });

  it('keeps resolved draft policy behind live list guards', () => {
    expect(
      selectLiveThreadListQuery({
        folder: 'draft',
        demoMode: true,
        listEnabled: true,
        useDraftsList: true,
      }),
    ).toEqual({ useDraftsList: false, useMailListThreads: false });
    expect(
      selectLiveThreadListQuery({
        folder: 'draft',
        demoMode: false,
        listEnabled: false,
        useDraftsList: true,
      }),
    ).toEqual({ useDraftsList: false, useMailListThreads: false });
  });
});

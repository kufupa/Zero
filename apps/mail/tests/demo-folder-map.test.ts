import { describe, expect, it } from 'vitest';
import {
  DEMO_FOLDER_DEFINITIONS,
  isDemoQueueFolder,
  resolveDemoFolderQueryContext,
} from '../lib/demo/folder-map';

describe('demo folder map', () => {
  it('defines the requested folder model', () => {
    expect(DEMO_FOLDER_DEFINITIONS.map((folder) => folder.id)).toEqual([
      'internal',
      'individual',
      'group',
      'spam',
      'urgent',
    ]);
  });

  it('maps folder identities to queue context', () => {
    expect(resolveDemoFolderQueryContext('internal')).toEqual({
      folder: 'inbox',
      workQueue: 'hr',
    });
    expect(resolveDemoFolderQueryContext('individual')).toEqual({
      folder: 'inbox',
      workQueue: 'individual',
    });
    expect(resolveDemoFolderQueryContext('group')).toEqual({
      folder: 'inbox',
      workQueue: 'group',
    });
    expect(resolveDemoFolderQueryContext('spam')).toEqual({
      folder: 'spam',
      workQueue: null,
    });
    expect(resolveDemoFolderQueryContext('urgent')).toEqual({
      folder: 'inbox',
      workQueue: 'urgent',
    });
  });

  it('keeps urgent and aliases valid demo folders', () => {
    expect(isDemoQueueFolder('urgent')).toBe(true);
    expect(isDemoQueueFolder('hr')).toBe(true);
    expect(isDemoQueueFolder('group')).toBe(true);
    expect(isDemoQueueFolder('individual')).toBe(true);
    expect(isDemoQueueFolder('group-bookings')).toBe(true);
    expect(isDemoQueueFolder('individual-room-bookings')).toBe(true);
  });

  it('preserves regular folder behavior for non-mapped folders', () => {
    expect(resolveDemoFolderQueryContext('inbox')).toEqual({
      folder: 'inbox',
      workQueue: null,
    });
    expect(resolveDemoFolderQueryContext('archive')).toEqual({
      folder: 'archive',
      workQueue: null,
    });
  });
});

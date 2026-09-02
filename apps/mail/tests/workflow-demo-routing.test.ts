import {
  WORKFLOW_MAIL_FOLDER_DEFINITIONS,
  normalizeDemoMailFolderSlug,
} from '../lib/demo/folder-map';
import { listDemoThreads } from '../lib/demo-data/adapter';
import { describe, expect, it } from 'vitest';

describe('frontend-only workflow demo routing', () => {
  it('keeps the legacy bookings alias when workflow navigation is off', () => {
    expect(normalizeDemoMailFolderSlug('bookings', false)).toBe('new-bookings');
    expect(normalizeDemoMailFolderSlug('new-bookings', true)).toBe('new-bookings');
  });

  it('treats bookings as the workflow route when workflow navigation is on', () => {
    expect(normalizeDemoMailFolderSlug('bookings', true)).toBe('bookings');
  });

  it('has demo rows for every workflow primary route', () => {
    const workflowFolders = WORKFLOW_MAIL_FOLDER_DEFINITIONS.filter(
      (folder) => folder.id !== 'urgent',
    );

    for (const folder of workflowFolders) {
      expect(
        listDemoThreads({ folder: folder.id, maxResults: 100 }).threads,
        folder.id,
      ).not.toHaveLength(0);
    }
  });

  it('preserves /mail/bookings legacy and workflow list semantics by route mode', () => {
    const legacyBookings = listDemoThreads({
      folder: normalizeDemoMailFolderSlug('bookings', false),
      maxResults: 100,
    });
    const explicitLegacy = listDemoThreads({ folder: 'new-bookings', maxResults: 100 });
    const workflowBookings = listDemoThreads({
      folder: normalizeDemoMailFolderSlug('bookings', true),
      maxResults: 100,
    });

    expect(legacyBookings.threads.map((thread) => thread.id)).toEqual(
      explicitLegacy.threads.map((thread) => thread.id),
    );
    expect(workflowBookings.threads.length).toBeGreaterThan(0);
  });
});

import { describe, expect, it } from 'vitest';
import {
  DEMO_MAIL_FOLDER_DEFINITIONS,
  isDemoMailFolderSlug,
  normalizeDemoMailFolderSlug,
  shouldShowCenturionCategoryPill,
} from '../lib/demo/folder-map';

describe('demo mail folder map', () => {
  it('defines demo folder ids in sidebar order', () => {
    expect(DEMO_MAIL_FOLDER_DEFINITIONS.map((f) => f.id)).toEqual([
      'at-risk',
      'new-bookings',
      'groups-events',
      'ops',
      'urgent',
      'spam',
    ]);
  });

  it('normalizes alias slugs to canonical ids', () => {
    expect(normalizeDemoMailFolderSlug('at_risk')).toBe('at-risk');
    expect(normalizeDemoMailFolderSlug('groups')).toBe('groups-events');
    expect(normalizeDemoMailFolderSlug('operations')).toBe('ops');
    expect(normalizeDemoMailFolderSlug('inbox')).toBe('inbox');
  });

  it('detects demo mail folder slugs and aliases', () => {
    expect(isDemoMailFolderSlug('urgent')).toBe(true);
    expect(isDemoMailFolderSlug('at_risk')).toBe(true);
    expect(isDemoMailFolderSlug('groups-events')).toBe(true);
    expect(isDemoMailFolderSlug('groups')).toBe(true);
    expect(isDemoMailFolderSlug('inbox')).toBe(false);
    expect(isDemoMailFolderSlug('archive')).toBe(false);
  });

  it('shouldShowCenturionCategoryPill hides on matching category route', () => {
    expect(
      shouldShowCenturionCategoryPill({ routeFolder: 'at-risk', category: 'at-risk' }),
    ).toBe(false);
    expect(
      shouldShowCenturionCategoryPill({ routeFolder: 'inbox', category: 'at-risk' }),
    ).toBe(true);
    expect(
      shouldShowCenturionCategoryPill({ routeFolder: 'urgent', category: 'groups-events' }),
    ).toBe(true);
    expect(shouldShowCenturionCategoryPill({ routeFolder: 'inbox', category: undefined })).toBe(
      false,
    );
  });
});

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
      'internal',
      'individual',
      'group',
      'travel-agents',
      'urgent',
      'spam',
    ]);
  });

  it('normalizes alias slugs to canonical ids', () => {
    expect(normalizeDemoMailFolderSlug('hr')).toBe('internal');
    expect(normalizeDemoMailFolderSlug('internal-mail')).toBe('internal');
    expect(normalizeDemoMailFolderSlug('travel-agent')).toBe('travel-agents');
    expect(normalizeDemoMailFolderSlug('inbox')).toBe('inbox');
  });

  it('detects demo mail folder slugs and aliases', () => {
    expect(isDemoMailFolderSlug('urgent')).toBe(true);
    expect(isDemoMailFolderSlug('hr')).toBe(true);
    expect(isDemoMailFolderSlug('travel-agents')).toBe(true);
    expect(isDemoMailFolderSlug('travel-agent')).toBe(true);
    expect(isDemoMailFolderSlug('inbox')).toBe(false);
    expect(isDemoMailFolderSlug('archive')).toBe(false);
  });

  it('shouldShowCenturionCategoryPill hides on matching category route', () => {
    expect(
      shouldShowCenturionCategoryPill({ routeFolder: 'internal', category: 'internal' }),
    ).toBe(false);
    expect(
      shouldShowCenturionCategoryPill({ routeFolder: 'inbox', category: 'internal' }),
    ).toBe(true);
    expect(
      shouldShowCenturionCategoryPill({ routeFolder: 'urgent', category: 'group' }),
    ).toBe(true);
    expect(shouldShowCenturionCategoryPill({ routeFolder: 'inbox', category: undefined })).toBe(
      false,
    );
  });
});

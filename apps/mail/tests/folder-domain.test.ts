import { describe, expect, it } from 'vitest';
import {
  STANDARD_MAIL_FOLDER_SLUGS,
  isStandardMailFolderSlug,
} from '../lib/domain/folders';
import {
  getDemoMailFolderSidebarChrome,
  listDemoMailSidebarNavDescriptors,
} from '../lib/demo/folder-map';

describe('folder domain', () => {
  it('lists every standard slug as standard', () => {
    for (const slug of STANDARD_MAIL_FOLDER_SLUGS) {
      expect(isStandardMailFolderSlug(slug)).toBe(true);
      expect(isStandardMailFolderSlug(slug.toUpperCase())).toBe(true);
    }
  });

  it('rejects demo-only and arbitrary slugs for standard check', () => {
    expect(isStandardMailFolderSlug('internal')).toBe(false);
    expect(isStandardMailFolderSlug('inbox-copy')).toBe(false);
    expect(isStandardMailFolderSlug('')).toBe(false);
  });

  it('exposes demo sidebar rows without spam and puts urgent first', () => {
    const rows = listDemoMailSidebarNavDescriptors();
    expect(rows.some((r) => r.id === 'spam')).toBe(false);
    expect(rows[0]?.id).toBe('urgent');
    expect(rows.find((r) => r.id === 'internal')?.pathSegment).toBe('internal');
  });

  it('returns chrome only for Centurion category folders', () => {
    expect(getDemoMailFolderSidebarChrome('internal').style?.['--centurion-sidebar-bg']).toBeDefined();
    expect(getDemoMailFolderSidebarChrome('urgent')).toEqual({});
    expect(getDemoMailFolderSidebarChrome('spam')).toEqual({});
  });
});

import { describe, expect, it } from 'vitest';
import {
  MY_FOLDERS_SIDEBAR_TITLE,
  shouldNavigateMyFolderRoute,
  shouldShowMyFoldersCreate,
} from '@/lib/mail/my-folders-nav';

describe('My folders sidebar chrome', () => {
  it('uses My folders title (not Labels)', () => {
    expect(MY_FOLDERS_SIDEBAR_TITLE).toBe('My folders');
    expect(MY_FOLDERS_SIDEBAR_TITLE).not.toBe('Labels');
  });

  it('shows create + for mailbox and google providers', () => {
    expect(shouldShowMyFoldersCreate('mailbox')).toBe(true);
    expect(shouldShowMyFoldersCreate('google')).toBe(true);
  });

  it('hides create + for other providers', () => {
    expect(shouldShowMyFoldersCreate('microsoft')).toBe(false);
    expect(shouldShowMyFoldersCreate('demo')).toBe(false);
    expect(shouldShowMyFoldersCreate(undefined)).toBe(false);
    expect(shouldShowMyFoldersCreate(null)).toBe(false);
  });

  it('navigates My folders route for mailbox, microsoft, and google', () => {
    expect(shouldNavigateMyFolderRoute('mailbox')).toBe(true);
    expect(shouldNavigateMyFolderRoute('microsoft')).toBe(true);
    expect(shouldNavigateMyFolderRoute('google')).toBe(true);
    expect(shouldNavigateMyFolderRoute('demo')).toBe(false);
  });
});

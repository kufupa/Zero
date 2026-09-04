import { describe, expect, it } from 'vitest';
import {
  toSidebarUnreadCountSnapshot,
  getNavUnreadCount,
  getLabelUnreadCount,
} from '../lib/mail/sidebar-unread-counts';
import type { Outputs } from '@zero/server/trpc';
import * as fs from 'node:fs';
import * as path from 'node:path';

type PilotUnreadCounts = Outputs['mail']['unreadCounts'];

describe('mail sidebar unread contracts', () => {
  const samplePilotCounts: PilotUnreadCounts = {
    folders: [
      { id: 'inbox', unreadCount: 15 },
      { id: 'sent', unreadCount: 0 },
      { id: 'archive', unreadCount: 8 },
      { id: 'snoozed', unreadCount: 3 },
      { id: 'bin', unreadCount: 4 },
      { id: 'spam', unreadCount: 2 },
    ],
    categories: [
      { categoryId: 'cat-vip-id', unreadCount: 5 },
      { categoryId: 'cat-empty-id', unreadCount: 0 },
    ],
    labels: [
      { labelId: 'lbl-work-id', unreadCount: 7 },
      { labelId: 'lbl-empty-id', unreadCount: 0 },
      { labelId: 'lbl-quarantine-id', unreadCount: 2 },
    ],
  };

  it('maps system IDs: inbox, sent, archive, snoozed, spam and trash->bin', () => {
    const snapshot = toSidebarUnreadCountSnapshot(
      samplePilotCounts,
      [],
      'mailbox',
      'transport-1',
    );

    expect(getNavUnreadCount(snapshot, 'inbox')).toBe(15);
    expect(getNavUnreadCount(snapshot, 'sent')).toBe(0);
    expect(getNavUnreadCount(snapshot, 'archive')).toBe(8);
    expect(getNavUnreadCount(snapshot, 'snoozed')).toBe(3);
    expect(getNavUnreadCount(snapshot, 'trash')).toBe(4); // mapped to bin!
    expect(getNavUnreadCount(snapshot, 'bin')).toBe(4);
    expect(getNavUnreadCount(snapshot, 'spam')).toBe(2);
  });

  it('omits badges for drafts and pilot synthetic group IDs', () => {
    const snapshot = toSidebarUnreadCountSnapshot(
      samplePilotCounts,
      [],
      'mailbox',
      'transport-1',
    );

    expect(getNavUnreadCount(snapshot, 'drafts')).toBeUndefined();
    expect(getNavUnreadCount(snapshot, 'draft')).toBeUndefined();
    expect(getLabelUnreadCount(snapshot, 'group-projects')).toBeUndefined();
    expect(getLabelUnreadCount(snapshot, 'group-other')).toBeUndefined();
  });

  it('maps live category slug to opaque category ID', () => {
    const snapshot = toSidebarUnreadCountSnapshot(
      samplePilotCounts,
      [],
      'mailbox',
      'transport-1',
    );

    // slug 'vip' maps to 'cat-vip-id'
    expect(getNavUnreadCount(snapshot, 'vip', 'cat-vip-id')).toBe(5);
    // slug 'empty' maps to 'cat-empty-id' (count 0)
    expect(getNavUnreadCount(snapshot, 'empty', 'cat-empty-id')).toBe(0);
    // unmapped slug
    expect(getNavUnreadCount(snapshot, 'unmapped', undefined)).toBeUndefined();
  });

  it('resolves pilot user-label counts by opaque ID', () => {
    const snapshot = toSidebarUnreadCountSnapshot(
      samplePilotCounts,
      [],
      'mailbox',
      'transport-1',
    );

    expect(getLabelUnreadCount(snapshot, 'lbl-work-id', 'Work')).toBe(7);
    expect(getLabelUnreadCount(snapshot, 'lbl-empty-id', 'Empty')).toBe(0);
    expect(getLabelUnreadCount(snapshot, 'lbl-quarantine-id', 'Quarantine')).toBe(2);
  });

  it('falls back to legacy stats when provider is not mailbox, regardless of stats ordering', () => {
    const legacyStats1 = [
      { label: 'inbox', count: 10 },
      { label: 'sent', count: 5 },
      { label: 'Receipts', count: 3 },
    ];
    const legacyStats2 = [
      { label: 'Receipts', count: 3 },
      { label: 'sent', count: 5 },
      { label: 'inbox', count: 10 },
    ];

    const snap1 = toSidebarUnreadCountSnapshot(undefined, legacyStats1, 'google', null);
    const snap2 = toSidebarUnreadCountSnapshot(undefined, legacyStats2, 'google', null);

    expect(getNavUnreadCount(snap1, 'inbox')).toBe(10);
    expect(getNavUnreadCount(snap2, 'inbox')).toBe(10);
    expect(getNavUnreadCount(snap1, 'sent')).toBe(5);
    expect(getNavUnreadCount(snap2, 'sent')).toBe(5);
    expect(getLabelUnreadCount(snap1, 'lbl-random', 'receipts')).toBe(3);
    expect(getLabelUnreadCount(snap2, 'lbl-random', 'receipts')).toBe(3);
  });

  it('preserves My folders default-open and section-disclosures source contracts', () => {
    const navMainContent = fs.readFileSync(
      path.resolve(__dirname, '../components/ui/nav-main.tsx'),
      'utf-8',
    );
    // My folders collapsible defaultOpen={true}
    expect(navMainContent).toContain('defaultOpen={true}');
    expect(navMainContent).toContain('MY_FOLDERS_SIDEBAR_TITLE');

    const appSidebarContent = fs.readFileSync(
      path.resolve(__dirname, '../components/ui/app-sidebar.tsx'),
      'utf-8',
    );
    // AppSidebar renders NavMain and passes unreadCountsSnapshot
    expect(appSidebarContent).toContain('useUnreadCounts');
    expect(appSidebarContent).toContain('<NavMain items={navItems}');
    expect(appSidebarContent).toContain('<NavMain items={footerItems}');
  });
});

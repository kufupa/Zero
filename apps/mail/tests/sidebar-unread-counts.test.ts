import { describe, expect, it } from 'vitest';
import {
  toSidebarUnreadCountSnapshot,
  getNavUnreadCount,
  getLabelUnreadCount,
} from '../lib/mail/sidebar-unread-counts';
import { resolveThreadPollingMs } from '../lib/mail/thread-polling-policy';
import type { Outputs } from '@zero/server/trpc';

type PilotUnreadCounts = Outputs['mail']['unreadCounts'];

describe('sidebar-unread-counts pure mapping', () => {
  const samplePilotPayload: PilotUnreadCounts = {
    folders: [
      { id: 'inbox', unreadCount: 5, totalCount: 124 },
      { id: 'sent', unreadCount: 0, totalCount: 50 },
      { id: 'archive', unreadCount: 2, totalCount: 80 },
      { id: 'snoozed', unreadCount: 1, totalCount: 10 },
      { id: 'bin', unreadCount: 3, totalCount: 15 },
      { id: 'spam', unreadCount: 4, totalCount: 20 },
    ],
    categories: [
      { categoryId: 'cat-urgent-123', unreadCount: 3, totalCount: 10 },
      { categoryId: 'cat-travel-456', unreadCount: 0, totalCount: 5 },
    ],
    labels: [
      { labelId: 'lbl-work-789', unreadCount: 2, totalCount: 25 },
      { labelId: 'lbl-quarantine-999', unreadCount: 4, totalCount: 4 },
      { labelId: 'lbl-empty-000', unreadCount: 0, totalCount: 0 },
    ],
    draftsCount: 2,
  };

  it('converts pilot payload to snapshot with stable opaque ID keys and scopeKey', () => {
    const snapshot = toSidebarUnreadCountSnapshot(
      samplePilotPayload,
      [],
      'mailbox',
      'transport-1',
    );

    expect(snapshot.source).toBe('pilot');
    expect(snapshot.scopeKey).toBe('transport-1');
    expect(snapshot.hasData).toBe(true);
    expect(snapshot.draftsCount).toBe(2);
    expect(snapshot.folders.inbox).toBe(5);
    expect(snapshot.folderTotals.inbox).toBe(124);
    expect(snapshot.folders.sent).toBe(0);
    expect(snapshot.folderTotals.sent).toBe(50);
    expect(snapshot.folders.bin).toBe(3);
    expect(snapshot.categories['cat-urgent-123']).toBe(3);
    expect(snapshot.categoryTotals['cat-urgent-123']).toBe(10);
    expect(snapshot.categories['cat-travel-456']).toBe(0);
    expect(snapshot.labels['lbl-work-789']).toBe(2);
    expect(snapshot.labelTotals['lbl-work-789']).toBe(25);
    expect(snapshot.labels['lbl-empty-000']).toBe(0);
  });

  it('resolves system nav items: maps trash -> bin, returns active drafts count, returns zero for known empty', () => {
    const snapshot = toSidebarUnreadCountSnapshot(
      samplePilotPayload,
      [],
      'mailbox',
      'transport-1',
    );

    expect(getNavUnreadCount(snapshot, 'inbox')).toBe(5);
    expect(getNavUnreadCount(snapshot, 'sent')).toBe(0);
    expect(getNavUnreadCount(snapshot, 'trash')).toBe(3); // mapped to bin
    expect(getNavUnreadCount(snapshot, 'bin')).toBe(3);
    expect(getNavUnreadCount(snapshot, 'spam')).toBe(4);
    expect(getNavUnreadCount(snapshot, 'archive')).toBe(2);
    expect(getNavUnreadCount(snapshot, 'snoozed')).toBe(1);

    // Drafts returns active drafts count
    expect(getNavUnreadCount(snapshot, 'drafts')).toBe(2);
    expect(getNavUnreadCount(snapshot, 'draft')).toBe(2);
    expect(snapshot.getCount('drafts')).toBe(2);

    // Unknown nav item
    expect(getNavUnreadCount(snapshot, 'unknown-item')).toBeUndefined();
  });

  it('resolves totals and rich hover tooltips correctly', () => {
    const snapshot = toSidebarUnreadCountSnapshot(
      {
        ...samplePilotPayload,
        folders: [
          { id: 'inbox', unreadCount: 3, totalCount: 124 },
          { id: 'sent', unreadCount: 0, totalCount: 124 },
          { id: 'archive', unreadCount: 0, totalCount: 1 },
          { id: 'snoozed', unreadCount: 1, totalCount: 1 },
          { id: 'bin', unreadCount: 0, totalCount: 0 },
          { id: 'spam', unreadCount: 0, totalCount: 0 },
        ],
        draftsCount: 2,
      },
      [],
      'mailbox',
      'transport-1',
    );

    // 1. snapshot.getCount('drafts') returns draftsCount when > 0
    expect(snapshot.getCount('drafts')).toBe(2);

    // 2. snapshot.getTotal('inbox') returns total threads
    expect(snapshot.getTotal('inbox')).toBe(124);

    // 3. snapshot.getTooltip('inbox', 'Inbox') returns "3 unread of 124 threads" when unread > 0
    expect(snapshot.getTooltip('inbox', 'Inbox')).toBe('3 unread of 124 threads');

    // 4. snapshot.getTooltip('inbox', 'Inbox') returns "124 threads (all read)" when unread = 0
    expect(snapshot.getTooltip('sent', 'Sent')).toBe('124 threads (all read)');

    // 5. snapshot.getTooltip('drafts', 'Drafts') returns "2 active drafts"
    expect(snapshot.getTooltip('drafts', 'Drafts')).toBe('2 active drafts');

    // Singular thread cases
    expect(snapshot.getTooltip('archive', 'Archive')).toBe('1 thread (all read)');
    expect(snapshot.getTooltip('snoozed', 'Snoozed')).toBe('1 unread of 1 thread');

    // Zero threads
    expect(snapshot.getTooltip('bin', 'Bin')).toBe('0 threads (all read)');
  });

  it('resolves live category items via categoryIdForSlug mapping and preserves opaque ID', () => {
    const snapshot = toSidebarUnreadCountSnapshot(
      samplePilotPayload,
      [],
      'mailbox',
      'transport-1',
    );

    // item.id is slug 'urgent', mapped via categoryIdForSlug 'cat-urgent-123'
    expect(getNavUnreadCount(snapshot, 'urgent', 'cat-urgent-123')).toBe(3);
    // category with zero count
    expect(getNavUnreadCount(snapshot, 'travel', 'cat-travel-456')).toBe(0);
    // unmapped category slug
    expect(getNavUnreadCount(snapshot, 'vip', undefined)).toBeUndefined();
  });

  it('resolves user label items by ID, hides synthetic parent groups, handles renamed labels', () => {
    const snapshot = toSidebarUnreadCountSnapshot(
      samplePilotPayload,
      [],
      'mailbox',
      'transport-1',
    );

    expect(getLabelUnreadCount(snapshot, 'lbl-work-789', 'Work')).toBe(2);
    // Renamed label: name is now "Renamed Work" but labelId is still 'lbl-work-789'
    expect(getLabelUnreadCount(snapshot, 'lbl-work-789', 'Renamed Work')).toBe(2);
    // Known empty label returns 0
    expect(getLabelUnreadCount(snapshot, 'lbl-empty-000', 'Empty')).toBe(0);

    // Synthetic parent slash groups return undefined (no aggregate)
    expect(getLabelUnreadCount(snapshot, 'group-projects', 'projects')).toBeUndefined();
    expect(getLabelUnreadCount(snapshot, 'group-other', 'other')).toBeUndefined();
  });

  it('falls back to legacy stats for non-pilot or demo providers case-insensitively', () => {
    const legacyStats = [
      { label: 'INBOX', count: 12 },
      { label: 'sent', count: 7 },
      { label: 'Receipts', count: 4 },
      { label: 'Trash', count: 1 },
    ];

    const snapshot = toSidebarUnreadCountSnapshot(
      undefined,
      legacyStats,
      'google',
      null,
    );

    expect(snapshot.source).toBe('legacy');
    expect(snapshot.scopeKey).toBeNull();
    expect(getNavUnreadCount(snapshot, 'inbox')).toBe(12);
    expect(getNavUnreadCount(snapshot, 'sent')).toBe(7);
    expect(getNavUnreadCount(snapshot, 'trash')).toBe(1);
    expect(getLabelUnreadCount(snapshot, 'lbl-custom', 'receipts')).toBe(4);
    expect(getLabelUnreadCount(snapshot, 'lbl-custom', 'Unknown')).toBeUndefined();
  });

  it('returns undefined when snapshot is empty or source is none', () => {
    const emptySnapshot = toSidebarUnreadCountSnapshot(undefined, [], undefined, null);

    expect(emptySnapshot.hasData).toBe(false);
    expect(getNavUnreadCount(emptySnapshot, 'inbox')).toBeUndefined();
    expect(getLabelUnreadCount(emptySnapshot, 'lbl-1', 'Test')).toBeUndefined();
    expect(emptySnapshot.getCount('inbox')).toBeUndefined();
    expect(emptySnapshot.getTotal('inbox')).toBeUndefined();
    expect(getNavUnreadCount(undefined, 'inbox')).toBeUndefined();
    expect(getLabelUnreadCount(undefined, 'lbl-1', 'Test')).toBeUndefined();
  });
});

describe('useUnreadCounts polling and scope policy', () => {
  it('respects resolveThreadPollingMs contract', () => {
    expect(resolveThreadPollingMs(undefined)).toBe(15000);
    expect(resolveThreadPollingMs('20000')).toBe(20000);
    expect(resolveThreadPollingMs('5000')).toBeNull(); // under 15s -> null / refetchInterval: false
    expect(resolveThreadPollingMs('invalid')).toBeNull();
  });
});

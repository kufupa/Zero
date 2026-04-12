import { describe, expect, it } from 'vitest';
import { getDemoThread, listDemoThreads, threadMatchesDemoListFolder } from '../lib/demo-data/adapter';
import type { DemoThread } from '../lib/demo-data/schema';

const REMOVED_DEMO_LABELS = new Set(['comment', 'to respond', 'promotion', 'billing', 'notification']);

function minimalThread(id: string, folder: DemoThread['folder'], urgent = false): DemoThread {
  return {
    id,
    folder,
    urgent,
    labels: [],
    messages: [
      {
        id: `${id}-m`,
        sender: { email: 'a@b.co' },
        to: [{ email: 'c@d.co' }],
        subject: 's',
        body: 'b',
        receivedOn: '2026-01-01T00:00:00.000Z',
        unread: false,
      },
    ],
  };
}

describe('demo adapter', () => {
  it('returns at least one inbox thread', () => {
    const result = listDemoThreads({
      folder: 'inbox',
      q: '',
      cursor: '',
      maxResults: 50,
      labelIds: [],
    });

    expect(result.threads.length).toBeGreaterThan(0);
  });

  it('inbox excludes spam folder threads', () => {
    const inbox = listDemoThreads({ folder: 'inbox', maxResults: 100 });
    const spam = listDemoThreads({ folder: 'spam', maxResults: 100 });
    const inboxIds = new Set(inbox.threads.map((t) => t.id));
    for (const s of spam.threads) {
      expect(inboxIds.has(s.id)).toBe(false);
    }
    expect(spam.threads.length).toBeGreaterThan(0);
  });

  it('internal folder is subset of inbox', () => {
    const inbox = listDemoThreads({ folder: 'inbox', maxResults: 100 });
    const internal = listDemoThreads({ folder: 'internal', maxResults: 100 });
    const inboxIds = new Set(inbox.threads.map((t) => t.id));
    for (const t of internal.threads) {
      expect(inboxIds.has(t.id)).toBe(true);
    }
    expect(internal.threads.length).toBeGreaterThan(0);
  });

  it('urgent folder lists urgent threads across categories', () => {
    const urgent = listDemoThreads({ folder: 'urgent', maxResults: 100 });
    expect(urgent.threads.length).toBeGreaterThan(0);
    for (const ref of urgent.threads) {
      const thread = getDemoThread(ref.id);
      expect(thread.messages.length).toBeGreaterThan(0);
    }
  });

  it('fetches full thread payload for first id', () => {
    const list = listDemoThreads({
      folder: 'inbox',
      q: '',
      cursor: '',
      maxResults: 50,
      labelIds: [],
    });
    const thread = getDemoThread(list.threads[0]!.id);

    expect(thread.messages.length).toBeGreaterThan(0);
    expect(thread.latest?.id).toBeTruthy();
    expect(Array.isArray(thread.labels)).toBe(true);
    expect(thread.centurionCategory).toBeDefined();
  });

  it('list rows carry centurionCategory for non-spam threads', () => {
    const inbox = listDemoThreads({ folder: 'inbox', maxResults: 100 });
    for (const row of inbox.threads) {
      expect(row.centurionCategory).toBeDefined();
      expect(['internal', 'individual', 'group', 'travel-agents']).toContain(row.centurionCategory);
    }
    const spam = listDemoThreads({ folder: 'spam', maxResults: 100 });
    for (const row of spam.threads) {
      expect(row.centurionCategory).toBeUndefined();
    }
  });

  it('threadMatchesDemoListFolder encodes view rules', () => {
    const t = minimalThread('1', 'individual', true);
    expect(threadMatchesDemoListFolder(t, 'inbox')).toBe(true);
    expect(threadMatchesDemoListFolder(t, 'individual')).toBe(true);
    expect(threadMatchesDemoListFolder(t, 'urgent')).toBe(true);
    expect(threadMatchesDemoListFolder(t, 'spam')).toBe(false);

    const spam = minimalThread('2', 'spam');
    expect(threadMatchesDemoListFolder(spam, 'inbox')).toBe(false);
    expect(threadMatchesDemoListFolder(spam, 'spam')).toBe(true);
  });

  it('omits removed demo labels from thread labels and message tags', () => {
    const list = listDemoThreads({
      folder: 'inbox',
      q: '',
      cursor: '',
      maxResults: 100,
      labelIds: [],
    });

    for (const threadRef of list.threads) {
      const thread = getDemoThread(threadRef.id);
      const hasRemovedThreadLabel = thread.labels.some(
        (label) =>
          REMOVED_DEMO_LABELS.has(label.id.toLowerCase()) || REMOVED_DEMO_LABELS.has(label.name.toLowerCase()),
      );
      const hasRemovedTag = thread.messages.some((message) =>
        message.tags.some(
          (tag) => REMOVED_DEMO_LABELS.has(tag.id.toLowerCase()) || REMOVED_DEMO_LABELS.has(tag.name.toLowerCase()),
        ),
      );

      expect(hasRemovedThreadLabel).toBe(false);
      expect(hasRemovedTag).toBe(false);
    }
  });

  it('does not match removed labels in labelIds filtering', () => {
    const removedLabelList = listDemoThreads({
      folder: 'inbox',
      q: '',
      cursor: '',
      maxResults: 50,
      labelIds: ['promotion'],
    });

    expect(removedLabelList.threads).toHaveLength(0);
  });
});

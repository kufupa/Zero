import { describe, expect, it } from 'vitest';
import { getDemoThread, listDemoThreads } from '../lib/demo-data/adapter';
import { parseWorkQueueSlug } from '../lib/demo-data/work-queue';

const REMOVED_DEMO_LABELS = new Set(['comment', 'to respond', 'promotion']);

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
  });

  it('supports urgent queue filtering', () => {
    const queue = parseWorkQueueSlug('urgent');
    expect(queue).toBe('urgent');
    if (!queue) {
      throw new Error('Expected urgent queue slug to parse');
    }

    const urgent = listDemoThreads({
      folder: 'inbox',
      workQueue: queue,
      q: '',
      cursor: '',
      maxResults: 50,
      labelIds: [],
    });

    expect(urgent.threads.length).toBeGreaterThan(0);
    expect(
      getDemoThread(urgent.threads[0]!.id).messages.every((message) => !message.isDraft || message.id),
    ).toBe(true);
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

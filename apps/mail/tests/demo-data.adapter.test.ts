import { describe, expect, it } from 'vitest';
import { getDemoThread, listDemoThreads } from '../lib/demo-data/adapter';
import { parseWorkQueueSlug } from '../lib/demo-data/work-queue';

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
    expect(thread.labels.length).toBeGreaterThan(0);
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
});

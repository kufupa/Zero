import { describe, expect, it } from 'vitest';
import {
  parseWorkQueueSlug,
  threadMatchesWorkQueue,
  type DemoCorpusThreadShape,
} from '../lib/demo-mail/work-queue';

const t = (overrides: Partial<DemoCorpusThreadShape>): DemoCorpusThreadShape => ({
  id: 'x',
  demoCategory: 'group',
  urgent: false,
  messages: [{ isDraft: false }],
  ...overrides,
});

describe('parseWorkQueueSlug', () => {
  it('returns null for undefined, empty, and invalid slugs', () => {
    expect(parseWorkQueueSlug(undefined)).toBeNull();
    expect(parseWorkQueueSlug('')).toBeNull();
    expect(parseWorkQueueSlug('not-a-queue')).toBeNull();
  });

  it('returns the slug for valid work queue paths', () => {
    expect(parseWorkQueueSlug('travel-agent')).toBe('travel-agent');
    expect(parseWorkQueueSlug('urgent')).toBe('urgent');
    expect(parseWorkQueueSlug('group')).toBe('group');
  });
});

describe('threadMatchesWorkQueue', () => {
  it('matches category slug', () => {
    expect(threadMatchesWorkQueue(t({ demoCategory: 'hr' }), 'hr')).toBe(true);
    expect(threadMatchesWorkQueue(t({ demoCategory: 'hr' }), 'group')).toBe(false);
  });

  it('matches urgent rollup', () => {
    expect(threadMatchesWorkQueue(t({ urgent: true, demoCategory: 'individual' }), 'urgent')).toBe(
      true,
    );
    expect(threadMatchesWorkQueue(t({ urgent: false }), 'urgent')).toBe(false);
  });
});

import { describe, expect, it } from 'vitest';
import { threadMatchesWorkQueue } from '../lib/demo-data/work-queue';

describe('threadMatchesWorkQueue', () => {
  it('matches urgent queue by urgent=true', () => {
    expect(
      threadMatchesWorkQueue(
        { id: 'x', demoCategory: 'group', urgent: true, messages: [{ id: 'm', isDraft: false }] },
        'urgent',
      ),
    ).toBe(true);
  });

  it('does not match urgent queue by urgent=false', () => {
    expect(
      threadMatchesWorkQueue(
        { id: 'x', demoCategory: 'group', urgent: false, messages: [{ id: 'm', isDraft: false }] },
        'urgent',
      ),
    ).toBe(false);
  });

  it('matches category queue by demoCategory', () => {
    expect(
      threadMatchesWorkQueue(
        { id: 'x', demoCategory: 'group', urgent: false, messages: [{ id: 'm', isDraft: false }] },
        'group',
      ),
    ).toBe(true);
  });

  it('does not match wrong category queue', () => {
    expect(
      threadMatchesWorkQueue(
        { id: 'x', demoCategory: 'hr', urgent: true, messages: [{ id: 'm', isDraft: false }] },
        'travel-agent',
      ),
    ).toBe(false);
  });
});

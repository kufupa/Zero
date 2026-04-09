import { describe, expect, it } from 'vitest';
import { threadMatchesWorkQueue, type DemoCorpusThreadShape } from '../lib/demo-mail/work-queue';

const t = (overrides: Partial<DemoCorpusThreadShape>): DemoCorpusThreadShape => ({
  id: 'x',
  demoCategory: 'group',
  urgent: false,
  messages: [{ isDraft: false }],
  ...overrides,
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

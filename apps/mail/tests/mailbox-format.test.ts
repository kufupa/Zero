import { describe, expect, it } from 'vitest';
import { formatMailboxEntries } from '../lib/mail/mailbox-format';

describe('formatMailboxEntries', () => {
  it('gives repeated rendered recipients distinct deterministic keys', () => {
    expect(
      formatMailboxEntries([
        { email: 'guest@example.com' },
        { email: 'guest@example.com' },
        { name: 'Guest', email: 'guest@example.com' },
      ]),
    ).toEqual([
      { key: '["guest@example.com",1]', value: 'guest@example.com' },
      { key: '["guest@example.com",2]', value: 'guest@example.com' },
      { key: '["Guest <guest@example.com>",1]', value: 'Guest <guest@example.com>' },
    ]);
  });
});

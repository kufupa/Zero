import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const listSource = readFileSync(new URL('../components/mail/mail-list.tsx', import.meta.url), 'utf8');
const threadsSource = readFileSync(new URL('../hooks/use-threads.ts', import.meta.url), 'utf8');
const displaySource = readFileSync(
  new URL('../components/mail/thread-display.tsx', import.meta.url),
  'utf8',
);

describe('conversation-linked mail list contract', () => {
  it('filters to primary rows and renders linked stubs from list metadata', () => {
    expect(threadsSource).toContain('buildConversationPrimaryListRows');
    expect(listSource).toContain('LinkedThreadStubRow');
    expect(listSource).toContain("row.type === 'linked-stub'");
    expect(listSource).toContain('message.conversationResponded');
  });

  it('thread detail shows linked conversation banner and merged timeline dividers', () => {
    expect(displaySource).toContain('Linked conversation');
    expect(displaySource).toContain('Earlier thread');
    expect(threadsSource).toContain('mergeLinked: true');
  });
});

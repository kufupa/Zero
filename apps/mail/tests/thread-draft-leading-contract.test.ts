import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';

const threadDisplaySource = readFileSync(
  new URL('../components/mail/thread-display.tsx', import.meta.url),
  'utf8',
);

const messageListSource = () => {
  const listStart = threadDisplaySource.indexOf('const MessageList =');
  const listEnd = threadDisplaySource.indexOf('\n};', listStart);
  if (listStart < 0 || listEnd <= listStart) {
    throw new Error('Could not locate MessageList');
  }
  return threadDisplaySource.slice(listStart, listEnd + '\n};'.length);
};

describe('thread draft leading placement contract', () => {
  it('MessageList accepts leading (not trailing) for the draft stack', () => {
    const list = messageListSource();
    expect(list).toContain('leading');
    expect(list).toMatch(/leading\s*[,}]/);
    expect(list).not.toMatch(/\btrailing\b/);
  });

  it('mounts leading after attachments and before displayMessages.map', () => {
    const list = messageListSource();
    const attachments = list.indexOf('ThreadAttachments');
    const leadingMount = list.indexOf('{leading ?');
    // JSX list mount — not linked-thread id `displayMessages.map` earlier in MessageList.
    const messagesMap = list.indexOf('{displayMessages.map');
    expect(attachments).toBeGreaterThan(-1);
    expect(leadingMount).toBeGreaterThan(attachments);
    expect(messagesMap).toBeGreaterThan(leadingMount);
  });

  it('ThreadDisplay call sites pass leading={threadDraftSection}', () => {
    expect(threadDisplaySource).toContain('leading={threadDraftSection}');
    expect(threadDisplaySource).not.toContain('trailing={threadDraftSection}');
  });
});

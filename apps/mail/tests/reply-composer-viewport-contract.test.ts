import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';

const replyComposerSource = readFileSync(
  new URL('../components/mail/reply-composer.tsx', import.meta.url),
  'utf8',
);
const threadDisplaySource = readFileSync(
  new URL('../components/mail/thread-display.tsx', import.meta.url),
  'utf8',
);

const mountedAlignmentEffectSource = () => {
  const guard = 'if (!mode || !messageId || !replyComposeViewportElement) return;';
  const guardIndex = replyComposerSource.indexOf(guard);
  const effectStart = replyComposerSource.lastIndexOf('  useEffect(() => {', guardIndex);
  const effectEnd = replyComposerSource.indexOf(
    '  }, [mode, messageId, replyComposeViewportElement]);',
    guardIndex,
  );

  if (guardIndex < 0 || effectStart < 0 || effectEnd <= effectStart) {
    throw new Error('Could not locate mounted ReplyCompose viewport alignment effect');
  }

  return replyComposerSource.slice(
    effectStart,
    effectEnd + '  }, [mode, messageId, replyComposeViewportElement]);'.length,
  );
};

const messageListSource = () => {
  const listStart = threadDisplaySource.indexOf('const MessageList =');
  const listEnd = threadDisplaySource.indexOf('\n};', listStart);

  if (listStart < 0 || listEnd <= listStart) {
    throw new Error('Could not locate MessageList');
  }

  return threadDisplaySource.slice(listStart, listEnd + '\n};'.length);
};

describe('ReplyCompose viewport alignment contract', () => {
  it('waits for a mounted element before aligning each explicit mode and target', () => {
    const effect = mountedAlignmentEffectSource();

    expect(replyComposerSource).toContain(
      'const [replyComposeViewportElement, setReplyComposeViewportElement] =',
    );
    expect(replyComposerSource).toContain('useState<HTMLDivElement | null>(null);');
    expect(replyComposerSource).toContain('<div ref={setReplyComposeViewportElement}');
    expect(replyComposerSource).not.toContain('replyComposeViewportRef');
    expect(replyComposerSource).not.toContain('useCallback');
    expect(replyComposerSource.match(/requestAnimationFrame/g)).toHaveLength(1);
    expect(effect).toContain('const frameId = requestAnimationFrame(() => {');
    expect(effect).toContain('if (!replyComposeViewportElement.isConnected) return;');
    expect(effect).toContain('if (!mode || !messageId || !replyComposeViewportElement) return;');
    expect(effect).toContain('}, [mode, messageId, replyComposeViewportElement]);');
    expect(effect).not.toContain('emailData');
    expect(effect).not.toContain('latest');
    expect(effect).not.toContain('document.getElementById');
  });

  it('prioritizes composer footer, honors reduced motion, and cancels pending work', () => {
    const effect = mountedAlignmentEffectSource();

    expect(effect).toMatch(
      /window\.matchMedia\?\.\('\(prefers-reduced-motion: reduce\)'\)\.matches\s*\?\s*'auto'\s*:\s*'smooth'/,
    );
    expect(effect).toMatch(
      /replyComposeViewportElement\.scrollIntoView\(\{\s*behavior,\s*block: 'end',\s*inline: 'nearest',?\s*\}\)/,
    );
    expect(effect).toMatch(/return \(\) => \{\s*cancelAnimationFrame\(frameId\);\s*\};/);
  });

  it('keeps placement inline while removing parent delay and continuous observation', () => {
    const messageList = messageListSource();
    const composerIndex = messageList.indexOf('<ReplyCompose messageId={message.id} />');
    const mailDisplayIndex = messageList.indexOf('<MailDisplay', composerIndex);

    expect(messageList).toContain(
      'const displayMessages = orderMessagesNewestFirst(messages || []);',
    );
    expect(messageList).toContain(
      'const isReplyingToThisMessage = Boolean(mode && activeReplyId === message.id);',
    );
    expect(composerIndex).toBeGreaterThan(-1);
    expect(composerIndex).toBeLessThan(mailDisplayIndex);
    expect(threadDisplaySource).not.toContain(
      'document.getElementById(`reply-composer-${activeReplyId}`)',
    );
    expect(threadDisplaySource).not.toMatch(
      /setTimeout\(\(\) => \{[\s\S]*?reply-composer-\$\{activeReplyId\}[\s\S]*?scrollIntoView/,
    );
    expect(replyComposerSource).not.toContain('ResizeObserver');
    expect(threadDisplaySource).not.toContain('ResizeObserver');
  });
});

import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const readSource = (relativePath: string) =>
  readFileSync(new URL(relativePath, import.meta.url), 'utf8');

const useThreadsSource = readSource('../hooks/use-threads.ts');
const threadDisplaySource = readSource('../components/mail/thread-display.tsx');
const emailComposerSource = readSource('../components/create/email-composer.tsx');

describe('compose typing kick-out unmount wiring', () => {
  it('keeps prior open-thread data and never resolves thread id from message id', () => {
    expect(useThreadsSource).toContain('resolveOpenThreadId');
    expect(useThreadsSource).toContain('shouldBlankOpenThreadData');
    expect(useThreadsSource).toContain('placeholderData: (previousData) => previousData');
    expect(useThreadsSource).not.toMatch(/latest\.threadId\s*\?\?\s*threadData\.latest\.id/);
    expect(useThreadsSource).not.toMatch(/firstMessage\?\.threadId\s*\?\?\s*firstMessage\?\.id/);
  });

  it('uses skeleton helper so loaded threads are not unmounted on refetch', () => {
    expect(threadDisplaySource).toContain('shouldShowOpenThreadSkeleton');
    expect(threadDisplaySource).not.toMatch(
      /shouldShowSkeleton\s*=\s*!emailData\s*\|\|\s*isLoading/,
    );
  });

  it('routes Escape through resolveComposeEscapeAction', () => {
    expect(emailComposerSource).toContain('resolveComposeEscapeAction');
    expect(emailComposerSource).toContain('handleEscapeClose');
    expect(emailComposerSource).toContain('handleEscapeClose(e.isComposing)');
  });
});

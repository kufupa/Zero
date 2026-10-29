import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const listSource = readFileSync(new URL('../components/mail/mail-list.tsx', import.meta.url), 'utf8');
const typesSource = readFileSync(new URL('../types/index.ts', import.meta.url), 'utf8');

describe('mail list selection wiring', () => {
  it('uses the shared selection contract and passes reactive keyboard mode to rows', () => {
    expect(typesSource).toMatch(/isKeyboardNavigationActive\?: boolean/);
    expect(listSource).toContain("getMailRowSelectionClasses");
    expect(listSource).toContain('getMailRowSelectionClasses({');
    expect(listSource).toContain('isKeyboardNavigationActive={keyboardActive}');
    expect(listSource).toContain(
      'isKeyboardFocused={focusedIndex === row.threadIndex && keyboardActive}',
    );
    expect(listSource).toContain('prev.isKeyboardNavigationActive === next.isKeyboardNavigationActive');
    expect(listSource).toContain('isKeyboardNavigationActive,');
  });

  it('suppresses the stranded native outline and keeps one keyboard ring', () => {
    expect(listSource).toContain('focus:outline-none');
    expect(listSource).toContain('focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-primary/60');
    expect(listSource).toContain('!isKeyboardNavigationActive &&');
    expect(listSource).toContain('focusThreadElement');
    expect(listSource).toContain('const setThreadElementRef = useCallback(');
    expect(listSource).toContain('ref={setThreadElementRef}');
  });

  it('preserves the draggable and compose-leave contracts', () => {
    expect(listSource).toContain('{...dragListeners}');
    expect(listSource).toContain('{...dragAttributes}');

    const clickHandlerStart = listSource.indexOf('const handleMailClick = useCallback(');
    const clickHandlerEnd = listSource.indexOf('const activeSearch', clickHandlerStart);
    const clickHandler = listSource.slice(clickHandlerStart, clickHandlerEnd);

    expect(clickHandler.indexOf('runComposeLeaveFlush')).toBeGreaterThanOrEqual(0);
    expect(clickHandler.indexOf('runComposeLeaveFlush')).toBeLessThan(
      clickHandler.indexOf('setThreadSelection({ threadId: messageThreadId, sourceMessageId: null })'),
    );
  });
});

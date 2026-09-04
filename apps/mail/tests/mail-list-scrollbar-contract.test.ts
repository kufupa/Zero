import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const source = readFileSync(
  new URL('../components/mail/mail-list.tsx', import.meta.url),
  'utf8',
);

const scrollMarker = source.indexOf('id="mail-list-scroll"');
const vListStart = source.indexOf('<VList', scrollMarker);
const vListEnd = source.indexOf('{vListRenderer}', vListStart);
if (scrollMarker < 0 || vListStart < 0 || vListEnd < vListStart) {
  throw new Error('Could not locate the inbox VList opening tag');
}

const vListOpeningTag = source.slice(vListStart, vListEnd);
const className = vListOpeningTag.match(/className="([^"]+)"/)?.[1] ?? '';
const classTokens = className.split(/\s+/).filter(Boolean);

describe('mail list scrollbar contract', () => {
  it('keeps the virtualized inbox list visible and horizontally contained', () => {
    expect(source).toContain('id="mail-list-scroll"');
    expect(classTokens).toEqual(
      expect.arrayContaining([
        'scrollbar',
        'scrollbar-w-1',
        'scrollbar-thumb-accent/40',
        'scrollbar-track-transparent',
        'hover:scrollbar-thumb-accent',
        'scrollbar-thumb-rounded-full',
        'flex-1',
        'overflow-x-hidden',
      ]),
    );
    expect(classTokens).not.toContain('scrollbar-none');
  });

  it('keeps pagination attached to the same VList scroll owner', () => {
    expect(source).toContain('onScroll={() => {');
    expect(source).toContain('const endIndex = vListRef.current.findEndIndex();');
    expect(source).toContain('void loadMore();');
  });
});

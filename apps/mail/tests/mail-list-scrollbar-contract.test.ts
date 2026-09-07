import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

import { NATIVE_VISIBLE_SCROLLBAR_CLASSES } from '../lib/scrollbar-chrome';

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

describe('mail list scrollbar contract', () => {
  it('keeps the virtualized inbox list visible and horizontally contained', () => {
    expect(source).toContain('id="mail-list-scroll"');
    expect(vListOpeningTag).toContain('NATIVE_VISIBLE_SCROLLBAR_CLASSES');
    expect(vListOpeningTag).toContain('flex-1');
    expect(vListOpeningTag).toContain('overflow-x-hidden');
    expect(vListOpeningTag).not.toContain('scrollbar-none');
    expect(vListOpeningTag).not.toContain('scrollbar-w-1');
    expect(NATIVE_VISIBLE_SCROLLBAR_CLASSES).toContain('scrollbar-w-[14px]');
  });

  it('keeps pagination attached to the same VList scroll owner', () => {
    expect(source).toContain('onScroll={() => {');
    expect(source).toContain('const endIndex = vListRef.current.findEndIndex();');
    expect(source).toContain('void loadMore();');
  });
});

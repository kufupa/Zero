import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

import {
  NATIVE_SCROLLBAR_WIDTH_CLASS,
  NATIVE_VISIBLE_SCROLLBAR_CLASSES,
  RADIX_SCROLLBAR_HORIZONTAL_SIZE_CLASS,
  RADIX_SCROLLBAR_VERTICAL_SIZE_CLASS,
  SCROLLBAR_GRAB_WIDTH_PX,
} from '../lib/scrollbar-chrome';

const scrollAreaSource = readFileSync(
  new URL('../components/ui/scroll-area.tsx', import.meta.url),
  'utf8',
);
const mailListSource = readFileSync(
  new URL('../components/mail/mail-list.tsx', import.meta.url),
  'utf8',
);
const appSidebarSource = readFileSync(
  new URL('../components/ui/app-sidebar.tsx', import.meta.url),
  'utf8',
);
const sidebarSource = readFileSync(
  new URL('../components/ui/sidebar.tsx', import.meta.url),
  'utf8',
);
const emailComposerSource = readFileSync(
  new URL('../components/create/email-composer.tsx', import.meta.url),
  'utf8',
);

describe('scrollbar chrome grab target', () => {
  it('keeps a fixed px width large enough to grab (~Outlook list bar)', () => {
    expect(SCROLLBAR_GRAB_WIDTH_PX).toBeGreaterThanOrEqual(12);
    expect(SCROLLBAR_GRAB_WIDTH_PX).toBeLessThanOrEqual(16);
    expect(NATIVE_SCROLLBAR_WIDTH_CLASS).toBe(`scrollbar-w-[${SCROLLBAR_GRAB_WIDTH_PX}px]`);
    expect(RADIX_SCROLLBAR_VERTICAL_SIZE_CLASS).toBe(`w-[${SCROLLBAR_GRAB_WIDTH_PX}px]`);
    expect(RADIX_SCROLLBAR_HORIZONTAL_SIZE_CLASS).toBe(`h-[${SCROLLBAR_GRAB_WIDTH_PX}px]`);
  });

  it('wires Radix ScrollBar to the shared grab width (not rem scale w-2.5)', () => {
    expect(scrollAreaSource).toContain('RADIX_SCROLLBAR_VERTICAL_SIZE_CLASS');
    expect(scrollAreaSource).toContain('RADIX_SCROLLBAR_HORIZONTAL_SIZE_CLASS');
    expect(scrollAreaSource).not.toMatch(/orientation === 'vertical' && 'h-full w-2\.5/);
    expect(scrollAreaSource).not.toMatch(/orientation === 'horizontal' && 'h-2\.5/);
  });

  it('wires inbox list + sidebar native scrollbars to the shared visible set', () => {
    expect(mailListSource).toContain('NATIVE_VISIBLE_SCROLLBAR_CLASSES');
    expect(appSidebarSource).toContain('NATIVE_VISIBLE_SCROLLBAR_CLASSES');
    expect(NATIVE_VISIBLE_SCROLLBAR_CLASSES).toContain(NATIVE_SCROLLBAR_WIDTH_CLASS);
    expect(NATIVE_VISIBLE_SCROLLBAR_CLASSES).not.toContain('scrollbar-w-1');
  });

  it('ensures SidebarContent does not suppress scrollbars with scrollbar-none', () => {
    const contentMarker = 'const SidebarContent = React.forwardRef';
    const contentStart = sidebarSource.indexOf(contentMarker);
    expect(contentStart).toBeGreaterThan(-1);
    const contentEnd = sidebarSource.indexOf(');', contentStart);
    const contentDef = sidebarSource.slice(contentStart, contentEnd);

    expect(contentDef).not.toContain('scrollbar-none');
    expect(contentDef).not.toContain('scrollbar-w-0');
  });

  it('wires reply email composer message content to the shared visible scrollbar set', () => {
    expect(emailComposerSource).toContain(
      "import { NATIVE_VISIBLE_SCROLLBAR_CLASSES } from '@/lib/scrollbar-chrome';",
    );

    const contentMarker = '{/* Message Content */}';
    const markerIndex = emailComposerSource.indexOf(contentMarker);
    expect(markerIndex).toBeGreaterThan(-1);
    const tagStart = emailComposerSource.indexOf('<div', markerIndex);
    const tagEnd = emailComposerSource.indexOf('>', tagStart);
    const openingTag = emailComposerSource.slice(tagStart, tagEnd + 1);

    expect(openingTag).toContain('NATIVE_VISIBLE_SCROLLBAR_CLASSES');
    expect(openingTag).toContain('overflow-y-auto');
  });
});

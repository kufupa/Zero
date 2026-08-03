import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const readSource = (relativePath: string) =>
  readFileSync(new URL(relativePath, import.meta.url), 'utf8');

const openingTagAfter = (source: string, anchor: string, tagName: string) => {
  const anchorIndex = source.indexOf(anchor);
  expect(anchorIndex).toBeGreaterThanOrEqual(0);

  const tagStart = source.indexOf(`<${tagName}`, anchorIndex);
  const tagEnd = source.indexOf('>', tagStart);
  expect(tagStart).toBeGreaterThanOrEqual(0);
  expect(tagEnd).toBeGreaterThan(tagStart);
  return source.slice(tagStart, tagEnd + 1);
};

const openingTagContaining = (source: string, anchor: string, tagName: string) => {
  const anchorIndex = source.indexOf(anchor);
  expect(anchorIndex).toBeGreaterThanOrEqual(0);

  const tagStart = source.lastIndexOf(`<${tagName}`, anchorIndex);
  const tagEnd = source.indexOf('>', anchorIndex);
  expect(tagStart).toBeGreaterThanOrEqual(0);
  expect(tagEnd).toBeGreaterThan(anchorIndex);
  return source.slice(tagStart, tagEnd + 1);
};

const classTokens = (openingTag: string) => {
  const className = openingTag.match(/className=(?:"([^"]*)"|{cn\(\s*`([^`]*)`)/);
  expect(className).not.toBeNull();
  return (className?.[1] ?? className?.[2] ?? '').split(/\s+/);
};

const routeLayoutSource = readSource('../app/(routes)/mail/layout.tsx');
const mailSplitSource = readSource('../components/mail/mail.tsx');

describe('mail shell horizontal containment', () => {
  it('lets route content beside the fixed sidebar shrink to the viewport', () => {
    const routeContent = openingTagAfter(routeLayoutSource, '<AppSidebar />', 'div');

    expect(classTokens(routeContent)).toContain('min-w-0');
  });

  it.each(['mail-list-panel', 'mail-thread-panel'])(
    'lets the %s follow its resizable percentage instead of wide min-content',
    (panelId) => {
      const panel = openingTagContaining(
        mailSplitSource,
        `id="${panelId}"`,
        'ResizablePanel',
      );
      const classes = classTokens(panel);

      expect(classes).toContain('min-w-0');
      expect(classes).not.toContain('w-fit');
    },
  );
});

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

  it('uses mail-split-v3 autoSave only for wide split', () => {
    expect(mailSplitSource).toContain("mail-split-v3");
    expect(mailSplitSource).not.toContain("mail-split-v2");
    expect(mailSplitSource).toMatch(/autoSaveId=\{isWideSplit \? ['"]mail-split-v3['"] : undefined\}/);
  });

  it('avoids CSS hidden lg:block on the list panel for mid-width thread', () => {
    expect(mailSplitSource).not.toContain('hidden lg:block');
  });

  it('gates desktop list/thread mount via mail-panel-visibility helpers', () => {
    expect(mailSplitSource).toContain('shouldShowDesktopListPanel');
    expect(mailSplitSource).toContain('shouldShowDesktopThreadPanel');
    expect(mailSplitSource).toContain('shouldShowMailSplitHandle');
    expect(mailSplitSource).toContain("from '@/lib/mail/mail-panel-visibility'");
  });

  it('keeps list expand affordance outside the collapsed list panel', () => {
    expect(mailSplitSource).toContain('data-mail-list-expand');
    const listPanelIdx = mailSplitSource.indexOf('id="mail-list-panel"');
    const expandIdx = mailSplitSource.indexOf('data-mail-list-expand');
    const threadPanelIdx = mailSplitSource.indexOf('id="mail-thread-panel"');
    expect(listPanelIdx).toBeGreaterThanOrEqual(0);
    expect(threadPanelIdx).toBeGreaterThan(listPanelIdx);
    expect(expandIdx).toBeGreaterThan(threadPanelIdx);
  });
});

import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const emailComposerSource = readFileSync(
  new URL('../components/create/email-composer.tsx', import.meta.url),
  'utf8',
);

const recipientAutosuggestSource = readFileSync(
  new URL('../components/ui/recipient-autosuggest.tsx', import.meta.url),
  'utf8',
);

const openingTagBefore = (source: string, marker: string): string => {
  const markerIndex = source.indexOf(marker);
  expect(markerIndex).toBeGreaterThanOrEqual(0);

  const tagStart = source.lastIndexOf('<div', markerIndex);
  const tagEnd = source.indexOf('>', tagStart);
  return source.slice(tagStart, tagEnd + 1);
};

describe('reply composer header containment', () => {
  it('keeps every recipient row shrinkable while labels retain their width', () => {
    for (const label of ['To', 'Cc', 'Bcc']) {
      const row = openingTagBefore(
        emailComposerSource,
        `<p className="shrink-0 text-sm font-medium text-[#8C8C8C]">${label}:</p>`,
      );

      expect(row).toContain('flex');
      expect(row).toContain('min-w-0');
    }

    const toRow = openingTagBefore(
      emailComposerSource,
      '<p className="shrink-0 text-sm font-medium text-[#8C8C8C]">To:</p>',
    );
    expect(toRow).toContain('flex-1');

    const rootStart = recipientAutosuggestSource.indexOf("className={cn('relative");
    const rootEnd = recipientAutosuggestSource.indexOf(')}', rootStart);
    const root = recipientAutosuggestSource.slice(rootStart, rootEnd + 2);
    expect(root).toContain('min-w-0');
    expect(root).toContain('flex-1');
  });

  it('keeps header actions fixed-width and keyboard reachable', () => {
    const headerStart = emailComposerSource.indexOf('{/* To, Cc, Bcc */}');
    const headerEnd = emailComposerSource.indexOf('{/* CC Section */}');
    const header = emailComposerSource.slice(headerStart, headerEnd);
    const actionCluster = openingTagBefore(emailComposerSource, '<span>Cc</span>');
    const controls = header.match(/<button\b[\s\S]*?>/g) ?? [];

    expect(actionCluster).toContain('flex');
    expect(actionCluster).toContain('shrink-0');
    expect(controls).toHaveLength(3);
    controls.forEach((control) => expect(control).toContain('type="button"'));
    expect(header).not.toContain('tabIndex={-1}');
    expect(header).toContain('aria-label="Close composer"');
  });

  it('bounds and truncates recipient chips without hiding full values from assistive technology', () => {
    const chipsStart = recipientAutosuggestSource.indexOf('{recipients.map');
    const chipsEnd = recipientAutosuggestSource.indexOf('<input', chipsStart);
    const chips = recipientAutosuggestSource.slice(chipsStart, chipsEnd);

    expect(chips).toContain('min-w-0');
    expect(chips).toContain('max-w-full');
    expect(chips).toMatch(/className="[^"]*\btruncate\b[^"]*"/);
    expect(chips).toContain('title={email}');
    expect(chips).toMatch(/title=\{email\}>\s*\{email\}\s*<\/span>/);
    expect(chips).toContain('h-5 w-5 shrink-0');
    expect(chips).toMatch(/<button[\s\S]*?className="[^"]*\bshrink-0\b[^"]*"/);
    expect(chips).toContain('aria-label={`Remove ${email}`}');
  });

  it('keeps raw recipient input shrinkable while it flexes', () => {
    const inputStart = recipientAutosuggestSource.indexOf('<input');
    const inputEnd = recipientAutosuggestSource.indexOf('/>', inputStart);
    const input = recipientAutosuggestSource.slice(inputStart, inputEnd + 2);

    expect(input).toMatch(/className="[^"]*\bmin-w-0\b[^"]*"/);
    expect(input).toMatch(/className="[^"]*\bflex-1\b[^"]*"/);
  });
});

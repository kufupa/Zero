import { describe, expect, it } from 'vitest';
import {
  collapseQuotedHtml,
  processQuotedContent,
} from '../src/mail/collapse-quoted-html.js';

describe('collapseQuotedHtml', () => {
  it('wraps blockquote in closed details with ellipsis summary', () => {
    const input = `<p>new reply</p><blockquote><p>old message hi!!</p></blockquote>`;
    const out = collapseQuotedHtml(input);

    expect(out).toContain('new reply');
    expect(out).toContain('old message hi!!');
    expect(out).toContain('<details class="quoted-toggle"');
    expect(out).toContain('quoted-toggle-ellipsis');
    expect(out).toContain('⋯');
    expect(out).not.toMatch(/<details[^>]*\sopen[\s>]/i);
  });

  it('wraps .gmail_quote blocks', () => {
    const input = `<div>hi</div><div class="gmail_quote"><p>prior</p></div>`;
    const out = collapseQuotedHtml(input);
    expect(out).toContain('quoted-toggle');
    expect(out).toContain('prior');
  });

  it('does not double-wrap already collapsed quotes', () => {
    const once = collapseQuotedHtml(`<blockquote><p>x</p></blockquote>`);
    const twice = collapseQuotedHtml(once);
    expect(twice.match(/<details class="quoted-toggle"/g)?.length).toBe(1);
  });
});

describe('processQuotedContent', () => {
  it('injects styles when quotes are collapsed', () => {
    const out = processQuotedContent(
      `<p>a</p><blockquote><p>b</p></blockquote>`,
      'dark',
    );
    expect(out).toContain('data-quoted-toggle-styles');
    expect(out).toContain('quoted-toggle');
  });

  it('leaves plain html without styles when no quotes', () => {
    const out = processQuotedContent('<p>only new</p>', 'light');
    expect(out).toBe('<p>only new</p>');
    expect(out).not.toContain('data-quoted-toggle-styles');
  });
});

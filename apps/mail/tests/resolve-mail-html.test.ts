import { describe, expect, it } from 'vitest';
import { resolveMailHtml } from '../lib/mail/resolve-mail-html';

describe('resolveMailHtml', () => {
  it('returns processed html with style tag when available', () => {
    const result = resolveMailHtml({
      rawHtml: '<p>raw</p>',
      processedHtml: '<div>processed</div>',
    });

    expect(result).toContain('data-nava-mail-font="1"');
    expect(result).toContain('<div>processed</div>');
  });

  it('extracts body html when processed html is missing', () => {
    const result = resolveMailHtml({
      rawHtml:
        '<html><head><title>ignored</title></head><body><section><p>Hello demo</p></section></body></html>',
    });

    expect(result).toContain('data-nava-mail-font="1"');
    expect(result).toContain('<section><p>Hello demo</p></section>');
  });

  it('strips script tags from fallback content', () => {
    const result = resolveMailHtml({
      rawHtml: '<body><p>safe</p><script>alert("xss")</script></body>',
    });

    expect(result).toContain('<p>safe</p>');
    expect(result).not.toContain('<script');
  });

  it('converts plain text body into escaped html', () => {
    const result = resolveMailHtml({
      rawHtml: 'Line 1\n<script>not html</script>\nLine 2',
    });

    expect(result).toContain('<div>Line 1<br />Line 2</div>');
  });

  it('returns default empty state html when no content exists', () => {
    expect(resolveMailHtml({ rawHtml: '' })).toBe('<p><em>No email content available</em></p>');
    expect(resolveMailHtml({ rawHtml: '   ', processedHtml: '   ' })).toBe(
      '<p><em>No email content available</em></p>',
    );
  });

  it('client style twin contains nested table cells so long disclaimers wrap', () => {
    const result = resolveMailHtml({ rawHtml: '<p>hi</p>' });
    expect(result).toMatch(/contain\s*:\s*inline-size/i);
    expect(result).toMatch(/table\s*\{[^}]*table-layout\s*:\s*fixed\s*!important/i);
    expect(result).toMatch(/table\s*\{[^}]*width\s*:\s*100%\s*!important/i);
    expect(result).toMatch(/word-break\s*:\s*break-word/i);
    expect(result).toMatch(/td[\s\S]*overflow-wrap\s*:\s*anywhere\s*!important/i);
  });
});

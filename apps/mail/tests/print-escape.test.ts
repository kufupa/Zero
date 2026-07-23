import { describe, expect, it } from 'vitest';

const escapePrintHtml = (value: string) =>
  value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;');

describe('print subject escape', () => {
  it('print subject escapes script tags', () => {
    const subject = '<script>alert(1)</script>';
    const title = `Print Email - ${escapePrintHtml(subject)}`;
    expect(title).not.toContain('<script>alert(1)</script>');
    expect(title).toContain('&lt;script&gt;');
  });
});

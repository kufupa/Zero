import { describe, expect, it } from 'vitest';

import { normalizeDemoMessageBody } from '../lib/demo-data/normalize-demo-message-body';

describe('normalizeDemoMessageBody', () => {
  it('converts plain text body into paragraph HTML', () => {
    expect(
      normalizeDemoMessageBody({
        bodyFormat: 'text',
        body: ' Hello\n\nWorld\n  from\n',
      }),
    ).toBe('<p>Hello</p><p>World</p><p>from</p>');
  });

  it('preserves HTML while removing script tags', () => {
    expect(
      normalizeDemoMessageBody({
        bodyFormat: 'html',
        body: '<div>Hello</div><script>alert(1)</script><p>World</p><script>ignored</script>',
      }),
    ).toBe('<div>Hello</div><p>World</p>');
  });

  it('escapes angle brackets in text format', () => {
    expect(
      normalizeDemoMessageBody({
        bodyFormat: 'text',
        body: 'Use <em>tags</em> and & symbols',
      }),
    ).toBe('<p>Use &lt;em&gt;tags&lt;/em&gt; and &amp; symbols</p>');
  });

  it('preserves paragraph HTML even when mock data omits bodyFormat', () => {
    expect(
      normalizeDemoMessageBody({
        bodyFormat: 'text',
        body: '<p>Dear Ms Ruganzu,</p><p>Thank you for sharing your travel information.</p>',
      }),
    ).toBe('<p>Dear Ms Ruganzu,</p><p>Thank you for sharing your travel information.</p>');
  });
});

import { describe, expect, it } from 'vitest';
import { prepareOutboundHtml } from '../src/mail/prepare-outbound-html.js';

describe('prepareOutboundHtml', () => {
  it('wraps AI/bare paragraphs for SMTP', () => {
    expect(prepareOutboundHtml('<p>Thanks</p>')).toContain('nava-mail-body');
  });

  it('is idempotent for already-wrapped reply HTML', () => {
    const wrapped =
      '<div class="nava-mail-body" style="font-family: Calibri, Arial, sans-serif; font-size: 11pt;"><p>x</p></div>';
    expect(prepareOutboundHtml(wrapped)).toBe(wrapped);
  });
});

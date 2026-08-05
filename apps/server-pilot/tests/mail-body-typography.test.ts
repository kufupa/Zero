import { describe, expect, it } from 'vitest';
import {
  MAIL_BODY_FONT_FAMILY,
  MAIL_BODY_FONT_SIZE,
  mailBodyDisplayStyleTag,
  wrapMailBodyHtml,
} from '../src/mail/mail-body-typography.js';

describe('wrapMailBodyHtml', () => {
  it('wraps bare TipTap HTML with nava-mail-body + Calibri 11pt', () => {
    const out = wrapMailBodyHtml('<p>hi</p>');
    expect(out).toContain('class="nava-mail-body"');
    expect(out).toContain(`font-family: ${MAIL_BODY_FONT_FAMILY}`);
    expect(out).toContain(`font-size: ${MAIL_BODY_FONT_SIZE}`);
    expect(out).toContain('<p>hi</p>');
    expect(out).toContain('color: #000000');
  });

  it('is idempotent when nava-mail-body already present', () => {
    const once = wrapMailBodyHtml('<p>hi</p>');
    const twice = wrapMailBodyHtml(once);
    expect(twice).toBe(once);
    expect(twice.match(/nava-mail-body/g)?.length).toBe(1);
  });

  it('does not wrap empty string into a meaningful body (passthrough empty)', () => {
    expect(wrapMailBodyHtml('')).toBe('');
  });
});

describe('mailBodyDisplayStyleTag', () => {
  it('emits fixed Calibri 11pt CSS without forced black', () => {
    const tag = mailBodyDisplayStyleTag();
    expect(tag).toContain('<style');
    expect(tag).toContain(MAIL_BODY_FONT_FAMILY);
    expect(tag).toContain(MAIL_BODY_FONT_SIZE);
    expect(tag).not.toMatch(/color\s*:\s*#000/i);
  });
});

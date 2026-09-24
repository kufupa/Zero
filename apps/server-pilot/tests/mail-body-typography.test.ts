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
  it('emits fixed Calibri 11pt wrapping CSS with default black color', () => {
    const tag = mailBodyDisplayStyleTag();
    expect(tag).toContain('<style');
    expect(tag).toContain(MAIL_BODY_FONT_FAMILY);
    expect(tag).toContain(MAIL_BODY_FONT_SIZE);
    expect(tag).toMatch(/white-space\s*:\s*normal/i);
    expect(tag).toMatch(/overflow-wrap\s*:\s*anywhere/i);
    expect(tag).toMatch(/color\s*:\s*#000000/i);
  });

  it('contains fixed-width email tables and images within the reader', () => {
    const tag = mailBodyDisplayStyleTag();
    expect(tag).toMatch(/table\s*\{[^}]*max-width\s*:\s*100%\s*!important/i);
    expect(tag).toMatch(/table\s*\{[^}]*width\s*:\s*auto\s*!important/i);
    expect(tag).toMatch(/img\s*\{[^}]*max-width\s*:\s*100%\s*!important/i);
    expect(tag).toMatch(/img\s*\{[^}]*object-fit\s*:\s*contain/i);
    expect(tag).not.toMatch(/height\s*:\s*auto\s*!important/i);
  });

  it('forces nested Outlook table cells and paragraphs to wrap long disclaimer lines', () => {
    const tag = mailBodyDisplayStyleTag();
    expect(tag).toMatch(/:host(?:,\s*\.mail-content-root,\s*\.nava-mail-body)?\s*\{[^}]*max-width\s*:\s*100%/i);
    expect(tag).toMatch(/:host(?:,\s*\.mail-content-root,\s*\.nava-mail-body)?\s*\{[^}]*word-break\s*:\s*break-word/i);
    expect(tag).toMatch(
      /:host\s+(?:td|th|p|div|li|span)(?:,\s*:host\s+(?:td|th|p|div|li|span))*\s*\{[^}]*overflow-wrap\s*:\s*anywhere\s*!important/i,
    );
    expect(tag).toMatch(
      /:host\s+(?:td|th|p|div|li|span)(?:,\s*:host\s+(?:td|th|p|div|li|span))*\s*\{[^}]*word-break\s*:\s*break-word\s*!important/i,
    );
    expect(tag).toMatch(/:host\s+pre(?:,\s*:host\s+code)?\s*\{[^}]*white-space\s*:\s*pre-wrap\s*!important/i);
  });

  it('restores zero margins for sanitized Outlook MsoNormal paragraphs', () => {
    const tag = mailBodyDisplayStyleTag();
    expect(tag).toMatch(/p\.MsoNormal\s*\{[^}]*margin\s*:\s*0\s*;/i);
  });
});

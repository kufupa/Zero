import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import {
  MAIL_RECIPIENT_FIELDS_CLASS,
  MAIL_RECIPIENT_HEADER_CLASS,
  MAIL_RECIPIENT_ITEM_CLASS,
  MAIL_RECIPIENT_LINE_CLASS,
} from '../lib/mail/mail-recipient-line';

const source = readFileSync(new URL('../components/mail/mail-display.tsx', import.meta.url), 'utf8');

describe('mail recipient line containment', () => {
  it('header shrinks below unwrapped To/Cc min-content and stacks fields above actions', () => {
    expect(MAIL_RECIPIENT_HEADER_CLASS).toMatch(/\bflex\b/);
    expect(MAIL_RECIPIENT_HEADER_CLASS).toMatch(/\bw-full\b/);
    expect(MAIL_RECIPIENT_HEADER_CLASS).toMatch(/\bmin-w-0\b/);
    expect(MAIL_RECIPIENT_HEADER_CLASS).toMatch(/\bmax-w-full\b/);
    expect(MAIL_RECIPIENT_HEADER_CLASS).toMatch(/flex-col/);
    expect(MAIL_RECIPIENT_HEADER_CLASS).not.toMatch(/flex-wrap/);
  });

  it('fields column is width-bounded so child lines inherit a definite containing block', () => {
    expect(MAIL_RECIPIENT_FIELDS_CLASS).toMatch(/\bw-full\b/);
    expect(MAIL_RECIPIENT_FIELDS_CLASS).toMatch(/\bmin-w-0\b/);
    expect(MAIL_RECIPIENT_FIELDS_CLASS).toMatch(/\bmax-w-full\b/);
    expect(MAIL_RECIPIENT_FIELDS_CLASS).toMatch(/flex-col/);
  });

  it('each To/Cc/Bcc line wraps at recipient boundaries', () => {
    expect(MAIL_RECIPIENT_LINE_CLASS).toMatch(/\bflex-wrap\b/);
    expect(MAIL_RECIPIENT_LINE_CLASS).toMatch(/\bw-full\b/);
    expect(MAIL_RECIPIENT_LINE_CLASS).toMatch(/\bmin-w-0\b/);
    expect(MAIL_RECIPIENT_LINE_CLASS).toMatch(/\bmax-w-full\b/);
    expect(MAIL_RECIPIENT_ITEM_CLASS).toMatch(/\bmin-w-0\b/);
    expect(MAIL_RECIPIENT_ITEM_CLASS).toMatch(/\bmax-w-full\b/);
    expect(MAIL_RECIPIENT_ITEM_CLASS).toMatch(/break-all/);
  });

  it('MailDisplay uses the bounded recipient-line classes', () => {
    expect(source).toContain('MAIL_RECIPIENT_HEADER_CLASS');
    expect(source).toContain('MAIL_RECIPIENT_FIELDS_CLASS');
    expect(source).toContain('MAIL_RECIPIENT_LINE_CLASS');
    expect(source).toContain('MAIL_RECIPIENT_ITEM_CLASS');
    expect(source).not.toContain(
      'className="flex flex-wrap items-start justify-between gap-2"',
    );
  });
});

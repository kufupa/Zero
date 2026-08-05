import { describe, expect, it } from 'vitest';
import { constructForwardBody, constructReplyBody } from '../lib/utils';

describe('constructReplyBody', () => {
  it('includes quoted prior body after the wrote header', () => {
    const html = constructReplyBody(
      '<p>hiii</p>',
      '7/23/2026, 11:33:26 AM',
      { name: 'aroransh17', email: 'aroransh17@gmail.com' },
      [{ name: 'Nava', email: 'navaai@legacyhotels.co.za' }],
      '<p>hi!!</p>',
    );

    expect(html).toContain('wrote:');
    expect(html).toContain('<p>hi!!</p>');
    expect(html).toContain('<p>hiii</p>');
    expect(html).toContain('class="gmail_quote"');
  });

  it('puts the original sender email in the wrote header', () => {
    const html = constructReplyBody(
      '<p>hiii</p>',
      '7/23/2026, 11:33:26 AM',
      { name: 'aroransh17', email: 'aroransh17@gmail.com' },
      [{ name: 'Nava', email: 'navaai@legacyhotels.co.za' }],
      '<p>hi!!</p>',
    );
    expect(html).toContain('aroransh17@gmail.com');
    expect(html).not.toContain('navaai@legacyhotels.co.za');
  });

  it('uses Outlook Calibri body stack not apple-system', () => {
    const html = constructReplyBody(
      '<p>hiii</p>',
      '7/23/2026, 11:33:26 AM',
      { name: 'aroransh17', email: 'aroransh17@gmail.com' },
      [{ name: 'Nava', email: 'navaai@legacyhotels.co.za' }],
      '<p>hi!!</p>',
    );
    expect(html).toContain('nava-mail-body');
    expect(html).toContain('Calibri, Arial, sans-serif');
    expect(html).toContain('font-size: 11pt');
    expect(html).not.toContain('apple-system');
  });
});

describe('constructForwardBody', () => {
  it('includes quoted prior body after the forward header', () => {
    const html = constructForwardBody(
      '<p>fyi</p>',
      'Thu',
      { name: 'Ann', email: 'ann@x.com', subject: 'Hello' },
      [{ email: 'bob@x.com' }],
      '<p>original body</p>',
    );

    expect(html).toContain('Forwarded message');
    expect(html).toContain('<p>original body</p>');
    expect(html).toContain('<p>fyi</p>');
  });

  it('uses Outlook Calibri body stack not apple-system', () => {
    const html = constructForwardBody(
      '<p>fyi</p>',
      'Thu',
      { name: 'Ann', email: 'ann@x.com', subject: 'Hello' },
      [{ email: 'bob@x.com' }],
      '<p>original body</p>',
    );
    expect(html).toContain('nava-mail-body');
    expect(html).toContain('Calibri, Arial, sans-serif');
    expect(html).toContain('font-size: 11pt');
    expect(html).not.toContain('apple-system');
  });
});

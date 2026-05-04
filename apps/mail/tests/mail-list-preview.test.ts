import { describe, expect, it } from 'vitest';
import { mailListPlainPreview } from '../lib/mail/mail-list-preview';

describe('mailListPlainPreview', () => {
  it('removes headings and inline formatting tags', () => {
    expect(
      mailListPlainPreview(
        '<h1>Guest Handover</h1><h2>Arrival readiness checklist</h2><p>Please review <strong>urgent</strong>, <em>timely</em>, <u>clear</u> and <s>outdated</s> items.</p>',
      ),
    ).toBe('Guest Handover Arrival readiness checklist Please review urgent, timely, clear and outdated items.');
  });

  it('removes spans and style noise', () => {
    expect(
      mailListPlainPreview('<p>Welcome <span style="color:red">package</span> ready</p>'),
    ).toBe('Welcome package ready');
  });

  it('returns empty for blank input', () => {
    expect(mailListPlainPreview('   ')).toBe('');
  });
});

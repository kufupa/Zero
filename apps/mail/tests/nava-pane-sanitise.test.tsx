/**
 * @vitest-environment happy-dom
 */
import type { DraftedDetails } from '../components/nava-pane/use-insert-ai-draft';
import { DraftPreviewBlock } from '../components/nava-pane/blocks/draft-preview';
import { sanitizeMailBodyHtml } from '../lib/mail/sanitize-mail-body-html';
import { cleanup, render } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';

const HOSTILE =
  '<p onclick="steal()">Hi Ada</p><script>alert(1)</script><a href="javascript:alert(2)">pay</a>';

// Same shape as the option tables multiOptionDraftHtml writes.
const QUOTE_REPLY =
  '<h3>Option A</h3><table border="1" cellpadding="6" cellspacing="0" style="border-collapse:collapse;width:100%">' +
  '<thead><tr><th align="left">DATE</th></tr></thead><tbody><tr><td align="right">R1,000.00</td></tr></tbody></table>';

const DETAILS: DraftedDetails = {
  entryId: 'entry-1',
  subject: 'Quote request',
  sender: 'Ada',
  senderEmail: 'ada@example.test',
  planName: 'Quote A.pdf',
};

const OPTIONS = { shouldLoadImages: true, inlineStyles: true };

afterEach(cleanup);

describe('sanitizeMailBodyHtml for draft replies', () => {
  it('strips script, inline handlers and javascript: links', () => {
    const { html } = sanitizeMailBodyHtml(HOSTILE, OPTIONS);

    expect(html).toContain('Hi Ada');
    expect(html).not.toContain('<script');
    expect(html).not.toMatch(/onclick/i);
    expect(html).not.toMatch(/javascript:/i);
  });

  it('keeps quote tables and their inline styles', () => {
    const { html } = sanitizeMailBodyHtml(QUOTE_REPLY, OPTIONS);

    expect(html).toContain('<table');
    expect(html).toContain('style="border-collapse:collapse;width:100%"');
    expect(html).toContain('<td align="right">R1,000.00</td>');
  });

  it('drops positioning and url() declarations from inline styles', () => {
    const { html } = sanitizeMailBodyHtml(
      '<p style="position:fixed;top:0;background:url(https://tracker.example/p.gif);color:red">x</p>',
      OPTIONS,
    );

    expect(html).not.toMatch(/position|url\(|tracker/);
    expect(html).toContain('color:red');
  });

  it('keeps mail bodies free of style attributes unless a caller asks for them', () => {
    const { html } = sanitizeMailBodyHtml(QUOTE_REPLY, { shouldLoadImages: true });

    expect(html).not.toContain('style=');
    expect(html).toContain('<table');
  });
});

describe('DraftPreviewBlock', () => {
  it('renders the quote reply without scripts or handlers, keeping its styles', () => {
    const preview: DraftedDetails = { ...DETAILS, previewHtml: HOSTILE + QUOTE_REPLY };
    const { container } = render(
      <DraftPreviewBlock details={preview} reviewedReplyHtml="" onDismiss={() => {}} />,
    );

    expect(container.querySelector('script')).toBeNull();
    expect(container.querySelector('[onclick]')).toBeNull();
    expect(container.querySelector('a[href^="javascript:"]')).toBeNull();
    expect(container.querySelector('table')?.getAttribute('style')).toBe(
      'border-collapse:collapse;width:100%',
    );
  });

  it('sanitises the reviewed reply the same way when there is no preview', () => {
    const reviewed = HOSTILE + QUOTE_REPLY;
    const { container } = render(
      <DraftPreviewBlock details={DETAILS} reviewedReplyHtml={reviewed} onDismiss={() => {}} />,
    );

    expect(container.textContent).toContain('Hi Ada');
    expect(container.querySelector('script')).toBeNull();
    expect(container.querySelector('[onclick]')).toBeNull();
    expect(container.querySelector('table')?.getAttribute('style')).toBe(
      'border-collapse:collapse;width:100%',
    );
  });
});

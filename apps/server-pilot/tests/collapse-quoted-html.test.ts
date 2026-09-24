import { describe, expect, it } from 'vitest';
import {
  collapseQuotedHtml,
  processQuotedContent,
} from '../src/mail/collapse-quoted-html.js';

describe('collapseQuotedHtml', () => {
  it('wraps blockquote in closed details with ellipsis summary', () => {
    const input = `<p>new reply</p><blockquote><p>old message hi!!</p></blockquote>`;
    const out = collapseQuotedHtml(input);

    expect(out).toContain('new reply');
    expect(out).toContain('old message hi!!');
    expect(out).toContain('<details class="quoted-toggle"');
    expect(out).toContain('quoted-toggle-ellipsis');
    expect(out).toContain('aria-label="Show message history"');
    expect(out).not.toMatch(/<details[^>]*\sopen[\s>]/i);
  });

  it('wraps .gmail_quote blocks', () => {
    const input = `<div>hi</div><div class="gmail_quote"><p>prior</p></div>`;
    const out = collapseQuotedHtml(input);
    expect(out).toContain('quoted-toggle');
    expect(out).toContain('prior');
  });

  it('collapses Outlook #divRplyFwdMsg container into a single details toggle', () => {
    const input = `<p>Here is my reply</p>
<div id="divRplyFwdMsg" dir="ltr" class="gmail_quote" style="border-top:solid #E1E1E1 1.0pt;padding-top:3.0pt;">
  <hr style="display:inline-block;width:98%" size="1">
  <div style="font-family: Calibri, Arial, sans-serif; font-size: 11pt;">
    <b>From:</b> Centurion Hotel &lt;centurion@legacyhotels.co.za&gt;<br>
    <b>Sent:</b> Wednesday, September 9, 2026 2:00 PM<br>
    <b>To:</b> Guest &lt;guest@example.com&gt;<br>
    <b>Subject:</b> RE: Booking Confirmation<br>
  </div>
  <div><br></div>
  <div id="zero-quoted-content">
    <p>Dear Guest, Your reservation is confirmed.</p>
  </div>
</div>`;

    const out = collapseQuotedHtml(input);
    const toggles = out.match(/<details class="quoted-toggle"/g) ?? [];

    expect(toggles).toHaveLength(1);
    expect(out).toContain('Here is my reply');
    expect(out).toMatch(/quoted-toggle-body[\s\S]*centurion@legacyhotels\.co\.za[\s\S]*Your reservation is confirmed/);
  });

  it('collapses loose Outlook hr separator and header siblings', () => {
    const input = `<p>Thank you</p>
<hr>
<b>From:</b> Martha Mthembu<br>
<b>Sent:</b> Wednesday, September 9, 2026<br>
<p>Original body text</p>`;

    const out = collapseQuotedHtml(input);
    const toggles = out.match(/<details class="quoted-toggle"/g) ?? [];

    expect(toggles).toHaveLength(1);
    expect(out).toContain('Thank you');
    expect(out).toMatch(/quoted-toggle-body[\s\S]*Martha Mthembu/);
  });

  it('does not double-wrap already collapsed quotes', () => {
    const once = collapseQuotedHtml(`<blockquote><p>x</p></blockquote>`);
    const twice = collapseQuotedHtml(once);
    expect(twice.match(/<details class="quoted-toggle"/g)?.length).toBe(1);
  });

  it('collapses nested gmail_quote + blockquote to a single outermost toggle', () => {
    // Classic Gmail reply MIME: outer .gmail_quote wrapping attribution + nested blockquote history
    const input = `<p>hiii</p>
<div class="gmail_quote">
  On Thu, Jul 23, 2026 at 3:16 PM &lt;navaai@legacyhotels.co.za&gt; wrote:<br>
  <blockquote class="gmail_quote">
    <p>hi!!</p>
    <div class="gmail_quote">
      On 7/23/2026, 11:33:26 AM, aroransh17 wrote:
      <p>earlier</p>
    </div>
  </blockquote>
</div>`;

    const out = collapseQuotedHtml(input);
    const toggles = out.match(/<details class="quoted-toggle"/g) ?? [];

    expect(toggles).toHaveLength(1);
    expect(out).toContain('hiii');
    expect(out).toContain('hi!!');
    expect(out).toContain('earlier');
    expect(out).toContain('navaai@legacyhotels.co.za');
    // Attribution + full nested stream live inside the one collapsed body
    expect(out).toMatch(
      /quoted-toggle-body[\s\S]*navaai@legacyhotels\.co\.za[\s\S]*hi!![\s\S]*earlier/,
    );
  });

  it('still collapses sibling top-level quotes separately', () => {
    const input = `<p>a</p><blockquote><p>one</p></blockquote><p>mid</p><blockquote><p>two</p></blockquote>`;
    const out = collapseQuotedHtml(input);
    expect(out.match(/<details class="quoted-toggle"/g)?.length).toBe(2);
  });
});

describe('processQuotedContent', () => {
  it('injects styles when quotes are collapsed', () => {
    const out = processQuotedContent(
      `<p>a</p><blockquote><p>b</p></blockquote>`,
      'dark',
    );
    expect(out).toContain('data-quoted-toggle-styles');
    expect(out).toContain('quoted-toggle');
    // Match Zero mail chrome tokens (thread ThreeDots / #313131)
    expect(out).toContain('#313131');
  });

  it('leaves plain html without styles when no quotes', () => {
    const out = processQuotedContent('<p>only new</p>', 'light');
    expect(out).toBe('<p>only new</p>');
    expect(out).not.toContain('data-quoted-toggle-styles');
  });
});

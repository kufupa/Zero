import * as cheerio from 'cheerio';

const ELLIPSIS_SUMMARY = `<summary class="quoted-toggle-ellipsis" aria-label="Show message history" title="Show message history">⋯</summary>`;

/**
 * Collapse quoted reply blocks behind a Gmail/Outlook-style ellipsis control.
 * View-layer only — does not alter stored MIME.
 */
export function collapseQuotedHtml(html: string): string {
  if (!html || !html.includes('<')) return html;

  const $ = cheerio.load(html, null, false);

  const collapseSelector = (selector: string) => {
    $(selector).each((_, el) => {
      const $el = $(el);
      if ($el.parents('details.quoted-toggle').length) return;

      const innerHtml = $el.html();
      if (typeof innerHtml !== 'string' || !innerHtml.trim()) return;

      const detailsHtml = `<details class="quoted-toggle">${ELLIPSIS_SUMMARY}<div class="quoted-toggle-body">${innerHtml}</div></details>`;
      $el.replaceWith(detailsHtml);
    });
  };

  collapseSelector('blockquote');
  collapseSelector('.gmail_quote');

  return $.root().html() ?? html;
}

/** Minimal CSS injected into processed email HTML for the ellipsis control. */
export function quotedToggleStyles(theme: 'light' | 'dark' = 'light'): string {
  const border = theme === 'dark' ? '#4b5563' : '#d1d5db';
  const bg = theme === 'dark' ? '#374151' : '#e5e7eb';
  const fg = theme === 'dark' ? '#e5e7eb' : '#374151';

  return `<style data-quoted-toggle-styles>
details.quoted-toggle {
  margin-top: 0.75rem;
  border: none;
}
details.quoted-toggle > summary.quoted-toggle-ellipsis {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  min-width: 2rem;
  height: 1.25rem;
  padding: 0 0.5rem;
  margin: 0.25rem 0;
  cursor: pointer;
  user-select: none;
  list-style: none;
  border-radius: 0.25rem;
  border: 1px solid ${border};
  background: ${bg};
  color: ${fg};
  font-size: 0.875rem;
  line-height: 1;
  letter-spacing: 0.05em;
}
details.quoted-toggle > summary.quoted-toggle-ellipsis::-webkit-details-marker {
  display: none;
}
details.quoted-toggle > .quoted-toggle-body {
  margin-top: 0.5rem;
  padding-left: 0.5rem;
  border-left: 2px solid ${border};
}
</style>`;
}

export function processQuotedContent(
  html: string,
  theme: 'light' | 'dark' = 'light',
): string {
  const collapsed = collapseQuotedHtml(html);
  if (collapsed === html && !html.includes('quoted-toggle')) {
    // Still may have collapsed nothing — only inject styles when toggles present
  }
  if (!collapsed.includes('quoted-toggle')) return collapsed;
  return `${quotedToggleStyles(theme)}${collapsed}`;
}

import * as cheerio from 'cheerio';

const QUOTE_ROOT_SELECTOR =
  'blockquote, .gmail_quote, #divRplyFwdMsg, [id="divRplyFwdMsg"], .OutlookMessageHeader';

/** Inline ThreeDots path matching apps/mail icons — shadow DOM can't use React/lucide. */
const ELLIPSIS_ICON = `<svg class="quoted-toggle-icon" width="12" height="4" viewBox="0 0 12 4" fill="currentColor" xmlns="http://www.w3.org/2000/svg" aria-hidden="true"><path d="M0 2C0 1.17157 0.671573 0.5 1.5 0.5C2.32843 0.5 3 1.17157 3 2C3 2.82843 2.32843 3.5 1.5 3.5C0.671573 3.5 0 2.82843 0 2Z"/><path d="M4.5 2C4.5 1.17157 5.17157 0.5 6 0.5C6.82843 0.5 7.5 1.17157 7.5 2C7.5 2.82843 6.82843 3.5 6 3.5C5.17157 3.5 4.5 2.82843 4.5 2Z"/><path d="M10.5 0.5C9.67157 0.5 9 1.17157 9 2C9 2.82843 9.67157 3.5 10.5 3.5C11.3284 3.5 12 2.82843 12 2C12 1.17157 11.3284 0.5 10.5 0.5Z"/></svg>`;

const ELLIPSIS_SUMMARY = `<summary class="quoted-toggle-ellipsis" aria-label="Show message history" title="Show message history">${ELLIPSIS_ICON}</summary>`;

/**
 * Collapse quoted reply blocks behind a Gmail/Outlook-style ellipsis control.
 * Only outermost quote roots — one toggle reveals the full nested history stream.
 * View-layer only — does not alter stored MIME.
 */
export function collapseQuotedHtml(html: string): string {
  if (!html || !html.includes('<')) return html;

  const $ = cheerio.load(html, null, false);

  // Group loose Outlook hr separators and following header siblings into divRplyFwdMsg
  $('hr').each((_, hrEl) => {
    const $hr = $(hrEl);
    if ($hr.parents(QUOTE_ROOT_SELECTOR).length || $hr.parents('details.quoted-toggle').length) return;
    const nextText = $hr.nextAll().text();
    if (/From:[\s\S]*?(?:Sent|Date):/i.test(nextText)) {
      const siblings = $hr.nextAll();
      const quoteContainer = $('<div id="divRplyFwdMsg" class="gmail_quote"></div>');
      $hr.before(quoteContainer);
      quoteContainer.append($hr);
      quoteContainer.append(siblings);
    }
  });

  $(QUOTE_ROOT_SELECTOR).each((_, el) => {
    const $el = $(el);
    // Skip nested quotes — outer root already covers the full stream (Gmail/Outlook).
    if ($el.parents(QUOTE_ROOT_SELECTOR).length) return;
    if ($el.parents('details.quoted-toggle').length) return;

    const innerHtml = $el.html();
    if (typeof innerHtml !== 'string' || !innerHtml.trim()) return;

    const detailsHtml = `<details class="quoted-toggle">${ELLIPSIS_SUMMARY}<div class="quoted-toggle-body">${innerHtml}</div></details>`;
    $el.replaceWith(detailsHtml);
  });

  return $.root().html() ?? html;
}

/**
 * Injected into shadow DOM — must use hex literals (no Tailwind / CSS vars pierce).
 * Matches thread chrome: h-7 w-7 rounded-lg dark:bg-[#313131] + iconDark/iconLight.
 */
export function quotedToggleStyles(theme: 'light' | 'dark' = 'light'): string {
  const isDark = theme === 'dark';
  const border = isDark ? 'transparent' : '#e4e4e7'; // --border light; dark buttons are borderless
  const bg = isDark ? '#313131' : '#ffffff';
  const bgHover = isDark ? '#404040' : '#f4f4f5';
  const fg = isDark ? '#898989' : '#6D6D6D'; // --iconDark / --iconLight
  const quoteBorder = isDark ? '#313135' : '#e4e4e7';

  return `<style data-quoted-toggle-styles>
details.quoted-toggle {
  margin-top: 0.75rem;
  border: none;
}
details.quoted-toggle > summary.quoted-toggle-ellipsis {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 1.75rem;
  height: 1.75rem;
  min-width: 1.75rem;
  padding: 0;
  margin: 0.25rem 0;
  cursor: pointer;
  user-select: none;
  list-style: none;
  border-radius: 0.5rem;
  border: 1px solid ${border};
  background: ${bg};
  color: ${fg};
  line-height: 1;
  transition: background-color 150ms ease, color 150ms ease;
}
details.quoted-toggle > summary.quoted-toggle-ellipsis:hover {
  background: ${bgHover};
}
details.quoted-toggle > summary.quoted-toggle-ellipsis:focus-visible {
  outline: 2px solid ${isDark ? '#a1a1aa' : '#71717a'};
  outline-offset: 2px;
}
details.quoted-toggle > summary.quoted-toggle-ellipsis::-webkit-details-marker {
  display: none;
}
details.quoted-toggle > summary.quoted-toggle-ellipsis .quoted-toggle-icon {
  display: block;
  flex-shrink: 0;
}
details.quoted-toggle > .quoted-toggle-body {
  margin-top: 0.5rem;
  padding-left: 0.5rem;
  border-left: 2px solid ${quoteBorder};
  color: inherit;
}
</style>`;
}

export function processQuotedContent(
  html: string,
  theme: 'light' | 'dark' = 'light',
): string {
  const collapsed = collapseQuotedHtml(html);
  if (!collapsed.includes('quoted-toggle')) return collapsed;
  return `${quotedToggleStyles(theme)}${collapsed}`;
}

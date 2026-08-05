export const MAIL_BODY_FONT_FAMILY = 'Calibri, Arial, sans-serif';
export const MAIL_BODY_FONT_SIZE = '11pt';

const MARKER_CLASS = 'nava-mail-body';

export function wrapMailBodyHtml(html: string): string {
  if (!html) return html;
  if (html.includes(MARKER_CLASS)) return html;
  const style = `font-family: ${MAIL_BODY_FONT_FAMILY}; font-size: ${MAIL_BODY_FONT_SIZE}; color: #000000;`;
  return `<div class="${MARKER_CLASS}" style="${style}">${html}</div>`;
}

export function mailBodyDisplayStyleTag(): string {
  return `<style data-nava-mail-font="1">
:host, .mail-content-root, .nava-mail-body {
  font-family: ${MAIL_BODY_FONT_FAMILY};
  font-size: ${MAIL_BODY_FONT_SIZE};
}
</style>`;
}

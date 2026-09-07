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
  display: block;
  max-width: 100%;
  font-family: ${MAIL_BODY_FONT_FAMILY};
  font-size: ${MAIL_BODY_FONT_SIZE};
  color: #000000;
  white-space: normal;
  overflow-wrap: anywhere;
  word-break: break-word;
}
:host table {
  width: auto !important;
  max-width: 100% !important;
}
:host img {
  max-width: 100% !important;
  object-fit: contain;
}
:host td, :host th, :host p, :host div, :host li, :host span {
  overflow-wrap: anywhere !important;
  word-break: break-word !important;
  max-width: 100%;
}
:host pre, :host code {
  white-space: pre-wrap !important;
  overflow-wrap: anywhere;
}
:host p.MsoNormal {
  margin: 0;
}
</style>`;
}

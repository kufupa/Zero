import { wrapMailBodyHtml } from './mail-body-typography.js';

/** Single outbound font choke point for mail.send (persist + SMTP). */
export function prepareOutboundHtml(html: string): string {
  return wrapMailBodyHtml(html);
}

export const MAIL_MESSAGE_ROOT_SELECTOR = '#mail-thread-panel [data-mail-message-id]';

export type HarnessRequest = {
  url: string;
  method: string;
  postData?: string | null;
};

export type BlockedHarnessRequestReason = 'mail-send' | 'non-loopback-http' | 'unsupported-scheme';

function isLoopbackHostname(hostname: string): boolean {
  return ['127.0.0.1', 'localhost', '::1', '[::1]'].includes(hostname.toLowerCase());
}

export function blockedHarnessRequestReason(
  request: HarnessRequest,
): BlockedHarnessRequestReason | null {
  const requestText = `${request.url}\n${request.postData ?? ''}`;
  if (request.method.toUpperCase() === 'POST' && requestText.includes('mail.send')) {
    return 'mail-send';
  }

  let parsed: URL;
  try {
    parsed = new URL(request.url);
  } catch {
    return 'unsupported-scheme';
  }
  if (parsed.protocol === 'data:' || parsed.protocol === 'blob:') return null;
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    return 'unsupported-scheme';
  }
  return isLoopbackHostname(parsed.hostname) ? null : 'non-loopback-http';
}

export function requireLoopbackBaseUrl(raw: string): string {
  const parsed = new URL(raw);
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error(`Rocketseed pixel gate requires HTTP(S) baseURL (protocol=${parsed.protocol})`);
  }
  if (!isLoopbackHostname(parsed.hostname)) {
    throw new Error(`Rocketseed pixel gate refuses non-loopback baseURL (host=${parsed.hostname})`);
  }
  return raw;
}

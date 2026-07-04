import type { HeaderDebugLine } from '@/types';

export const NAVA_TRANSPORT_ID = 'transport-nava';
export const HEADER_DEBUG_STORAGE_KEY = 'zero-dev-show-headers';

export function canShowHeaderDebug(
  transportId: string | null | undefined,
): boolean {
  return transportId === NAVA_TRANSPORT_ID;
}

export function isHeaderDebugEnabled(): boolean {
  if (typeof window === 'undefined') return false;
  try {
    return window.localStorage.getItem(HEADER_DEBUG_STORAGE_KEY) === '1';
  } catch {
    return false;
  }
}

export function setHeaderDebugEnabled(enabled: boolean): void {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.setItem(HEADER_DEBUG_STORAGE_KEY, enabled ? '1' : '0');
  } catch {
    return;
  }
}

export function buildOutboundHeaderPreview(args: {
  transportEmail: string | null | undefined;
  messageId?: string | null;
  inReplyTo?: string | null;
  references?: string | string[] | null;
}): HeaderDebugLine[] {
  if (!args.transportEmail) return [];
  const refs = Array.isArray(args.references)
    ? args.references
    : args.references?.split(/\s+/).filter(Boolean) ?? [];
  const lines: HeaderDebugLine[] = [
    { key: 'x-zero-mailbox', line: `X-Zero-Mailbox: ${args.transportEmail}` },
  ];
  if (args.messageId) lines.push({ key: 'message-id', line: `Message-ID: ${args.messageId}` });
  if (args.inReplyTo) lines.push({ key: 'in-reply-to', line: `In-Reply-To: ${args.inReplyTo}` });
  if (refs.length) lines.push({ key: 'references', line: `References: ${refs.join(' ')}` });
  return lines;
}

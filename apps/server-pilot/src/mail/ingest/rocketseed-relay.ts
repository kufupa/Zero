import { isIP } from 'node:net';

export const DEFAULT_ROCKETSEED_RELAY_IP = '172.24.0.8';

export type RawHeaderLine = {
  key: string;
  line: string;
};

export function resolveTrustedRocketseedRelayIp(
  override: string | undefined,
): string | null {
  if (override === undefined || override === '') {
    return DEFAULT_ROCKETSEED_RELAY_IP;
  }
  if (override !== override.trim() || isIP(override) === 0) return null;
  return override;
}

export function hasTrustedTopReceivedHeader(
  rawHeaderLines: readonly RawHeaderLine[],
  override = process.env.ROCKETSEED_TRUSTED_RELAY_IP,
): boolean {
  const trustedIp = resolveTrustedRocketseedRelayIp(override);
  if (!trustedIp) return false;
  const topReceived = rawHeaderLines.find(
    (header) => header.key.trim().toLowerCase() === 'received',
  );
  if (!topReceived) return false;

  // Deliberately strict until canary MIME confirms the production relay shape.
  // The trusted address must be the bracketed peer literal in `from (...) by`.
  const peerMatch = topReceived.line.match(
    /^Received:\s+from\s+\S+\s+\([^()[\]]*\[(?:IPv6:)?([^\]]+)\][^()]*\)\s+by(?:\s|$)/i,
  );
  const peerIp = peerMatch?.[1];
  if (!peerIp || isIP(peerIp) === 0) return false;
  return peerIp.toLowerCase() === trustedIp.toLowerCase();
}

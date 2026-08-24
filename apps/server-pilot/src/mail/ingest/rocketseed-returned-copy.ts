export type RocketseedReturnedCopyTrustReason =
  | 'transport_identity_mismatch'
  | 'owner_mismatch'
  | 'sender_mismatch'
  | 'sent_queue_row_missing'
  | 'received_missing'
  | 'received_malformed'
  | 'received_topology_mismatch';

export type RocketseedReturnedCopyTrustResult =
  | { trusted: true }
  | { trusted: false; reason: RocketseedReturnedCopyTrustReason };

export interface RocketseedReturnedCopyTrustInput {
  activeTransportId: string | null;
  expectedTransportId: string;
  expectedTransportAddress: string;
  hasEligibleLocalSentQueueRow: boolean;
  parsed: {
    ownerHeaderValue: string | null;
    fromAddress: string | null;
    rawHeaderLines: ReadonlyArray<{ key: string; line: string }>;
  };
}

type ReceivedRole = 'zimbra' | 'local' | 'rocket' | 'other';

const TRUSTED_RECEIVED_PREFIX: readonly ReceivedRole[] = [
  'zimbra',
  'local',
  'local',
  'rocket',
  'rocket',
];

export function evaluateRocketseedReturnedCopyTrust(
  input: RocketseedReturnedCopyTrustInput,
): RocketseedReturnedCopyTrustResult {
  if (
    !input.activeTransportId ||
    !input.expectedTransportId ||
    input.activeTransportId !== input.expectedTransportId
  ) {
    return rejected('transport_identity_mismatch');
  }

  const expectedAddress = normalizeAddress(input.expectedTransportAddress);
  if (!expectedAddress || normalizeAddress(input.parsed.ownerHeaderValue) !== expectedAddress) {
    return rejected('owner_mismatch');
  }

  if (normalizeAddress(input.parsed.fromAddress) !== expectedAddress) {
    return rejected('sender_mismatch');
  }

  if (!input.hasEligibleLocalSentQueueRow) {
    return rejected('sent_queue_row_missing');
  }

  return verifyReceivedTopology(input.parsed.rawHeaderLines);
}

function verifyReceivedTopology(
  rawHeaderLines: ReadonlyArray<{ key: string; line: string }>,
): RocketseedReturnedCopyTrustResult {
  const roles: ReceivedRole[] = [];

  for (const header of rawHeaderLines) {
    if (header.key.toLowerCase() !== 'received') continue;
    if (isMalformedReceivedHeader(header.line)) {
      return rejected('received_malformed');
    }
    roles.push(receivedRole(header.line));
  }

  if (roles.length === 0) return rejected('received_missing');

  const hasTrustedPrefix = TRUSTED_RECEIVED_PREFIX.every((role, index) => roles[index] === role);
  return hasTrustedPrefix ? { trusted: true } : rejected('received_topology_mismatch');
}

function normalizeAddress(value: string | null): string | null {
  if (!value) return null;
  const trimmed = value.trim();
  const bracketed = trimmed.match(/<([^<>]+)>/)?.[1]?.trim();
  const address = bracketed ?? trimmed;
  return address ? address.toLowerCase() : null;
}

function isMalformedReceivedHeader(value: string): boolean {
  return (
    !value ||
    value.includes('\r') ||
    value.includes('\n') ||
    !/^received:\s+from\s+\S.+\s+by\s+\S/i.test(value)
  );
}

function receivedRole(value: string): ReceivedRole {
  const source = /^received:\s+from\s+(.+?)\s+by\s+/i.exec(value)?.[1];
  if (!source) return 'other';
  const normalized = source.toLowerCase();
  if (
    normalized.includes('rocketseed') ||
    normalized.includes('branding.legacyhotels.co.za') ||
    normalized.includes('172.24.0.8')
  ) {
    return 'rocket';
  }
  if (normalized.includes('zimbra') || normalized.includes('172.24.0.10')) {
    return 'zimbra';
  }
  if (/\blocal(?:host)?\b/.test(normalized)) return 'local';
  return 'other';
}

function rejected(reason: RocketseedReturnedCopyTrustReason): RocketseedReturnedCopyTrustResult {
  return { trusted: false, reason };
}

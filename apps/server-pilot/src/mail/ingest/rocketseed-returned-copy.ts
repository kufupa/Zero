export type RocketseedReturnedCopyTrustReason =
  | 'transport_identity_mismatch'
  | 'owner_mismatch'
  | 'sender_mismatch'
  | 'eligible_queue_row_missing'
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
  hasEligibleLocalQueueRow: boolean;
  parsed: {
    ownerHeaderValue: string | null;
    fromAddress: string | null;
    rawHeaderLines: ReadonlyArray<{ key: string; line: string }>;
  };
}

export type RocketseedReturnedCopyPrecheckInput = Pick<
  RocketseedReturnedCopyTrustInput,
  'expectedTransportAddress' | 'parsed'
>;

type ReceivedRole = 'zimbra' | 'local' | 'rocket' | 'other';

const TRUSTED_RECEIVED_PREFIX: readonly ReceivedRole[] = [
  'zimbra',
  'local',
  'local',
  'rocket',
  'rocket',
];
const ZIMBRA_SOURCE_IDENTITIES = new Set(['172.24.0.10']);
const LOCAL_SOURCE_IDENTITIES = new Set(['localhost']);
const ROCKETSEED_SOURCE_IDENTITIES = new Set(['172.24.0.8', 'branding.legacyhotels.co.za']);
const MAILBOX =
  /^[A-Z0-9.!#$%&'*+/=?^_`{|}~-]+@[A-Z0-9](?:[A-Z0-9-]*[A-Z0-9])?(?:\.[A-Z0-9](?:[A-Z0-9-]*[A-Z0-9])?)*$/i;
const TRUST_REJECTION_MESSAGE_TYPE = 'rocketseed_returned_copy_trust_rejected';

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

  const addressCheck = evaluateExpectedAddressing(input);
  if (addressCheck) return addressCheck;

  if (!input.hasEligibleLocalQueueRow) {
    return rejected('eligible_queue_row_missing');
  }

  return verifyReceivedTopology(input.parsed.rawHeaderLines);
}

/**
 * Queue-independent gate for legacy Message-ID candidate lookup. The complete
 * trust evaluator still runs after canonical lookup before reconciliation.
 */
export function evaluateRocketseedReturnedCopyPrecheck(
  input: RocketseedReturnedCopyPrecheckInput,
): RocketseedReturnedCopyTrustResult {
  const addressCheck = evaluateExpectedAddressing(input);
  if (addressCheck) return addressCheck;
  return verifyReceivedTopology(input.parsed.rawHeaderLines);
}

/** Deliberately omit all message metadata from aggregate trust diagnostics. */
export function emitRocketseedReturnedCopyTrustRejection(
  reason: RocketseedReturnedCopyTrustReason,
): void {
  console.warn(
    JSON.stringify({
      messageType: TRUST_REJECTION_MESSAGE_TYPE,
      reason,
    }),
  );
}

function evaluateExpectedAddressing(
  input: RocketseedReturnedCopyPrecheckInput,
): Extract<RocketseedReturnedCopyTrustResult, { trusted: false }> | null {
  const expectedAddress = normalizeRocketseedMailbox(input.expectedTransportAddress);
  if (
    !expectedAddress ||
    normalizeRocketseedMailbox(input.parsed.ownerHeaderValue) !== expectedAddress
  ) {
    return rejected('owner_mismatch');
  }
  if (normalizeRocketseedMailbox(input.parsed.fromAddress) !== expectedAddress) {
    return rejected('sender_mismatch');
  }
  return null;
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

export function normalizeRocketseedMailbox(value: string | null): string | null {
  if (!value) return null;
  const trimmed = value.trim();
  const bracketed = /^(?:(?<display>[^<>]+?)\s+)?<(?<mailbox>[^<>\s]+)>$/.exec(trimmed);
  const display = bracketed?.groups?.display?.trim();
  const address = bracketed?.groups?.mailbox ?? trimmed;
  if (!address || !MAILBOX.test(address) || (display && /[,@;]/.test(display))) {
    return null;
  }
  return address.toLowerCase();
}

function isMalformedReceivedHeader(value: string): boolean {
  return !value || value.includes('\r') || value.includes('\n') || !receivedSourceIdentity(value);
}

function receivedRole(value: string): ReceivedRole {
  const sourceIdentity = receivedSourceIdentity(value);
  if (!sourceIdentity) return 'other';
  if (ROCKETSEED_SOURCE_IDENTITIES.has(sourceIdentity)) return 'rocket';
  if (ZIMBRA_SOURCE_IDENTITIES.has(sourceIdentity)) return 'zimbra';
  if (LOCAL_SOURCE_IDENTITIES.has(sourceIdentity)) return 'local';
  return 'other';
}

function receivedSourceIdentity(value: string): string | null {
  const source =
    /^received:\s+from\s+(\[[^\]\s]+\]|[^\s(]+)(?:\s+\([^)]*\))?\s+by\s+[^\s;]+(?:\s+(?:with|via|id|for)\s+(?:<[^<>\r\n;]+>|[^\s;\r\n]+))*\s*;\s*\S.*$/i.exec(
      value,
    )?.[1];
  if (!source) return null;
  const unbracketed = source.startsWith('[') && source.endsWith(']') ? source.slice(1, -1) : source;
  return unbracketed.toLowerCase();
}

function rejected(
  reason: RocketseedReturnedCopyTrustReason,
): Extract<RocketseedReturnedCopyTrustResult, { trusted: false }> {
  return { trusted: false, reason };
}

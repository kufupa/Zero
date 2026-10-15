import { createHash } from 'node:crypto';
import { canonicalMessageId } from './message-id.js';

export interface MailboxRouteTransport {
  id: string;
  email: string;
  isActive: boolean;
  sendFromConfig?: unknown;
}

export interface MailboxAddressSignals {
  fromAddress?: string | null;
  toAddresses?: readonly string[] | null;
  ccAddresses?: readonly string[] | null;
  bccAddresses?: readonly string[] | null;
}

export type MailboxPromotionRoute = {
  transportId: string;
  direction: 'inbound' | 'outbound';
};

export type MailboxPromotionRouteResult =
  | { kind: 'unmatched' }
  | { kind: 'routed'; transportId: string; direction: 'inbound' | 'outbound' }
  | { kind: 'ambiguous'; routes: MailboxPromotionRoute[] };

export function resolveMailboxPromotionRoute(
  signals: MailboxAddressSignals,
  transports: readonly MailboxRouteTransport[],
  options: { includeInactive?: boolean } = {},
): MailboxPromotionRouteResult {
  const sender = normalizeAddress(signals.fromAddress);
  const recipients = new Set(
    [...(signals.toAddresses ?? []), ...(signals.ccAddresses ?? []), ...(signals.bccAddresses ?? [])]
      .map(normalizeAddress)
      .filter(Boolean),
  );
  const routes: MailboxPromotionRoute[] = [];

  for (const transport of transports) {
    if (!transport.isActive && !options.includeInactive) continue;
    const identities = transportIdentitySet(transport);
    const senderMatch = Boolean(sender && identities.has(sender));
    const recipientMatch = [...recipients].some((address) => identities.has(address));
    if (!senderMatch && !recipientMatch) continue;
    routes.push({
      transportId: transport.id,
      direction: senderMatch && !recipientMatch ? 'outbound' : 'inbound',
    });
  }

  routes.sort((left, right) => left.transportId.localeCompare(right.transportId));
  if (routes.length === 0) return { kind: 'unmatched' };
  if (routes.length > 1) return { kind: 'ambiguous', routes };
  return { kind: 'routed', ...routes[0]! };
}

export function canonicalMailboxMessageKey(messageId: string | null | undefined, raw: Buffer): string {
  const canonical = canonicalMessageId(messageId);
  if (canonical && /^[^@\s<>]+@[^@\s<>]+$/.test(canonical)) {
    return `message-id:${canonical}`;
  }
  return `sha256:${createHash('sha256').update(raw).digest('hex')}`;
}

export interface MailboxDryRunCandidate {
  raw: Buffer;
  messageId?: string | null;
  signals: MailboxAddressSignals;
}

export interface MailboxDryRunCount {
  transportId: string;
  active: boolean;
  inboundCandidates: number;
  outboundCandidates: number;
  ambiguousCandidates: number;
  wouldPromote: number;
  wouldPromoteIfActivated: number;
  uniqueCanonicalMessages: number;
  duplicateCopies: number;
}

export interface MailboxSplitDryRunSummary {
  scanned: number;
  uniqueMessages: number;
  duplicateCopies: number;
  crossMailboxDuplicateKeys: number;
  ambiguousRows: number;
  unmatchedRows: number;
  mailboxes: MailboxDryRunCount[];
}

export function summarizeMailboxSplitDryRun(
  candidates: readonly MailboxDryRunCandidate[],
  transports: readonly MailboxRouteTransport[],
): MailboxSplitDryRunSummary {
  const byMailbox = new Map<string, MailboxDryRunCount>();
  const activeKeys = new Map<string, Set<string>>();
  const activeCounts = new Map<string, number>();
  const allMatchedTransportsByKey = new Map<string, Set<string>>();
  const allKeys = new Set<string>();
  let ambiguousRows = 0;
  let unmatchedRows = 0;

  for (const transport of transports) {
    byMailbox.set(transport.id, {
      transportId: transport.id,
      active: transport.isActive,
      inboundCandidates: 0,
      outboundCandidates: 0,
      ambiguousCandidates: 0,
      wouldPromote: 0,
      wouldPromoteIfActivated: 0,
      uniqueCanonicalMessages: 0,
      duplicateCopies: 0,
    });
    activeKeys.set(transport.id, new Set());
    activeCounts.set(transport.id, 0);
  }

  for (const candidate of candidates) {
    const key = canonicalMailboxMessageKey(candidate.messageId, candidate.raw);
    allKeys.add(key);
    const route = resolveMailboxPromotionRoute(candidate.signals, transports, { includeInactive: true });
    const routes = route.kind === 'routed' ? [route] : route.kind === 'ambiguous' ? route.routes : [];

    if (route.kind === 'unmatched') {
      unmatchedRows += 1;
      continue;
    }
    if (route.kind === 'ambiguous') ambiguousRows += 1;

    const matchedIds = allMatchedTransportsByKey.get(key) ?? new Set<string>();
    for (const matched of routes) {
      matchedIds.add(matched.transportId);
      const counts = byMailbox.get(matched.transportId);
      if (!counts) continue;
      if (matched.direction === 'inbound') counts.inboundCandidates += 1;
      else counts.outboundCandidates += 1;
      if (route.kind === 'ambiguous') {
        counts.ambiguousCandidates += 1;
      } else if (counts.active) {
        counts.wouldPromote += 1;
        activeCounts.set(matched.transportId, (activeCounts.get(matched.transportId) ?? 0) + 1);
        activeKeys.get(matched.transportId)?.add(key);
      } else {
        counts.wouldPromoteIfActivated += 1;
      }
    }
    allMatchedTransportsByKey.set(key, matchedIds);
  }

  for (const counts of byMailbox.values()) {
    const unique = activeKeys.get(counts.transportId)?.size ?? 0;
    counts.uniqueCanonicalMessages = unique;
    counts.duplicateCopies = (activeCounts.get(counts.transportId) ?? 0) - unique;
  }

  return {
    scanned: candidates.length,
    uniqueMessages: allKeys.size,
    duplicateCopies: candidates.length - allKeys.size,
    crossMailboxDuplicateKeys: [...allMatchedTransportsByKey.values()].filter((ids) => ids.size > 1)
      .length,
    ambiguousRows,
    unmatchedRows,
    mailboxes: [...byMailbox.values()].sort((left, right) =>
      left.transportId.localeCompare(right.transportId),
    ),
  };
}

function transportIdentitySet(transport: MailboxRouteTransport): Set<string> {
  const identities = new Set<string>();
  const email = normalizeAddress(transport.email);
  if (email) identities.add(email);
  if (!transport.sendFromConfig || typeof transport.sendFromConfig !== 'object') return identities;
  const aliases = (transport.sendFromConfig as { aliases?: unknown }).aliases;
  if (!Array.isArray(aliases)) return identities;
  for (const alias of aliases) {
    if (typeof alias !== 'string') continue;
    const normalized = normalizeAddress(alias);
    if (normalized) identities.add(normalized);
  }
  return identities;
}

function normalizeAddress(raw: string | null | undefined): string {
  const trimmed = (raw ?? '').trim().toLowerCase();
  return trimmed.match(/<([^<>]+)>/)?.[1]?.trim() ?? trimmed;
}

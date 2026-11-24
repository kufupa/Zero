/**
 * Pure request-time context projection for Centurion mail.
 * No DB, network, or writable attachment handles. Offline adapters feed authorized records.
 */
import { createHash } from 'node:crypto';
import { buildReferenceChain, canonicalMessageId } from './ingest/message-id.js';

export const REQUEST_TIME_CONTEXT_VERSION = 1 as const;

/** Full confirmation suffix as printed on native letters (e.g. 92227177-1). */
const FULL_CONF_RE = /\bn[°º]\s*(\d{6,10}-\d+)\b/gi;
const BARE_FULL_CONF_RE = /(?<![\w-])(\d{6,10}-\d+)(?![\w-])/g;

export type RequestTimeScope = {
  property: string;
  mailbox: string;
};

export type AuthorizedContextMessage = {
  id: string;
  threadId: string;
  rfcMessageId: string | null;
  inReplyTo: string | null;
  references: readonly string[];
  direction: 'inbound' | 'outbound';
  /** ISO-8601 with offset when known. */
  receivedAt: string;
  subject: string;
  /** Historically admissible body bytes decoded as text (untrusted content). */
  bodyText: string;
  fromEmail: string;
  attachmentRefs?: readonly {
    id: string;
    contentDigest?: string;
    /** Read-only extract already held by the caller; never a file handle. */
    textExcerpt?: string | null;
  }[];
};

export type RecordedContextEdge = {
  srcThreadId: string;
  dstThreadId: string;
  srcMessageId?: string | null;
  dstMessageId?: string | null;
  linkType: string;
  createdAt?: string | null;
  supersededAt?: string | null;
};

export type StrongContextRelation = 'header_parent' | 'domain_conf_full';

export type ProvenStrongLink = {
  srcThreadId: string;
  dstThreadId: string;
  srcMessageId: string;
  dstMessageId: string;
  relation: StrongContextRelation;
  /** Recorded when a then-visible edge matches; otherwise reconstructed from admissible bytes. */
  provenance: 'recorded' | 'reconstructed';
  evidenceRefs: string[];
};

export type RequestTimeEarlier = {
  sourceMessageId: string;
  threadId: string;
  relation: StrongContextRelation;
  evidenceRefs: string[];
  /** Content digest of body text; raw body only for projection consumers. */
  bodyRef: string;
  bodyText: string;
  attachmentRefs: {
    id: string;
    contentDigest?: string;
    extractedText: string | null;
  }[];
};

export type RequestTimeContextPacket = {
  version: typeof REQUEST_TIME_CONTEXT_VERSION;
  selectedId: string;
  cutoff: string;
  contextDigest: string;
  scope: RequestTimeScope;
  attested_by: 'nava_gateway' | 'nava_arrival' | 'offline';
  earlier: RequestTimeEarlier[];
};

export type RequestTimeContextResult =
  | { state: 'observed'; packet: RequestTimeContextPacket }
  | { state: 'unobserved'; reason: string; contextDigest: string };

function parseTime(value: string | null | undefined): number {
  if (value == null || value === '') return Number.NaN;
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? ms : Number.NaN;
}

function bodyDigest(text: string): string {
  return createHash('sha256').update(text).digest('hex');
}

function stableJson(value: unknown): string {
  return JSON.stringify(value, (_key, item: unknown) =>
    item && typeof item === 'object' && !Array.isArray(item)
      ? Object.fromEntries(Object.entries(item as Record<string, unknown>).sort(([a], [b]) =>
        a < b ? -1 : a > b ? 1 : 0))
      : item);
}

/** Extract full confirmation tokens from a single message's own admissible bytes. */
export function extractFullConfirmations(subject: string, bodyText: string, attachmentTexts: readonly string[] = []): string[] {
  const haystack = [subject, bodyText, ...attachmentTexts].join('\n');
  const found = new Set<string>();
  for (const re of [FULL_CONF_RE, BARE_FULL_CONF_RE]) {
    re.lastIndex = 0;
    for (const match of haystack.matchAll(re)) {
      const token = match[1]?.toLowerCase();
      if (token) found.add(token);
    }
  }
  return [...found].sort();
}

function messageHeaderIndex(messages: readonly AuthorizedContextMessage[]): Map<string, AuthorizedContextMessage> {
  const index = new Map<string, AuthorizedContextMessage>();
  for (const message of messages) {
    const id = canonicalMessageId(message.rfcMessageId);
    if (id) index.set(id, message);
  }
  return index;
}

function edgeVisibleAt(edge: RecordedContextEdge, cutoffMs: number): boolean {
  // Fail closed: unknown cutoff or unknown creation time → not visible at cutoff.
  if (!Number.isFinite(cutoffMs)) return false;
  const created = parseTime(edge.createdAt ?? undefined);
  if (!Number.isFinite(created) || created > cutoffMs) return false;
  const superseded = parseTime(edge.supersededAt ?? undefined);
  if (Number.isFinite(superseded) && superseded <= cutoffMs) return false;
  return true;
}

/**
 * Prove strong links only from headers / full confirmation text present in
 * historically admissible messages at or before cutoff. Same-domain-only and
 * weak proximity signals never create a link. Empty proof → no link.
 */
export function proveStrongLinksAtCutoff(
  messages: readonly AuthorizedContextMessage[],
  cutoff: string,
  recordedEdges: readonly RecordedContextEdge[] = [],
): ProvenStrongLink[] {
  const cutoffMs = parseTime(cutoff);
  if (!Number.isFinite(cutoffMs)) return [];

  const admissible = messages
    .filter((message) => {
      const at = parseTime(message.receivedAt);
      return Number.isFinite(at) && at <= cutoffMs;
    })
    .sort((a, b) => {
      const dt = parseTime(a.receivedAt) - parseTime(b.receivedAt);
      return dt !== 0 ? dt : a.id.localeCompare(b.id);
    });

  const byId = new Map(admissible.map((message) => [message.id, message]));
  const byHeader = messageHeaderIndex(admissible);
  const links: ProvenStrongLink[] = [];
  const seen = new Set<string>();

  const push = (link: ProvenStrongLink) => {
    const key = [link.relation, link.srcThreadId, link.dstThreadId, link.srcMessageId, link.dstMessageId].join('|');
    if (seen.has(key) || link.srcThreadId === link.dstThreadId) return;
    seen.add(key);
    links.push(link);
  };

  // Header / References: the child message's own headers must cite the parent.
  for (const child of admissible) {
    const chain = buildReferenceChain(child.inReplyTo, child.references ?? []);
    for (const ref of chain) {
      const parent = byHeader.get(ref);
      if (!parent || parent.threadId === child.threadId) continue;
      const parentAt = parseTime(parent.receivedAt);
      const childAt = parseTime(child.receivedAt);
      if (!(Number.isFinite(parentAt) && Number.isFinite(childAt)) || parentAt > childAt) continue;
      const evidenceRefs = [
        `header:${child.id}:in_reply_to_or_references`,
        `rfc:${parent.id}:${canonicalMessageId(parent.rfcMessageId) ?? ''}`,
      ];
      const recorded = recordedEdges.some((edge) =>
        edgeVisibleAt(edge, cutoffMs)
        && edge.linkType === 'header_parent'
        && ((edge.srcThreadId === parent.threadId && edge.dstThreadId === child.threadId)
          || (edge.srcThreadId === child.threadId && edge.dstThreadId === parent.threadId)));
      push({
        srcThreadId: parent.threadId,
        dstThreadId: child.threadId,
        srcMessageId: parent.id,
        dstMessageId: child.id,
        relation: 'header_parent',
        provenance: recorded ? 'recorded' : 'reconstructed',
        evidenceRefs,
      });
    }
  }

  // Full native confirmation: outbound confirmation must carry the suffix in its
  // own subject/body; inbound (or other thread) must independently print the same
  // full token in its own bytes. Matching a number that appears only in a later
  // reply does not count — that message is outside admissible set.
  const confirmations: { message: AuthorizedContextMessage; tokens: Set<string> }[] = [];
  for (const message of admissible) {
    const attachmentTexts = (message.attachmentRefs ?? [])
      .map((file) => file.textExcerpt)
      .filter((text): text is string => typeof text === 'string' && text.length > 0);
    const tokens = new Set(extractFullConfirmations(message.subject, message.bodyText, attachmentTexts));
    if (tokens.size) confirmations.push({ message, tokens });
  }

  for (const outbound of confirmations) {
    if (outbound.message.direction !== 'outbound') continue;
    const subjectLooksConfirm = /confirmation/i.test(outbound.message.subject);
    if (!subjectLooksConfirm && ![...outbound.tokens].some((token) =>
      new RegExp(`n[°º]\\s*${token.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`, 'i').test(
        `${outbound.message.subject}\n${outbound.message.bodyText}`))) {
      continue;
    }
    for (const other of confirmations) {
      if (other.message.id === outbound.message.id) continue;
      if (other.message.threadId === outbound.message.threadId) continue;
      const shared = [...outbound.tokens].filter((token) => other.tokens.has(token));
      if (shared.length !== 1) continue;
      const token = shared[0]!;
      const earlier = parseTime(outbound.message.receivedAt) <= parseTime(other.message.receivedAt)
        ? outbound.message : other.message;
      const later = earlier.id === outbound.message.id ? other.message : outbound.message;
      const evidenceRefs = [
        `conf:${outbound.message.id}:${token}`,
        `conf:${other.message.id}:${token}`,
      ];
      const recorded = recordedEdges.some((edge) =>
        edgeVisibleAt(edge, cutoffMs)
        && edge.linkType === 'domain_conf'
        && ((edge.srcThreadId === earlier.threadId && edge.dstThreadId === later.threadId)
          || (edge.srcThreadId === later.threadId && edge.dstThreadId === earlier.threadId)));
      push({
        srcThreadId: earlier.threadId,
        dstThreadId: later.threadId,
        srcMessageId: earlier.id,
        dstMessageId: later.id,
        relation: 'domain_conf_full',
        provenance: recorded ? 'recorded' : 'reconstructed',
        evidenceRefs,
      });
    }
  }

  // Drop recorded-only edges that cannot be re-proved from admissible bytes.
  void byId;
  return links;
}

function componentMembers(
  seedThreadId: string,
  links: readonly ProvenStrongLink[],
): Set<string> {
  const adj = new Map<string, Set<string>>();
  const add = (a: string, b: string) => {
    const left = adj.get(a) ?? new Set<string>();
    left.add(b);
    adj.set(a, left);
    const right = adj.get(b) ?? new Set<string>();
    right.add(a);
    adj.set(b, right);
  };
  for (const link of links) add(link.srcThreadId, link.dstThreadId);
  const out = new Set<string>([seedThreadId]);
  const stack = [seedThreadId];
  while (stack.length) {
    const id = stack.pop()!;
    for (const next of adj.get(id) ?? []) {
      if (out.has(next)) continue;
      out.add(next);
      stack.push(next);
    }
  }
  return out;
}

export function digestRequestTimeContext(parts: {
  scope: RequestTimeScope;
  selectedId: string;
  cutoff: string;
  earlier: readonly Omit<RequestTimeEarlier, 'bodyText'>[];
  attested_by: RequestTimeContextPacket['attested_by'];
}): string {
  return createHash('sha256').update(stableJson({
    version: REQUEST_TIME_CONTEXT_VERSION,
    scope: parts.scope,
    selectedId: parts.selectedId,
    cutoff: parts.cutoff,
    attested_by: parts.attested_by,
    earlier: parts.earlier.map((item) => ({
      sourceMessageId: item.sourceMessageId,
      threadId: item.threadId,
      relation: item.relation,
      evidenceRefs: item.evidenceRefs,
      bodyRef: item.bodyRef,
      attachmentRefs: item.attachmentRefs.map((file) => ({
        id: file.id,
        contentDigest: file.contentDigest ?? null,
        // Extracts are untrusted text; digest identity uses presence + length only.
        extractedChars: file.extractedText?.length ?? 0,
      })),
    })),
  })).digest('hex');
}

/**
 * Project earlier cross-thread evidence visible at cutoff for the selected message.
 * Empty proof yields `unobserved` (never an empty "complete" earlier list).
 */
export function projectRequestTimeContext(input: {
  scope: RequestTimeScope;
  selectedId: string;
  cutoff: string;
  messages: readonly AuthorizedContextMessage[];
  recordedEdges?: readonly RecordedContextEdge[];
  attested_by: RequestTimeContextPacket['attested_by'];
}): RequestTimeContextResult {
  const selected = input.messages.find((message) => message.id === input.selectedId);
  if (!selected) {
    return {
      state: 'unobserved',
      reason: 'selected_message_missing',
      contextDigest: createHash('sha256').update(`missing:${input.selectedId}`).digest('hex'),
    };
  }
  const cutoffMs = parseTime(input.cutoff);
  if (!Number.isFinite(cutoffMs) || parseTime(selected.receivedAt) !== cutoffMs) {
    // Live without explicit cutoff may pass selected.receivedAt as cutoff.
    if (!Number.isFinite(cutoffMs)) {
      return {
        state: 'unobserved',
        reason: 'cutoff_invalid',
        contextDigest: createHash('sha256').update(`cutoff:${input.selectedId}`).digest('hex'),
      };
    }
  }

  const links = proveStrongLinksAtCutoff(input.messages, input.cutoff, input.recordedEdges ?? []);
  const members = componentMembers(selected.threadId, links);
  const byThreadLinks = links.filter((link) =>
    members.has(link.srcThreadId) && members.has(link.dstThreadId)
    && (link.srcThreadId === selected.threadId || link.dstThreadId === selected.threadId
      || members.size > 1));

  const earlierMessages = new Map<string, RequestTimeEarlier>();
  for (const link of byThreadLinks) {
    const otherId = link.srcMessageId === input.selectedId ? link.dstMessageId
      : link.dstMessageId === input.selectedId ? link.srcMessageId
      : parseTime(input.messages.find((m) => m.id === link.srcMessageId)?.receivedAt ?? '')
          < parseTime(selected.receivedAt)
        ? link.srcMessageId
        : link.dstMessageId;
    const other = input.messages.find((message) => message.id === otherId);
    if (!other || other.id === selected.id) continue;
    if (!members.has(other.threadId)) continue;
    const otherAt = parseTime(other.receivedAt);
    if (!Number.isFinite(otherAt) || otherAt > cutoffMs) continue;
    // Earlier evidence only — not the selected message and not future witnesses.
    if (otherAt > parseTime(selected.receivedAt)) continue;
    if (other.threadId === selected.threadId) continue;

    const attachmentRefs = (other.attachmentRefs ?? []).map((file) => ({
      id: file.id,
      contentDigest: file.contentDigest,
      extractedText: file.textExcerpt ?? null,
    }));
    const bodyRef = bodyDigest(other.bodyText);
    const existing = earlierMessages.get(other.id);
    if (existing) {
      for (const ref of link.evidenceRefs) {
        if (!existing.evidenceRefs.includes(ref)) existing.evidenceRefs.push(ref);
      }
      continue;
    }
    earlierMessages.set(other.id, {
      sourceMessageId: other.id,
      threadId: other.threadId,
      relation: link.relation,
      evidenceRefs: [...link.evidenceRefs],
      bodyRef,
      bodyText: other.bodyText,
      attachmentRefs,
    });
  }

  const earlier = [...earlierMessages.values()].sort((a, b) =>
    a.sourceMessageId.localeCompare(b.sourceMessageId));

  if (earlier.length === 0) {
    const digest = digestRequestTimeContext({
      scope: input.scope,
      selectedId: input.selectedId,
      cutoff: input.cutoff,
      earlier: [],
      attested_by: input.attested_by,
    });
    return { state: 'unobserved', reason: 'no_strong_earlier_evidence', contextDigest: digest };
  }

  const packet: RequestTimeContextPacket = {
    version: REQUEST_TIME_CONTEXT_VERSION,
    selectedId: input.selectedId,
    cutoff: input.cutoff,
    scope: input.scope,
    attested_by: input.attested_by,
    earlier,
    contextDigest: '',
  };
  packet.contextDigest = digestRequestTimeContext({
    scope: packet.scope,
    selectedId: packet.selectedId,
    cutoff: packet.cutoff,
    attested_by: packet.attested_by,
    earlier: packet.earlier.map(({ bodyText: _body, ...rest }) => rest),
  });
  return { state: 'observed', packet };
}

/** Validate a packet digest and scope binding; reject arbitrary client enrichment. */
export function acceptRequestTimeContext(
  packet: unknown,
  expected: { scope: RequestTimeScope; selectedId: string; allowedAttestations: readonly RequestTimeContextPacket['attested_by'][] },
): RequestTimeContextPacket | null {
  if (!packet || typeof packet !== 'object' || Array.isArray(packet)) return null;
  const row = packet as Partial<RequestTimeContextPacket>;
  if (row.version !== REQUEST_TIME_CONTEXT_VERSION) return null;
  if (row.selectedId !== expected.selectedId) return null;
  if (!row.scope || row.scope.property !== expected.scope.property || row.scope.mailbox !== expected.scope.mailbox) {
    return null;
  }
  if (!row.attested_by || !expected.allowedAttestations.includes(row.attested_by)) return null;
  if (typeof row.cutoff !== 'string' || typeof row.contextDigest !== 'string') return null;
  if (!Array.isArray(row.earlier)) return null;
  const earlier = row.earlier.map((item) => {
    if (!item || typeof item !== 'object') return null;
    const entry = item as RequestTimeEarlier;
    if (typeof entry.sourceMessageId !== 'string' || typeof entry.threadId !== 'string') return null;
    if (entry.relation !== 'header_parent' && entry.relation !== 'domain_conf_full') return null;
    if (!Array.isArray(entry.evidenceRefs) || typeof entry.bodyRef !== 'string' || typeof entry.bodyText !== 'string') {
      return null;
    }
    if (!Array.isArray(entry.attachmentRefs)) return null;
    return {
      sourceMessageId: entry.sourceMessageId,
      threadId: entry.threadId,
      relation: entry.relation,
      evidenceRefs: entry.evidenceRefs.map(String),
      bodyRef: entry.bodyRef,
      bodyText: entry.bodyText,
      attachmentRefs: entry.attachmentRefs.map((file) => ({
        id: String(file.id),
        contentDigest: file.contentDigest,
        extractedText: file.extractedText ?? null,
      })),
    } satisfies RequestTimeEarlier;
  });
  if (earlier.some((item) => item == null)) return null;
  const digest = digestRequestTimeContext({
    scope: row.scope,
    selectedId: row.selectedId,
    cutoff: row.cutoff,
    attested_by: row.attested_by,
    earlier: (earlier as RequestTimeEarlier[]).map(({ bodyText: _b, ...rest }) => rest),
  });
  if (digest !== row.contextDigest) return null;
  return {
    version: REQUEST_TIME_CONTEXT_VERSION,
    selectedId: row.selectedId,
    cutoff: row.cutoff,
    contextDigest: row.contextDigest,
    scope: row.scope,
    attested_by: row.attested_by,
    earlier: earlier as RequestTimeEarlier[],
  };
}

/** Offline adapter: same pure linker over exported authorized records. */
export function projectRequestTimeContextFromExport(input: {
  scope: RequestTimeScope;
  selectedId: string;
  cutoff: string;
  messages: readonly AuthorizedContextMessage[];
  recordedEdges?: readonly RecordedContextEdge[];
}): RequestTimeContextResult {
  return projectRequestTimeContext({ ...input, attested_by: 'offline' });
}

/** Delivery revision for freeze: selected message identity only (not conversation root / enrichment). */
export function selectedDeliveryRevision(selected: {
  id: string;
  rfc_message_id?: string | null;
  received_at: string;
  subject: string;
  body_text: string;
  from: { email: string };
  attachments: readonly { id: string; handle: string; size: number; name: string }[];
}): string {
  return createHash('sha256').update(stableJson({
    id: selected.id,
    rfc_message_id: selected.rfc_message_id ?? null,
    received_at: selected.received_at,
    subject: selected.subject,
    body_text: selected.body_text,
    from: selected.from.email,
    attachments: selected.attachments.map((file) => ({
      id: file.id, handle: file.handle, size: file.size, name: file.name,
    })),
  })).digest('hex');
}

export function deliveryEnvelopeKey(input: {
  property: string;
  mailbox: string;
  selectedId: string;
  revision: string;
}): string {
  return createHash('sha256').update(stableJson({
    property: input.property,
    mailbox: input.mailbox,
    selectedId: input.selectedId,
    revision: input.revision,
  })).digest('hex');
}

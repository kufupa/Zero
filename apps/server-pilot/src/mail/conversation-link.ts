import { randomUUID } from 'node:crypto';
import { and, asc, eq, inArray, isNull } from 'drizzle-orm';
import {
  mailConversationLink,
  type MailConversationLinkType,
} from '../db/schema/mail-conversation-link.js';
import { message } from '../db/schema/mail.js';
import type { DB } from '../db/client.js';
import {
  buildAutoConfirmIndex,
  buildOrphanOutboundIndex,
  externalEmails,
  type ConversationMessage,
  type IndexableMessage,
} from './conversation-signals.js';
import { buildReferenceChain, canonicalMessageId } from './ingest/message-id.js';

const MS_7D = 7 * 24 * 60 * 60 * 1000;
const MS_72H = 72 * 60 * 60 * 1000;

const OPS_DIGEST_SUBJECT_PATTERNS = [
  'daily summary',
  'digest',
  'fortimail',
  'quarantine report',
  'unpaid invoice summary',
  'failure notification',
] as const;

const QUOTED_FROM_HOTEL_RE =
  /From:\s*(?:Centurion Hotel Reservations|Martha Mthembu|Isaac Seabi)\s*<(?:centurion|marthamthembu|isaacseabi)@legacyhotels/i;
const CONF_RE = /n[°º]\s*(\d{6,})-1/i;
const SYSTEM_LOCALPART_HINTS = [
  'mail',
  'hotels',
  'noreply',
  'no-reply',
  'donotreply',
  'mailer-daemon',
  'postmaster',
  'bounce',
  'notification',
  'notifications',
  'alert',
  'alerts',
  'system',
  'navaai',
] as const;
const OPS_LOCALPART_HINTS = [
  'ops',
  'operations',
  'nightaudit',
  'night-audit',
  'channelmanager',
  'channel-manager',
] as const;
const SUBJECT_CLUSTER_TEMPLATE_PATTERNS = [
  /\b(?:bounce|bounced|undeliverable|undelivered|returned to sender|did not reach the guest|delivery status)\b/i,
  /\b(?:handover|hand over|night audit|daily report|discrepancy report|no\s+shows?|scans?)\b/i,
  /\bnedbank\b/i,
  /\b(?:quote|quotation)\b/i,
  /\b(?:digest|quarantine report|failure notification|update failure)\b/i,
] as const;
const LOW_ENTROPY_SUBJECT_PATTERNS = [
  /^(?:new\s+)?(?:booking|reservation|reservations)$/i,
  /^(?:hello|hi|test|thanks?|thank you|no subject)$/i,
] as const;
const MAX_SUBJECT_CLUSTER_BUCKET_SIZE = 8;
const MAX_AUTO_ORPHAN_LINKS_PER_THREAD = 1;
const MAX_HUMAN_ORPHAN_LINKS_PER_THREAD = 1;
// Keep weak deterministic edges below the same eight-thread mega-cluster gate
// used by subject buckets. Strong RFC/confidence edges are not constrained.
const MAX_WEAK_COMPONENT_SIZE = MAX_SUBJECT_CLUSTER_BUCKET_SIZE - 1;
const MAX_HUMAN_ORPHAN_COMPONENT_SIZE = MAX_WEAK_COMPONENT_SIZE;
const MAX_QUOTED_BODY_LINKS_PER_MESSAGE_GUEST = 1;
const MAX_QUOTED_BODY_COMPONENT_SIZE = MAX_WEAK_COMPONENT_SIZE;

export type LinkableMessage = {
  id: string;
  threadId: string;
  transportId: string;
  direction: 'inbound' | 'outbound';
  messageIdHeader: string | null;
  inReplyTo: string | null;
  references: readonly string[] | null;
  fromAddress: string;
  toAddresses: readonly string[];
  ccAddresses: readonly string[];
  subject: string | null;
  textBody: string | null;
  receivedAt: Date | null;
};

export type ProposedConversationLink = {
  srcThreadId: string;
  dstThreadId: string;
  srcMessageId?: string;
  dstMessageId?: string;
  linkType: MailConversationLinkType;
  confidence: string;
};

/** Addresses that are not a person and must not be the only subject overlap. */
export function isSystemAddress(address: string): boolean {
  const match = /<?([^<>\s]+@[^>\s]+)>?/.exec(address.trim().toLowerCase());
  const email = match?.[1] ?? address.trim().toLowerCase();
  const at = email.lastIndexOf('@');
  if (at < 1) return false;
  const local = email.slice(0, at);
  return (
    SYSTEM_LOCALPART_HINTS.some((hint) => local.includes(hint)) ||
    OPS_LOCALPART_HINTS.some(
      (hint) => local === hint || local.startsWith(`${hint}.`) || local.startsWith(`${hint}-`),
    )
  );
}

/** RFC-style subject normalize for conversation-layer grouping (not ingest). */
export function normalizeConversationSubject(subject: string): string {
  let s = subject.trim().toLowerCase();
  for (let i = 0; i < 12; i++) {
    const stripped = s.replace(/^(re|fwd|fw|aw|sv)\s*:\s*/i, '').trim();
    const bracket = stripped.replace(/^\[[^\]]+\]\s*/i, '').trim();
    if (bracket === s) break;
    s = bracket;
  }
  return s.replace(/\s+/g, ' ').trim();
}

/** Collapse Outlook-style spaced subjects ("B re akfast Pack Re quest"). */
export function collapseSpacedSubjectArtifacts(normSubject: string): string {
  const tokens = normSubject.split(/\s+/).filter(Boolean);
  if (tokens.length < 4) return normSubject;
  const shortCount = tokens.filter((token) => token.length <= 3).length;
  if (shortCount / tokens.length < 0.35) return normSubject;
  return tokens.join('');
}

export function canonicalThreadPair(a: string, b: string): [string, string] {
  return a < b ? [a, b] : [b, a];
}

function messageTime(message: LinkableMessage): number {
  return message.receivedAt?.getTime() ?? 0;
}

function compareLinkableMessages(left: LinkableMessage, right: LinkableMessage): number {
  const leftTime = left.receivedAt?.getTime() ?? Number.POSITIVE_INFINITY;
  const rightTime = right.receivedAt?.getTime() ?? Number.POSITIVE_INFINITY;
  return (
    leftTime - rightTime ||
    left.id.localeCompare(right.id) ||
    left.threadId.localeCompare(right.threadId)
  );
}

function orderedMessages(messages: readonly LinkableMessage[]): LinkableMessage[] {
  return [...messages].sort(compareLinkableMessages);
}

function withinWindow(a: LinkableMessage, b: LinkableMessage, windowMs: number): boolean {
  if (!a.receivedAt || !b.receivedAt) return false;
  return Math.abs(messageTime(a) - messageTime(b)) <= windowMs;
}

function toIndexable(message: LinkableMessage): IndexableMessage {
  return {
    id: message.id,
    threadId: message.threadId,
    direction: message.direction,
    from: message.fromAddress,
    to: message.toAddresses.join(', '),
    cc: message.ccAddresses.join(', '),
    subject: message.subject ?? '',
    receivedAt: message.receivedAt?.toISOString() ?? '',
  };
}

function toConversationMessage(message: LinkableMessage): ConversationMessage {
  return {
    ...toIndexable(message),
    bodyText: message.textBody ?? '',
  };
}

export function conversationLinkKey(
  srcThreadId: string,
  dstThreadId: string,
  linkType: MailConversationLinkType,
): string {
  const [canonicalSrc, canonicalDst] = canonicalThreadPair(srcThreadId, dstThreadId);
  return `${canonicalSrc}|${canonicalDst}|${linkType}`;
}

function pushLink(
  links: ProposedConversationLink[],
  seen: Set<string>,
  proposal: ProposedConversationLink,
): boolean {
  const [srcThreadId, dstThreadId] = canonicalThreadPair(proposal.srcThreadId, proposal.dstThreadId);
  if (srcThreadId === dstThreadId) return false;
  const key = conversationLinkKey(srcThreadId, dstThreadId, proposal.linkType);
  if (seen.has(key)) return false;
  seen.add(key);
  links.push({ ...proposal, srcThreadId, dstThreadId });
  return true;
}

export function discoverHeaderParentLinks(
  messages: readonly LinkableMessage[],
  messageByHeader: ReadonlyMap<string, LinkableMessage>,
): ProposedConversationLink[] {
  const links: ProposedConversationLink[] = [];
  const seen = new Set<string>();

  for (const msg of orderedMessages(messages)) {
    const refs = buildReferenceChain(msg.inReplyTo, msg.references ?? []);
    for (const ref of refs) {
      const parent = messageByHeader.get(ref);
      if (!parent || parent.threadId === msg.threadId) continue;
      pushLink(links, seen, {
        srcThreadId: parent.threadId,
        dstThreadId: msg.threadId,
        srcMessageId: parent.id,
        dstMessageId: msg.id,
        linkType: 'header_parent',
        confidence: '1.0000',
      });
    }
  }

  return links;
}

export function discoverDomainLinks(messages: readonly LinkableMessage[]): ProposedConversationLink[] {
  const links: ProposedConversationLink[] = [];
  const seen = new Set<string>();
  const sortedMessages = orderedMessages(messages);
  const indexable = sortedMessages.map(toIndexable);
  const autoIndex = buildAutoConfirmIndex(indexable);
  const orphanByGuest = buildOrphanOutboundIndex(indexable);
  const byThread = new Map<string, LinkableMessage[]>();

  for (const msg of sortedMessages) {
    const list = byThread.get(msg.threadId) ?? [];
    list.push(msg);
    byThread.set(msg.threadId, list);
  }

  const humanOrphanIncomingLinks = new Map<string, number>();
  const humanOrphanParent = new Map<string, string>();
  const humanOrphanSize = new Map<string, number>();
  const findHumanOrphanRoot = (threadId: string): string => {
    const parent = humanOrphanParent.get(threadId);
    if (!parent) {
      humanOrphanParent.set(threadId, threadId);
      humanOrphanSize.set(threadId, 1);
      return threadId;
    }
    if (parent === threadId) return parent;
    const root = findHumanOrphanRoot(parent);
    humanOrphanParent.set(threadId, root);
    return root;
  };
  const canJoinHumanOrphanComponent = (left: string, right: string): boolean => {
    const leftRoot = findHumanOrphanRoot(left);
    const rightRoot = findHumanOrphanRoot(right);
    if (leftRoot === rightRoot) return true;
    return (
      (humanOrphanSize.get(leftRoot) ?? 1) + (humanOrphanSize.get(rightRoot) ?? 1) <=
      MAX_HUMAN_ORPHAN_COMPONENT_SIZE
    );
  };
  const joinHumanOrphanComponents = (left: string, right: string): void => {
    const leftRoot = findHumanOrphanRoot(left);
    const rightRoot = findHumanOrphanRoot(right);
    if (leftRoot === rightRoot) return;
    const leftSize = humanOrphanSize.get(leftRoot) ?? 1;
    const rightSize = humanOrphanSize.get(rightRoot) ?? 1;
    humanOrphanParent.set(rightRoot, leftRoot);
    humanOrphanSize.set(leftRoot, leftSize + rightSize);
  };
  for (const [threadId, threadMessages] of byThread) {
    const inboundMessages = threadMessages.filter((msg) => msg.direction === 'inbound');
    let autoLinksForThread = 0;
    let humanLinksForThread = 0;
    for (const inbound of inboundMessages) {
      const threadText = threadMessages
        .map((msg) => `${msg.subject ?? ''}\n${msg.textBody ?? ''}`)
        .join('\n');
      const triggerDay = inbound.receivedAt?.toISOString().slice(0, 10) ?? '';
      const confMatches = new Set<string>();
      for (const match of threadText.matchAll(new RegExp(CONF_RE.source, 'gi'))) {
        if (match[1]) confMatches.add(match[1]);
      }
      const guestEmails = externalEmails(inbound.fromAddress);

      for (const auto of autoIndex) {
        if (autoLinksForThread >= MAX_AUTO_ORPHAN_LINKS_PER_THREAD) break;
        if (auto.threadId === threadId) continue;
        const autoMessages = byThread.get(auto.threadId) ?? [];
        const anchor = autoMessages.find((msg) => msg.direction === 'outbound');
        if (!anchor || !withinWindow(inbound, anchor, MS_7D)) continue;
        if (auto.day && triggerDay && auto.day < triggerDay) continue;

        if (auto.conf && confMatches.has(auto.conf)) {
          if (pushLink(links, seen, {
            srcThreadId: threadId,
            dstThreadId: auto.threadId,
            srcMessageId: inbound.id,
            dstMessageId: anchor.id,
            linkType: 'domain_conf',
            confidence: '0.9500',
          })) autoLinksForThread += 1;
        }
      }

      for (const guestEmail of guestEmails) {
        const orphans = orphanByGuest.get(guestEmail) ?? [];
        for (const orphan of orphans) {
          // Auto-confirmations are only linkable through an exact conf# match
          // above; guest email/name alone is deliberately insufficient.
          if (orphan.isAuto) continue;
          if (humanLinksForThread >= MAX_HUMAN_ORPHAN_LINKS_PER_THREAD) break;
          if (orphan.threadId === threadId) continue;
          if (
            (humanOrphanIncomingLinks.get(orphan.threadId) ?? 0) >=
            MAX_HUMAN_ORPHAN_LINKS_PER_THREAD
          ) {
            continue;
          }
          if (!canJoinHumanOrphanComponent(threadId, orphan.threadId)) continue;
          const orphanMessages = byThread.get(orphan.threadId) ?? [];
          const anchor = orphanMessages.find((msg) => msg.direction === 'outbound');
          if (!anchor || !withinWindow(inbound, anchor, MS_7D)) continue;
          if (
            inbound.receivedAt &&
            anchor.receivedAt &&
            anchor.receivedAt.getTime() < inbound.receivedAt.getTime()
          ) {
            continue;
          }

          const linkType: MailConversationLinkType = 'domain_guest_email';
          if (!pushLink(links, seen, {
            srcThreadId: threadId,
            dstThreadId: orphan.threadId,
            srcMessageId: inbound.id,
            dstMessageId: anchor.id,
            linkType,
            confidence: '0.9000',
          })) continue;
          humanLinksForThread += 1;
          humanOrphanIncomingLinks.set(
            orphan.threadId,
            (humanOrphanIncomingLinks.get(orphan.threadId) ?? 0) + 1,
          );
          joinHumanOrphanComponents(threadId, orphan.threadId);
        }
      }
    }
  }

  return links;
}

export function discoverQuotedBodyLinks(messages: readonly LinkableMessage[]): ProposedConversationLink[] {
  const links: ProposedConversationLink[] = [];
  const seen = new Set<string>();
  const sortedMessages = orderedMessages(messages);
  const inboundByGuest = new Map<string, LinkableMessage[]>();
  const quotedParent = new Map<string, string>();
  const quotedSize = new Map<string, number>();
  const findQuotedRoot = (threadId: string): string => {
    const parent = quotedParent.get(threadId);
    if (!parent) {
      quotedParent.set(threadId, threadId);
      quotedSize.set(threadId, 1);
      return threadId;
    }
    if (parent === threadId) return parent;
    const root = findQuotedRoot(parent);
    quotedParent.set(threadId, root);
    return root;
  };
  const canJoinQuotedComponent = (left: string, right: string): boolean => {
    const leftRoot = findQuotedRoot(left);
    const rightRoot = findQuotedRoot(right);
    if (leftRoot === rightRoot) return true;
    return (
      (quotedSize.get(leftRoot) ?? 1) + (quotedSize.get(rightRoot) ?? 1) <=
      MAX_QUOTED_BODY_COMPONENT_SIZE
    );
  };
  const joinQuotedComponents = (left: string, right: string): void => {
    const leftRoot = findQuotedRoot(left);
    const rightRoot = findQuotedRoot(right);
    if (leftRoot === rightRoot) return;
    const leftComponentSize = quotedSize.get(leftRoot) ?? 1;
    const rightComponentSize = quotedSize.get(rightRoot) ?? 1;
    quotedParent.set(rightRoot, leftRoot);
    quotedSize.set(leftRoot, leftComponentSize + rightComponentSize);
  };

  for (const msg of sortedMessages) {
    if (msg.direction !== 'inbound') continue;
    for (const guestEmail of externalEmails(msg.fromAddress)) {
      const list = inboundByGuest.get(guestEmail) ?? [];
      list.push(msg);
      inboundByGuest.set(guestEmail, list);
    }
  }

  for (const msg of sortedMessages) {
    const body = msg.textBody ?? '';
    if (!QUOTED_FROM_HOTEL_RE.test(body)) continue;
    const guestEmails = new Set<string>();
    if (msg.direction === 'inbound') {
      for (const email of externalEmails(msg.fromAddress)) guestEmails.add(email);
    } else {
      for (const email of externalEmails(msg.toAddresses.join(' '))) guestEmails.add(email);
      for (const email of externalEmails(msg.ccAddresses.join(' '))) guestEmails.add(email);
    }
    for (const guestEmail of guestEmails) {
      let acceptedForGuest = 0;
      const candidates = [...(inboundByGuest.get(guestEmail) ?? [])].sort(
        (left, right) =>
          Math.abs(messageTime(left) - messageTime(msg)) -
          Math.abs(messageTime(right) - messageTime(msg)),
      );
      for (const prior of candidates) {
        if (acceptedForGuest >= MAX_QUOTED_BODY_LINKS_PER_MESSAGE_GUEST) break;
        if (prior.threadId === msg.threadId) continue;
        if (!withinWindow(prior, msg, MS_7D)) continue;
        if (
          prior.receivedAt &&
          msg.receivedAt &&
          prior.receivedAt.getTime() > msg.receivedAt.getTime()
        ) {
          continue;
        }
        if (!canJoinQuotedComponent(prior.threadId, msg.threadId)) continue;
        if (!pushLink(links, seen, {
          srcThreadId: prior.threadId,
          dstThreadId: msg.threadId,
          srcMessageId: prior.id,
          dstMessageId: msg.id,
          linkType: 'quoted_body',
          confidence: '0.8500',
        })) continue;
        acceptedForGuest += 1;
        joinQuotedComponents(prior.threadId, msg.threadId);
      }
    }
  }

  return links;
}

function allParticipantEmails(message: LinkableMessage): Set<string> {
  const emails = new Set<string>();
  const blob = [message.fromAddress, ...message.toAddresses, ...message.ccAddresses].join(' ');
  for (const email of blob.match(/[\w.+-]+@[\w.-]+\.[a-z]{2,}/gi) ?? []) {
    emails.add(email.toLowerCase());
  }
  return emails;
}

function nonSystemParticipants(messages: readonly LinkableMessage[]): Set<string> {
  const participants = new Set<string>();
  for (const msg of messages) {
    for (const email of allParticipantEmails(msg)) {
      if (!isSystemAddress(email)) participants.add(email);
    }
  }
  return participants;
}

function isBreakfastPackSubject(normSubject: string): boolean {
  return /breakfast\s*pack/i.test(normSubject) || normSubject.includes('breakfastpack');
}

function participantsOverlapForSubjectCluster(
  a: readonly LinkableMessage[],
  b: readonly LinkableMessage[],
  normSubject: string,
): boolean {
  const left = nonSystemParticipants(a);
  const right = nonSystemParticipants(b);
  const overlap = [...left].filter((email) => right.has(email));
  if (overlap.length === 0) return false;

  // P1 excludes system-only overlap; internal staff participants remain valid
  // for the Breakfast Pack and other non-system chains.
  if (isBreakfastPackSubject(normSubject)) return true;
  // P3 permits any shared non-system participant, including internal staff.
  return overlap.length > 0;
}

function isOpsDigestSubject(subject: string): boolean {
  const norm = normalizeConversationSubject(subject);
  return OPS_DIGEST_SUBJECT_PATTERNS.some((pattern) => norm.includes(pattern));
}

export function isSubjectClusterTemplate(subject: string): boolean {
  const norm = normalizeConversationSubject(subject);
  return (
    norm.length < 8 ||
    LOW_ENTROPY_SUBJECT_PATTERNS.some((pattern) => pattern.test(norm)) ||
    SUBJECT_CLUSTER_TEMPLATE_PATTERNS.some((pattern) => pattern.test(norm))
  );
}

export function discoverSubjectClusterLinks(
  messages: readonly LinkableMessage[],
): ProposedConversationLink[] {
  const links: ProposedConversationLink[] = [];
  const seen = new Set<string>();
  const sortedMessages = orderedMessages(messages);
  const byThread = new Map<string, LinkableMessage[]>();

  for (const msg of sortedMessages) {
    const list = byThread.get(msg.threadId) ?? [];
    list.push(msg);
    byThread.set(msg.threadId, list);
  }

  const clusters = new Map<string, string[]>();
  for (const [threadId, threadMessages] of byThread) {
    const subject = threadMessages.find((msg) => msg.subject)?.subject ?? '';
    if (!subject || isOpsDigestSubject(subject) || isSubjectClusterTemplate(subject)) continue;
    const norm = normalizeConversationSubject(subject);
    const collapsed = collapseSpacedSubjectArtifacts(norm);
    const key = collapsed.length >= 8 ? collapsed : norm;
    if (!key) continue;
    const bucket = clusters.get(key) ?? [];
    bucket.push(threadId);
    clusters.set(key, bucket);
  }

  for (const threadIds of clusters.values()) {
    if (threadIds.length < 2 || threadIds.length >= MAX_SUBJECT_CLUSTER_BUCKET_SIZE) continue;
    const firstSubject = byThread.get(threadIds[0]!)?.find((msg) => msg.subject)?.subject ?? '';
    const normalizedSubject = normalizeConversationSubject(firstSubject);
    const collapsedSubject = collapseSpacedSubjectArtifacts(normalizedSubject);
    const normSubject = collapsedSubject.length >= 8 ? collapsedSubject : normalizedSubject;
    for (let i = 0; i < threadIds.length; i++) {
      for (let j = i + 1; j < threadIds.length; j++) {
        const leftId = threadIds[i]!;
        const rightId = threadIds[j]!;
        const leftMessages = byThread.get(leftId) ?? [];
        const rightMessages = byThread.get(rightId) ?? [];
        if (!participantsOverlapForSubjectCluster(leftMessages, rightMessages, normSubject))
          continue;

        const leftTimes = leftMessages.map(messageTime).filter((t) => t > 0);
        const rightTimes = rightMessages.map(messageTime).filter((t) => t > 0);
        if (leftTimes.length === 0 || rightTimes.length === 0) continue;
        const times = [...leftTimes, ...rightTimes];
        const span = Math.max(...times) - Math.min(...times);
        if (span > MS_72H) continue;

        pushLink(links, seen, {
          srcThreadId: leftId,
          dstThreadId: rightId,
          linkType: 'subject_cluster',
          confidence: '0.7500',
        });
      }
    }
  }

  return links;
}

export function discoverConversationLinks(messages: readonly LinkableMessage[]): ProposedConversationLink[] {
  const sortedMessages = orderedMessages(messages);
  const messageByHeader = new Map<string, LinkableMessage>();
  for (const msg of sortedMessages) {
    const canon = canonicalMessageId(msg.messageIdHeader);
    if (canon) messageByHeader.set(canon, msg);
  }

  const proposals = [
    ...discoverHeaderParentLinks(sortedMessages, messageByHeader),
    ...discoverDomainLinks(sortedMessages),
    ...discoverQuotedBodyLinks(sortedMessages),
    ...discoverSubjectClusterLinks(sortedMessages),
  ];

  // Strong RFC/confidence edges may form larger real conversations. Weak
  // deterministic edges must not bridge components past the mega-cluster gate.
  const weakLinkTypes = new Set<MailConversationLinkType>([
    'domain_guest_email',
    'quoted_body',
    'subject_cluster',
  ]);
  const parent = new Map<string, string>();
  const size = new Map<string, number>();
  const find = (threadId: string): string => {
    const current = parent.get(threadId);
    if (!current) {
      parent.set(threadId, threadId);
      size.set(threadId, 1);
      return threadId;
    }
    if (current === threadId) return current;
    const root = find(current);
    parent.set(threadId, root);
    return root;
  };
  const bounded: ProposedConversationLink[] = [];
  for (const proposal of proposals) {
    const leftRoot = find(proposal.srcThreadId);
    const rightRoot = find(proposal.dstThreadId);
    if (
      weakLinkTypes.has(proposal.linkType) &&
      leftRoot !== rightRoot &&
      (size.get(leftRoot) ?? 1) + (size.get(rightRoot) ?? 1) > MAX_WEAK_COMPONENT_SIZE
    ) {
      continue;
    }
    bounded.push(proposal);
    if (leftRoot !== rightRoot) {
      parent.set(rightRoot, leftRoot);
      size.set(leftRoot, (size.get(leftRoot) ?? 1) + (size.get(rightRoot) ?? 1));
    }
  }
  return bounded;
}

export type PersistedConversationLink = {
  id: string;
  srcThreadId: string;
  dstThreadId: string;
  linkType: MailConversationLinkType;
  supersededAt?: Date | string | null;
};

/** Link kinds owned by deterministic discovery in this backfill. */
const DETERMINISTIC_LINK_TYPES = new Set<MailConversationLinkType>([
  'header_parent',
  'domain_conf',
  'domain_guest_email',
  'quoted_body',
  'subject_cluster',
]);

/**
 * Return active persisted edges no longer justified by current deterministic
 * discovery. Discovery owns all precision predicates; backfill only compares
 * canonical edge identities, so it cannot drift into a second policy.
 */
export function findSupersededConversationLinks<T extends PersistedConversationLink>(
  activeLinks: readonly T[],
  proposals: readonly ProposedConversationLink[],
): T[] {
  const safeKeys = new Set(
    proposals.map((proposal) =>
      conversationLinkKey(proposal.srcThreadId, proposal.dstThreadId, proposal.linkType),
    ),
  );
  return activeLinks.filter(
    (link) =>
      DETERMINISTIC_LINK_TYPES.has(link.linkType) &&
      link.supersededAt == null &&
      !safeKeys.has(conversationLinkKey(link.srcThreadId, link.dstThreadId, link.linkType)),
  );
}

/** Mark stale active edges without deleting history or rewriting thread_id. */
export async function deactivateSupersededConversationLinks(
  db: DB,
  transportId: string,
  proposals: readonly ProposedConversationLink[],
  supersededAt = new Date(),
): Promise<number> {
  const activeLinks = await db
    .select({
      id: mailConversationLink.id,
      srcThreadId: mailConversationLink.srcThreadId,
      dstThreadId: mailConversationLink.dstThreadId,
      linkType: mailConversationLink.linkType,
      supersededAt: mailConversationLink.supersededAt,
    })
    .from(mailConversationLink)
    .where(
      and(eq(mailConversationLink.transportId, transportId), isNull(mailConversationLink.supersededAt)),
    );
  const staleLinks = findSupersededConversationLinks(activeLinks, proposals);
  if (staleLinks.length === 0) return 0;

  await db
    .update(mailConversationLink)
    .set({ supersededAt })
    .where(
      and(
        eq(mailConversationLink.transportId, transportId),
        isNull(mailConversationLink.supersededAt),
        inArray(
          mailConversationLink.id,
          staleLinks.map((link) => link.id),
        ),
      ),
    );
  return staleLinks.length;
}

export async function upsertConversationLinks(
  db: DB,
  transportId: string,
  proposals: readonly ProposedConversationLink[],
): Promise<number> {
  if (proposals.length === 0) return 0;

  for (const proposal of proposals) {
    const [srcThreadId, dstThreadId] = canonicalThreadPair(proposal.srcThreadId, proposal.dstThreadId);
    await db
      .insert(mailConversationLink)
      .values({
        id: randomUUID(),
        transportId,
        srcThreadId,
        dstThreadId,
        srcMessageId: proposal.srcMessageId ?? null,
        dstMessageId: proposal.dstMessageId ?? null,
        linkType: proposal.linkType,
        confidence: proposal.confidence,
        supersededAt: null,
      })
      .onConflictDoUpdate({
        target: [
          mailConversationLink.transportId,
          mailConversationLink.srcThreadId,
          mailConversationLink.dstThreadId,
          mailConversationLink.linkType,
        ],
        set: {
          confidence: proposal.confidence,
          srcMessageId: proposal.srcMessageId ?? null,
          dstMessageId: proposal.dstMessageId ?? null,
          supersededAt: null,
        },
      });
  }

  return proposals.length;
}

export async function recomputeConversationLinksForTransport(
  db: DB,
  transportId: string,
): Promise<number> {
  const rows = await db
    .select({
      id: message.id,
      threadId: message.threadId,
      transportId: message.transportId,
      direction: message.direction,
      messageIdHeader: message.messageIdHeader,
      inReplyTo: message.inReplyTo,
      references: message.references,
      fromAddress: message.fromAddress,
      toAddresses: message.toAddresses,
      ccAddresses: message.ccAddresses,
      subject: message.subject,
      textBody: message.textBody,
      receivedAt: message.receivedAt,
    })
    .from(message)
    .where(eq(message.transportId, transportId))
    .orderBy(asc(message.receivedAt), asc(message.id), asc(message.threadId));

  const linkable: LinkableMessage[] = rows.map((row) => ({
    id: row.id,
    threadId: row.threadId,
    transportId: row.transportId,
    direction: row.direction,
    messageIdHeader: row.messageIdHeader,
    inReplyTo: row.inReplyTo,
    references: row.references ?? [],
    fromAddress: row.fromAddress,
    toAddresses: row.toAddresses,
    ccAddresses: row.ccAddresses,
    subject: row.subject,
    textBody: row.textBody,
    receivedAt: row.receivedAt,
  }));

  const proposals = discoverConversationLinks(linkable);
  return upsertConversationLinks(db, transportId, proposals);
}

export function toConversationMessages(messages: readonly LinkableMessage[]): ConversationMessage[] {
  return messages.map(toConversationMessage);
}

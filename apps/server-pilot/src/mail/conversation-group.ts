import { createHash } from 'node:crypto';
import { and, eq, inArray, isNull, sql } from 'drizzle-orm';
import { mailConversationLink } from '../db/schema/mail-conversation-link.js';
import { message } from '../db/schema/mail.js';
import type { DB } from '../db/client.js';
import type { MailConversationLinkType } from '../db/schema/mail-conversation-link.js';

const RESPONSE_LINK_TYPES = new Set<MailConversationLinkType>([
  'domain_conf',
  'domain_guest_email',
  'quoted_body',
]);

export type ThreadStats = {
  latestMessageAt: Date | null;
  messageCount: number;
  hasOutbound: boolean;
};

function toDate(value: Date | string | null | undefined): Date | null {
  if (value == null) return null;
  if (value instanceof Date) return value;
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

function latestMessageTime(stats: ThreadStats | undefined): number {
  return toDate(stats?.latestMessageAt)?.getTime() ?? 0;
}

export type ThreadConversationMeta = {
  conversationId: string;
  linkedThreadIds: readonly string[];
  primaryThreadId: string;
  conversationMessageCount: number;
  conversationResponded: boolean;
};

export class UnionFind {
  private readonly parent = new Map<string, string>();

  constructor(ids: readonly string[]) {
    for (const id of ids) {
      this.parent.set(id, id);
    }
  }

  add(id: string): void {
    if (!this.parent.has(id)) {
      this.parent.set(id, id);
    }
  }

  find(id: string): string {
    let root = id;
    while (this.parent.get(root) !== root) {
      root = this.parent.get(root)!;
    }
    let cursor = id;
    while (cursor !== root) {
      const next = this.parent.get(cursor)!;
      this.parent.set(cursor, root);
      cursor = next;
    }
    return root;
  }

  union(a: string, b: string): void {
    const rootA = this.find(a);
    const rootB = this.find(b);
    if (rootA === rootB) return;
    const canonical = rootA < rootB ? rootA : rootB;
    const other = canonical === rootA ? rootB : rootA;
    this.parent.set(other, canonical);
  }

  components(): Map<string, string[]> {
    const groups = new Map<string, string[]>();
    for (const id of this.parent.keys()) {
      const root = this.find(id);
      const list = groups.get(root) ?? [];
      list.push(id);
      groups.set(root, list);
    }
    for (const list of groups.values()) {
      list.sort();
    }
    return groups;
  }
}

/** Stable UUID-shaped id from transport + canonical root thread id. */
export function stableConversationId(transportId: string, rootThreadId: string): string {
  const digest = createHash('sha256')
    .update(`${transportId}\0${rootThreadId}`)
    .digest('hex');
  return [
    digest.slice(0, 8),
    digest.slice(8, 12),
    `4${digest.slice(13, 16)}`,
    `a${digest.slice(17, 20)}`,
    digest.slice(20, 32),
  ].join('-');
}

function respondedForComponent(
  threadIds: readonly string[],
  stats: ReadonlyMap<string, ThreadStats>,
  links: readonly { srcThreadId: string; dstThreadId: string; linkType: MailConversationLinkType }[],
): boolean {
  for (const threadId of threadIds) {
    if (stats.get(threadId)?.hasOutbound) return true;
  }
  for (const link of links) {
    if (!RESPONSE_LINK_TYPES.has(link.linkType)) continue;
    if (threadIds.includes(link.srcThreadId) && threadIds.includes(link.dstThreadId)) {
      return true;
    }
  }
  return false;
}

export function buildConversationMeta(
  transportId: string,
  requestedThreadIds: readonly string[],
  edges: readonly {
    srcThreadId: string;
    dstThreadId: string;
    linkType: MailConversationLinkType;
    supersededAt?: Date | string | null;
  }[],
  stats: ReadonlyMap<string, ThreadStats>,
): Map<string, ThreadConversationMeta> {
  const uf = new UnionFind(requestedThreadIds);
  const activeEdges = edges.filter((edge) => edge.supersededAt == null);
  for (const edge of activeEdges) {
    uf.add(edge.srcThreadId);
    uf.add(edge.dstThreadId);
    uf.union(edge.srcThreadId, edge.dstThreadId);
  }

  const components = uf.components();
  const out = new Map<string, ThreadConversationMeta>();

  for (const [, threadIds] of components) {
    const root = threadIds[0]!;
    const conversationId = stableConversationId(transportId, root);
    const primaryThreadId = [...threadIds].sort((a, b) => {
      const aTime = latestMessageTime(stats.get(a));
      const bTime = latestMessageTime(stats.get(b));
      if (aTime !== bTime) return bTime - aTime;
      return b.localeCompare(a);
    })[0]!;
    const conversationMessageCount = threadIds.reduce(
      (sum, threadId) => sum + (stats.get(threadId)?.messageCount ?? 0),
      0,
    );
    const componentLinks = activeEdges.filter(
      (edge) => threadIds.includes(edge.srcThreadId) && threadIds.includes(edge.dstThreadId),
    );
    const conversationResponded = respondedForComponent(threadIds, stats, componentLinks);

    for (const threadId of threadIds) {
      out.set(threadId, {
        conversationId,
        linkedThreadIds: threadIds.filter((id) => id !== threadId),
        primaryThreadId,
        conversationMessageCount,
        conversationResponded,
      });
    }
  }

  for (const threadId of requestedThreadIds) {
    if (out.has(threadId)) continue;
    const stat = stats.get(threadId);
    out.set(threadId, {
      conversationId: stableConversationId(transportId, threadId),
      linkedThreadIds: [],
      primaryThreadId: threadId,
      conversationMessageCount: stat?.messageCount ?? 0,
      conversationResponded: stat?.hasOutbound ?? false,
    });
  }

  return out;
}

/** Edges with witness clocks for as-of request-time projection (includes superseded). */
export async function loadConversationEdgesForTransport(
  db: DB,
  transportId: string,
): Promise<{
  srcThreadId: string;
  dstThreadId: string;
  srcMessageId: string | null;
  dstMessageId: string | null;
  linkType: MailConversationLinkType;
  createdAt: Date | string | null;
  supersededAt: Date | string | null;
}[]> {
  return db
    .select({
      srcThreadId: mailConversationLink.srcThreadId,
      dstThreadId: mailConversationLink.dstThreadId,
      srcMessageId: mailConversationLink.srcMessageId,
      dstMessageId: mailConversationLink.dstMessageId,
      linkType: mailConversationLink.linkType,
      createdAt: mailConversationLink.createdAt,
      supersededAt: mailConversationLink.supersededAt,
    })
    .from(mailConversationLink)
    .where(eq(mailConversationLink.transportId, transportId));
}

/** Refilter component membership by edge/witness time, not only message timestamps. */
export function buildConversationMetaAsOf(
  transportId: string,
  requestedThreadIds: readonly string[],
  edges: readonly {
    srcThreadId: string;
    dstThreadId: string;
    linkType: MailConversationLinkType;
    createdAt?: Date | string | null;
    supersededAt?: Date | string | null;
  }[],
  stats: ReadonlyMap<string, ThreadStats>,
  cutoffMs: number,
): Map<string, ThreadConversationMeta> {
  // Fail closed: unknown cutoff or unknown edge creation time → edge not visible.
  if (!Number.isFinite(cutoffMs)) {
    return buildConversationMeta(transportId, requestedThreadIds, [], stats);
  }
  const visible = edges.filter((edge) => {
    const created = toDate(edge.createdAt)?.getTime();
    if (created == null || !Number.isFinite(created) || created > cutoffMs) return false;
    const superseded = toDate(edge.supersededAt)?.getTime();
    if (superseded != null && Number.isFinite(superseded) && superseded <= cutoffMs) return false;
    return true;
  });
  return buildConversationMeta(transportId, requestedThreadIds, visible, stats);
}

export async function loadConversationMetaForThreads(
  db: DB,
  transportId: string,
  threadIds: readonly string[],
): Promise<Map<string, ThreadConversationMeta>> {
  if (threadIds.length === 0) return new Map();

  const activeLinks = await db
    .select({
      srcThreadId: mailConversationLink.srcThreadId,
      dstThreadId: mailConversationLink.dstThreadId,
      linkType: mailConversationLink.linkType,
    })
    .from(mailConversationLink)
    .where(
      and(eq(mailConversationLink.transportId, transportId), isNull(mailConversationLink.supersededAt)),
    );

  const uf = new UnionFind(threadIds);
  for (const link of activeLinks) {
    uf.add(link.srcThreadId);
    uf.add(link.dstThreadId);
    uf.union(link.srcThreadId, link.dstThreadId);
  }

  const componentThreadIds = new Set<string>();
  for (const threadId of threadIds) {
    for (const member of uf.components().get(uf.find(threadId)) ?? [threadId]) {
      componentThreadIds.add(member);
    }
  }

  const allThreadIds = [...componentThreadIds];
  const statsRows =
    allThreadIds.length > 0
      ? await db
          .select({
            threadId: message.threadId,
            messageCount: sql<number>`count(*)::int`,
            hasOutbound: sql<boolean>`bool_or(${message.direction} = 'outbound')`,
            latestMessageAt: sql<Date | null>`max(coalesce(${message.receivedAt}, ${message.sentAt}, ${message.createdAt}))`,
          })
          .from(message)
          .where(
            and(eq(message.transportId, transportId), inArray(message.threadId, allThreadIds)),
          )
          .groupBy(message.threadId)
      : [];

  const stats = new Map<string, ThreadStats>(
    statsRows.map((row) => [
      row.threadId,
      {
        latestMessageAt: toDate(row.latestMessageAt),
        messageCount: row.messageCount,
        hasOutbound: row.hasOutbound,
      },
    ]),
  );

  for (const threadId of allThreadIds) {
    if (!stats.has(threadId)) {
      stats.set(threadId, { latestMessageAt: null, messageCount: 0, hasOutbound: false });
    }
  }

  const relevantEdges = activeLinks.filter(
    (edge) => componentThreadIds.has(edge.srcThreadId) && componentThreadIds.has(edge.dstThreadId),
  );

  return buildConversationMeta(transportId, allThreadIds, relevantEdges, stats);
}

export async function loadConversationMetaForThread(
  db: DB,
  transportId: string,
  threadId: string,
): Promise<ThreadConversationMeta> {
  const map = await loadConversationMetaForThreads(db, transportId, [threadId]);
  return (
    map.get(threadId) ?? {
      conversationId: stableConversationId(transportId, threadId),
      linkedThreadIds: [],
      primaryThreadId: threadId,
      conversationMessageCount: 0,
      conversationResponded: false,
    }
  );
}

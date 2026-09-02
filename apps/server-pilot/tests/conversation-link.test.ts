import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { and, eq, isNull } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { mailConversationLink } from '../src/db/schema/mail-conversation-link.js';
import { mailThread, message } from '../src/db/schema/mail.js';
import { TRANSPORT_ID, TRANSPORT_EMAIL } from '../src/db/seed.js';
import {
  canonicalThreadPair,
  discoverDomainLinks,
  discoverHeaderParentLinks,
  discoverQuotedBodyLinks,
  discoverSubjectClusterLinks,
  normalizeConversationSubject,
  collapseSpacedSubjectArtifacts,
  upsertConversationLinks,
  type LinkableMessage,
} from '../src/mail/conversation-link.js';
import {
  buildConversationMeta,
  stableConversationId,
  UnionFind,
} from '../src/mail/conversation-group.js';
import {
  TEST_DB_AVAILABLE,
  probeTestDb,
  withSeededTestDb,
} from './helpers/test-db.js';
import { callerFor } from './helpers/trpc-caller.js';

const reachable = await probeTestDb();

function msg(overrides: Partial<LinkableMessage> & Pick<LinkableMessage, 'id' | 'threadId'>): LinkableMessage {
  return {
    transportId: TRANSPORT_ID,
    direction: 'inbound',
    messageIdHeader: `<${overrides.id}@example.com>`,
    inReplyTo: null,
    references: [],
    fromAddress: 'guest@example.com',
    toAddresses: [TRANSPORT_EMAIL],
    ccAddresses: [],
    subject: 'Booking enquiry',
    textBody: 'Hello',
    receivedAt: new Date('2026-07-01T10:00:00.000Z'),
    ...overrides,
  };
}

describe('conversation subject normalize', () => {
  it('strips re/fwd prefixes and collapses spaced artifacts', () => {
    expect(normalizeConversationSubject('Re: Fwd: Breakfast Pack')).toBe('breakfast pack');
    expect(collapseSpacedSubjectArtifacts('b re akfast pa ck')).toBe('breakfastpack');
  });
});

describe('union-find conversation groups', () => {
  it('assigns stable conversationId from canonical root thread', () => {
    const uf = new UnionFind(['thread-a', 'thread-b', 'thread-c']);
    uf.union('thread-a', 'thread-b');
    const root = uf.find('thread-b');
    const conversationId = stableConversationId(TRANSPORT_ID, root);
    expect(stableConversationId(TRANSPORT_ID, uf.find('thread-a'))).toBe(conversationId);
    expect(uf.find('thread-c')).not.toBe(root);
  });

  it('builds linkedThreadIds and primaryThreadId from edges', () => {
    const edges = [
      { srcThreadId: 'thread-a', dstThreadId: 'thread-b' },
      { srcThreadId: 'thread-b', dstThreadId: 'thread-c' },
    ];
    const stats = new Map([
      ['thread-a', { latestMessageAt: new Date('2026-07-01T10:00:00Z'), messageCount: 1, hasOutbound: false }],
      ['thread-b', { latestMessageAt: new Date('2026-07-02T10:00:00Z'), messageCount: 2, hasOutbound: false }],
      ['thread-c', { latestMessageAt: new Date('2026-07-03T10:00:00Z'), messageCount: 1, hasOutbound: true }],
    ]);
    const meta = buildConversationMeta(TRANSPORT_ID, ['thread-a', 'thread-b'], edges, stats);
    const rowB = meta.get('thread-b');
    expect(rowB?.primaryThreadId).toBe('thread-c');
    expect(rowB?.linkedThreadIds).toEqual(['thread-a', 'thread-c']);
    expect(rowB?.conversationMessageCount).toBe(4);
    expect(rowB?.conversationResponded).toBe(true);
  });
});

describe('deterministic link discovery', () => {
  it('links header_parent when reply references parent message in another thread', () => {
    const parent = msg({
      id: 'msg-parent',
      threadId: 'thread-parent',
      messageIdHeader: 'parent@hotel.com',
    });
    const child = msg({
      id: 'msg-child',
      threadId: 'thread-child',
      inReplyTo: 'parent@hotel.com',
      references: ['parent@hotel.com'],
    });
    const headerIndex = new Map([[ 'parent@hotel.com', parent ]]);
    const links = discoverHeaderParentLinks([parent, child], headerIndex);
    expect(links).toHaveLength(1);
    expect(links[0]).toMatchObject({
      linkType: 'header_parent',
      srcThreadId: 'thread-child',
      dstThreadId: 'thread-parent',
    });
    expect(canonicalThreadPair('thread-child', 'thread-parent')).toEqual(['thread-child', 'thread-parent']);
  });

  it('links domain_conf across threads on matching confirmation number within 7d', () => {
    const inbound = msg({
      id: 'msg-in',
      threadId: 'thread-in',
      subject: 'Question about reservation N° 1234567-1',
      textBody: 'Can I add breakfast?',
      receivedAt: new Date('2026-07-01T10:00:00.000Z'),
    });
    const auto = msg({
      id: 'msg-auto',
      threadId: 'thread-auto',
      direction: 'outbound',
      fromAddress: TRANSPORT_EMAIL,
      toAddresses: ['booking.com@channel.com'],
      subject: 'Confirmation letter_Guest Name (N° 1234567-1)',
      textBody: 'Auto confirmation',
      receivedAt: new Date('2026-07-03T10:00:00.000Z'),
    });
    const links = discoverDomainLinks([inbound, auto]);
    expect(links.some((l) => l.linkType === 'domain_conf')).toBe(true);
  });

  it('links quoted_body when hotel header quoted in sibling thread for same guest', () => {
    const prior = msg({
      id: 'msg-prior',
      threadId: 'thread-prior',
      fromAddress: 'guest@travel.com',
      receivedAt: new Date('2026-07-01T09:00:00.000Z'),
    });
    const quoted = msg({
      id: 'msg-quoted',
      threadId: 'thread-quoted',
      fromAddress: 'guest@travel.com',
      textBody:
        'See below\nFrom: Centurion Hotel Reservations <centurion@legacyhotels.co.za>\nOriginal question',
      receivedAt: new Date('2026-07-01T11:00:00.000Z'),
    });
    const links = discoverQuotedBodyLinks([prior, quoted]);
    expect(links).toHaveLength(1);
    expect(links[0]?.linkType).toBe('quoted_body');
  });

  it('links subject_cluster for same participants within 72h', () => {
    const a = msg({
      id: 'msg-a',
      threadId: 'thread-a',
      subject: 'Re: Breakfast Pack request',
      receivedAt: new Date('2026-07-01T10:00:00.000Z'),
    });
    const b = msg({
      id: 'msg-b',
      threadId: 'thread-b',
      subject: 'RE: Breakfast Pack request',
      fromAddress: 'staff@legacyhotels.co.za',
      toAddresses: ['guest@example.com'],
      receivedAt: new Date('2026-07-02T08:00:00.000Z'),
    });
    const links = discoverSubjectClusterLinks([a, b]);
    expect(links.some((l) => l.linkType === 'subject_cluster')).toBe(true);
  });
});

describe('mail_conversation_link migration', () => {
  it('defines durable edge table with unique transport/src/dst/linkType', async () => {
    const sql = await readFile(
      new URL('../drizzle/0021_mail_conversation_link.sql', import.meta.url),
      'utf8',
    );
    expect(sql).toContain('CREATE TABLE IF NOT EXISTS "mail_conversation_link"');
    expect(sql).toContain('"link_type"');
    expect(sql).toContain('mail_conversation_link_edge_uidx');
  });
});

describe.skipIf(!TEST_DB_AVAILABLE || !reachable)('conversation link persistence (disposable DB)', () => {
  it('upserts links idempotently without duplicating edges', async () => {
    await withSeededTestDb(async (db) => {
      const threadA = randomUUID();
      const threadB = randomUUID();
      const now = new Date('2026-07-01T10:00:00Z');
      await db.insert(mailThread).values([
        {
          id: threadA,
          transportId: TRANSPORT_ID,
          threadRootId: `<${threadA}@example.com>`,
          subject: 'Thread A',
          snippet: 'A',
          latestMessageAt: now,
        },
        {
          id: threadB,
          transportId: TRANSPORT_ID,
          threadRootId: `<${threadB}@example.com>`,
          subject: 'Thread B',
          snippet: 'B',
          latestMessageAt: now,
        },
      ]);

      const proposal = {
        srcThreadId: threadA,
        dstThreadId: threadB,
        linkType: 'header_parent' as const,
        confidence: '1.0000',
      };
      const first = await upsertConversationLinks(db, TRANSPORT_ID, [proposal]);
      const second = await upsertConversationLinks(db, TRANSPORT_ID, [proposal]);
      expect(first).toBe(1);
      expect(second).toBe(1);

      const rows = await db
        .select()
        .from(mailConversationLink)
        .where(
          and(
            eq(mailConversationLink.transportId, TRANSPORT_ID),
            isNull(mailConversationLink.supersededAt),
          ),
        );
      expect(rows).toHaveLength(1);
      expect(rows[0]?.linkType).toBe('header_parent');
    });
  });

  it('listThreads exposes conversation fields for linked threads', async () => {
    await withSeededTestDb(async (db) => {
      const threadA = randomUUID();
      const threadB = randomUUID();
      const msgA = randomUUID();
      const msgB = randomUUID();
      const now = new Date('2026-07-06T10:00:00Z');
      const earlier = new Date('2026-07-05T10:00:00Z');

      await db.insert(mailThread).values([
        {
          id: threadA,
          transportId: TRANSPORT_ID,
          threadRootId: `<${threadA}@example.com>`,
          subject: 'Guest question',
          snippet: 'Guest question',
          latestMessageAt: earlier,
        },
        {
          id: threadB,
          transportId: TRANSPORT_ID,
          threadRootId: `<${threadB}@example.com>`,
          subject: 'Staff reply',
          snippet: 'Staff reply',
          latestMessageAt: now,
        },
      ]);
      await db.insert(message).values([
        {
          id: msgA,
          transportId: TRANSPORT_ID,
          threadId: threadA,
          direction: 'inbound',
          fromAddress: 'guest@example.com',
          toAddresses: [TRANSPORT_EMAIL],
          subject: 'Guest question',
          textBody: 'Need help',
          receivedAt: earlier,
        },
        {
          id: msgB,
          transportId: TRANSPORT_ID,
          threadId: threadB,
          direction: 'outbound',
          fromAddress: TRANSPORT_EMAIL,
          toAddresses: ['guest@example.com'],
          subject: 'Re: Guest question',
          textBody: 'We can help',
          receivedAt: now,
        },
      ]);
      await upsertConversationLinks(db, TRANSPORT_ID, [
        {
          srcThreadId: threadA,
          dstThreadId: threadB,
          linkType: 'domain_guest_email',
          confidence: '0.9000',
        },
      ]);

      const { mail } = await callerFor('user-centurion', { db });
      const list = await mail.listThreads({ folder: 'all', limit: 50 });
      const rowA = list.threads.find((t) => t.id === threadA);
      const rowB = list.threads.find((t) => t.id === threadB);
      expect(rowA?.conversationId).toBe(rowB?.conversationId);
      expect(rowA?.linkedThreadIds).toEqual([threadB]);
      expect(rowB?.primaryThreadId).toBe(threadB);
      expect(rowB?.conversationResponded).toBe(true);
      expect(rowB?.conversationMessageCount).toBe(2);

      const detail = await mail.get({ id: threadA });
      expect(detail.conversationId).toBe(rowA?.conversationId);
      expect(detail.linkedThreadIds).toEqual([threadB]);
    });
  });
});

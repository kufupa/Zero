import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { and, eq, isNull } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { mailConversationLink } from '../src/db/schema/mail-conversation-link.js';
import { mailThread, message } from '../src/db/schema/mail.js';
import { TRANSPORT_ID, TRANSPORT_EMAIL } from '../src/db/seed.js';
import {
  canonicalThreadPair,
  conversationLinkKey,
  discoverConversationLinks,
  discoverDomainLinks,
  discoverHeaderParentLinks,
  discoverQuotedBodyLinks,
  discoverSubjectClusterLinks,
  normalizeConversationSubject,
  collapseSpacedSubjectArtifacts,
  deactivateSupersededConversationLinks,
  findSupersededConversationLinks,
  isSystemAddress,
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
import { parseArgs as parseConversationLinkBackfillArgs } from '../scripts/backfill-centurion-conversation-links.js';

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

  it('ignores superseded edges when resolving conversation metadata', () => {
    const edges = [
      {
        srcThreadId: 'thread-a',
        dstThreadId: 'thread-b',
        linkType: 'subject_cluster' as const,
        supersededAt: new Date('2026-09-02T12:00:00Z'),
      },
    ];
    const stats = new Map([
      [
        'thread-a',
        { latestMessageAt: new Date('2026-07-01T10:00:00Z'), messageCount: 1, hasOutbound: false },
      ],
      [
        'thread-b',
        { latestMessageAt: new Date('2026-07-01T11:00:00Z'), messageCount: 1, hasOutbound: false },
      ],
    ]);

    const meta = buildConversationMeta(TRANSPORT_ID, ['thread-a', 'thread-b'], edges, stats);

    expect(meta.get('thread-a')?.linkedThreadIds).toEqual([]);
    expect(meta.get('thread-b')?.linkedThreadIds).toEqual([]);
  });
});

describe('deterministic link discovery', () => {
  it('parses unsafe-edge deactivation as explicit opt-in', () => {
    expect(
      parseConversationLinkBackfillArgs([
        '--transport=transport-centurion',
        '--deactivate-unsafe',
        '--confirm-pilot-rds',
      ]),
    ).toEqual({
      transportId: 'transport-centurion',
      apply: false,
      confirmPilotRds: true,
      deactivateUnsafe: true,
    });
  });

  it('recomputes proposals inside a serializable deactivation transaction', async () => {
    const source = await readFile(
      new URL('../scripts/backfill-centurion-conversation-links.ts', import.meta.url),
      'utf8',
    );
    expect(source).toMatch(/isolationLevel:\s*'serializable'/);
    expect(source).toMatch(/const txLinkable = await loadLinkableMessages\(tx/);
    expect(source).toMatch(/const txProposals = discoverConversationLinks\(txLinkable\)/);
    expect(source).toMatch(/deactivateSupersededConversationLinks\(tx, cli\.transportId!, txProposals\)/);
    expect(source).toMatch(/upsertConversationLinks\(tx, cli\.transportId!, txProposals\)/);
  });

  it('marks active persisted edges absent from current safe proposals as superseded candidates', () => {
    const activeEdges = [
      {
        id: 'unsafe-subject-edge',
        srcThreadId: 'thread-a',
        dstThreadId: 'thread-b',
        linkType: 'subject_cluster' as const,
        supersededAt: null,
      },
      {
        id: 'safe-header-edge',
        srcThreadId: 'thread-c',
        dstThreadId: 'thread-d',
        linkType: 'header_parent' as const,
        supersededAt: null,
      },
      {
        id: 'already-superseded',
        srcThreadId: 'thread-e',
        dstThreadId: 'thread-f',
        linkType: 'subject_cluster' as const,
        supersededAt: new Date('2026-09-02T12:00:00Z'),
      },
      {
        id: 'llm-edge',
        srcThreadId: 'thread-g',
        dstThreadId: 'thread-h',
        linkType: 'llm_link' as const,
        supersededAt: null,
      },
    ];

    const candidates = findSupersededConversationLinks(activeEdges, [
      {
        srcThreadId: 'thread-d',
        dstThreadId: 'thread-c',
        linkType: 'header_parent',
        confidence: '1.0000',
      },
    ]);

    expect(candidates).toEqual([activeEdges[0]]);
  });

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

  it('caps quoted-body fanout per guest and refuses a weak mega-component', () => {
    const prior = Array.from({ length: 9 }, (_, index) =>
      msg({
        id: `quoted-fanout-prior-${index}`,
        threadId: `quoted-fanout-prior-${index}`,
        fromAddress: 'guest@travel.com',
        receivedAt: new Date(`2026-07-01T${String(1 + index).padStart(2, '0')}:00:00.000Z`),
      }),
    );
    const quoted = msg({
      id: 'quoted-fanout-target',
      threadId: 'quoted-fanout-target',
      fromAddress: 'guest@travel.com',
      textBody:
        'See below\nFrom: Centurion Hotel Reservations <centurion@legacyhotels.co.za>\nOriginal question',
      receivedAt: new Date('2026-07-01T12:00:00.000Z'),
    });

    const links = discoverQuotedBodyLinks([...prior, quoted]);

    expect(links).toHaveLength(1);
    expect(links[0]?.linkType).toBe('quoted_body');
  });

  it('bounds weak components across the combined deterministic graph', () => {
    const messages = Array.from({ length: 10 }, (_, index) =>
      msg({
        id: `quoted-chain-${index}`,
        threadId: `quoted-chain-${index}`,
        fromAddress: 'guest@travel.com',
        textBody:
          'See below\nFrom: Centurion Hotel Reservations <centurion@legacyhotels.co.za>\nOriginal question',
        receivedAt: new Date(`2026-07-01T${String(10 + index).padStart(2, '0')}:00:00.000Z`),
      }),
    );

    const links = discoverConversationLinks(messages).filter(
      (link) => link.linkType === 'quoted_body',
    );
    const parent = new Map<string, string>();
    const size = new Map<string, number>();
    const find = (id: string): string => {
      const current = parent.get(id);
      if (!current) {
        parent.set(id, id);
        size.set(id, 1);
        return id;
      }
      if (current === id) return id;
      const root = find(current);
      parent.set(id, root);
      return root;
    };
    for (const link of links) {
      const left = find(link.srcThreadId);
      const right = find(link.dstThreadId);
      if (left === right) continue;
      parent.set(right, left);
      size.set(left, (size.get(left) ?? 1) + (size.get(right) ?? 1));
    }
    expect(Math.max(...size.values())).toBeLessThanOrEqual(7);
  });

  it('fails closed when quoted sibling timestamps are missing', () => {
    const prior = msg({
      id: 'msg-undated-prior',
      threadId: 'thread-undated-prior',
      fromAddress: 'guest@example.com',
      receivedAt: null,
    });
    const quoted = msg({
      id: 'msg-undated-quoted',
      threadId: 'thread-undated-quoted',
      fromAddress: 'guest@example.com',
      bodyText: 'From: Centurion Hotel Reservations <centurion@legacyhotels.co.za>',
      receivedAt: null,
    });

    expect(discoverQuotedBodyLinks([prior, quoted])).toEqual([]);
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

  it('links staff-internal Breakfast Pack RE chain (no external guest)', () => {
    const a = msg({
      id: 'bp-1',
      threadId: 'thread-bp-1',
      direction: 'inbound',
      fromAddress: 'centurionrec@legacyhotels.co.za',
      toAddresses: ['fsmith@legacyhotels.co.za'],
      subject: 'RE: Breakfast Pack Request',
      receivedAt: new Date('2026-08-31T16:31:00.000Z'),
    });
    const b = msg({
      id: 'bp-2',
      threadId: 'thread-bp-2',
      direction: 'inbound',
      fromAddress: 'centurionrec@legacyhotels.co.za',
      toAddresses: ['fsmith@legacyhotels.co.za'],
      subject: 'RE: Breakfast Pack Request',
      receivedAt: new Date('2026-08-31T17:57:00.000Z'),
    });
    const links = discoverSubjectClusterLinks([a, b]);
    expect(links).toHaveLength(1);
    expect(links[0]?.linkType).toBe('subject_cluster');
  });

  it('links spaced Outlook Breakfast Pack subjects after subject-key collapse', () => {
    const a = msg({
      id: 'bp-spaced-1',
      threadId: 'thread-bp-spaced-1',
      direction: 'inbound',
      fromAddress: 'centurionrec@legacyhotels.co.za',
      toAddresses: ['fsmith@legacyhotels.co.za'],
      subject: 'B re akfast pa ck Request',
      receivedAt: new Date('2026-08-31T16:31:00.000Z'),
    });
    const b = msg({
      id: 'bp-spaced-2',
      threadId: 'thread-bp-spaced-2',
      direction: 'inbound',
      fromAddress: 'centurionrec@legacyhotels.co.za',
      toAddresses: ['fsmith@legacyhotels.co.za'],
      subject: 'RE: B re akfast pa ck Request',
      receivedAt: new Date('2026-08-31T17:57:00.000Z'),
    });

    const links = discoverSubjectClusterLinks([a, b]);

    expect(links).toHaveLength(1);
    expect(links[0]?.linkType).toBe('subject_cluster');
  });

  it.each([
    ['bounce', 'Action needed: Your email did not reach the guest', 3],
    ['handover', 'Handover Report', 9],
    ['nedbank', 'Nedbank update', 9],
    ['quotation', 'Request for a quotation', 9],
  ])('refuses %s template subject clusters', (_name, subject, count) => {
    const messages = Array.from({ length: count }, (_, index) =>
      msg({
        id: `template-${_name}-${index}`,
        threadId: `template-thread-${_name}-${index}`,
        fromAddress: 'same-guest@example.com',
        toAddresses: ['ops@legacyhotels.co.za'],
        subject,
        receivedAt: new Date(`2026-07-${String(index + 1).padStart(2, '0')}T10:00:00.000Z`),
      }),
    );

    expect(discoverSubjectClusterLinks(messages)).toEqual([]);
  });

  it('refuses low-entropy generic subject clusters', () => {
    const messages = ['low-a', 'low-b'].map((threadId, index) =>
      msg({
        id: `${threadId}-message`,
        threadId,
        fromAddress: 'same-guest@example.com',
        toAddresses: ['centurion@legacyhotels.co.za'],
        subject: 'Booking',
        receivedAt: new Date(`2026-07-0${index + 1}T10:00:00.000Z`),
      }),
    );

    expect(discoverSubjectClusterLinks(messages)).toEqual([]);
  });

  it.each([8, 9])('skips any subject bucket with %s or more threads', (count) => {
    const messages = Array.from({ length: count }, (_, index) =>
      msg({
        id: `large-bucket-${index}`,
        threadId: `large-bucket-thread-${index}`,
        fromAddress: `guest-${index}@example.com`,
        toAddresses: ['centurion@legacyhotels.co.za'],
        subject: 'Specific reservation request',
        receivedAt: new Date(`2026-07-${String(index + 1).padStart(2, '0')}T10:00:00.000Z`),
      }),
    );

    expect(discoverSubjectClusterLinks(messages)).toEqual([]);
  });

  it('fails closed when one subject endpoint has no timestamps', () => {
    const messages = [
      msg({
        id: 'dated-endpoint',
        threadId: 'dated-endpoint',
        fromAddress: 'guest@example.com',
        subject: 'Specific reservation request',
        receivedAt: new Date('2026-07-01T10:00:00.000Z'),
      }),
      msg({
        id: 'undated-endpoint',
        threadId: 'undated-endpoint',
        fromAddress: 'guest@example.com',
        subject: 'RE: Specific reservation request',
        receivedAt: null,
      }),
    ];

    expect(discoverSubjectClusterLinks(messages)).toEqual([]);
  });

  it('does not use system-only participant overlap for guest subject links', () => {
    expect(isSystemAddress('mailer-daemon@legacyhotels.co.za')).toBe(true);
    expect(isSystemAddress('ops@legacyhotels.co.za')).toBe(true);
    expect(isSystemAddress('mail@legacyhotels.co.za')).toBe(true);
    expect(isSystemAddress('hotels@legacyhotels.co.za')).toBe(true);
    expect(isSystemAddress('navaai@legacyhotels.co.za')).toBe(true);
    const messages = [
      msg({
        id: 'system-subject-a',
        threadId: 'system-subject-a',
        fromAddress: 'mailer-daemon@legacyhotels.co.za',
        toAddresses: ['ops@legacyhotels.co.za'],
        subject: 'Specific internal update',
      }),
      msg({
        id: 'system-subject-b',
        threadId: 'system-subject-b',
        fromAddress: 'mailer-daemon@legacyhotels.co.za',
        toAddresses: ['ops@legacyhotels.co.za'],
        subject: 'RE: Specific internal update',
        receivedAt: new Date('2026-07-01T11:00:00.000Z'),
      }),
    ];

    expect(discoverSubjectClusterLinks(messages)).toEqual([]);
  });

  it('allows shared non-system internal staff participants for ordinary subjects', () => {
    const messages = [
      msg({
        id: 'staff-subject-a',
        threadId: 'staff-subject-a',
        fromAddress: 'centurionrec@legacyhotels.co.za',
        toAddresses: ['fsmith@legacyhotels.co.za'],
        subject: 'Specific internal update',
      }),
      msg({
        id: 'staff-subject-b',
        threadId: 'staff-subject-b',
        fromAddress: 'centurionrec@legacyhotels.co.za',
        toAddresses: ['fsmith@legacyhotels.co.za'],
        subject: 'RE: Specific internal update',
        receivedAt: new Date('2026-07-01T11:00:00.000Z'),
      }),
    ];

    expect(discoverSubjectClusterLinks(messages)).toHaveLength(1);
  });

  it('requires a matching confirmation number and caps auto-orphan links at one', () => {
    const autoConfirmations = Array.from({ length: 5 }, (_, index) =>
      msg({
        id: `agency-auto-${index}`,
        threadId: `agency-auto-thread-${index}`,
        direction: 'outbound',
        fromAddress: TRANSPORT_EMAIL,
        toAddresses: ['agency@example.com'],
        subject: `Confirmation letter_Guest Name (N° ${1234560 + index}-1)`,
        textBody: 'Automatic confirmation',
        receivedAt: new Date(`2026-07-0${index + 1}T11:00:00.000Z`),
      }),
    );
    const inbound = msg({
      id: 'agency-inbound',
      threadId: 'agency-inbound-thread',
      fromAddress: 'agency@example.com',
      subject: 'Agency reservation request',
      receivedAt: new Date('2026-07-01T10:00:00.000Z'),
    });

    expect(discoverDomainLinks([inbound, ...autoConfirmations])).toEqual([]);

    const matchingInbound = msg({
      ...inbound,
      id: 'agency-inbound-matching',
      threadId: 'agency-inbound-matching-thread',
      subject: 'Agency reservation request N° 1234562-1',
    });
    const matchingLinks = discoverDomainLinks([matchingInbound, ...autoConfirmations]);
    expect(matchingLinks.filter((link) => link.linkType === 'domain_conf')).toHaveLength(1);
  });

  it('caps recent human orphan fanout and rejects replies before the trigger', () => {
    const inbound = msg({
      id: 'human-inbound',
      threadId: 'human-inbound-thread',
      fromAddress: 'guest@example.com',
      subject: 'Room request',
      receivedAt: new Date('2026-07-01T10:00:00.000Z'),
    });
    const humanOrphans = Array.from({ length: 3 }, (_, index) =>
      msg({
        id: `human-orphan-${index}`,
        threadId: `human-orphan-thread-${index}`,
        direction: 'outbound',
        fromAddress: 'centurion@legacyhotels.co.za',
        toAddresses: ['guest@example.com'],
        subject: `Re: Room request ${index}`,
        receivedAt: new Date(`2026-07-01T${String(11 + index).padStart(2, '0')}:00:00.000Z`),
      }),
    );
    const beforeTrigger = msg({
      id: 'human-before',
      threadId: 'human-before-thread',
      direction: 'outbound',
      fromAddress: 'centurion@legacyhotels.co.za',
      toAddresses: ['guest@example.com'],
      subject: 'Re: Room request before',
      receivedAt: new Date('2026-07-01T09:00:00.000Z'),
    });

    const links = discoverDomainLinks([inbound, ...humanOrphans, beforeTrigger]);
    const humanLinks = links.filter((link) => link.linkType === 'domain_guest_email');
    expect(humanLinks).toHaveLength(1);
    expect(humanLinks[0]?.dstThreadId).toBe('human-orphan-thread-0');
  });

  it('caps reverse human orphan fanout into one destination thread', () => {
    const humanAnchor = msg({
      id: 'human-anchor',
      threadId: 'human-anchor-thread',
      direction: 'outbound',
      fromAddress: 'centurion@legacyhotels.co.za',
      toAddresses: ['guest@example.com'],
      subject: 'Re: Room request',
      receivedAt: new Date('2026-07-01T11:00:00.000Z'),
    });
    const inbounds = Array.from({ length: 9 }, (_, index) =>
      msg({
        id: `human-source-${index}`,
        threadId: `human-source-thread-${index}`,
        fromAddress: 'guest@example.com',
        subject: `Room request ${index}`,
        receivedAt: new Date(`2026-07-01T${String(10 + index).padStart(2, '0')}:00:00.000Z`),
      }),
    );

    const links = discoverDomainLinks([humanAnchor, ...inbounds]).filter(
      (link) => link.linkType === 'domain_guest_email',
    );
    expect(links).toHaveLength(1);
    expect([links[0]?.srcThreadId, links[0]?.dstThreadId]).toContain('human-anchor-thread');
  });

  it('does not consume orphan caps when a reverse edge is a duplicate', () => {
    const inbounds = [
      msg({
        id: 'duplicate-budget-in-a',
        threadId: 'duplicate-budget-a',
        fromAddress: 'guest@example.com',
        receivedAt: new Date('2026-07-01T10:00:00.000Z'),
      }),
      msg({
        id: 'duplicate-budget-in-b',
        threadId: 'duplicate-budget-b',
        fromAddress: 'guest@example.com',
        receivedAt: new Date('2026-07-01T11:00:00.000Z'),
      }),
      msg({
        id: 'duplicate-budget-in-c',
        threadId: 'duplicate-budget-c',
        fromAddress: 'guest@example.com',
        receivedAt: new Date('2026-07-02T10:00:00.000Z'),
      }),
    ];
    const outbounds = [
      msg({
        id: 'duplicate-budget-out-a',
        threadId: 'duplicate-budget-a',
        direction: 'outbound',
        fromAddress: 'centurion@legacyhotels.co.za',
        toAddresses: ['guest@example.com'],
        receivedAt: new Date('2026-07-01T20:00:00.000Z'),
      }),
      msg({
        id: 'duplicate-budget-out-b',
        threadId: 'duplicate-budget-b',
        direction: 'outbound',
        fromAddress: 'centurion@legacyhotels.co.za',
        toAddresses: ['guest@example.com'],
        receivedAt: new Date('2026-07-01T21:00:00.000Z'),
      }),
      msg({
        id: 'duplicate-budget-out-c',
        threadId: 'duplicate-budget-c',
        direction: 'outbound',
        fromAddress: 'centurion@legacyhotels.co.za',
        toAddresses: ['guest@example.com'],
        receivedAt: new Date('2026-07-02T11:00:00.000Z'),
      }),
    ];

    const links = discoverDomainLinks([...inbounds, ...outbounds]).filter(
      (link) => link.linkType === 'domain_guest_email',
    );

    expect(links).toHaveLength(2);
    expect(links.map((link) => canonicalThreadPair(link.srcThreadId, link.dstThreadId))).toEqual([
      ['duplicate-budget-a', 'duplicate-budget-b'],
      ['duplicate-budget-b', 'duplicate-budget-c'],
    ]);
  });

  it('keeps capped weak link choices stable across input permutations', () => {
    const messages = Array.from({ length: 5 }, (_, index) => {
      const threadId = `permutation-thread-${index}`;
      const hour = String(10 + index).padStart(2, '0');
      return [
        msg({
          id: `permutation-in-${index}`,
          threadId,
          fromAddress: 'guest@example.com',
          receivedAt: new Date(`2026-07-01T${hour}:00:00.000Z`),
        }),
        msg({
          id: `permutation-out-${index}`,
          threadId,
          direction: 'outbound',
          fromAddress: 'centurion@legacyhotels.co.za',
          toAddresses: ['guest@example.com'],
          receivedAt: new Date(`2026-07-01T${hour}:30:00.000Z`),
        }),
      ];
    }).flat();
    const linkKeys = (input: readonly LinkableMessage[]) =>
      discoverDomainLinks(input)
        .filter((link) => link.linkType === 'domain_guest_email')
        .map((link) => conversationLinkKey(link.srcThreadId, link.dstThreadId, link.linkType))
        .sort();

    expect(linkKeys(messages)).toEqual(linkKeys([...messages].reverse()));
  });

  it('bounds chain growth from weak human orphan edges', () => {
    const threads = Array.from({ length: 10 }, (_, index) => {
      const threadId = `human-chain-thread-${index}`;
      const at = String(10 + index).padStart(2, '0');
      return [
        msg({
          id: `human-chain-in-${index}`,
          threadId,
          fromAddress: 'guest@example.com',
          subject: 'Room request',
          receivedAt: new Date(`2026-07-01T${at}:00:00.000Z`),
        }),
        msg({
          id: `human-chain-out-${index}`,
          threadId,
          direction: 'outbound',
          fromAddress: 'centurion@legacyhotels.co.za',
          toAddresses: ['guest@example.com'],
          subject: 'Re: Room request',
          receivedAt: new Date(`2026-07-01T${at}:30:00.000Z`),
        }),
      ];
    }).flat();

    const links = discoverDomainLinks(threads).filter(
      (link) => link.linkType === 'domain_guest_email',
    );
    const parent = new Map<string, string>();
    const size = new Map<string, number>();
    const find = (id: string): string => {
      const current = parent.get(id);
      if (!current) {
        parent.set(id, id);
        size.set(id, 1);
        return id;
      }
      if (current === id) return id;
      const root = find(current);
      parent.set(id, root);
      return root;
    };
    for (const link of links) {
      const left = find(link.srcThreadId);
      const right = find(link.dstThreadId);
      if (left === right) continue;
      parent.set(right, left);
      size.set(left, (size.get(left) ?? 1) + (size.get(right) ?? 1));
    }
    expect(Math.max(...size.values())).toBeLessThanOrEqual(7);
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
  it('supersedes stale active edges without deleting them', async () => {
    await withSeededTestDb(async (db) => {
      const threadA = randomUUID();
      const threadB = randomUUID();
      const now = new Date('2026-09-02T12:00:00Z');
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
      await db.insert(mailConversationLink).values({
        id: randomUUID(),
        transportId: TRANSPORT_ID,
        srcThreadId: threadA,
        dstThreadId: threadB,
        linkType: 'subject_cluster',
        confidence: '0.7500',
      });

      const superseded = await deactivateSupersededConversationLinks(db, TRANSPORT_ID, [], now);
      expect(superseded).toBe(1);
      const [row] = await db
        .select({ supersededAt: mailConversationLink.supersededAt })
        .from(mailConversationLink)
        .where(eq(mailConversationLink.transportId, TRANSPORT_ID));
      expect(row?.supersededAt).toEqual(now);
    });
  });

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

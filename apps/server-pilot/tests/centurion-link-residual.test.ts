import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  collapseSpacedSubjectArtifacts,
  enumerateCenturionLinkResiduals,
  formatResidualStdout,
  isOpsDigestSubject,
  normalizeConversationSubject,
  resolveLinkResidualOutputPath,
  resolvePrivateCorpusWorkRoot,
  type SnapshotRow,
} from '../src/ops/centurion-link-residual-enumerator.js';
import {
  parseConnectedMailboxSnapshot,
  resolvePrivateCorpusRoot,
} from '../src/ops/centurion-conversation-signals-eval.js';

const serverRoot = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(serverRoot, '../..');

function row(
  overrides: Partial<SnapshotRow> & Pick<SnapshotRow, 'messageId' | 'threadId'>,
): SnapshotRow {
  return {
    direction: 'inbound',
    from: 'guest-a@example.com',
    to: 'centurion@legacyhotels.co.za',
    cc: '',
    subject: 'Room enquiry',
    bodyText: 'Need availability for two rooms.',
    receivedAt: '2026-08-01T10:00:00.000Z',
    ...overrides,
  };
}

const GLOBAL_OUTBOUNDS: readonly SnapshotRow[] = [
  row({
    messageId: 'auto-conf-1',
    threadId: 'thread-auto-conf-0001',
    direction: 'outbound',
    from: 'centurion@legacyhotels.co.za',
    to: 'booking.com notification',
    subject: 'Confirmation letter_Jane Guest (n°7654321-1) booking update notification',
    bodyText: '',
    receivedAt: '2026-08-01T12:00:00.000Z',
  }),
  row({
    messageId: 'orphan-human-1',
    threadId: 'thread-orphan-human-0002',
    direction: 'outbound',
    from: 'centurion@legacyhotels.co.za',
    to: 'guest-b@example.com',
    subject: 'Re: Quote follow-up',
    bodyText: 'Please see attached quotation.',
    receivedAt: '2026-08-01T11:30:00.000Z',
  }),
  row({
    messageId: 'quote-src-1',
    threadId: 'thread-quote-src-0004',
    direction: 'outbound',
    from: 'centurion@legacyhotels.co.za',
    to: 'guest-c@example.com',
    subject: 'Quotation for stay',
    bodyText: 'Please find attached quotation.',
    receivedAt: '2026-08-01T13:00:00.000Z',
  }),
];

function buildFixtureInput() {
  const fixtureThreads = [
    {
      threadIdPrefix: 't-xconf',
      responded: true,
      responseSignals: ['cross_thread_conf', 'orphan_auto_confirm'],
      messages: [
        row({
          messageId: 't1-trigger',
          threadId: 't-xconf-0001',
          bodyText: 'Please confirm reservation n°7654321-1.',
          receivedAt: '2026-08-01T10:00:00.000Z',
        }),
      ],
    },
    {
      threadIdPrefix: 't-orph-h',
      responded: true,
      responseSignals: ['orphan_centurion_human'],
      messages: [
        row({
          messageId: 't2-trigger',
          threadId: 't-orph-h-0002',
          from: 'guest-b@example.com',
          receivedAt: '2026-08-01T10:15:00.000Z',
        }),
      ],
    },
    {
      threadIdPrefix: 't-q-hdr',
      responded: true,
      responseSignals: ['quoted_hotel_header'],
      messages: [
        row({
          messageId: 't3-trigger',
          threadId: 't-q-hdr-0003',
          from: 'guest-c@example.com',
          bodyText: [
            'Forwarded quote.',
            'From: Centurion Hotel Reservations <centurion@legacyhotels.co.za>',
            'Subject: Quote',
          ].join('\n'),
          receivedAt: '2026-08-01T14:00:00.000Z',
        }),
      ],
    },
    {
      threadIdPrefix: 't-sub-a',
      responded: false,
      responseSignals: [],
      messages: [
        row({
          messageId: 't4a',
          threadId: 't-sub-a-0005',
          from: 'guest-d@example.com',
          subject: 'Request for quotation',
          receivedAt: '2026-08-02T09:00:00.000Z',
        }),
      ],
    },
    {
      threadIdPrefix: 't-sub-b',
      responded: false,
      responseSignals: [],
      messages: [
        row({
          messageId: 't4b',
          threadId: 't-sub-b-0006',
          from: 'guest-d@example.com',
          subject: 'Re: Request for quotation',
          receivedAt: '2026-08-02T15:00:00.000Z',
        }),
      ],
    },
    {
      threadIdPrefix: 't-sub-far',
      responded: false,
      responseSignals: [],
      messages: [
        row({
          messageId: 't5a',
          threadId: 't-sub-far-0007',
          from: 'guest-e@example.com',
          subject: 'Request for quotation',
          receivedAt: '2026-08-01T09:00:00.000Z',
        }),
      ],
    },
    {
      threadIdPrefix: 't-sub-far2',
      responded: false,
      responseSignals: [],
      messages: [
        row({
          messageId: 't5b',
          threadId: 't-sub-far2-0008',
          from: 'guest-e@example.com',
          subject: 'Re: Request for quotation',
          receivedAt: '2026-08-05T09:00:00.000Z',
        }),
      ],
    },
    {
      threadIdPrefix: 't-digest',
      responded: false,
      responseSignals: [],
      messages: [
        row({
          messageId: 't6a',
          threadId: 't-digest-0009',
          from: 'system@example.com',
          subject: 'Fortimail quarantine digest',
          receivedAt: '2026-08-03T09:00:00.000Z',
        }),
      ],
    },
    {
      threadIdPrefix: 't-digest2',
      responded: false,
      responseSignals: [],
      messages: [
        row({
          messageId: 't6b',
          threadId: 't-digest2-0010',
          from: 'system@example.com',
          subject: 'Re: Fortimail quarantine digest',
          receivedAt: '2026-08-03T10:00:00.000Z',
        }),
      ],
    },
  ] as const;

  const rows: SnapshotRow[] = [...GLOBAL_OUTBOUNDS];
  const byThread = new Map<string, SnapshotRow[]>();

  for (const fixture of fixtureThreads) {
    for (const message of fixture.messages) {
      rows.push(message);
      const bucket = byThread.get(message.threadId) ?? [];
      bucket.push(message);
      byThread.set(message.threadId, bucket);
    }
  }

  for (const [threadId, messages] of byThread) {
    messages.sort((left, right) => left.receivedAt.localeCompare(right.receivedAt));
    byThread.set(threadId, messages);
  }

  return {
    defensibleThreads: fixtureThreads.map((fixture) => ({
      threadId: fixture.threadIdPrefix,
      day: '2026-08-01',
      intent: 'quote_request',
      centurionOnly: false,
      responded: fixture.responded,
      threadClass: 'external_enquiry',
      responseSignals: [...fixture.responseSignals],
    })),
    staffBriefThreads: fixtureThreads.map((fixture) => ({
      threadId: fixture.threadIdPrefix,
      subject: fixture.messages[0]?.subject ?? 'Room enquiry',
      day: '2026-08-01',
      intent: 'quote_request',
    })),
    rows,
    byThread,
  };
}

describe('subject helpers', () => {
  it('normalizes and collapses spaced subjects', () => {
    const norm = normalizeConversationSubject('RE : B re akfast Pack Re quest');
    expect(collapseSpacedSubjectArtifacts(norm)).toContain('breakfast');
  });

  it('flags ops digest subjects', () => {
    expect(isOpsDigestSubject('fortimail quarantine digest')).toBe(true);
    expect(isOpsDigestSubject('request for quotation')).toBe(false);
  });
});

describe('enumerateCenturionLinkResiduals fixture', () => {
  it('enumerates cross-thread, quoted, and subject-cluster pairs', () => {
    const fixture = buildFixtureInput();
    const report = enumerateCenturionLinkResiduals({
      defensibleThreads: fixture.defensibleThreads,
      staffBriefThreads: fixture.staffBriefThreads,
      rows: fixture.rows,
      byThread: fixture.byThread,
      sources: {
        defensible: 'fixture-defensible.json',
        walkthrough: 'fixture-walkthrough.json',
        staffBrief: 'fixture-staff.json',
        inboxMarkdown: 'fixture-inbox.md',
      },
    });

    const crossPair = report.pairs.find((pair) => pair.reason === 'cross_thread_conf');
    expect(crossPair).toMatchObject({
      srcThreadId: 't-xconf-0001',
      dstThreadId: 'thread-auto-conf-0001',
      linkType: 'domain_conf',
      confidenceBand: 'high',
    });

    const orphanHuman = report.pairs.find((pair) => pair.reason === 'orphan_centurion_human');
    expect(orphanHuman).toMatchObject({
      srcThreadId: 't-orph-h-0002',
      dstThreadId: 'thread-orphan-human-0002',
      linkType: 'domain_guest_email',
    });

    const quotedPair = report.pairs.find((pair) => pair.reason === 'quoted_hotel_header');
    expect(quotedPair).toMatchObject({
      linkType: 'quoted_body',
      confidenceBand: 'medium',
    });

    const subjectPair = report.pairs.find(
      (pair) =>
        pair.reason === 'subject_cluster' &&
        pair.srcThreadId.startsWith('t-sub-') &&
        pair.dstThreadId.startsWith('t-sub-'),
    );
    expect(subjectPair).toBeDefined();
    expect(subjectPair?.evidence.spanHours).toBeLessThanOrEqual(72);

    const farSubjectPair = report.pairs.find(
      (pair) =>
        pair.reason === 'subject_cluster' &&
        (pair.srcThreadId.startsWith('t-sub-far') || pair.dstThreadId.startsWith('t-sub-far')),
    );
    expect(farSubjectPair).toBeUndefined();

    const digestPair = report.pairs.find(
      (pair) =>
        pair.reason === 'subject_cluster' &&
        (pair.srcThreadId.startsWith('t-digest') || pair.dstThreadId.startsWith('t-digest')),
    );
    expect(digestPair).toBeUndefined();

    expect(report.totals.pairsTotal).toBe(report.pairs.length);
    expect(report.totals.deterministicLinker).toBeGreaterThan(0);
    expect(report.handoff.deterministicLinker.count).toBe(report.totals.deterministicLinker);
  });

  it('stdout formatter exposes counts only', () => {
    const fixture = buildFixtureInput();
    const report = enumerateCenturionLinkResiduals({
      defensibleThreads: fixture.defensibleThreads,
      staffBriefThreads: fixture.staffBriefThreads,
      rows: fixture.rows,
      byThread: fixture.byThread,
      sources: {
        defensible: 'fixture-defensible.json',
        walkthrough: 'fixture-walkthrough.json',
        staffBrief: 'fixture-staff.json',
        inboxMarkdown: 'fixture-inbox.md',
      },
    });

    const stdout = formatResidualStdout(report);
    expect(stdout).not.toMatch(/@/);
    expect(stdout).not.toMatch(/guest-/i);
    const parsed = JSON.parse(stdout) as { totals: { pairsTotal: number } };
    expect(parsed.totals.pairsTotal).toBe(report.totals.pairsTotal);
  });
});

function privateCorpusAvailable(): boolean {
  try {
    resolvePrivateCorpusRoot(repoRoot);
    return true;
  } catch {
    return false;
  }
}

describe.skipIf(!privateCorpusAvailable())('enumerateCenturionLinkResiduals private corpus', () => {
  it('loads corpus inputs and emits non-zero pair counts', async () => {
    const corpusRoot = resolvePrivateCorpusRoot(repoRoot);
    const workRoot = resolvePrivateCorpusWorkRoot(corpusRoot);
    const { readFile } = await import('node:fs/promises');

    const defensible = JSON.parse(
      await readFile(path.join(workRoot, 'defensible-daily-chart-2026-09-01.json'), 'utf8'),
    ) as { threads: Array<Record<string, unknown>> };
    const staffBrief = JSON.parse(
      await readFile(path.join(workRoot, 'staff-email-brief-analysis-2026-09-01.json'), 'utf8'),
    ) as { threads: Array<{ threadId: string; subject: string; day: string; intent: string }> };
    const snapshotText = await readFile(
      path.join(corpusRoot, 'connected-mailbox-inbox-2026-08-30.md'),
      'utf8',
    );
    const { rows, byThread } = parseConnectedMailboxSnapshot(snapshotText);

    const report = enumerateCenturionLinkResiduals({
      defensibleThreads: defensible.threads as never,
      staffBriefThreads: staffBrief.threads,
      rows,
      byThread,
      sources: {
        defensible: path.join(workRoot, 'defensible-daily-chart-2026-09-01.json'),
        walkthrough: path.join(workRoot, 'thread-walkthrough-2026-09-01.json'),
        staffBrief: path.join(workRoot, 'staff-email-brief-analysis-2026-09-01.json'),
        inboxMarkdown: path.join(corpusRoot, 'connected-mailbox-inbox-2026-08-30.md'),
      },
    });

    expect(report.totals.actionable).toBe(438);
    expect(report.totals.pairsTotal).toBeGreaterThan(50);
    expect(report.totals.byReason.cross_thread_conf).toBeGreaterThan(10);
    expect(report.totals.byReason.quoted_hotel_header).toBeGreaterThan(10);
    expect(report.totals.byReason.subject_cluster).toBeGreaterThan(0);
    expect(resolveLinkResidualOutputPath(workRoot)).toMatch(/thread-link-residual-2026-09-02\.json$/);
  });
});

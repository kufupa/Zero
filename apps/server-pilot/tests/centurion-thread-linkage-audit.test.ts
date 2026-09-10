import { describe, expect, it } from 'vitest';
import {
  collapseSpacedSubjectArtifacts,
  normalizeConversationSubject,
  runCenturionThreadLinkageAudit,
} from '../src/ops/centurion-thread-linkage-audit.js';
import { mkdtemp, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';

describe('normalizeConversationSubject', () => {
  it('strips Re: prefix', () => {
    expect(normalizeConversationSubject('Re: Breakfast Pack Request')).toBe('breakfast pack request');
  });

  it('collapses spaced artifact subjects', () => {
    const norm = normalizeConversationSubject('RE : B re akfast Pack Re quest');
    expect(collapseSpacedSubjectArtifacts(norm)).toContain('breakfast');
  });
});

describe('runCenturionThreadLinkageAudit', () => {
  it('assigns layers from fixture JSON', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'linkage-audit-'));
    const defensiblePath = path.join(dir, 'defensible.json');
    const walkthroughPath = path.join(dir, 'walkthrough.json');
    const staffBriefPath = path.join(dir, 'staff.json');

    await writeFile(
      defensiblePath,
      JSON.stringify({
        totals: { actionable: 2, unanswered: 1 },
        threads: [
          {
            threadId: 'aaa',
            day: '2026-08-01',
            intent: 'booking_new',
            centurionOnly: false,
            responded: true,
            threadClass: 'external_enquiry',
            responseSignals: ['in_thread staff outbound'],
          },
          {
            threadId: 'bbb',
            day: '2026-08-01',
            intent: 'booking_new',
            centurionOnly: false,
            responded: false,
            threadClass: 'external_enquiry',
            responseSignals: [],
          },
        ],
      }),
    );
    await writeFile(
      walkthroughPath,
      JSON.stringify({
        threads: [
          { threadId: 'aaa', msgs: 2, in: 1, out: 1, handling: 'staff_replied_centurion' },
          { threadId: 'bbb', msgs: 1, in: 1, out: 0, handling: 'unanswered_external' },
        ],
      }),
    );
    await writeFile(
      staffBriefPath,
      JSON.stringify({
        threads: [
          { threadId: 'aaa', subject: 'RFQ Alpha', day: '2026-08-01', intent: 'booking_new' },
          { threadId: 'bbb', subject: 'Re: RFQ Alpha', day: '2026-08-01', intent: 'booking_new' },
        ],
      }),
    );

    const report = await runCenturionThreadLinkageAudit({
      defensiblePath,
      walkthroughPath,
      staffBriefPath,
      outDir: path.join(dir, 'out'),
    });

    expect(report.waterfall.defensibleResponded).toBe(1);
    expect(report.layerCounts.unlinked).toBe(1);
    expect(report.subjectClustersMultiThread.some((c) => c.threadIds.length === 2)).toBe(true);
  });
});

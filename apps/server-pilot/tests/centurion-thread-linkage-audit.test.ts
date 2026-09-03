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
    expect(report.auditMode).toBe('descriptive');
    expect(report.goldTotals).toEqual({ actionable: 483, responded: 282, unanswered: 201 });
    expect(report.waterfall.responded).toBe(1);
    expect(report.layerCounts.unlinked).toBe(1);
    expect(report.subjectClustersMultiThread.some((c) => c.threadIds.length === 2)).toBe(true);
  });

  it('keeps all deterministic EOD signals out of the LLM residual bucket', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'linkage-audit-signals-'));
    const defensiblePath = path.join(dir, 'defensible.json');
    const walkthroughPath = path.join(dir, 'walkthrough.json');
    const staffBriefPath = path.join(dir, 'staff.json');
    const signals = ['in_reply_to_hotel_msgid', 'staff_inbound_commercial_reply'];

    await writeFile(
      defensiblePath,
      JSON.stringify({
        totals: { actionable: signals.length },
        threads: signals.map((signal, index) => ({
          threadId: `signal-${index}`,
          day: '2026-08-01',
          intent: 'booking_new',
          centurionOnly: false,
          responded: true,
          threadClass: 'external_enquiry',
          responseSignals: [signal],
        })),
      }),
    );
    await writeFile(
      walkthroughPath,
      JSON.stringify({
        threads: signals.map((_, index) => ({
          threadId: `signal-${index}`,
          msgs: 1,
          in: 1,
          out: 0,
          handling: 'unanswered_external',
        })),
      }),
    );
    await writeFile(
      staffBriefPath,
      JSON.stringify({
        threads: signals.map((_, index) => ({
          threadId: `signal-${index}`,
          subject: `Signal ${index}`,
          day: '2026-08-01',
          intent: 'booking_new',
        })),
      }),
    );

    const report = await runCenturionThreadLinkageAudit({
      defensiblePath,
      walkthroughPath,
      staffBriefPath,
      outDir: path.join(dir, 'out'),
    });

    expect(report.layerCounts.layer_d_llm).toBe(0);
    expect(report.layerCounts.layer_b_signal).toBe(signals.length);
  });
});

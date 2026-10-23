import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  QUOTE_PRICE_CUTOFF_ISO,
  formatQuotePriceStdout,
  parseQuotePriceGoldReplayArgs,
  quotePriceProdInput,
  runQuotePriceGoldReplay,
  scoreQuotePriceRow,
  selectRecentQuoteAsks,
  type QuoteAskFixture,
  type QuoteQueueResult,
} from '../scripts/quote-price-gold-replay.js';

const CUTOFF = new Date(QUOTE_PRICE_CUTOFF_ISO);

function ask(overrides: Partial<QuoteAskFixture> = {}): QuoteAskFixture {
  return {
    id: 'ask-hrcen-1',
    hotel: 'HRCEN',
    askedAt: '2026-10-21T09:00:00.000Z',
    staffSent: { pdf: true },
    staffTruth: { ratePlan: 'BAR', pricePerNightMinor: 194_000 },
    attachments: [
      {
        id: 'att-ask',
        filename: 'request.pdf',
        mimeType: 'application/pdf',
        sizeBytes: 1_000,
        text: 'Synthetic quote request for one single B&B.',
      },
    ],
    ...overrides,
  };
}

function priced(overrides: Partial<Extract<QuoteQueueResult, { status: 'priced' }>> = {}): QuoteQueueResult {
  return { status: 'priced', ratePlan: 'BAR', pricePerNightMinor: 194_000, ...overrides };
}

describe('quote price gold replay', () => {
  it('names the live PANE_BRAIN prompt path as readQuoteAttachments then classifier prompt', () => {
    expect(quotePriceProdInput({})).toBe('readQuoteAttachments → buildQuoteWorkflowPrompt');
    expect(quotePriceProdInput({ PANE_BRAIN: undefined })).toBe(
      'readQuoteAttachments → buildQuoteWorkflowPrompt',
    );
    expect(quotePriceProdInput({ PANE_BRAIN: 'classifier' })).toBe(
      'readQuoteAttachments → buildQuoteWorkflowPrompt',
    );
    expect(quotePriceProdInput({ PANE_BRAIN: 'agent' })).toBe(
      'readQuoteAttachments → selectionToAgentPrompt',
    );
  });

  it('passes when rate plan and price per night match staff', () => {
    expect(scoreQuotePriceRow({ staff: { ratePlan: 'BAR', pricePerNightMinor: 194_000 }, nava: priced() })).toEqual({
      verdict: 'pass',
      reason: 'exact_match',
    });
  });

  it('fails a price that differs with no HMS reason', () => {
    expect(
      scoreQuotePriceRow({
        staff: { ratePlan: 'BAR', pricePerNightMinor: 194_000 },
        nava: priced({ pricePerNightMinor: 198_000 }),
      }),
    ).toEqual({ verdict: 'fail', reason: 'price_mismatch' });
  });

  it('counts a named HMS refusal (fully booked) as a pass', () => {
    expect(
      scoreQuotePriceRow({
        staff: { ratePlan: 'BAR', pricePerNightMinor: 194_000 },
        nava: { status: 'refused', outcome: 'refused: Fully booked for those dates.' },
      }),
    ).toEqual({ verdict: 'pass', reason: 'named_hms_refusal' });
  });

  it('excludes a non-plannable ask with a reason', async () => {
    const result = await runQuotePriceGoldReplay(
      [
        ask({
          id: 'ask-skip-1',
          plannable: false,
          excludeReason: 'missing_dates',
          staffTruth: undefined,
        }),
      ],
      { runQuote: async () => priced() },
    );
    expect(result.summary.plannable).toBe(0);
    expect(result.summary.excluded).toBe(1);
    expect(result.rows).toEqual([
      { id: 'ask-skip-1', hotel: 'HRCEN', verdict: 'excluded', reason: 'missing_dates' },
    ]);
    expect(result.summary.misses).toEqual([{ id: 'ask-skip-1', reason: 'missing_dates' }]);
  });

  it('picks the most recent staff-answered ask per hotel since the cut-off', () => {
    const selected = selectRecentQuoteAsks(
      [
        ask({ id: 'ask-hrcen-old', askedAt: '2026-10-19T09:00:00.000Z' }),
        ask({ id: 'ask-hrcen-new', askedAt: '2026-10-22T09:00:00.000Z' }),
        ask({
          id: 'ask-hrdav-new',
          hotel: 'HRDAV',
          askedAt: '2026-10-21T12:00:00.000Z',
        }),
        ask({
          id: 'ask-hrcen-noreply',
          askedAt: '2026-10-22T10:00:00.000Z',
          staffSent: {},
        }),
      ],
      { cutoff: CUTOFF },
    );
    expect(selected.map((row) => row.id)).toEqual(['ask-hrcen-new', 'ask-hrdav-new']);
  });

  it('runs quotes one at a time through the queue and scores both hotels', async () => {
    let inFlight = 0;
    let maxInFlight = 0;
    const seen: string[] = [];
    const result = await runQuotePriceGoldReplay(
      [
        ask({ id: 'ask-hrcen-1' }),
        ask({
          id: 'ask-hrdav-1',
          hotel: 'HRDAV',
          askedAt: '2026-10-21T10:00:00.000Z',
          staffTruth: { ratePlan: 'BAR', pricePerNightMinor: 210_000 },
        }),
      ],
      {
        runQuote: async (job) => {
          inFlight += 1;
          maxInFlight = Math.max(maxInFlight, inFlight);
          seen.push(job.id);
          expect(job.promptPath).toBe('readQuoteAttachments → buildQuoteWorkflowPrompt');
          expect(job.prompt).toContain('Synthetic quote request for one single B&B.');
          await Promise.resolve();
          inFlight -= 1;
          if (job.hotel === 'HRDAV') {
            return priced({ pricePerNightMinor: 210_000 });
          }
          return priced();
        },
      },
    );
    expect(maxInFlight).toBe(1);
    expect(seen).toEqual(['ask-hrcen-1', 'ask-hrdav-1']);
    expect(result.summary.plannable).toBe(2);
    expect(result.summary.passed).toBe(2);
    expect(result.summary.failed).toBe(0);
    expect(result.summary.prodInput).toBe('readQuoteAttachments → buildQuoteWorkflowPrompt');
    expect(result.summary.scoreKind).toBe('behaviour_check');
    expect(result.summary.byHotel.HRCEN).toEqual({ n: 1, plannable: 1, passed: 1, failed: 0, excluded: 0 });
    expect(result.summary.byHotel.HRDAV).toEqual({ n: 1, plannable: 1, passed: 1, failed: 0, excluded: 0 });
    expect(result.rows.every((row) => row.verdict === 'pass')).toBe(true);
  });

  it('refuses --apply and remote paths', () => {
    expect(() =>
      parseQuotePriceGoldReplayArgs(['--apply', '--fixture', 'a.jsonl', '--out', 'b.jsonl']),
    ).toThrow('apply_forbidden');
    expect(() =>
      parseQuotePriceGoldReplayArgs(['--fixture', 'postgres://example/db', '--out', '/tmp/out.jsonl']),
    ).toThrow('local_paths_only');
  });

  it('prints counts only, no guest-shaped ids or addresses', async () => {
    const result = await runQuotePriceGoldReplay([ask()], { runQuote: async () => priced() });
    const stdout = formatQuotePriceStdout(result.summary);
    expect(stdout).not.toContain('ask-hrcen-1');
    expect(stdout).not.toMatch(/@/);
    expect(JSON.parse(stdout).plannable).toBe(1);
    expect(JSON.parse(stdout).passed).toBe(1);
    expect(JSON.parse(stdout).prodInput).toBe('readQuoteAttachments → buildQuoteWorkflowPrompt');
  });

  it('scores an offline fixture nava result without calling the queue', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'quote-price-gold-'));
    try {
      const fixturePath = join(dir, 'fixture.jsonl');
      writeFileSync(
        fixturePath,
        `${JSON.stringify({
          ...ask({ id: 'ask-hrcen-2' }),
          nava: priced(),
        })}\n`,
      );
      expect(parseQuotePriceGoldReplayArgs(['--fixture', fixturePath, '--out', join(dir, 'out.jsonl')])).toEqual({
        fixturePath,
        outPath: join(dir, 'out.jsonl'),
      });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

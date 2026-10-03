import { describe, expect, it } from 'vitest';
import type { CenturionCorpusMessageRow } from '../src/ops/centurion-thread-corpus-postgres-reader.js';
import {
  buildCases,
  pickPhaseA,
  scoreCase,
  toIsoDay,
  type BacktestCase,
  type ToolCall,
} from '../src/ai/reservationist-backtest.js';
import { QUOTE_UNAVAILABLE, type ReservationistDecision } from '../src/ai/reservationist-agent.js';

let seq = 0;
function msg(p: Partial<CenturionCorpusMessageRow>): CenturionCorpusMessageRow {
  seq += 1;
  return {
    id: `m${seq}`,
    threadId: 't',
    businessDirection: 'inbound',
    confirmedOutbound: false,
    scope: 'in_window',
    eventAt: '2026-09-27T08:00:00.000Z',
    subject: 's',
    textBody: '',
    htmlBody: '',
    from: ['guest@example.test'],
    ...p,
  } as CenturionCorpusMessageRow;
}

function thread(id: string, day: string, ask: string, gold: string, extra: Partial<CenturionCorpusMessageRow> = {}) {
  return [
    msg({ threadId: id, messageId: `<ask-${id}>`, eventAt: `${day}T08:00:00.000Z`, textBody: ask, ...extra }),
    msg({
      threadId: id,
      eventAt: `${day}T09:00:00.000Z`,
      businessDirection: 'outbound',
      inReplyTo: `<ask-${id}>`,
      queueState: null,
      textBody: gold,
      from: ['reservations@centurion.test'],
    }),
  ];
}

const QUOTE = 'Please quote 2 adults check in 2 October 2026 check out 4 October 2026';
const PARTY = 'Please quote for our company account ACME, corporate rate, check in 2 October 2026';
const CREATE = 'Please book a room for Mr Smith, arriving 2 October 2026';
const THANKS = 'Thank you, noted.';

describe('buildCases', () => {
  it('keeps sent in-window replies paired to the inbound they answer', () => {
    const rows = [
      ...thread('gold', '2026-09-28', QUOTE, 'Rate is R1 850 per night'),
      msg({ threadId: 'no-gold', textBody: QUOTE }),
      ...thread('queued', '2026-09-28', QUOTE, 'x').map((m) =>
        m.businessDirection === 'outbound' ? { ...m, queueState: 'pending' } : m,
      ),
      ...thread('missing-trigger', '2026-09-28', QUOTE, 'x').map((m) =>
        m.businessDirection === 'outbound' ? { ...m, inReplyTo: '<never-ingested>' } : m,
      ),
      ...thread('no-header', '2026-09-27', QUOTE, 'R1 000').map((m) => ({ ...m, inReplyTo: null, subject: 'RE: stay' })),
      ...thread('staff-initiated', '2026-09-27', QUOTE, 'Group report').map((m) => ({ ...m, inReplyTo: null })),
      msg({ threadId: 'later-reply', messageId: '<a1>', eventAt: '2026-09-26T07:00:00.000Z', textBody: QUOTE }),
      msg({ threadId: 'later-reply', eventAt: '2026-09-26T08:00:00.000Z', businessDirection: 'outbound', subject: 'Report', textBody: 'FYI' }),
      msg({ threadId: 'later-reply', eventAt: '2026-09-26T09:00:00.000Z', businessDirection: 'outbound', inReplyTo: '<a1>', textBody: 'R1 500' }),
      msg({ threadId: 'split-in', messageId: '<s1>', eventAt: '2026-09-26T05:00:00.000Z', textBody: QUOTE }),
      msg({ threadId: 'split-out', eventAt: '2026-09-26T06:00:00.000Z', businessDirection: 'outbound', inReplyTo: '<s1>', textBody: 'R1 700' }),
      ...thread('empty-forward', '2026-09-28', 'Thank you', ' From: Guest\nSent: Monday\nRate R2 000'),
    ];
    const cases = buildCases(rows);
    expect(cases.map((c) => c.threadId)).toEqual(['gold', 'no-header', 'later-reply', 'split-in']);
    expect(cases.find((c) => c.threadId === 'split-in')?.goldText).toBe('R1 700');
    expect(cases[0]).toMatchObject({ stratum: 'quote_fit', oracle: { quote: true }, goldText: 'Rate is R1 850 per night' });
  });

  it('reads html-only bodies and strata from the oracle', () => {
    const cases = buildCases([
      ...thread('p', '2026-09-28', '', 'ok', { htmlBody: `<p>${PARTY}</p>` }),
      ...thread('c', '2026-09-28', CREATE, 'Booked'),
      ...thread('n', '2026-09-28', THANKS, 'Pleasure'),
    ]);
    expect(Object.fromEntries(cases.map((c) => [c.threadId, c.stratum]))).toEqual({
      p: 'quote_party',
      c: 'create',
      n: 'no_tool',
    });
    const [agent] = buildCases(thread('a', '2026-09-28', 'Please quote our agent rate for 2 nights', 'R900'));
    expect(agent?.stratum).toBe('quote_party');
  });
});

describe('pickPhaseA', () => {
  it('is deterministic, prefers the latest day, and caps quotes at 1 party + 3 fit', () => {
    const rows = [];
    for (let i = 0; i < 6; i += 1) rows.push(...thread(`fit28-${i}`, '2026-09-28', QUOTE, 'R1 000'));
    for (let i = 0; i < 3; i += 1) rows.push(...thread(`fit26-${i}`, '2026-09-26', QUOTE, 'R1 000'));
    for (let i = 0; i < 2; i += 1) rows.push(...thread(`party-${i}`, '2026-09-27', PARTY, 'R900'));
    for (let i = 0; i < 5; i += 1) rows.push(...thread(`create-${i}`, '2026-09-26', CREATE, 'Booked'));
    for (let i = 0; i < 8; i += 1) rows.push(...thread(`none-${i}`, '2026-09-27', THANKS, 'Pleasure'));
    const cases = buildCases(rows);
    const a = pickPhaseA(cases);
    const b = pickPhaseA([...cases].reverse());
    expect(a.picked.map((c) => c.threadId)).toEqual(b.picked.map((c) => c.threadId));
    expect(a.picked).toHaveLength(15);
    const by = (s: string) => a.picked.filter((c) => c.stratum === s);
    expect(by('quote_party')).toHaveLength(1);
    expect(by('quote_fit').map((c) => c.threadId)).toEqual(['fit28-0', 'fit28-1', 'fit28-2']);
    expect(by('create').length).toBeGreaterThanOrEqual(2);
    expect(by('no_tool').length).toBeGreaterThanOrEqual(2);
    expect(a.emptyStrata).toEqual(['other']);
  });
});

describe('toIsoDay', () => {
  it('normalises SA date formats', () => {
    expect(toIsoDay('2 October 2026')).toBe('2026-10-02');
    expect(toIsoDay('02/10/2026')).toBe('2026-10-02');
    expect(toIsoDay('2026-10-02')).toBe('2026-10-02');
    expect(toIsoDay('Fri 2 Oct', '2026-09-27T08:00:00.000Z')).toBe('2026-10-02');
    expect(toIsoDay('15 Jan', '2026-09-27T08:00:00.000Z')).toBe('2027-01-15');
    expect(toIsoDay('soon')).toBeNull();
  });
});

describe('scoreCase', () => {
  const [quoteCase] = buildCases(thread('q', '2026-09-28', QUOTE, 'Rate is R1 850 per night')) as [BacktestCase];
  const [noneCase] = buildCases(thread('n', '2026-09-28', THANKS, 'Pleasure')) as [BacktestCase];
  const decision = (p: Partial<ReservationistDecision>): ReservationistDecision => ({
    workflow: 'quote',
    stayAsk: { arrivalDate: '2026-10-02', departureDate: '2026-10-04', adults: 2, children: 0, rooms: 1 },
    missing: [],
    replyDraft: '',
    rationale: '',
    ...p,
  });
  const live = (rate: number): ToolCall => ({
    toolName: 'quote_stay',
    args: {},
    result: { outcome: 'quote', elapsedMs: 220000, groups: [{ options: [{ total: rate }] }] },
  });

  it('matches gold money and dates', () => {
    const row = scoreCase(quoteCase, decision({ replyDraft: 'R1 850 per night' }), [live(1850)]);
    expect(row).toMatchObject({ money: 'match', datesOk: true, paxOk: true, quoteLive: true, hmsElapsedMs: 220000, pass: true });
  });

  it('grounds draft amounts in HMS decimal-string rates', () => {
    const call: ToolCall = { ...live(0), result: { outcome: 'quote', groups: [{ options: [{ amount: '1850.00' }] }] } };
    expect(scoreCase(quoteCase, decision({ replyDraft: 'R1,850 (R7,400 for 4 nights)' }), [call]).money).toBe('extract_fail');
    expect(scoreCase(quoteCase, decision({ replyDraft: 'R1,850' }), [call]).money).toBe('match');
  });

  it('grounds cents the same way on both sides', () => {
    const call: ToolCall = { ...live(0), result: { outcome: 'quote', groups: [{ options: [{ amount: 1850.5 }] }] } };
    expect(scoreCase(quoteCase, decision({ replyDraft: 'R1 850.50' }), [call]).money).toBe('match');
  });

  it('separates rate_stale from extract_fail', () => {
    expect(scoreCase(quoteCase, decision({ replyDraft: 'R2 100' }), [live(2100)]).money).toBe('rate_stale');
    const bad = scoreCase(quoteCase, decision({ replyDraft: 'R1 234' }), [live(2100)]);
    expect(bad.money).toBe('extract_fail');
    expect(bad.pass).toBe(false);
  });

  it('flags quote false positive on stub and quote miss', () => {
    const fp = scoreCase(noneCase, decision({ workflow: 'quote' }), [
      { toolName: 'quote_stay', args: {}, result: { status: QUOTE_UNAVAILABLE } },
    ]);
    expect(fp).toMatchObject({ quoteCalled: true, quoteLive: false, quoteFalsePositive: true, workflowOk: false, pass: false });
    const miss = scoreCase(quoteCase, decision({ workflow: 'other' }), []);
    expect(miss).toMatchObject({ quoteMiss: true, pass: false });
    const skip = scoreCase(noneCase, decision({ workflow: 'skip', stayAsk: null }), []);
    expect(skip).toMatchObject({ workflowOk: true, pass: true });
  });
});

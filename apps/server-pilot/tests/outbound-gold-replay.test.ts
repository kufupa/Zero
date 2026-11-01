import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import type { MailExtractionPayload } from '../src/ai/extraction/schema.js';
import {
  parseFixtureJsonl,
  scoreOutboundGoldFixture,
} from '../src/ai/outbound-gold-features.js';
import type { SyncedQuoteSelection } from '../src/ai/quote-workflow-synced-selection.js';
import {
  REPLAY_CHECK,
  REPLAY_PROD_INPUT,
  cardsFromPayload,
  formatReplayStdout,
  freezeThreadHistoryAt,
  inRequestWindow,
  isConfirmationLetterFilename,
  orderInboundRequests,
  parseOutboundGoldReplayArgs,
  readThreadIdList,
  replayIoErrorCode,
  reserveReplayOutputs,
  runOutboundGoldReplay,
  selectRequestOutbound,
  type ReplayDeps,
  type ReplayTrigger,
} from '../scripts/outbound-gold-replay.js';

const FIXTURE_GUEST = 'Fixturealpha';
const FIXTURE_GUEST_B = 'Fixturebravo';
const CONF = '10000001';
const CONF_B = '10000002';
const ARRIVAL = '2027-01-15';
const ARRIVAL_B = '2027-02-20';
const THREAD_A = 'thread-fixture-alpha';
const THREAD_B = 'thread-fixture-bravo';
const REQUEST_AT = new Date('2026-10-14T09:00:00.000Z');
const UNTIL = new Date('2026-10-20T09:00:00.000Z');

const PAYLOAD: MailExtractionPayload = {
  contact: { name: null, email: null, phone: null },
  agency: null,
  endClient: null,
  confirmationNumbers: [`${CONF}-1`],
  stays: [
    {
      id: 's_fixture1',
      hotel: null,
      requested: { arrival: ARRIVAL, departure: '2027-01-17' },
      booked: null,
      totalRooms: 1,
      rows: [],
      guests: [{ name: FIXTURE_GUEST, confirmationNumber: `${CONF}-1` }],
    },
  ],
  missing: [],
};

const PAYLOAD_TWO: MailExtractionPayload = {
  ...PAYLOAD,
  confirmationNumbers: [`${CONF}-1`, `${CONF_B}-1`],
  stays: [
    PAYLOAD.stays[0]!,
    {
      id: 's_fixture2',
      hotel: null,
      requested: { arrival: ARRIVAL_B, departure: '2027-02-22' },
      booked: null,
      totalRooms: 1,
      rows: [],
      guests: [{ name: FIXTURE_GUEST_B, confirmationNumber: `${CONF_B}-1` }],
    },
  ],
};

const SELECTION: SyncedQuoteSelection = {
  subject: 'Synthetic stay request',
  bodyText: 'Please book one room.',
  receivedAt: '2026-10-14T09:00:00.000Z',
  preceding: [],
  attachments: [
    {
      id: 'att-in',
      filename: 'request.pdf',
      bytesPresent: true,
      text: 'Synthetic attachment text',
    },
  ],
  messageId: 'message-fixture-1',
  threadId: THREAD_A,
  fromAddress: 'agent@example.test',
};

function trigger(threadId = THREAD_A): ReplayTrigger {
  return {
    threadId,
    messageId: 'message-fixture-1',
    transportId: 'transport-centurion',
    fromAddress: 'agent@example.test',
    mailbox: 'reservations@example.test',
    at: REQUEST_AT,
    until: UNTIL,
  };
}

function deps(overrides: Partial<ReplayDeps> = {}): ReplayDeps {
  const extract = vi.fn(async (input: { selection: SyncedQuoteSelection }) => {
    expect(input.selection.attachments[0]?.text).toContain('Synthetic attachment text');
    return { ok: true as const, kind: 'booking' as const, payload: PAYLOAD };
  });
  return {
    loadRequests: async (threadId) => (threadId === THREAD_A ? [trigger(threadId)] : []),
    loadSelection: async () => SELECTION,
    loadArtifacts: async () => ({
      letters: [
        {
          id: 'letter-fixture-1',
          guest: FIXTURE_GUEST,
          conf: CONF,
          arrival: ARRIVAL,
          filename: `HRCEN_Confirmation_Letter_${CONF}.pdf`,
        },
      ],
      replyId: 'reply-fixture-1',
      quotePdfId: null,
    }),
    extract,
    ...overrides,
  };
}

describe('outbound-gold replay runner', () => {
  it('refuses --apply, remote paths, and guest-shaped id lines', () => {
    expect(() =>
      parseOutboundGoldReplayArgs(['--apply', '--ids', 'a.txt', '--out', 'b.jsonl', '--misses', 'c.jsonl']),
    ).toThrow('apply_forbidden');
    expect(() =>
      parseOutboundGoldReplayArgs([
        '--ids',
        'postgres://example/db',
        '--out',
        '/tmp/out.jsonl',
        '--misses',
        '/tmp/miss.jsonl',
      ]),
    ).toThrow('local_paths_only');
    expect(() => readThreadIdList('not a thread@id\n')).toThrow('invalid_thread_id');
    expect(readThreadIdList(`# comment\n${THREAD_A}\n${THREAD_A}\n${THREAD_B}\n`)).toEqual([
      THREAD_A,
      THREAD_B,
    ]);
    expect(isConfirmationLetterFilename(`nested/HRCEN_Confirmation_Letter_${CONF}.pdf`)).toBe(true);
  });

  it('pairs letters to the request window and ignores earlier outbound', () => {
    const before = { id: 'old-letter', at: new Date('2026-10-13T09:00:00.000Z') };
    const answer = { id: 'new-letter', at: new Date('2026-10-15T09:00:00.000Z') };
    const laterAsk = { id: 'next-letter', at: new Date('2026-10-21T09:00:00.000Z') };
    expect(inRequestWindow(before.at, REQUEST_AT, UNTIL)).toBe(false);
    expect(inRequestWindow(answer.at, REQUEST_AT, UNTIL)).toBe(true);
    expect(inRequestWindow(laterAsk.at, REQUEST_AT, UNTIL)).toBe(false);
    expect(selectRequestOutbound([before, answer, laterAsk], REQUEST_AT, UNTIL).map((row) => row.id)).toEqual([
      'new-letter',
    ]);
  });

  it('orders a null receivedAt inbound by inboundAt so its reply stays in window', () => {
    const early = {
      messageId: 'inbound-early',
      arrivedAt: null,
      receivedAt: new Date('2026-10-20T09:00:00.000Z'),
      sentAt: new Date('2026-10-20T09:00:00.000Z'),
      createdAt: new Date('2026-10-10T09:00:00.000Z'),
    };
    const later = {
      messageId: 'inbound-later',
      arrivedAt: null,
      receivedAt: new Date('2026-10-08T09:00:00.000Z'),
      sentAt: null,
      createdAt: new Date('2026-10-12T09:00:00.000Z'),
    };
    const ordered = orderInboundRequests([later, early]);
    expect(ordered.map((row) => row.messageId)).toEqual(['inbound-early', 'inbound-later']);
    expect(ordered[0]?.until?.getTime()).toBe(later.createdAt.getTime());
    const reply = { id: 'reply-after-early', at: new Date('2026-10-11T09:00:00.000Z') };
    expect(inRequestWindow(reply.at, ordered[0]!.at, ordered[0]!.until)).toBe(true);
  });

  it('refuses existing --out or --misses before extract', () => {
    const dir = mkdtempSync(join(tmpdir(), 'outbound-gold-reserve-'));
    const extract = vi.fn();
    try {
      const outPath = join(dir, 'fixture.jsonl');
      const missesPath = join(dir, 'misses.jsonl');
      writeFileSync(outPath, 'stale\n');
      expect(() => reserveReplayOutputs(outPath, missesPath)).toThrow('out_exists');
      expect(extract).not.toHaveBeenCalled();
      rmSync(outPath);
      writeFileSync(missesPath, 'stale\n');
      expect(() => reserveReplayOutputs(outPath, missesPath)).toThrow('out_exists');
      expect(extract).not.toHaveBeenCalled();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('replays fake thread ids through extractInboundMail and writes one scorer row per request', async () => {
    const source = deps();
    const result = await runOutboundGoldReplay([THREAD_A, THREAD_B], source);

    expect(result.summary.n).toBe(2);
    expect(result.summary.covered).toBe(1);
    expect(result.summary.missed).toBe(1);
    expect(result.summary.distinctLetters).toBe(1);
    expect(result.summary.lettersCovered).toBe(1);
    expect(result.summary.distinctDateSets).toBe(1);
    expect(result.summary.extractFailed).toBe(0);
    expect(result.summary.check).toBe(REPLAY_CHECK);
    expect(result.summary.prodInput).toBe(REPLAY_PROD_INPUT);
    expect(result.summary.prodInput).toBe('readQuoteAttachments → extractInboundMail');
    expect(result.summary.visionParity).toBe('gap');
    expect(result.summary.scoreKind).toBe('behaviour_check');
    expect(result.misses).toEqual([{ id: THREAD_B, reason: 'thread_not_found' }]);
    expect(result.rows).toHaveLength(1);
    expect(result.rows[0]?.letters).toHaveLength(1);
    expect(result.rows[0]?.cards).toHaveLength(1);
    expect(source.extract).toHaveBeenCalledWith(expect.objectContaining({ propertyCode: 'HRCEN' }));

    const parsed = parseFixtureJsonl(result.rows.map((row) => JSON.stringify(row)).join('\n'));
    const scored = scoreOutboundGoldFixture(parsed.rows, parsed.jsonlErrors);
    expect(parsed.jsonlErrors).toBe(0);
    expect(scored.letters).toBe(1);
    expect(scored.lettersCovered).toBe(1);
    expect(scored.cards).toBe(1);
    expect(scored.pass).toBe(true);

    const stdout = formatReplayStdout(result.summary);
    expect(stdout).not.toContain(FIXTURE_GUEST);
    expect(stdout).not.toContain(THREAD_A);
    expect(stdout).not.toContain(CONF);
    expect(stdout).not.toMatch(/@/);
    expect(stdout).not.toContain('checkPass');
    expect(stdout).not.toContain('selectionToAgentPrompt');
    expect(JSON.parse(stdout).check).toBe('not_tested');
    expect(cardsFromPayload(PAYLOAD)[0]?.guests?.[0]?.guest).toBe(FIXTURE_GUEST);
  });

  it('writes one two-letter fixture row so the scorer does not double cards', async () => {
    const result = await runOutboundGoldReplay([THREAD_A], {
      ...deps({
        extract: async () => ({ ok: true, kind: 'booking', payload: PAYLOAD_TWO }),
        loadArtifacts: async () => ({
          letters: [
            {
              id: 'letter-fixture-1',
              guest: FIXTURE_GUEST,
              conf: CONF,
              arrival: ARRIVAL,
              filename: `HRCEN_Confirmation_Letter_${CONF}.pdf`,
            },
            {
              id: 'letter-fixture-2',
              guest: FIXTURE_GUEST_B,
              conf: CONF_B,
              arrival: ARRIVAL_B,
              filename: `HRCEN_Confirmation_Letter_${CONF_B}.pdf`,
            },
          ],
          replyId: 'reply-fixture-1',
          quotePdfId: null,
        }),
      }),
    });

    expect(result.rows).toHaveLength(1);
    expect(result.rows[0]?.letters).toHaveLength(2);
    expect(result.rows[0]?.cards).toHaveLength(2);
    expect(result.summary.cards).toBe(2);
    expect(result.summary.distinctLetters).toBe(2);

    const scored = scoreOutboundGoldFixture(result.rows);
    expect(scored.letters).toBe(2);
    expect(scored.cards).toBe(2);
    expect(scored.distinctDateSets).toBe(2);
    expect(scored.pass).toBe(true);
  });

  it('covers a new booking whose card confirmation is still null', async () => {
    const payload: MailExtractionPayload = {
      ...PAYLOAD,
      confirmationNumbers: [],
      stays: [
        {
          ...PAYLOAD.stays[0]!,
          guests: [{ name: FIXTURE_GUEST, confirmationNumber: null }],
        },
      ],
    };
    const result = await runOutboundGoldReplay([THREAD_A], {
      ...deps({
        extract: async () => ({ ok: true, kind: 'booking', payload }),
      }),
    });
    expect(result.summary.covered).toBe(1);
    expect(result.summary.missed).toBe(0);
    expect(result.rows[0]?.kind).toBe('booking');
    expect(result.rows[0]?.cards?.[0]?.guests?.[0]?.conf).toBeNull();
    expect(scoreOutboundGoldFixture(result.rows).pass).toBe(true);
  });

  it('counts a failed extract in stdout and does not treat it as covered', async () => {
    const result = await runOutboundGoldReplay([THREAD_A], {
      ...deps({
        extract: async () => ({ ok: false }),
      }),
    });
    expect(result.summary.extractFailed).toBe(1);
    expect(result.summary.covered).toBe(0);
    expect(result.misses).toEqual([{ id: 'message-fixture-1', reason: 'extract_failed' }]);
    expect(result.rows).toHaveLength(1);
    expect(result.rows[0]?.letters).toEqual([]);
    expect(scoreOutboundGoldFixture(result.rows).pass).toBe(false);
    expect(JSON.parse(formatReplayStdout(result.summary)).extractFailed).toBe(1);
  });

  it('drops a later staff reply from the extract prompt at trigger mailbox arrival', async () => {
    const later = 'Later staff reply must not reach extract';
    const extract = vi.fn(async (input: { selection: SyncedQuoteSelection }) => {
      expect(input.selection.threadMessages?.some((message) => message.bodyText === later)).toBe(false);
      return { ok: true as const, kind: 'booking' as const, payload: PAYLOAD };
    });
    await runOutboundGoldReplay([THREAD_A], {
      ...deps({
        loadSelection: async () => ({
          ...SELECTION,
          threadMessages: [
            {
              direction: 'outbound',
              timestamp: '2026-10-14T08:00:00.000Z',
              subject: 'earlier',
              bodyText: 'Earlier staff reply',
            },
            {
              direction: 'outbound',
              timestamp: '2026-10-14T10:00:00.000Z',
              subject: 'later',
              bodyText: later,
            },
          ],
        }),
        extract,
      }),
    });
    expect(extract).toHaveBeenCalled();
    const frozen = freezeThreadHistoryAt(
      {
        ...SELECTION,
        threadMessages: [
          {
            direction: 'inbound',
            timestamp: '2026-10-14T10:00:00.000Z',
            subject: 'earlier ask',
            bodyText: 'Earlier inbound with a sender Date ahead of mailbox arrival',
          },
          {
            direction: 'outbound',
            timestamp: '2026-10-14T10:00:00.000Z',
            subject: 'later',
            bodyText: later,
          },
        ],
      },
      REQUEST_AT,
    );
    expect(frozen.threadMessages?.map((message) => message.direction)).toEqual(['inbound']);
  });

  it('does not fail coverage on a thank-you inbound with no letter', async () => {
    const result = await runOutboundGoldReplay([THREAD_A], {
      ...deps({
        extract: async () => ({ ok: true, kind: 'other', payload: { ...PAYLOAD, stays: [] } }),
        loadArtifacts: async () => ({ letters: [], replyId: null, quotePdfId: null }),
      }),
    });
    expect(result.summary.covered).toBe(0);
    expect(result.misses).toEqual([]);
    expect(result.rows).toHaveLength(0);
    expect(scoreOutboundGoldFixture(result.rows).pass).toBe(false);
  });

  it('keeps booked arrival when an amendment does not restate dates', () => {
    const cards = cardsFromPayload({
      ...PAYLOAD,
      stays: [
        {
          ...PAYLOAD.stays[0]!,
          requested: { arrival: null, departure: null },
          booked: { arrival: ARRIVAL, departure: '2027-01-17' },
        },
      ],
    });
    expect(cards[0]?.arrival).toBe(ARRIVAL);
  });

  it('prints out_exists for coded out_exists and EEXIST', () => {
    expect(replayIoErrorCode(Object.assign(new Error('out_exists'), { code: 'out_exists' }))).toBe(
      'out_exists',
    );
    expect(replayIoErrorCode(Object.assign(new Error('EEXIST'), { code: 'EEXIST' }))).toBe('out_exists');
  });
});

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
  inRequestWindow,
  isConfirmationLetterFilename,
  parseOutboundGoldReplayArgs,
  readThreadIdList,
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
    transportId: 'transport-fixture',
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

  it('replays fake thread ids through extractInboundMail and writes one scorer row per request', async () => {
    const source = deps();
    const result = await runOutboundGoldReplay([THREAD_A, THREAD_B], source);

    expect(result.summary.n).toBe(2);
    expect(result.summary.covered).toBe(1);
    expect(result.summary.missed).toBe(1);
    expect(result.summary.distinctLetters).toBe(1);
    expect(result.summary.lettersCovered).toBe(1);
    expect(result.summary.distinctDateSets).toBe(1);
    expect(result.summary.check).toBe(REPLAY_CHECK);
    expect(result.summary.prodInput).toBe(REPLAY_PROD_INPUT);
    expect(result.summary.prodInput).toBe('readQuoteAttachments → extractInboundMail');
    expect(result.summary.visionParity).toBe('gap');
    expect(result.summary.scoreKind).toBe('behaviour_check');
    expect(result.misses).toEqual([{ id: THREAD_B, reason: 'thread_not_found' }]);
    expect(result.rows).toHaveLength(1);
    expect(result.rows[0]?.letters).toHaveLength(1);
    expect(result.rows[0]?.cards).toHaveLength(1);

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
});

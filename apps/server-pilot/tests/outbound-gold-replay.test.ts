import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
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
  cardsFromPayload,
  formatReplayStdout,
  isConfirmationLetterFilename,
  parseOutboundGoldReplayArgs,
  readThreadIdList,
  runOutboundGoldReplay,
  type ReplayDeps,
} from '../scripts/outbound-gold-replay.js';

const FIXTURE_GUEST = 'Fixturealpha';
const CONF = '10000001';
const ARRIVAL = '2027-01-15';
const THREAD_A = 'thread-fixture-alpha';
const THREAD_B = 'thread-fixture-bravo';

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

function deps(overrides: Partial<ReplayDeps> = {}): ReplayDeps {
  const extract = vi.fn(async (input: { prompt: string }) => {
    expect(input.prompt).toContain('Synthetic attachment text');
    return { ok: true as const, kind: 'booking' as const, payload: PAYLOAD };
  });
  return {
    loadTrigger: async (threadId) =>
      threadId === THREAD_A
        ? {
            threadId,
            messageId: 'message-fixture-1',
            transportId: 'transport-fixture',
            fromAddress: 'agent@example.test',
            mailbox: 'reservations@example.test',
          }
        : null,
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

  it('replays fake thread ids through prod input and writes scorer JSONL plus a miss file', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'outbound-gold-replay-'));
    try {
      const source = deps();
      const result = await runOutboundGoldReplay([THREAD_A, THREAD_B], source);

      expect(result.summary.n).toBe(2);
      expect(result.summary.covered).toBe(1);
      expect(result.summary.missed).toBe(1);
      expect(result.summary.distinctLetters).toBe(1);
      expect(result.summary.lettersCovered).toBe(1);
      expect(result.summary.distinctDateSets).toBe(1);
      expect(result.summary.wroteBeforePick).toBe(0);
      expect(result.summary.checkPass).toBe(true);
      expect(result.summary.prodInput).toBe('readQuoteAttachments → selectionToAgentPrompt');
      expect(result.summary.visionParity).toBe('gap');
      expect(result.summary.scoreKind).toBe('behaviour_check');
      expect(result.misses).toEqual([{ id: THREAD_B, reason: 'thread_not_found' }]);

      const parsed = parseFixtureJsonl(
        result.rows.map((row) => JSON.stringify(row)).join('\n'),
      );
      const scored = scoreOutboundGoldFixture(parsed.rows, parsed.jsonlErrors);
      expect(parsed.jsonlErrors).toBe(0);
      expect(scored.letters).toBe(1);
      expect(scored.lettersCovered).toBe(1);
      expect(scored.pass).toBe(true);

      const stdout = formatReplayStdout(result.summary);
      expect(stdout).not.toContain(FIXTURE_GUEST);
      expect(stdout).not.toContain(THREAD_A);
      expect(stdout).not.toContain(CONF);
      expect(stdout).not.toMatch(/@/);

      const idsPath = join(dir, 'ids.txt');
      const outPath = join(dir, 'fixture.jsonl');
      const missPath = join(dir, 'misses.jsonl');
      writeFileSync(idsPath, `${THREAD_A}\n`);
      writeFileSync(outPath, result.rows.map((row) => JSON.stringify(row)).join('\n') + '\n', {
        flag: 'wx',
      });
      writeFileSync(missPath, result.misses.map((row) => JSON.stringify(row)).join('\n') + '\n', {
        flag: 'wx',
      });
      expect(readFileSync(idsPath, 'utf8')).toBe(`${THREAD_A}\n`);
      expect(readFileSync(missPath, 'utf8')).toContain(THREAD_B);
      expect(cardsFromPayload(PAYLOAD)[0]?.guests?.[0]?.guest).toBe(FIXTURE_GUEST);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

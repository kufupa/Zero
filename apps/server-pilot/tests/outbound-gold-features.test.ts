import { describe, expect, it } from 'vitest';
import {
  OUTBOUND_GOLD_COUNT_KEYS,
  checkLetterCoverage,
  formatAggregateStdout,
  parseFixtureJsonl,
  parseLetterFields,
  reportScoreKind,
  scoreOutboundGoldFixture,
  type GoldCardInput,
  type GoldLetterInput,
} from '../src/ai/outbound-gold-features.js';

const FIXTURE_GUEST_A = 'Fixturealpha';
const FIXTURE_GUEST_B = 'Fixturebravo';
const CONF_A = '10000001';
const CONF_B = '10000002';
const ARRIVAL = '2027-01-15';
const ARRIVAL_B = '2027-02-20';

function letter(overrides: Partial<GoldLetterInput> & Pick<GoldLetterInput, 'id'>): GoldLetterInput {
  return {
    guest: FIXTURE_GUEST_A,
    conf: CONF_A,
    arrival: ARRIVAL,
    ...overrides,
  };
}

function card(overrides: Partial<GoldCardInput> & Pick<GoldCardInput, 'id'>): GoldCardInput {
  return {
    arrival: ARRIVAL,
    departure: '2027-01-17',
    guests: [{ guest: FIXTURE_GUEST_A, conf: CONF_A }],
    ...overrides,
  };
}

describe('parseLetterFields', () => {
  it('parses guest from subject, conf from filename, arrival from pdf text', () => {
    expect(
      parseLetterFields({
        subject: `The Centurion Hotel_Confirmation Letter_${FIXTURE_GUEST_A} (n°${CONF_A}-1)`,
        filename: `HRCEN_Confirmation_Letter_${CONF_A}.pdf`,
        pdfText: 'Header\nArrival 15/01/2027\nRoom',
      }),
    ).toEqual({ guest: FIXTURE_GUEST_A, conf: CONF_A, arrival: ARRIVAL });
  });

  it('parses ISO arrival after Arrival label and ignores missing fields', () => {
    expect(
      parseLetterFields({
        filename: `nested/HRCEN_Confirmation_Letter_${CONF_B}.PDF`,
        pdfText: 'Arrival 2027-02-20 extra',
      }),
    ).toEqual({ guest: null, conf: CONF_B, arrival: ARRIVAL_B });
    expect(parseLetterFields({})).toEqual({ guest: null, conf: null, arrival: null });
  });
});

describe('checkLetterCoverage', () => {
  it('passes when every letter guest+dates+conf sits on some card', () => {
    const result = checkLetterCoverage({
      letters: [
        letter({ id: 'letter-a' }),
        letter({ id: 'letter-b', guest: FIXTURE_GUEST_B, conf: CONF_B }),
      ],
      cards: [
        card({
          id: 'card-1',
          guests: [
            { guest: FIXTURE_GUEST_A, conf: CONF_A },
            { guest: FIXTURE_GUEST_B, conf: CONF_B },
          ],
        }),
      ],
    });
    expect(result.pass).toBe(true);
    expect(result.letters).toBe(2);
    expect(result.lettersCovered).toBe(2);
    expect(result.distinctDateSets).toBe(1);
    expect(result.cards).toBe(1);
    expect(result.dateSetCardPass).toBe(true);
  });

  it('fails when a letter is uncovered or two cards share a date set', () => {
    const uncovered = checkLetterCoverage({
      letters: [letter({ id: 'letter-a' }), letter({ id: 'letter-b', conf: CONF_B })],
      cards: [card({ id: 'card-1' })],
    });
    expect(uncovered.pass).toBe(false);
    expect(uncovered.lettersCovered).toBe(1);
    expect(uncovered.lettersUncovered).toBe(1);

    const duplicateDates = checkLetterCoverage({
      letters: [letter({ id: 'letter-a' })],
      cards: [card({ id: 'card-1' }), card({ id: 'card-2' })],
    });
    expect(duplicateDates.dateSetCardPass).toBe(false);
    expect(duplicateDates.pass).toBe(false);
    expect(duplicateDates.distinctDateSets).toBe(1);
    expect(duplicateDates.cards).toBe(2);
  });

  it('passes a new-booking fixture when the card confirmation is still null', () => {
    const scored = scoreOutboundGoldFixture([
      {
        id: 'ask-new',
        kind: 'booking',
        letters: [letter({ id: 'letter-a' })],
        cards: [card({ id: 'card-1', guests: [{ guest: FIXTURE_GUEST_A, conf: null }] })],
      },
    ]);
    expect(scored.pass).toBe(true);
    expect(scored.lettersCovered).toBe(1);

    const amend = checkLetterCoverage({
      letters: [letter({ id: 'letter-a' })],
      cards: [card({ id: 'card-1', guests: [{ guest: FIXTURE_GUEST_A, conf: null }] })],
      requireConfirmation: true,
    });
    expect(amend.pass).toBe(false);
  });

  it('waives confirmation only when the card has no number', () => {
    const noNumber = checkLetterCoverage({
      letters: [letter({ id: 'letter-a' })],
      cards: [card({ id: 'card-1', guests: [{ guest: FIXTURE_GUEST_A, conf: null }] })],
      requireConfirmation: false,
    });
    expect(noNumber.pass).toBe(true);

    const differ = checkLetterCoverage({
      letters: [letter({ id: 'letter-a' })],
      cards: [card({ id: 'card-1', guests: [{ guest: FIXTURE_GUEST_A, conf: CONF_B }] })],
      requireConfirmation: false,
    });
    expect(differ.pass).toBe(false);
    expect(differ.lettersUncovered).toBe(1);

    const letterMissing = checkLetterCoverage({
      letters: [letter({ id: 'letter-a', conf: null })],
      cards: [card({ id: 'card-1', guests: [{ guest: FIXTURE_GUEST_A, conf: CONF_A }] })],
      requireConfirmation: false,
    });
    expect(letterMissing.pass).toBe(true);
  });

  it('requires a distinct card per distinct date set', () => {
    const result = checkLetterCoverage({
      letters: [letter({ id: 'letter-a' }), letter({ id: 'letter-b', arrival: ARRIVAL_B, conf: CONF_B })],
      cards: [
        card({ id: 'card-1' }),
        card({
          id: 'card-2',
          arrival: ARRIVAL_B,
          departure: '2027-02-22',
          guests: [{ guest: FIXTURE_GUEST_A, conf: CONF_B }],
        }),
      ],
    });
    expect(result.pass).toBe(true);
    expect(result.distinctDateSets).toBe(2);
    expect(result.cards).toBe(2);
    expect(result.dateSetCardPass).toBe(true);
  });
});

describe('reportScoreKind', () => {
  it('reports behaviour check, no rate when n < 100', () => {
    expect(reportScoreKind(0)).toEqual({
      scoreKind: 'behaviour_check',
      n: 0,
      label: 'behaviour check, no rate',
    });
    expect(reportScoreKind(99).label).toBe('behaviour check, no rate');
    expect(reportScoreKind(100)).toEqual({ scoreKind: 'rate', n: 100, label: 'rate' });
  });
});

describe('stdout shape is counts', () => {
  it('prints allowlisted aggregate keys only', () => {
    const scored = scoreOutboundGoldFixture([
      {
        id: 'ask-1',
        replyId: 'reply-1',
        letterId: 'letter-1',
        quotePdfId: null,
        letter: {
          subject: `The Centurion Hotel_Confirmation Letter_${FIXTURE_GUEST_A} (n°${CONF_A}-1)`,
          filename: `HRCEN_Confirmation_Letter_${CONF_A}.pdf`,
          pdfText: 'Arrival 15/01/2027',
        },
        cards: [card({ id: 'card-1' })],
      },
    ]);
    const stdout = formatAggregateStdout(scored);
    const parsed = JSON.parse(stdout) as Record<string, unknown>;
    expect(Object.keys(parsed).sort()).toEqual([...OUTBOUND_GOLD_COUNT_KEYS].sort());
    expect(parsed.rows).toBe(1);
    expect(parsed.letters).toBe(1);
    expect(parsed.coveragePass).toBe(true);
    expect(parsed.n).toBe(1);
    expect(parsed.scoreKind).toBe('behaviour_check');
    expect(parsed.label).toBe('behaviour check, no rate');
    expect(parsed.visionParity).toBe('gap');
    expect(stdout).not.toMatch(/@/);
    expect(stdout).not.toMatch(/\b(?:guest|email|phone|body|subject|filename)\b/i);
    expect(stdout).not.toContain(FIXTURE_GUEST_A);
    expect(stdout).not.toContain(CONF_A);
  });

  it('parses JSONL rows and counts jsonl errors without leaking line text', () => {
    const rows = parseFixtureJsonl(
      [
        '{"id":"ask-1","letterId":"letter-1","cards":[]}',
        '',
        '{not-json}',
        '{"id":"ask-2","replyId":"reply-2"}',
      ].join('\n'),
    );
    expect(rows.rows.map((row) => row.id)).toEqual(['ask-1', 'ask-2']);
    expect(rows.jsonlErrors).toBe(1);
    const stdout = formatAggregateStdout(scoreOutboundGoldFixture(rows.rows, rows.jsonlErrors));
    expect(stdout).not.toContain('not-json');
    expect(JSON.parse(stdout).jsonlErrors).toBe(1);
  });

  it('counts cards once when two letters share one request row', () => {
    const scored = scoreOutboundGoldFixture([
      {
        id: 'ask-1',
        letters: [
          letter({ id: 'letter-a' }),
          letter({ id: 'letter-b', guest: FIXTURE_GUEST_B, conf: CONF_B, arrival: ARRIVAL_B }),
        ],
        cards: [
          card({ id: 'card-1' }),
          card({
            id: 'card-2',
            arrival: ARRIVAL_B,
            departure: '2027-02-22',
            guests: [{ guest: FIXTURE_GUEST_B, conf: CONF_B }],
          }),
        ],
      },
    ]);
    expect(scored.letters).toBe(2);
    expect(scored.lettersCovered).toBe(2);
    expect(scored.cards).toBe(2);
    expect(scored.distinctDateSets).toBe(2);
    expect(scored.pass).toBe(true);
  });

  it('fails two swapped rows that would pass if cards were pooled', () => {
    const scored = scoreOutboundGoldFixture([
      {
        id: 'ask-1',
        letter: { guest: FIXTURE_GUEST_A, conf: CONF_A, arrival: ARRIVAL },
        cards: [card({ id: 'card-b', guests: [{ guest: FIXTURE_GUEST_B, conf: CONF_B }] })],
      },
      {
        id: 'ask-2',
        letter: { guest: FIXTURE_GUEST_B, conf: CONF_B, arrival: ARRIVAL },
        cards: [card({ id: 'card-a', guests: [{ guest: FIXTURE_GUEST_A, conf: CONF_A }] })],
      },
    ]);
    expect(scored.pass).toBe(false);
    expect(scored.letters).toBe(2);
    expect(scored.lettersCovered).toBe(0);
    expect(scored.lettersUncovered).toBe(2);
    expect(scored.cards).toBe(2);
  });

  it('drops rows whose letter or cards are not objects and counts jsonlErrors', () => {
    const parsed = parseFixtureJsonl(
      [
        '{"id":"ask-ok","letter":{},"cards":[]}',
        '{"id":"ask-letter","letter":"nope","cards":[]}',
        '{"id":"ask-cards","letter":{},"cards":"nope"}',
        '{"id":"ask-item","letter":{},"cards":[1]}',
      ].join('\n'),
    );
    expect(parsed.rows.map((row) => row.id)).toEqual(['ask-ok']);
    expect(parsed.jsonlErrors).toBe(3);
    const scored = scoreOutboundGoldFixture(parsed.rows, parsed.jsonlErrors);
    expect(scored.rows).toBe(1);
    expect(scored.jsonlErrors).toBe(3);
  });
});

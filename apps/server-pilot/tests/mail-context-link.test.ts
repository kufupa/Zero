import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  CONTEXT_DATASET_LABEL,
  LETTER_WINDOW_MS,
  linkMailContext,
  maskContextId,
  parseConfirmationLetterFilename,
  parseConfirmationLetterSubjectConf,
  parseMailContextLinkerCli,
  runMailContextLinker,
  type MailContextEvent,
} from '../src/ai/mail-context-link.js';

const temps = new Set<string>();
const REPLY_AT = '2026-10-14T09:00:00.000Z';
const CONF = '10000001';
const CONF_B = '10000002';
const ASK_ID = 'ask-fixture-alpha';
const REPLY_ID = 'reply-fixture-alpha';
const LETTER_ID = 'letter-fixture-alpha';
const THREAD = 'thread-fixture-alpha';
const DOMAIN = 'agency.example';
const GUEST = 'Fixturealpha';
const ARRIVAL = '2027-01-15';
const DEPARTURE = '2027-01-17';
const ROOM = 'STQN';
const ADULTS = 2;

afterEach(async () => {
  for (const dir of temps) await rm(dir, { recursive: true, force: true });
  temps.clear();
});

async function tempDir(): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'mail-context-link-'));
  temps.add(dir);
  return dir;
}

function atOffset(minutes: number): string {
  return new Date(Date.parse(REPLY_AT) + minutes * 60_000).toISOString();
}

function ask(overrides: Partial<MailContextEvent> = {}): MailContextEvent {
  return {
    id: ASK_ID,
    threadId: THREAD,
    at: atOffset(-20),
    direction: 'inbound',
    role: 'ask',
    recipientDomain: DOMAIN,
    facts: { guest: GUEST, arrival: ARRIVAL, departure: DEPARTURE, room: ROOM, adults: ADULTS },
    ...overrides,
  };
}

function reply(overrides: Partial<MailContextEvent> = {}): MailContextEvent {
  return {
    id: REPLY_ID,
    threadId: THREAD,
    at: REPLY_AT,
    direction: 'outbound',
    role: 'staff_reply',
    recipientDomain: DOMAIN,
    ...overrides,
  };
}

function letter(overrides: Partial<MailContextEvent> = {}): MailContextEvent {
  return {
    id: LETTER_ID,
    threadId: THREAD,
    at: atOffset(8),
    direction: 'outbound',
    role: 'hms_letter',
    recipientDomain: DOMAIN,
    subject: `Hotel_Confirmation Letter_${GUEST} (n°${CONF})`,
    filename: `HRCEN_Confirmation_Letter_${CONF}.pdf`,
    facts: { guest: GUEST, arrival: ARRIVAL, departure: DEPARTURE, room: ROOM, adults: ADULTS },
    ...overrides,
  };
}

describe('parseConfirmationLetterFilename', () => {
  it('parses HRCEN and HRDAV Confirmation_Letter filenames', () => {
    expect(parseConfirmationLetterFilename(`HRCEN_Confirmation_Letter_${CONF}.pdf`)).toEqual({
      property: 'HRCEN',
      conf: CONF,
    });
    expect(
      parseConfirmationLetterFilename(`nested/HRDAV_Confirmation_Letter_${CONF_B}.PDF`),
    ).toEqual({
      property: 'HRDAV',
      conf: CONF_B,
    });
    expect(parseConfirmationLetterFilename('offer.pdf')).toBeNull();
  });

  it('does not shorten a longer subject number into an 8-digit conf', () => {
    expect(parseConfirmationLetterSubjectConf(`Hotel_Confirmation Letter_${GUEST} (n°${CONF})`)).toBe(
      CONF,
    );
    expect(
      parseConfirmationLetterSubjectConf(`Hotel_Confirmation Letter_${GUEST} (n°${CONF}-1)`),
    ).toBe(CONF);
    expect(
      parseConfirmationLetterSubjectConf(`Hotel_Confirmation Letter_${GUEST} (n°123456789-1)`),
    ).toBeNull();
  });
});

describe('linkMailContext', () => {
  it('links an ask to a letter inside the 30 min window after the staff reply', () => {
    const links = linkMailContext([ask(), reply(), letter()]);
    expect(links).toHaveLength(1);
    expect(links[0]).toMatchObject({
      label: CONTEXT_DATASET_LABEL,
      fields_match: true,
      conf: CONF,
      field_flags: {
        guest: true,
        arrival: true,
        departure: true,
        room: true,
        adults: true,
      },
    });
    expect(links[0]!.ask_id).not.toBe(ASK_ID);
    expect(links[0]!.reply_id).not.toBe(REPLY_ID);
    expect(links[0]!.letter_id).not.toBe(LETTER_ID);
    expect(links[0]!.link_confidence).toBeGreaterThan(0);
    expect(LETTER_WINDOW_MS).toBe(30 * 60 * 1000);
  });

  it('does not link a letter 45 min after the staff reply', () => {
    expect(linkMailContext([ask(), reply(), letter({ at: atOffset(45) })])).toEqual([]);
  });

  it('does not link when subject conf and filename conf disagree', () => {
    expect(
      linkMailContext([
        ask(),
        reply(),
        letter({
          subject: `Hotel_Confirmation Letter_${GUEST} (n°${CONF_B})`,
          filename: `HRCEN_Confirmation_Letter_${CONF}.pdf`,
        }),
      ]),
    ).toEqual([]);
  });

  it('links with fields_match=false when PDF facts disagree with the ask', () => {
    const links = linkMailContext([
      ask(),
      reply(),
      letter({
        facts: {
          guest: 'Fixturebravo',
          arrival: '2027-02-20',
          departure: '2027-02-22',
          room: 'STWN',
          adults: 1,
        },
      }),
    ]);
    expect(links).toHaveLength(1);
    expect(links[0]!.fields_match).toBe(false);
    expect(links[0]!.field_flags).toEqual({
      guest: false,
      arrival: false,
      departure: false,
      room: false,
      adults: false,
    });
    expect(links[0]!.label).toBe('context');
  });

  it('prefers a same-thread letter over an earlier domain-only letter', () => {
    const links = linkMailContext([
      ask(),
      reply(),
      letter({
        id: 'letter-other-thread',
        threadId: 'thread-fixture-other',
        at: atOffset(2),
        filename: `HRCEN_Confirmation_Letter_${CONF_B}.pdf`,
        subject: `Hotel_Confirmation Letter_${GUEST} (n°${CONF_B})`,
      }),
      letter({ at: atOffset(8) }),
    ]);
    expect(links).toHaveLength(1);
    expect(links[0]!.conf).toBe(CONF);
    expect(links[0]!.letter_id).toBe(maskContextId(LETTER_ID));
  });

  it('sets fields_match false when no stay facts are present to compare', () => {
    const links = linkMailContext([
      ask({ facts: null }),
      reply(),
      letter({ facts: null }),
    ]);
    expect(links).toHaveLength(1);
    expect(links[0]!.fields_match).toBe(false);
  });

  it('tries a later staff reply when the first reply has no letter in the window', () => {
    const bookingReplyId = 'reply-fixture-booking';
    const links = linkMailContext([
      ask(),
      reply({ id: 'reply-fixture-ack' }),
      reply({ id: bookingReplyId, at: atOffset(60) }),
      letter({ at: atOffset(68) }),
    ]);
    expect(links).toHaveLength(1);
    expect(links[0]!.conf).toBe(CONF);
    expect(links[0]!.reply_id).toBe(maskContextId(bookingReplyId));
    expect(links[0]!.window_ms).toBe(8 * 60 * 1000);
  });

  it('does not let an earlier ask claim a later ask confirmation letter', () => {
    const laterAskId = 'ask-fixture-bravo';
    const laterReplyId = 'reply-fixture-bravo';
    const links = linkMailContext([
      ask(),
      reply({ id: 'reply-fixture-ack' }),
      ask({ id: laterAskId, at: atOffset(40) }),
      reply({ id: laterReplyId, at: atOffset(60) }),
      letter({ at: atOffset(68) }),
    ]);
    expect(links).toHaveLength(1);
    expect(links[0]!.ask_id).toBe(maskContextId(laterAskId));
    expect(links[0]!.reply_id).toBe(maskContextId(laterReplyId));
    expect(links[0]!.conf).toBe(CONF);
  });

  it('reserves a same-thread letter before a shared-domain ask can take it', () => {
    const otherAskId = 'ask-fixture-other';
    const otherReplyId = 'reply-fixture-other';
    const otherThread = 'thread-fixture-other';
    const links = linkMailContext([
      ask({ id: otherAskId, threadId: otherThread, at: atOffset(-30) }),
      reply({ id: otherReplyId, threadId: otherThread }),
      ask(),
      reply(),
      letter({ at: atOffset(8) }),
    ]);
    expect(links).toHaveLength(1);
    expect(links[0]!.ask_id).toBe(maskContextId(ASK_ID));
    expect(links[0]!.letter_id).toBe(maskContextId(LETTER_ID));
    expect(links[0]!.conf).toBe(CONF);
  });
});

describe('runMailContextLinker', () => {
  it('writes context JSONL with masked ids to a private dir', async () => {
    const dir = await tempDir();
    const inPath = path.join(dir, 'events.json');
    const outPath = path.join(dir, 'private', 'context.jsonl');
    await writeFile(
      inPath,
      JSON.stringify({ events: [ask(), reply(), letter({ at: atOffset(0) })] }),
      'utf8',
    );
    const result = runMailContextLinker({ inPath, outPath });
    expect(result.written).toBe(1);
    expect(result.label).toBe('context');
    const lines = (await readFile(outPath, 'utf8')).trim().split('\n');
    expect(lines).toHaveLength(1);
    const row = JSON.parse(lines[0]!) as Record<string, unknown>;
    expect(row.label).toBe('context');
    expect(row.ask_id).not.toBe(ASK_ID);
    expect(JSON.stringify(row)).not.toMatch(/ask-fixture-alpha|Fixturealpha|agency\.example/i);
  });
});

describe('parseMailContextLinkerCli', () => {
  it('requires --in and resolves --out under the given root', async () => {
    const dir = await tempDir();
    await mkdir(path.join(dir, '.private', 'mail-context'), { recursive: true });
    const parsed = parseMailContextLinkerCli(['--in', 'events.json'], dir);
    expect(parsed.inPath).toBe(path.resolve(dir, 'events.json'));
    expect(parsed.outPath).toBe(path.resolve(dir, '.private/mail-context/context.jsonl'));
  });
});

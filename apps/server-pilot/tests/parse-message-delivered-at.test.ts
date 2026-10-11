import { describe, expect, it } from 'vitest';
import { parseRawMessage } from '../src/mail/ingest/parse-message.js';
import { FakeS3Storage } from '../src/storage/s3.js';

const storage = () => new FakeS3Storage('parse-message-delivered-at-test');

async function parse(headers: string[]): Promise<Awaited<ReturnType<typeof parseRawMessage>>> {
  return parseRawMessage(
    Buffer.from(`${headers.join('\r\n')}\r\n\r\nmessage body`, 'utf8'),
    { messageId: 'parse-delivered-at-test', storage: storage() },
  );
}

describe('parseRawMessage deliveredAt', () => {
  it('uses the date at the end of the top-most Received header', async () => {
    const parsed = await parse([
      'Received: from first-hop.example (with ESMTP; id abc) by mailbox.example; Tue, 06 Oct 2026 10:00:00 +0000 (queue; server=mailbox)',
      'Received: from earlier-hop.example by first-hop.example; Tue, 06 Oct 2026 08:00:00 +0000',
      'Date: Tue, 06 Oct 2026 07:00:00 +0000',
      'From: guest@example.test',
      'To: mailbox@example.test',
      'Subject: request',
    ]);

    expect(parsed.deliveredAt).toEqual(new Date('2026-10-06T10:00:00.000Z'));
  });

  it('returns null for a malformed Received date without throwing', async () => {
    const parsed = await parse([
      'Received: from first-hop.example by mailbox.example; not a date',
      'From: guest@example.test',
      'To: mailbox@example.test',
      'Subject: request',
    ]);

    expect(parsed.deliveredAt).toBeNull();
  });

  it('rejects impossible calendar dates and trailing junk instead of normalizing them', async () => {
    const impossible = await parse([
      'Received: from first-hop.example by mailbox.example; Tue, 31 Feb 2026 10:00:00 +0000',
      'From: guest@example.test',
      'To: mailbox@example.test',
      'Subject: invalid delivery stamp',
    ]);
    const trailingJunk = await parse([
      'Received: from first-hop.example by mailbox.example; Tue, 06 Oct 2026 10:00:00 +0000 tomorrow',
      'From: guest@example.test',
      'To: mailbox@example.test',
      'Subject: invalid delivery stamp',
    ]);

    expect(impossible.deliveredAt).toBeNull();
    expect(trailingJunk.deliveredAt).toBeNull();
  });

  it('returns null when no Received header exists', async () => {
    const parsed = await parse([
      'Date: Tue, 06 Oct 2026 07:00:00 +0000',
      'From: guest@example.test',
      'To: mailbox@example.test',
      'Subject: request',
    ]);

    expect(parsed.deliveredAt).toBeNull();
  });
});

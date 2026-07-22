import { describe, expect, it, beforeEach } from 'vitest';
import {
  buildLoopbackEml,
  fixtureLoopbackStore,
  maybeEnqueueLoopback,
  recipientMatchesIngestEmail,
  resetFixtureLoopbackStoreForTests,
} from '../src/mail/fixture-loopback';
import { parseRawMessage } from '../src/mail/ingest/parse-message';
import { FakePop3Client } from '../src/mail/ingest/pop3-client';
import { FakeS3Storage } from '../src/storage/s3';

describe('fixture loopback', () => {
  beforeEach(() => resetFixtureLoopbackStoreForTests());

  it('recipientMatchesIngestEmail matches navaai@ case-insensitively', () => {
    expect(recipientMatchesIngestEmail(['Navaai@legacyhotels.co.za'])).toBe(true);
    expect(recipientMatchesIngestEmail(['other@example.com'])).toBe(false);
  });

  it('buildLoopbackEml round-trips through parseRawMessage with X-Zero-Mailbox', async () => {
    const storage = new FakeS3Storage('loopback-test');
    const raw = buildLoopbackEml({
      from: 'navaai@legacyhotels.co.za',
      to: ['navaai@legacyhotels.co.za'],
      subject: 'loop',
      html: '<p>loop</p>',
      text: 'loop',
      messageId: 'loop-1@zero-fake-smtp.local',
      extraHeaders: { 'X-Zero-Mailbox': 'navaai@legacyhotels.co.za' },
    });
    const parsed = await parseRawMessage(raw, { messageId: 'msg-1', storage });
    expect(parsed.ownerHeaderValue).toBe('navaai@legacyhotels.co.za');
    expect(parsed.toAddresses).toContain('navaai@legacyhotels.co.za');
  });

  it('FakePop3Client connect drains loopback queue', async () => {
    const raw = buildLoopbackEml({
      from: 'navaai@legacyhotels.co.za',
      to: ['navaai@legacyhotels.co.za'],
      subject: 'q',
      html: '<p>q</p>',
      text: 'q',
      messageId: 'q@local',
      extraHeaders: { 'X-Zero-Mailbox': 'navaai@legacyhotels.co.za' },
    });
    const uidl = fixtureLoopbackStore.enqueue(raw);
    const pop3 = new FakePop3Client();
    await pop3.connect();
    expect(await pop3.listUidl()).toContain(uidl);
  });

  it('maybeEnqueueLoopback does not enqueue in wire mode', () => {
    maybeEnqueueLoopback(
      {
        from: 'navaai@legacyhotels.co.za',
        to: ['navaai@legacyhotels.co.za'],
        cc: [],
        bcc: [],
        subject: 'wire-skip',
        html: '<p>x</p>',
        text: 'x',
      },
      { messageId: 'wire-1', accepted: ['navaai@legacyhotels.co.za'] },
      'wire',
      { 'X-Zero-Mailbox': 'navaai@legacyhotels.co.za' },
    );
    expect(fixtureLoopbackStore.drain()).toHaveLength(0);
  });

  it('maybeEnqueueLoopback does not enqueue in real mode', () => {
    maybeEnqueueLoopback(
      {
        from: 'navaai@legacyhotels.co.za',
        to: ['navaai@legacyhotels.co.za'],
        cc: [],
        bcc: [],
        subject: 'real-skip',
        html: '<p>x</p>',
        text: 'x',
      },
      { messageId: 'skip@local', accepted: ['navaai@legacyhotels.co.za'] },
      'real',
      { 'X-Zero-Mailbox': 'navaai@legacyhotels.co.za' },
    );
    expect(fixtureLoopbackStore.drain()).toHaveLength(0);
  });
});

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

  it('recipientMatchesIngestEmail matches nava@ case-insensitively', () => {
    expect(recipientMatchesIngestEmail(['Nava@legacyhotel.com'])).toBe(true);
    expect(recipientMatchesIngestEmail(['other@example.com'])).toBe(false);
  });

  it('buildLoopbackEml round-trips through parseRawMessage with X-Zero-Mailbox', async () => {
    const storage = new FakeS3Storage('loopback-test');
    const raw = buildLoopbackEml({
      from: 'nava@legacyhotel.com',
      to: ['nava@legacyhotel.com'],
      subject: 'loop',
      html: '<p>loop</p>',
      text: 'loop',
      messageId: 'loop-1@zero-fake-smtp.local',
      extraHeaders: { 'X-Zero-Mailbox': 'nava@legacyhotel.com' },
    });
    const parsed = await parseRawMessage(raw, { messageId: 'msg-1', storage });
    expect(parsed.ownerHeaderValue).toBe('nava@legacyhotel.com');
    expect(parsed.toAddresses).toContain('nava@legacyhotel.com');
  });

  it('FakePop3Client connect drains loopback queue', async () => {
    const raw = buildLoopbackEml({
      from: 'nava@legacyhotel.com',
      to: ['nava@legacyhotel.com'],
      subject: 'q',
      html: '<p>q</p>',
      text: 'q',
      messageId: 'q@local',
      extraHeaders: { 'X-Zero-Mailbox': 'nava@legacyhotel.com' },
    });
    const uidl = fixtureLoopbackStore.enqueue(raw);
    const pop3 = new FakePop3Client();
    await pop3.connect();
    expect(await pop3.listUidl()).toContain(uidl);
  });

  it('maybeEnqueueLoopback does not enqueue in real mode', () => {
    maybeEnqueueLoopback(
      {
        from: 'nava@legacyhotel.com',
        to: ['nava@legacyhotel.com'],
        cc: [],
        bcc: [],
        subject: 'real-skip',
        html: '<p>x</p>',
        text: 'x',
      },
      { messageId: 'skip@local', accepted: ['nava@legacyhotel.com'] },
      'real',
      { 'X-Zero-Mailbox': 'nava@legacyhotel.com' },
    );
    expect(fixtureLoopbackStore.drain()).toHaveLength(0);
  });
});

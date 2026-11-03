import { createHash } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import type { DB } from '../src/db/client.js';
import { readPanePop3Attachment } from '../src/mail/artifacts/pane-pop3-attachment.js';
import { FakeS3Storage } from '../src/storage/s3.js';

const identity = { transportId: 'transport-1', messageId: 'canonical-message', attachmentId: 'attachment-1' };
const bytes = Buffer.from('%PDF-1.7 synthetic voucher');
const makeRow = () => ({ ...identity, mailboxId: 'mailbox-1', uidl: 'uidl-1', direction: 'inbound',
  historyOnly: false, provenance: null as null | { attention: string }, filename: 'voucher.pdf',
  mimeType: 'application/pdf', sizeBytes: bytes.length, sha256: null as string | null,
  s3Key: 'attachments/original-ingest-id/001-voucher.pdf', isInline: false });

async function setup() {
  let row = makeRow();
  const db = { select: () => ({ from: () => ({ innerJoin: () => ({ where: () => ({
    limit: async () => [{ ...row }],
  }) }) }) }) } as unknown as DB;
  const s3 = new FakeS3Storage();
  await s3.putObject({ key: row.s3Key, body: bytes, contentType: row.mimeType });
  const checkAuthority = vi.fn(async () => true);
  const input = { ...identity, db, s3, signal: new AbortController().signal, checkAuthority };
  return { input, s3, checkAuthority, set: (next: Partial<ReturnType<typeof makeRow>>) => { row = { ...makeRow(), ...next }; } };
}

describe('pane POP3 attachment binding', () => {
  it('binds canonical message to legacy ingest key and the actual PDF digest', async () => {
    const s = await setup();
    const approved = await readPanePop3Attachment(s.input);
    expect(approved?.bytes).toEqual(bytes);
    expect(approved?.source).toMatchObject({ ...identity, filename: 'voucher.pdf',
      sha256: createHash('sha256').update(bytes).digest('hex') });
    expect(approved?.source.snapshotDigest).toMatch(/^[a-f0-9]{64}$/);
    expect(await readPanePop3Attachment({ ...s.input, expected: approved!.source })).toEqual(approved);
  });

  it('refuses a different scope, unsafe metadata or an unverified Outlook original before reading bytes', async () => {
    const s = await setup();
    for (const changed of [{ transportId: 'other' }, { messageId: 'other' }, { attachmentId: 'other' },
      { mailboxId: '' }, { uidl: '' }, { direction: 'outbound' }, { historyOnly: true }, { isInline: true },
      { provenance: { attention: 'AMBIGUOUS' } }, { filename: '../voucher.pdf' }, { filename: 'bad\u0000.pdf' },
      { filename: 'voucher.txt' }, { sizeBytes: 0 }, { sha256: 'invalid' },
      { s3Key: `outlook-sync-originals/v1/${'a'.repeat(64)}/${'b'.repeat(64)}` }]) {
      s.set(changed);
      expect(await readPanePop3Attachment(s.input)).toBeNull();
    }
    expect(s.s3.calls.filter((call) => call.op === 'GET_BOUNDED')).toHaveLength(0);
  });

  it('refuses changed metadata, bytes or authority after staff approval', async () => {
    const s = await setup();
    const approved = await readPanePop3Attachment(s.input);
    expect(approved).not.toBeNull();
    s.set({ uidl: 'other-uidl' });
    expect(await readPanePop3Attachment({ ...s.input, expected: approved!.source })).toBeNull();
    s.set({});
    const altered = Buffer.from(bytes); altered[6] ^= 1;
    await s.s3.putObject({ key: makeRow().s3Key, body: altered, contentType: 'application/pdf' });
    expect(await readPanePop3Attachment({ ...s.input, expected: approved!.source })).toBeNull();
    expect(await readPanePop3Attachment({ ...s.input, checkAuthority: async () => false })).toBeNull();
  });

  it('revalidates metadata and authority after reading bytes', async () => {
    const s = await setup();
    const get = s.s3.getObjectBounded.bind(s.s3);
    const spy = vi.spyOn(s.s3, 'getObjectBounded').mockImplementation(async (...args) => {
      const result = await get(...args);
      s.set({ uidl: 'changed-during-read' });
      return result;
    });
    expect(await readPanePop3Attachment(s.input)).toBeNull();
    spy.mockRestore();
    s.set({});
    let checks = 0;
    expect(await readPanePop3Attachment({ ...s.input, checkAuthority: async () => ++checks < 3 })).toBeNull();
  });
});

import { createHash } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { acquirePop3VoucherSource, type Pop3FilingRecord } from '../src/ai/voucher-filing-pop3-source.js';

const bytes = Buffer.from('%PDF-1.7 synthetic voucher');
const hash = createHash('sha256').update(bytes).digest('hex');
const identity = { transportId: 'transport-1', messageId: 'message-1', attachmentId: 'attachment-1' };
const makeRecord = (): Pop3FilingRecord => ({ ...identity, ingestMailboxId: 'mailbox-1', pop3Uidl: 'uidl-1',
  direction: 'inbound', historyOnly: false, attention: null, filename: 'proof.pdf', mimeType: 'application/pdf',
  isInline: false, sizeBytes: bytes.length, sha256: hash, s3Key: 'attachments/ingest-id/001-proof.pdf' });
function setup() {
  let record: Pop3FilingRecord | null = makeRecord();
  const load = vi.fn(async () => record && { ...record });
  const readBounded = vi.fn(async (_key: string, _maxBytes: number, _signal: AbortSignal): Promise<Uint8Array | null> => bytes);
  const checkAuthority = vi.fn(async () => true);
  const deps = { bucket: 'pilot-mail', signal: new AbortController().signal, load, readBounded, checkAuthority };
  return { deps, load, readBounded, checkAuthority, set: (next: Pop3FilingRecord | null) => { record = next; } };
}

describe('POP3 filing source', () => {
  it('binds the scoped record and exact bytes at prepare and execution', async () => {
    const s = setup();
    const prepared = await acquirePop3VoucherSource(identity, s.deps);
    expect(prepared?.bytes).toEqual(bytes);
    expect(prepared?.source).toMatchObject({ ...identity, sha256: hash, filename: 'proof.pdf' });
    expect(prepared?.source.snapshotDigest).toMatch(/^[a-f0-9]{64}$/);
    expect(JSON.stringify(prepared?.source)).not.toContain('attachments/');
    expect(s.readBounded).toHaveBeenCalledWith('attachments/ingest-id/001-proof.pdf', bytes.length, s.deps.signal);
    expect(await acquirePop3VoucherSource(identity, s.deps, prepared!.source)).toEqual(prepared);
  });

  it('accepts valid non-ASCII filenames', async () => {
    const s = setup();
    s.set({ ...makeRecord(), filename: 'Voucher Müller.pdf' });
    expect((await acquirePop3VoucherSource(identity, s.deps))?.source.filename).toBe('Voucher Müller.pdf');
  });

  it('binds legacy bytes without an ingest hash at prepare and rejects changed bytes at dispatch', async () => {
    const s = setup();
    s.set({ ...makeRecord(), sha256: null });
    const prepared = await acquirePop3VoucherSource(identity, s.deps);
    expect(prepared?.source.sha256).toBe(hash);
    expect(await acquirePop3VoucherSource(identity, s.deps, prepared!.source)).toEqual(prepared);
    const changed = Buffer.from(bytes); changed[6] ^= 1;
    expect(await acquirePop3VoucherSource(identity, { ...s.deps, readBounded: async () => changed }, prepared!.source)).toBeNull();
  });

  it('refuses wrong scope, unsafe metadata and missing hash before fetching', async () => {
    const s = setup();
    for (const patch of [
      { transportId: 'other' }, { messageId: 'other' }, { attachmentId: 'other' },
      { ingestMailboxId: null }, { pop3Uidl: null }, { direction: 'outbound' }, { historyOnly: true },
      { attention: 'AMBIGUOUS_IDENTITY' }, { isInline: true }, { mimeType: 'image/png' },
      { filename: '../proof.pdf' }, { filename: 'bad\u0000name.pdf' }, { filename: 'proof.txt' }, { sizeBytes: 0 }, { sha256: 'invalid' },
      { s3Key: 'outlook-sync-originals/wrong' },
    ]) {
      s.set({ ...makeRecord(), ...patch });
      expect(await acquirePop3VoucherSource(identity, s.deps)).toBeNull();
    }
    s.set(null);
    expect(await acquirePop3VoucherSource(identity, s.deps)).toBeNull();
    expect(s.readBounded).not.toHaveBeenCalled();
  });

  it('refuses changed approved source, bytes, or authority', async () => {
    const s = setup();
    const prepared = await acquirePop3VoucherSource(identity, s.deps);
    expect(prepared).not.toBeNull();
    const approved = prepared!.source;
    s.set({ ...makeRecord(), filename: 'new.pdf' });
    expect(await acquirePop3VoucherSource(identity, s.deps, approved)).toBeNull();
    s.set(makeRecord());
    expect(await acquirePop3VoucherSource(identity, s.deps, { ...approved, sha256: 'a'.repeat(64) })).toBeNull();
    const changed = Buffer.from(bytes); changed[6] ^= 1;
    expect(await acquirePop3VoucherSource(identity, { ...s.deps, readBounded: async () => changed }, approved)).toBeNull();
    expect(await acquirePop3VoucherSource(identity, { ...s.deps, checkAuthority: async () => false }, approved)).toBeNull();
  });

  it('refuses metadata and authority changes during the fetch', async () => {
    const s = setup();
    const metadataChanged = { ...s.deps, readBounded: async () => {
      s.set({ ...makeRecord(), s3Key: 'attachments/other/001-proof.pdf' });
      return bytes;
    } };
    expect(await acquirePop3VoucherSource(identity, metadataChanged)).toBeNull();
    s.set(makeRecord());
    let checks = 0;
    expect(await acquirePop3VoucherSource(identity, { ...s.deps, checkAuthority: async () => ++checks === 1 })).toBeNull();
    checks = 0;
    expect(await acquirePop3VoucherSource(identity, { ...s.deps, checkAuthority: async () => ++checks < 3 })).toBeNull();
    const controller = new AbortController();
    expect(await acquirePop3VoucherSource(identity, { ...s.deps, signal: controller.signal,
      readBounded: async () => { controller.abort(); return bytes; } })).toBeNull();
  });
});

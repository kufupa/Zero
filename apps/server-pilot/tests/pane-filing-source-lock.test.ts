import { createHash } from 'node:crypto';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { DB } from '../src/db/client.js';

const mocks = vi.hoisted(() => ({ read: vi.fn(), candidate: vi.fn() }));
vi.mock('../src/mail/artifacts/pane-pop3-attachment.js', async (original) => ({
  ...(await original<typeof import('../src/mail/artifacts/pane-pop3-attachment.js')>()),
  readPanePop3Attachment: mocks.read,
  panePop3AttachmentCandidate: mocks.candidate,
}));
vi.mock('../src/storage/s3.js', async (original) => ({
  ...(await original<typeof import('../src/storage/s3.js')>()), getS3Storage: () => ({ bucket: 'synthetic' }),
}));

import { lockBoundFilingSource, type BoundFilingForm } from '../src/ai/pane-filing-source.js';

const bytes = Buffer.from('%PDF-1.7 synthetic voucher');
const fingerprint = 'a'.repeat(64), pdfSha256 = createHash('sha256').update(bytes).digest('hex');
const form: BoundFilingForm = { action: 'attach_document', confirmation: '123456-1', arrival: '2027-09-14',
  lastName: 'Labtest', attachmentId: 'attachment', documentName: 'voucher.pdf', sourceMessageId: 'message',
  sourceInternetMessageId: 'selected@example.test', pdfSha256,
  sourceSnapshotDigest: createHash('sha256').update(`${fingerprint}:${pdfSha256}`).digest('hex') };
const item = { id: 'item', transportId: 'transport', threadId: 'thread', sourceMessageId: 'message',
  status: 'needs_you', state: form };
const mail = { id: 'message', transportId: 'transport', threadId: 'thread', messageIdHeader: 'selected@example.test',
  direction: 'inbound', fromAddress: 'guest@example.test', toAddresses: [], ccAddresses: [] };
const thread = { id: 'thread', historyOnly: false, trashedAt: null as Date | null };
const file = { id: 'attachment', messageId: 'message' };
type Tx = Parameters<Parameters<DB['transaction']>[0]>[0];

function transaction(rows: unknown[][] = [[{ threadId: 'thread' }], [thread], [mail], [{ id: 'message' }], [mail], [file], [item]]) {
  const calls: string[] = [];
  let index = 0;
  const tx = {
    execute: async () => { calls.push('canonical-mailbox'); },
    select: () => {
      const n = index++;
      const result = rows[n] ?? [];
      const query = new Proxy({ from: () => query, where: () => query, limit: () => query,
        for: async (mode: string) => { calls.push(`row-${n}:${mode}`); return result; } }, {
        get(target, property, receiver) {
          if (property === 'then') return (resolve: (value: unknown[]) => unknown, reject: (reason: unknown) => unknown) =>
            Promise.resolve(result).then(resolve, reject);
          return Reflect.get(target, property, receiver);
        },
      });
      return query;
    },
  } as unknown as Tx;
  return { tx, calls };
}

beforeEach(() => {
  mocks.read.mockReset();
  mocks.candidate.mockReset().mockResolvedValue({ filename: form.documentName, sha256: pdfSha256, fingerprint });
});

describe('filing dispatch source lock', () => {
  it('locks the exact source and compares the pinned bytes without network I/O', async () => {
    const { tx, calls } = transaction();
    await expect(lockBoundFilingSource(tx, { transportId: 'transport', workItemId: 'item', form })).resolves.toEqual(item);
    expect(calls).toEqual(['canonical-mailbox', 'row-1:share', 'row-2:no key update', 'row-3:share',
      'row-4:share', 'row-5:update', 'row-6:no key update']);
    expect(mocks.read).not.toHaveBeenCalled();
    expect(mocks.candidate).toHaveBeenCalledWith(expect.objectContaining({ db: tx, bucket: 'synthetic',
      messageId: 'message', attachmentId: 'attachment' }));
  });

  it('refuses a missing file, changed thread, changed form or unreadable approved bytes', async () => {
    const base = [[{ threadId: 'thread' }], [thread], [mail], [{ id: 'message' }], [mail], [file], [item]];
    for (const [index, replacement] of [
      [1, [{ ...thread, historyOnly: true }]], [1, [{ ...thread, trashedAt: new Date() }]],
      [2, [{ ...mail, threadId: 'other' }]], [2, [{ ...mail, messageIdHeader: 'different@example.test' }]],
      [3, [{ id: 'message' }, { id: 'other' }]], [5, []],
      [6, [{ ...item, state: { ...form, documentName: 'other.pdf' } }]],
    ] as Array<[number, unknown[]]>) {
      const rows: unknown[][] = base.map((row) => [...row]);
      rows[index] = replacement;
      const { tx } = transaction(rows);
      await expect(lockBoundFilingSource(tx, { transportId: 'transport', workItemId: 'item', form })).resolves.toBeNull();
    }
    const { tx } = transaction();
    mocks.candidate.mockResolvedValueOnce(null);
    await expect(lockBoundFilingSource(tx, { transportId: 'transport', workItemId: 'item', form })).resolves.toBeNull();
    mocks.candidate.mockResolvedValueOnce({ filename: form.documentName, sha256: pdfSha256, fingerprint: 'b'.repeat(64) });
    await expect(lockBoundFilingSource(transaction().tx, { transportId: 'transport', workItemId: 'item', form })).resolves.toBeNull();
  });
});

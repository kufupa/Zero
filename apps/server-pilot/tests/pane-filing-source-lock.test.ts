import { createHash } from 'node:crypto';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { SQL } from 'drizzle-orm';
import { PgDialect } from 'drizzle-orm/pg-core';
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
import { staffQuoteSourceHash } from '../src/ai/staff-quote-workflow.js';

const bytes = Buffer.from('%PDF-1.7 synthetic voucher');
const fingerprint = 'a'.repeat(64), pdfSha256 = createHash('sha256').update(bytes).digest('hex');
const form: BoundFilingForm = { action: 'attach_document', confirmation: '123456-1', arrival: '2027-09-14',
  lastName: 'Labtest', attachmentId: 'attachment', documentName: 'voucher.pdf', sourceMessageId: 'message',
  sourceInternetMessageId: 'selected@example.test', pdfSha256,
  sourceSnapshotDigest: createHash('sha256').update(`${fingerprint}:${pdfSha256}`).digest('hex') };
const item = { id: 'item', transportId: 'transport', threadId: 'thread', sourceMessageId: 'message',
  status: 'needs_you', state: form };
const mail = { id: 'message', transportId: 'transport', threadId: 'thread', messageIdHeader: 'selected@example.test',
  direction: 'inbound', fromAddress: 'guest@example.test', toAddresses: [], ccAddresses: [],
  subject: 'Voucher', textBody: 'Original mail', htmlBody: null };
const thread = { id: 'thread', historyOnly: false, trashedAt: null as Date | null };
const file = { id: 'attachment', messageId: 'message' };
type Tx = Parameters<Parameters<DB['transaction']>[0]>[0];

function transaction(rows: unknown[][] = [[{ threadId: 'thread' }], [thread], [mail], [{ id: 'message', threadId: 'thread' }], [mail], [file], [item]]) {
  const calls: string[] = [];
  const dialect = new PgDialect();
  let index = 0;
  const tx = {
    execute: async () => { calls.push('canonical-mailbox'); },
    select: () => {
      const n = index++;
      let params: unknown[] = [];
      const result = () => n === 3 && params.length === 4
        ? (rows[n] as Array<{ id: string; threadId: string }>).filter((row) => row.id === params[2] && row.threadId === params[3])
        : rows[n] ?? [];
      const query = new Proxy({ from: () => query, where: (sql: SQL) => { params = dialect.sqlToQuery(sql).params; return query; },
        limit: () => query, for: async (mode: string) => { calls.push(`row-${n}:${mode}`); return result(); } }, {
        get(target, property, receiver) {
          if (property === 'then') return (resolve: (value: unknown[]) => unknown, reject: (reason: unknown) => unknown) =>
            Promise.resolve(result()).then(resolve, reject);
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
  it('locks an exact source despite duplicate headers and compares pinned bytes without network I/O', async () => {
    const exactForm = { ...form, sourceThreadId: 'thread', sourceHash: staffQuoteSourceHash(mail) };
    const exactItem = { ...item, state: exactForm };
    const { tx, calls } = transaction([[{ threadId: 'thread' }], [thread], [mail],
      [{ id: 'message', threadId: 'thread' }, { id: 'duplicate', threadId: 'other' }], [mail], [file], [exactItem]]);
    await expect(lockBoundFilingSource(tx, { transportId: 'transport', workItemId: 'item', form: exactForm })).resolves.toEqual(exactItem);
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
    const exactForm = { ...form, sourceThreadId: 'thread', sourceHash: staffQuoteSourceHash(mail) };
    for (const changed of [
      { ...exactForm, sourceHash: '0'.repeat(64) },
      { ...exactForm, sourceThreadId: 'other' },
      { ...exactForm, sourceHash: undefined },
    ]) await expect(lockBoundFilingSource(transaction().tx, { transportId: 'transport', workItemId: 'item', form: changed })).resolves.toBeNull();
    for (const changedMail of [{ ...mail, direction: 'outbound' }, { ...mail, textBody: 'Changed mail' }]) {
      const rows = [[{ threadId: 'thread' }], [thread], [changedMail], [{ id: 'message', threadId: 'thread' }],
        [changedMail], [file], [{ ...item, state: exactForm }]];
      await expect(lockBoundFilingSource(transaction(rows).tx, { transportId: 'transport', workItemId: 'item', form: exactForm })).resolves.toBeNull();
    }
  });
});

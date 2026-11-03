import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  selected: 'message-1',
  existing: vi.fn(),
  readPop3: vi.fn(),
  extract: vi.fn(),
}));

vi.mock('../src/ai/quote-workflow-synced-selection.js', async (original) => ({
  ...await original<typeof import('../src/ai/quote-workflow-synced-selection.js')>(),
  createArtifactReader: () => mocks.existing,
}));
vi.mock('../src/mail/artifacts/pane-pop3-attachment.js', async (original) => ({
  ...await original<typeof import('../src/mail/artifacts/pane-pop3-attachment.js')>(),
  readPanePop3Attachment: mocks.readPop3,
}));
vi.mock('../src/mail/artifacts/read-artifact.js', async (original) => ({
  ...await original<typeof import('../src/mail/artifacts/read-artifact.js')>(),
  extractEmbeddedPdfText: mocks.extract,
}));
vi.mock('../src/db/client.js', async (original) => ({
  ...await original<typeof import('../src/db/client.js')>(),
  getDb: () => ({ select: () => ({ from: () => ({ where: () => ({ limit: async () => [{ id: mocks.selected }] }) }) }) }),
}));
vi.mock('../src/storage/s3.js', async (original) => ({
  ...await original<typeof import('../src/storage/s3.js')>(), getS3Storage: () => ({}),
}));
vi.mock('../src/env.js', async (original) => ({
  ...await original<typeof import('../src/env.js')>(), isScannedPdfVisionEnabled: () => false,
}));

import { extractVoucherGuest, readVoucherAttachmentText } from '../src/ai/voucher-find.js';
import { voucherLoaders } from '../src/trpc/routes/quote-workflow.js';
import { appRouter } from '../src/trpc/router.js';

const body = Buffer.from('%PDF-synthetic');
const scope = { transportId: 'hotel', messageId: 'message-1', internetMessageId: 'voucher@example.test' };
const file = { id: 'att-1', filename: 'voucher.pdf', mimeType: 'application/pdf', sizeBytes: body.length,
  isInline: false, messageId: scope.messageId, s3Key: 'attachments/original-ingest/voucher.pdf', sha256: null };
const source = { ...scope, attachmentId: file.id, filename: file.filename, sha256: 'a'.repeat(64),
  snapshotDigest: 'b'.repeat(64) };
const stored = { source, bytes: body, locator: { s3Key: file.s3Key, mimeType: file.mimeType,
  sizeBytes: file.sizeBytes, messageId: 'original-ingest', sha256: null } };
const extracted = { data: { text: 'GUEST: Labtest, Proof\nARRIVAL 2027-09-14', reason: 'text' } };

beforeEach(() => {
  mocks.selected = scope.messageId;
  mocks.existing.mockReset().mockResolvedValue({ text: null, reason: 'malformed' });
  mocks.extract.mockReset().mockResolvedValue(extracted);
  mocks.readPop3.mockReset().mockImplementation(async (input: { checkAuthority: () => Promise<boolean> }) =>
    await input.checkAuthority() ? stored : null);
});

describe('voucher lookup with a reconciled POP3 object key', () => {
  it('reads the exact selected mail PDF and revalidates before returning guest facts', async () => {
    const rows = await readVoucherAttachmentText([file], new AbortController().signal, scope);
    expect(extractVoucherGuest({ subject: '', bodyText: '', attachmentTexts: rows.map((row) => row.text ?? '') }))
      .toEqual({ lastName: 'Labtest', arrival: '2027-09-14' });
    expect(mocks.readPop3).toHaveBeenCalledTimes(2);
    expect(mocks.readPop3.mock.calls[1]?.[0]).toMatchObject({ expected: source });
  });

  it('drops extracted facts when the selected mail changes while the PDF is parsed', async () => {
    mocks.extract.mockImplementation(async () => { mocks.selected = 'different-message'; return extracted; });
    const rows = await readVoucherAttachmentText([file], new AbortController().signal, scope);
    expect(rows[0]).toMatchObject({ bytesPresent: false, readFailure: 'source changed' });
  });

  it('refuses a locator that differs from the file selected by the voucher route', async () => {
    mocks.readPop3.mockResolvedValue({ ...stored, locator: { ...stored.locator, s3Key: 'attachments/other/file.pdf' } });
    const rows = await readVoucherAttachmentText([file], new AbortController().signal, scope);
    expect(rows[0]).toMatchObject({ bytesPresent: false, readFailure: 'source changed' });
    expect(mocks.extract).not.toHaveBeenCalled();
  });

  it('keeps the existing reader when its PDF is already readable', async () => {
    mocks.existing.mockResolvedValue({ text: 'GUEST: Smith' });
    const rows = await readVoucherAttachmentText([file], new AbortController().signal, scope);
    expect(rows[0]?.text).toBe('GUEST: Smith');
    expect(mocks.readPop3).not.toHaveBeenCalled();
  });

  it('connects the mounted voucher route to the scoped fallback', async () => {
    voucherLoaders.candidate = async () => ({ messageId: scope.messageId, threadId: 'thread-1',
      subject: 'Voucher', bodyText: '', attachments: [file] });
    voucherLoaders.readText = null;
    try {
      const caller = appRouter.createCaller({ auth: null, reqHeaders: new Headers(),
        sessionUser: { id: 'staff', email: 'staff@example.test', name: 'Staff' },
        activeTransportId: scope.transportId, transportEmail: 'hotel@example.test', accessRole: 'owner' } as never);
      const reply = await caller.quoteWorkflow.voucherFind({ internetMessageId: scope.internetMessageId });
      expect(reply).toMatchObject({ status: 'voucher', messageId: scope.messageId,
        guest: { lastName: 'Labtest', arrival: '2027-09-14' }, file: { id: file.id } });
      expect(mocks.readPop3.mock.calls[0]?.[0]).toMatchObject({
        transportId: scope.transportId, messageId: scope.messageId, attachmentId: file.id,
      });
    } finally { voucherLoaders.candidate = null; }
  });
});

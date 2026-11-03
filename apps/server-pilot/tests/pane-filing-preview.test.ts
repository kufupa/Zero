import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { DB } from '../src/db/client.js';
import { FakeS3Storage } from '../src/storage/s3.js';

const stubs = vi.hoisted(() => ({ find: vi.fn(), read: vi.fn() }));
vi.mock('../src/ai/pane-stay-lookup.js', async (original) => ({
  ...(await original<typeof import('../src/ai/pane-stay-lookup.js')>()), findStay: stubs.find,
}));
vi.mock('../src/mail/artifacts/pane-pop3-attachment.js', async (original) => ({
  ...(await original<typeof import('../src/mail/artifacts/pane-pop3-attachment.js')>()), readPanePop3Attachment: stubs.read,
}));

import { previewFiling } from '../src/ai/pane-filing-preview.js';

const input = { transportId: 'transport-centurion', actorUserId: 'user-1', workItemId: 'item-1',
  sourceMessageId: 'mail-1', attachmentId: 'attachment-1', confirmation: '123456-1',
  arrival: '2027-09-14', lastName: 'Labtest' };
const source = { transportId: input.transportId, messageId: input.sourceMessageId,
  attachmentId: input.attachmentId, filename: 'voucher.pdf', sha256: 'a'.repeat(64), snapshotDigest: 'b'.repeat(64) };
const stay = { confirmation: input.confirmation, arrival: input.arrival, lastName: input.lastName };

function fixture() {
  let rows = [{ itemThread: 'thread-1', messageThread: 'thread-1', itemMessage: input.sourceMessageId,
    messageId: input.sourceMessageId, transportId: input.transportId, actorUserId: input.actorUserId,
    active: true, status: 'needs_you' }];
  const query = { from: () => query, innerJoin: () => query, where: () => query, limit: async () => rows };
  const db = { select: () => query } as unknown as DB;
  return { db, s3: new FakeS3Storage(), setRows: (next: typeof rows) => { rows = next; }, getRows: () => rows };
}

beforeEach(() => {
  stubs.find.mockReset().mockResolvedValue({ outcome: 'found', stay, arrivalMismatch: false });
  stubs.read.mockReset().mockImplementation(async (request) => {
    if (!await request.checkAuthority()) return null;
    return { source, bytes: Buffer.from('%PDF-'), locator: {} };
  });
});

describe('read-only filing preview', () => {
  it('rechecks the selected PDF and exact HMS booking without creating a grant or run', async () => {
    const f = fixture();
    await expect(previewFiling({ ...input, db: f.db, s3: f.s3 })).resolves.toEqual({
      status: 'ready', confirmation: input.confirmation, arrival: input.arrival, documentName: source.filename,
    });
    expect(stubs.read).toHaveBeenCalledTimes(2);
    expect(stubs.read.mock.calls[1]![0].expected).toEqual(source);
    expect(stubs.find).toHaveBeenCalledWith({ confirmation: input.confirmation, arrival: input.arrival },
      expect.objectContaining({ target: expect.objectContaining({ propertyCode: 'HRCEN' }) }));
  });

  it('refuses wrong source, thread, mailbox access, or a closed item before reading HMS', async () => {
    for (const change of [{ itemMessage: 'other' }, { messageId: 'other' }, { messageThread: 'other' },
      { actorUserId: 'other' }, { transportId: 'other' }, { active: false }, { status: 'dismissed' }]) {
      const f = fixture();
      f.setRows([{ ...f.getRows()[0]!, ...change }]);
      await expect(previewFiling({ ...input, db: f.db, s3: f.s3 })).resolves.toMatchObject({ status: 'refused' });
    }
    expect(stubs.find).not.toHaveBeenCalled();
  });

  it('refuses if access or the document changes during the HMS read', async () => {
    const f = fixture();
    stubs.find.mockImplementationOnce(async () => {
      f.setRows([{ ...f.getRows()[0]!, active: false }]);
      return { outcome: 'found', stay, arrivalMismatch: false };
    });
    await expect(previewFiling({ ...input, db: f.db, s3: f.s3 })).resolves.toEqual({ status: 'refused', reason: 'source_changed' });
    const second = fixture();
    stubs.read.mockImplementationOnce(async () => ({ source, bytes: Buffer.from('%PDF-'), locator: {} }))
      .mockResolvedValueOnce(null);
    await expect(previewFiling({ ...input, db: second.db, s3: second.s3 })).resolves.toEqual({ status: 'refused', reason: 'source_changed' });
  });

  it('refuses a mismatched booking or a different property', async () => {
    for (const mismatch of [{ confirmation: '999-1' }, { arrival: '2027-09-15' }, { lastName: 'Other' }]) {
      const f = fixture();
      stubs.find.mockResolvedValueOnce({ outcome: 'found', stay: { ...stay, ...mismatch }, arrivalMismatch: false });
      await expect(previewFiling({ ...input, db: f.db, s3: f.s3 })).resolves.toEqual({ status: 'refused', reason: 'booking_unavailable' });
    }
    const f = fixture();
    await expect(previewFiling({ ...input, transportId: 'transport-davinci', db: f.db, s3: f.s3 }))
      .resolves.toEqual({ status: 'refused', reason: 'property_unavailable' });
  });
});

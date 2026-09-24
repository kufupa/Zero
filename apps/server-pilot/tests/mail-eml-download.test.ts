import { describe, expect, it } from 'vitest';
import {
  createEmlDownloadHandler,
  loadAuthorizedMessage,
} from '../src/http/eml-download.js';
import {
  mailboxTransport,
  mailboxAccess,
  mailThread,
  message,
} from '../src/db/schema/mail.js';
import { user as userAuthTable } from '../src/db/schema/auth.js';
import { TEST_DB_AVAILABLE, probeTestDb, withSeededTestDb } from './helpers/test-db.js';
import { callerFor } from './helpers/trpc-caller.js';
import { simpleParser } from 'mailparser';
import { FakeS3Storage, setS3Storage } from '../src/storage/s3.js';

const reachable = await probeTestDb();

describe('createEmlDownloadHandler (unit / direct)', () => {
  it('returns 401 when unauthenticated', async () => {
    const handler = createEmlDownloadHandler({
      getSession: async () => null,
      loadAuthorizedMessage: async () => null,
    });

    const req = new Request('http://localhost/api/mail/messages/msg-1/download.eml');
    const res = await handler(req, { messageId: 'msg-1' });
    expect(res.status).toBe(401);
    expect(await res.text()).toBe('Unauthorized');
  });

  it('returns 404 when message not found or unauthorized', async () => {
    const handler = createEmlDownloadHandler({
      getSession: async () => ({ user: { id: 'user-1' } }),
      loadAuthorizedMessage: async () => null,
    });

    const req = new Request('http://localhost/api/mail/messages/msg-unknown/download.eml');
    const res = await handler(req, { messageId: 'msg-unknown' });
    expect(res.status).toBe(404);
    expect(await res.text()).toBe('Not Found');
  });

  it('synthesizes RFC 822 EML and returns 200 when rawMimeS3Key is null', async () => {
    const mockMessage: any = {
      id: 'msg-synth-1',
      transportId: 'transport-1',
      threadId: 'thread-1',
      direction: 'inbound',
      fromAddress: 'reservations@hotel.com',
      toAddresses: ['guest@example.com'],
      ccAddresses: ['concierge@hotel.com'],
      bccAddresses: [],
      subject: 'Reservation Confirmation #4321',
      textBody: 'Your room is confirmed.',
      htmlBody: '<p>Your room is confirmed.</p>',
      rawMimeS3Key: null,
      messageIdHeader: '<res-4321@hotel.com>',
      receivedAt: new Date('2026-09-09T14:30:00Z'),
      sentAt: null,
    };

    const handler = createEmlDownloadHandler({
      getSession: async () => ({ user: { id: 'user-1' } }),
      loadAuthorizedMessage: async () => mockMessage,
    });

    const req = new Request('http://localhost/api/mail/messages/msg-synth-1/download.eml');
    const res = await handler(req, { messageId: 'msg-synth-1' });

    expect(res.status).toBe(200);
    expect(res.headers.get('Content-Type')).toBe('message/rfc822');
    expect(res.headers.get('Content-Disposition')).toContain('Reservation_Confirmation_#4321_2026-09-09.eml');
    expect(res.headers.get('Cache-Control')).toBe('private, no-cache');

    const bodyBuffer = Buffer.from(await res.arrayBuffer());
    expect(res.headers.get('Content-Length')).toBe(String(bodyBuffer.length));

    const parsed = await simpleParser(bodyBuffer);
    expect(parsed.subject).toBe('Reservation Confirmation #4321');
    expect(parsed.from?.text).toBe('reservations@hotel.com');
    expect(parsed.to?.text).toBe('guest@example.com');
    expect(parsed.text?.trim()).toBe('Your room is confirmed.');
  });

  it('serves raw MIME from storage when rawMimeS3Key is present', async () => {
    const rawMimeContent = Buffer.from(
      'From: sender@example.com\r\nTo: dest@example.com\r\nSubject: S3 Raw Email\r\n\r\nRaw body from S3',
      'utf-8',
    );

    const mockMessage: any = {
      id: 'msg-s3-1',
      transportId: 'transport-1',
      threadId: 'thread-1',
      direction: 'inbound',
      fromAddress: 'sender@example.com',
      toAddresses: ['dest@example.com'],
      subject: 'S3 Raw Email',
      rawMimeS3Key: 'raw-mime/msg-s3-1.eml',
      receivedAt: new Date('2026-09-09T15:00:00Z'),
    };

    const handler = createEmlDownloadHandler({
      getSession: async () => ({ user: { id: 'user-1' } }),
      loadAuthorizedMessage: async () => mockMessage,
      getRawMime: async (key) => (key === 'raw-mime/msg-s3-1.eml' ? rawMimeContent : null),
    });

    const req = new Request('http://localhost/api/mail/messages/msg-s3-1/download.eml');
    const res = await handler(req, { messageId: 'msg-s3-1' });

    expect(res.status).toBe(200);
    expect(res.headers.get('Content-Type')).toBe('message/rfc822');
    expect(res.headers.get('Content-Disposition')).toContain('S3_Raw_Email_2026-09-09.eml');

    const bodyBuffer = Buffer.from(await res.arrayBuffer());
    expect(bodyBuffer.toString('utf-8')).toBe(rawMimeContent.toString('utf-8'));
  });

  it('falls back to synthesis when rawMimeS3Key is present but missing in storage', async () => {
    const mockMessage: any = {
      id: 'msg-missing-s3',
      transportId: 'transport-1',
      threadId: 'thread-1',
      direction: 'inbound',
      fromAddress: 'sender@example.com',
      toAddresses: ['dest@example.com'],
      subject: 'Missing S3 Email',
      textBody: 'Synthesized fallback content',
      rawMimeS3Key: 'raw-mime/missing.eml',
      receivedAt: new Date('2026-09-09T15:00:00Z'),
    };

    const handler = createEmlDownloadHandler({
      getSession: async () => ({ user: { id: 'user-1' } }),
      loadAuthorizedMessage: async () => mockMessage,
      getRawMime: async () => null,
    });

    const req = new Request('http://localhost/api/mail/messages/msg-missing-s3/download.eml');
    const res = await handler(req, { messageId: 'msg-missing-s3' });

    expect(res.status).toBe(200);
    const bodyBuffer = Buffer.from(await res.arrayBuffer());
    const parsed = await simpleParser(bodyBuffer);
    expect(parsed.subject).toBe('Missing S3 Email');
    expect(parsed.text?.trim()).toBe('Synthesized fallback content');
  });

  it('handles unexpected exceptions with 500 status', async () => {
    const handler = createEmlDownloadHandler({
      getSession: async () => {
        throw new Error('Database connection explosion');
      },
      loadAuthorizedMessage: async () => null,
    });

    const req = new Request('http://localhost/api/mail/messages/msg-err/download.eml');
    const res = await handler(req, { messageId: 'msg-err' });
    expect(res.status).toBe(500);
    expect(await res.text()).toBe('Internal Server Error');
  });
});

describe('mail.getEmlDownloadUrl (tRPC procedure unit)', () => {
  it('returns direct HTTP download url when rawMimeS3Key is null', async () => {
    const { appRouter } = await import('../src/trpc/router.js');
    const { __setDbForTests } = await import('../src/db/client.js');

    const mockMsg = {
      id: 'msg-proc-1',
      transportId: 'transport-1',
      subject: 'Reservation #9900',
      receivedAt: new Date('2026-09-09T16:00:00Z'),
      sentAt: null,
      rawMimeS3Key: null,
    };

    const mockDb = {
      select: () => ({
        from: () => ({
          innerJoin: () => ({
            where: () => ({
              limit: () => [
                {
                  transportId: 'transport-1',
                  role: 'owner',
                  email: 'test@example.com',
                },
              ],
            }),
          }),
          where: () => ({
            limit: () => [mockMsg],
          }),
        }),
      }),
    } as any;

    __setDbForTests({ db: mockDb, conn: null as any });

    try {
      const caller = appRouter.createCaller({
        auth: null as never,
        reqHeaders: new Headers({ 'x-zero-active-transport': 'transport-1' }),
        sessionUser: { id: 'user-1', email: 'test@example.com', name: 'Test' },
        activeTransportId: 'transport-1',
        activeTransportEmail: 'test@example.com',
        userRole: 'owner',
      });

      const res = await caller.mail.getEmlDownloadUrl({ messageId: 'msg-proc-1' });
      expect(res).toEqual({
        url: '/api/mail/messages/msg-proc-1/download.eml',
        filename: 'Reservation_#9900_2026-09-09.eml',
        isDirectHttp: true,
      });
    } finally {
      __setDbForTests(null);
    }
  });

  it('returns signed S3 url when rawMimeS3Key is present and S3 bucket configured', async () => {
    const { appRouter } = await import('../src/trpc/router.js');
    const { __setDbForTests } = await import('../src/db/client.js');

    const prevBucket = process.env.S3_BUCKET;
    const prevRegion = process.env.AWS_REGION;
    process.env.S3_BUCKET = 'test-mail-bucket';
    process.env.AWS_REGION = 'af-south-1';

    const fakeS3 = new FakeS3Storage('test-mail-bucket');
    await fakeS3.putObject({
      key: 'raw-mime/msg-proc-2.eml',
      body: Buffer.from('test content'),
      contentType: 'message/rfc822',
    });
    setS3Storage(fakeS3);

    const mockMsg = {
      id: 'msg-proc-2',
      transportId: 'transport-1',
      subject: 'Special Request',
      receivedAt: new Date('2026-09-09T18:00:00Z'),
      sentAt: null,
      rawMimeS3Key: 'raw-mime/msg-proc-2.eml',
    };

    const mockDb = {
      select: () => ({
        from: () => ({
          innerJoin: () => ({
            where: () => ({
              limit: () => [
                {
                  transportId: 'transport-1',
                  role: 'owner',
                  email: 'test@example.com',
                },
              ],
            }),
          }),
          where: () => ({
            limit: () => [mockMsg],
          }),
        }),
      }),
    } as any;

    __setDbForTests({ db: mockDb, conn: null as any });

    try {
      const caller = appRouter.createCaller({
        auth: null as never,
        reqHeaders: new Headers({ 'x-zero-active-transport': 'transport-1' }),
        sessionUser: { id: 'user-1', email: 'test@example.com', name: 'Test' },
        activeTransportId: 'transport-1',
        activeTransportEmail: 'test@example.com',
        userRole: 'owner',
      });

      const res = await caller.mail.getEmlDownloadUrl({ messageId: 'msg-proc-2' });
      expect(res.filename).toBe('Special_Request_2026-09-09.eml');
      expect(res.isDirectHttp).toBe(false);
      expect(res.url).toContain('test-mail-bucket');
    } finally {
      __setDbForTests(null);
      if (prevBucket !== undefined) {
        process.env.S3_BUCKET = prevBucket;
      } else {
        delete process.env.S3_BUCKET;
      }
      if (prevRegion !== undefined) {
        process.env.AWS_REGION = prevRegion;
      } else {
        delete process.env.AWS_REGION;
      }
    }
  });

  it('falls back to direct HTTP download url when rawMimeS3Key is missing in S3 storage (expired or not found)', async () => {
    const { appRouter } = await import('../src/trpc/router.js');
    const { __setDbForTests } = await import('../src/db/client.js');

    const prevBucket = process.env.S3_BUCKET;
    const prevRegion = process.env.AWS_REGION;
    process.env.S3_BUCKET = 'test-mail-bucket';
    process.env.AWS_REGION = 'af-south-1';

    const fakeS3 = new FakeS3Storage('test-mail-bucket');
    // Notice: not putting raw-mime/msg-expired-1.eml into fakeS3, simulating 30d lifecycle expiration
    setS3Storage(fakeS3);

    const mockMsg = {
      id: 'msg-expired-1',
      transportId: 'transport-1',
      subject: 'Expired S3 Email',
      receivedAt: new Date('2026-07-28T18:00:00Z'),
      sentAt: null,
      rawMimeS3Key: 'raw-mime/msg-expired-1.eml',
    };

    const mockDb = {
      select: () => ({
        from: () => ({
          innerJoin: () => ({
            where: () => ({
              limit: () => [
                {
                  transportId: 'transport-1',
                  role: 'owner',
                  email: 'test@example.com',
                },
              ],
            }),
          }),
          where: () => ({
            limit: () => [mockMsg],
          }),
        }),
      }),
    } as any;

    __setDbForTests({ db: mockDb, conn: null as any });

    try {
      const caller = appRouter.createCaller({
        auth: null as never,
        reqHeaders: new Headers({ 'x-zero-active-transport': 'transport-1' }),
        sessionUser: { id: 'user-1', email: 'test@example.com', name: 'Test' },
        activeTransportId: 'transport-1',
        activeTransportEmail: 'test@example.com',
        userRole: 'owner',
      });

      const res = await caller.mail.getEmlDownloadUrl({ messageId: 'msg-expired-1' });
      expect(res.filename).toBe('Expired_S3_Email_2026-07-28.eml');
      expect(res.isDirectHttp).toBe(true);
      expect(res.url).toBe('/api/mail/messages/msg-expired-1/download.eml');
    } finally {
      __setDbForTests(null);
      if (prevBucket !== undefined) {
        process.env.S3_BUCKET = prevBucket;
      } else {
        delete process.env.S3_BUCKET;
      }
      if (prevRegion !== undefined) {
        process.env.AWS_REGION = prevRegion;
      } else {
        delete process.env.AWS_REGION;
      }
    }
  });
});

describe.skipIf(!TEST_DB_AVAILABLE || !reachable)(
  'mail.getEmlDownloadUrl (db-backed integration)',
  () => {
    it('returns download url and safe filename for authorized user', async () => {
      await withSeededTestDb(async (db) => {
        await db
          .insert(userAuthTable)
          .values({
            id: 'user-eml-test',
            name: 'EML Tester',
            email: 'eml-tester@legacyhotel.com',
            emailVerified: true,
          })
          .onConflictDoNothing({ target: userAuthTable.email });

        await db
          .insert(mailboxTransport)
          .values({
            id: 'transport-eml-test',
            email: 'eml-tester@legacyhotel.com',
            ownerHeaderValue: 'eml-tester@legacyhotel.com',
            mailboxType: 'personal',
            displayName: 'EML Tester',
            isActive: true,
          })
          .onConflictDoNothing({ target: mailboxTransport.id });

        await db
          .insert(mailboxAccess)
          .values({
            id: 'access-eml-test',
            userId: 'user-eml-test',
            transportId: 'transport-eml-test',
            role: 'owner',
          })
          .onConflictDoNothing({ target: mailboxAccess.id });

        await db
          .insert(mailThread)
          .values({
            id: 'thread-eml-test',
            transportId: 'transport-eml-test',
            threadRootId: 'eml-root',
            subject: 'Reservation 9988',
            snippet: 'Booking confirmation',
            isArchived: false,
            isStarred: false,
            isRead: false,
            labelIds: [],
            latestMessageAt: new Date(),
          })
          .onConflictDoNothing({ target: mailThread.id });

        await db
          .insert(message)
          .values({
            id: 'msg-eml-test-1',
            transportId: 'transport-eml-test',
            threadId: 'thread-eml-test',
            direction: 'inbound',
            fromAddress: 'guest@example.com',
            toAddresses: ['eml-tester@legacyhotel.com'],
            subject: 'Reservation 9988',
            textBody: 'Here is your booking details',
            rawMimeS3Key: 'raw-mime/msg-eml-test-1.eml',
            receivedAt: new Date('2026-09-09T10:00:00Z'),
          })
          .onConflictDoNothing({ target: message.id });

        const caller = await callerFor('user-eml-test', {
          db,
          requestedTransportId: 'transport-eml-test',
        });
        const result = await caller.mail.getEmlDownloadUrl({ messageId: 'msg-eml-test-1' });

        expect(result).toHaveProperty('url');
        expect(result).toHaveProperty('filename');
        expect(result.filename).toBe('Reservation_9988_2026-09-09.eml');
      });
    });

    it('rejects access from unauthorized user (cross-mailbox isolation)', async () => {
      await withSeededTestDb(async (db) => {
        await db
          .insert(userAuthTable)
          .values({
            id: 'user-frontdesk-eml',
            name: 'Frontdesk EML',
            email: 'frontdesk-eml@legacyhotel.com',
            emailVerified: true,
          })
          .onConflictDoNothing({ target: userAuthTable.email });

        await db
          .insert(mailboxTransport)
          .values({
            id: 'transport-frontdesk-eml',
            email: 'frontdesk-eml@legacyhotel.com',
            ownerHeaderValue: 'frontdesk-eml@legacyhotel.com',
            mailboxType: 'personal',
            displayName: 'Frontdesk EML',
            isActive: true,
          })
          .onConflictDoNothing({ target: mailboxTransport.id });

        await db
          .insert(mailboxAccess)
          .values({
            id: 'access-frontdesk-eml',
            userId: 'user-frontdesk-eml',
            transportId: 'transport-frontdesk-eml',
            role: 'owner',
          })
          .onConflictDoNothing({ target: mailboxAccess.id });

        const caller = await callerFor('user-frontdesk-eml', {
          db,
          requestedTransportId: 'transport-frontdesk-eml',
        });
        await expect(
          caller.mail.getEmlDownloadUrl({ messageId: 'msg-eml-test-1' }),
        ).rejects.toThrow(/NOT_FOUND/);
      });
    });

    it('loadAuthorizedMessage queries db directly and enforces mailboxAccess', async () => {
      await withSeededTestDb(async (db) => {
        const authorized = await loadAuthorizedMessage(db, {
          userId: 'user-eml-test',
          messageId: 'msg-eml-test-1',
        });
        expect(authorized).not.toBeNull();
        expect(authorized?.id).toBe('msg-eml-test-1');

        const unauthorized = await loadAuthorizedMessage(db, {
          userId: 'user-frontdesk-eml',
          messageId: 'msg-eml-test-1',
        });
        expect(unauthorized).toBeNull();
      });
    });
  },
);

import { TEST_DB_AVAILABLE, probeTestDb, withSeededTestDb } from './helpers/test-db.js';
import { attachment, mailThread, message } from '../src/db/schema/mail.js';
import { BLOCKED_IMAGE_PLACEHOLDER } from '../src/mail/sanitize-email-html.js';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as mailRoute from '../src/trpc/routes/mail.js';
import { callerFor } from './helpers/trpc-caller.js';
import { appRouter } from '../src/trpc/router.js';
import type { DB } from '../src/db/client.js';
import { randomUUID } from 'node:crypto';

const reachable = await probeTestDb();
const originalBetterAuthUrl = process.env.BETTER_AUTH_URL;

beforeEach(() => {
  process.env.BETTER_AUTH_URL = 'https://mail.example.test/trusted/base?ignored=true';
});

afterEach(() => {
  if (originalBetterAuthUrl === undefined) {
    delete process.env.BETTER_AUTH_URL;
  } else {
    process.env.BETTER_AUTH_URL = originalBetterAuthUrl;
  }
});

describe('processEmailContent input and origin', () => {
  it('requires a messageId before processing caller-provided HTML', async () => {
    const caller = appRouter.createCaller({
      source: 'test',
      sessionUser: {
        id: 'user-1',
        email: 'user@example.test',
        name: 'User',
      },
      activeTransportId: 'transport-1',
      accessRole: 'owner',
      transportEmail: 'user@example.test',
      reqHeaders: new Headers(),
    } as never);

    await expect(
      caller.mail.processEmailContent({
        html: '<p>unsafe without message authorization</p>',
        shouldLoadImages: false,
        theme: 'light',
      } as never),
    ).rejects.toThrow(/messageId/i);
  });

  it('uses only a parsed http(s) BETTER_AUTH_URL origin', () => {
    const trustedInlineOrigin = (
      mailRoute as unknown as {
        trustedInlineOrigin?: (raw: string | undefined) => string;
      }
    ).trustedInlineOrigin;

    expect(trustedInlineOrigin).toBeTypeOf('function');
    expect(
      trustedInlineOrigin?.('https://mail.example.test/trusted/base?ignored=true#fragment'),
    ).toBe('https://mail.example.test');
    expect(() => trustedInlineOrigin?.('ftp://mail.example.test')).toThrow(
      /BETTER_AUTH_URL.*http/i,
    );
    expect(() => trustedInlineOrigin?.('not a url')).toThrow(/BETTER_AUTH_URL.*http/i);
  });
});

function withAttachmentQueryCount(db: DB): {
  db: DB;
  count: () => number;
} {
  let attachmentQueries = 0;
  const countedDb = new Proxy(db, {
    get(target, property, receiver) {
      if (property !== 'select') {
        const value = Reflect.get(target, property, receiver);
        return typeof value === 'function' ? value.bind(target) : value;
      }

      return (...args: unknown[]) => {
        const query = (target.select as (...selectArgs: unknown[]) => object)(...args);
        return new Proxy(query, {
          get(queryTarget, queryProperty, queryReceiver) {
            if (queryProperty !== 'from') {
              const value = Reflect.get(queryTarget, queryProperty, queryReceiver);
              return typeof value === 'function' ? value.bind(queryTarget) : value;
            }

            return (table: unknown) => {
              if (table === attachment) attachmentQueries += 1;
              const from = Reflect.get(queryTarget, queryProperty, queryTarget);
              return from.call(queryTarget, table);
            };
          },
        });
      };
    },
  }) as DB;

  return { db: countedDb, count: () => attachmentQueries };
}

describe.skipIf(!TEST_DB_AVAILABLE || !reachable)(
  'processEmailContent message-scoped projection',
  () => {
    it('authorizes message, loads metadata once, sanitizes, projects same-message CIDs, then collapses quotes', async () => {
      await withSeededTestDb(async (db) => {
        const suffix = randomUUID();
        const threadId = `thread-cid-${suffix}`;
        const otherThreadId = `thread-cid-other-${suffix}`;
        const foreignThreadId = `thread-cid-foreign-${suffix}`;
        const messageId = `message/cid ${suffix}`;
        const otherMessageId = `message-cid-other-${suffix}`;
        const foreignMessageId = `message-cid-foreign-${suffix}`;
        const firstAttachmentId = `attachment/banner ${suffix}`;
        const secondAttachmentId = `attachment-footer-${suffix}`;

        await db.insert(mailThread).values([
          {
            id: threadId,
            transportId: 'transport-centurion',
            threadRootId: `root-cid-${suffix}`,
            subject: 'CID projection',
            snippet: 'CID projection',
            latestMessageAt: new Date(),
          },
          {
            id: otherThreadId,
            transportId: 'transport-centurion',
            threadRootId: `root-cid-other-${suffix}`,
            subject: 'Other message',
            snippet: 'Other message',
            latestMessageAt: new Date(),
          },
          {
            id: foreignThreadId,
            transportId: 'transport-nava',
            threadRootId: `root-cid-foreign-${suffix}`,
            subject: 'Foreign mailbox',
            snippet: 'Foreign mailbox',
            latestMessageAt: new Date(),
          },
        ]);
        await db.insert(message).values([
          {
            id: messageId,
            transportId: 'transport-centurion',
            threadId,
            direction: 'inbound',
            fromAddress: 'brand@example.test',
            toAddresses: ['centurion@legacyhotels.co.za'],
            subject: 'CID projection',
            htmlBody: '<p>stored body</p>',
            receivedAt: new Date(),
          },
          {
            id: otherMessageId,
            transportId: 'transport-centurion',
            threadId: otherThreadId,
            direction: 'inbound',
            fromAddress: 'brand@example.test',
            toAddresses: ['centurion@legacyhotels.co.za'],
            subject: 'Other message',
            htmlBody: '<p>other body</p>',
            receivedAt: new Date(),
          },
          {
            id: foreignMessageId,
            transportId: 'transport-nava',
            threadId: foreignThreadId,
            direction: 'inbound',
            fromAddress: 'brand@example.test',
            toAddresses: ['navaai@legacyhotels.co.za'],
            subject: 'Foreign mailbox',
            htmlBody: '<p>foreign body</p>',
            receivedAt: new Date(),
          },
        ]);
        await db.insert(attachment).values([
          {
            id: firstAttachmentId,
            messageId,
            filename: 'banner.gif',
            mimeType: 'image/gif',
            sizeBytes: 1_024,
            s3Key: `attachments/${suffix}/banner.gif`,
            contentId: '<banner@brand>',
            isInline: true,
          },
          {
            id: secondAttachmentId,
            messageId,
            filename: 'footer.png',
            mimeType: 'image/png',
            sizeBytes: 2_048,
            s3Key: `attachments/${suffix}/footer.png`,
            contentId: '<footer@brand>',
            isInline: true,
          },
          {
            id: `attachment-duplicate-a-${suffix}`,
            messageId,
            filename: 'duplicate-a.png',
            mimeType: 'image/png',
            sizeBytes: 256,
            s3Key: `attachments/${suffix}/duplicate-a.png`,
            contentId: '<duplicate@brand>',
            isInline: true,
          },
          {
            id: `attachment-duplicate-b-${suffix}`,
            messageId,
            filename: 'duplicate-b.png',
            mimeType: 'image/png',
            sizeBytes: 256,
            s3Key: `attachments/${suffix}/duplicate-b.png`,
            contentId: 'CID:duplicate@brand',
            isInline: true,
          },
          {
            id: `attachment-other-${suffix}`,
            messageId: otherMessageId,
            filename: 'cross-message.png',
            mimeType: 'image/png',
            sizeBytes: 512,
            s3Key: `attachments/${suffix}/cross-message.png`,
            contentId: '<cross-message@brand>',
            isInline: true,
          },
        ]);

        const counted = withAttachmentQueryCount(db);
        const seededCaller = await callerFor('user-navaai', {
          db: counted.db,
          requestedTransportId: 'transport-centurion',
        });
        const caller = appRouter.createCaller({
          auth: null as never,
          reqHeaders: new Headers({ host: 'attacker.example.test' }),
          ...seededCaller.ctx,
        });

        const result = await caller.mail.processEmailContent({
          messageId,
          html:
            '<p onclick="alert(1)">Current</p>' +
            '<script>alert("xss")</script>' +
            '<img alt="Banner" src="cid:banner@brand">' +
            '<img alt="Footer" src="CID:footer@brand">' +
            '<img alt="Remote" src="https://remote.example.test/pixel.png">' +
            '<img alt="Duplicate" src="cid:duplicate@brand">' +
            '<blockquote><img alt="Cross" src="cid:cross-message@brand"></blockquote>',
          shouldLoadImages: false,
          theme: 'dark',
        });

        expect(counted.count()).toBe(1);
        expect(result.processedHtml).toContain(
          `https://mail.example.test/api/mail/messages/${encodeURIComponent(
            messageId,
          )}/attachments/${encodeURIComponent(firstAttachmentId)}/inline`,
        );
        expect(result.processedHtml).toContain(
          `https://mail.example.test/api/mail/messages/${encodeURIComponent(
            messageId,
          )}/attachments/${encodeURIComponent(secondAttachmentId)}/inline`,
        );
        expect(result.processedHtml).not.toContain('attacker.example.test');
        expect(result.processedHtml).not.toContain('remote.example.test');
        expect(result.processedHtml).not.toContain(`attachment-other-${suffix}`);
        expect(result.processedHtml).not.toContain('<script');
        expect(result.processedHtml).not.toContain('onclick');
        expect(result.processedHtml).toContain(BLOCKED_IMAGE_PLACEHOLDER);
        expect(result.processedHtml).toContain('<details class="quoted-toggle">');
        expect(result.processedHtml).toContain('#313131');
        expect(result.hasBlockedImages).toBe(true);

        await expect(
          caller.mail.processEmailContent({
            messageId: foreignMessageId,
            html: '<p>must not process</p>',
            shouldLoadImages: false,
            theme: 'light',
          }),
        ).rejects.toThrow(/NOT_FOUND/);
        expect(counted.count()).toBe(1);
      });
    }, 30_000);
  },
);

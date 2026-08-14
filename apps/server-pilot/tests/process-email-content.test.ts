import { describe, expect, it } from 'vitest';
import { processEmailHtmlForDisplay } from '../src/mail/process-email-html.js';
import { processEmailContentInput } from '../src/trpc/routes/mail.js';
import * as mailRoutes from '../src/trpc/routes/mail.js';
import { mailThread, message } from '../src/db/schema/mail.js';
import {
  TEST_DB_AVAILABLE,
  probeTestDb,
  withSeededTestDb,
} from './helpers/test-db.js';
import { callerFor } from './helpers/trpc-caller.js';

describe('processEmailContentInput', () => {
  it('requires messageId', () => {
    const missing = processEmailContentInput.safeParse({
      html: '<p>hi</p>',
    });
    expect(missing.success).toBe(false);

    const empty = processEmailContentInput.safeParse({
      html: '<p>hi</p>',
      messageId: '',
    });
    expect(empty.success).toBe(false);

    const ok = processEmailContentInput.safeParse({
      html: '<p>hi</p>',
      messageId: 'msg-1',
    });
    expect(ok.success).toBe(true);
  });
});

describe('processEmailHtmlForDisplay', () => {
  it('projects cid after sanitize when messageId in scope', async () => {
    const result = await processEmailHtmlForDisplay({
      html: '<img src="cid:banner001@rocketseed">',
      messageId: 'msg-1',
      shouldLoadImages: false,
      theme: 'light',
      origin: 'https://nava.legacy.local',
      attachments: [
        {
          attachmentId: 'att-1',
          contentId: '<banner001@rocketseed>',
          mimeType: 'image/gif',
          sizeBytes: 10,
        },
      ],
    });
    expect(result.processedHtml).toContain('/attachments/att-1/inline');
    expect(result.processedHtml).not.toContain('cid:');
  });

  it('keeps remote https blocked when shouldLoadImages false', async () => {
    const result = await processEmailHtmlForDisplay({
      html: '<img src="https://tracker.example/x.gif">',
      messageId: 'msg-1',
      shouldLoadImages: false,
      theme: 'light',
      origin: 'https://nava.legacy.local',
      attachments: [],
    });
    expect(result.hasBlockedImages).toBe(true);
    expect(result.processedHtml).not.toContain('tracker.example');
  });

  it('does not re-sanitize projected cid https urls with images off', async () => {
    const result = await processEmailHtmlForDisplay({
      html: '<img alt="b" src="cid:banner001@rocketseed">',
      messageId: 'msg-1',
      shouldLoadImages: false,
      theme: 'light',
      origin: 'https://nava.legacy.local',
      attachments: [
        {
          attachmentId: 'att-1',
          contentId: '<banner001@rocketseed>',
          mimeType: 'image/gif',
          sizeBytes: 10,
        },
      ],
    });
    expect(result.processedHtml).toContain(
      'https://nava.legacy.local/api/mail/messages/msg-1/attachments/att-1/inline',
    );
  });

  it.each([
    'https://nava.legacyhotels.co.za',
    'https://nava-admin.trynava.io',
  ])('uses origin-specific CID attachment auth URL for %s', async (origin) => {
    const result = await processEmailHtmlForDisplay({
      html: '<img src="cid:banner001@rocketseed">',
      messageId: 'msg-1',
      shouldLoadImages: false,
      theme: 'light',
      origin,
      attachments: [
        {
          attachmentId: 'att-1',
          contentId: '<banner001@rocketseed>',
          mimeType: 'image/gif',
          sizeBytes: 10,
        },
      ],
    });

    expect(result.processedHtml).toContain(
      `${origin}/api/mail/messages/msg-1/attachments/att-1/inline`,
    );
  });
});

describe('configured mail CID origin', () => {
  it.each([
    'https://nava.legacyhotels.co.za',
    'https://nava-admin.trynava.io',
  ])('projects CID through parsed BETTER_AUTH_URL for %s', async (BETTER_AUTH_URL) => {
    const project = (
      mailRoutes as unknown as {
        processEmailContentForConfiguredOrigin?: (input: {
          html: string;
          messageId: string;
          shouldLoadImages: boolean;
          theme: 'light' | 'dark';
          attachments: Array<{
            attachmentId: string;
            contentId: string;
            mimeType: string;
            sizeBytes: number;
          }>;
        }, env: NodeJS.ProcessEnv) => Promise<{ processedHtml: string }>;
      }
    ).processEmailContentForConfiguredOrigin;

    expect(project).toBeTypeOf('function');
    if (!project) return;

    const result = await project(
      {
        html: '<img src="cid:banner001@rocketseed">',
        messageId: 'msg-1',
        shouldLoadImages: false,
        theme: 'light',
        attachments: [
          {
            attachmentId: 'att-1',
            contentId: '<banner001@rocketseed>',
            mimeType: 'image/gif',
            sizeBytes: 10,
          },
        ],
      },
      {
        PORT: '8788',
        DATABASE_URL: 'not-used-by-pure-helper',
        BETTER_AUTH_URL,
        BETTER_AUTH_SECRET: 'not-used-by-pure-helper',
        AWS_REGION: 'af-south-1',
        S3_BUCKET: 'not-used-by-pure-helper',
      },
    );

    expect(result.processedHtml).toContain(
      `${BETTER_AUTH_URL}/api/mail/messages/msg-1/attachments/att-1/inline`,
    );
  });
});

const reachable = await probeTestDb();

describe.skipIf(!TEST_DB_AVAILABLE || !reachable)(
  'mail.processEmailContent authz (seeded, transaction-rollback)',
  () => {
    it(
      'rejects missing / foreign message via requireMessageForTransport',
      async () => {
        await withSeededTestDb(async (db) => {
          await db.insert(mailThread).values({
            id: 'thread-proc-authz-cent',
            transportId: 'transport-centurion',
            threadRootId: 'proc-authz-cent-root',
            subject: 'Centurion process authz',
            snippet: 'body',
            isArchived: false,
            isStarred: false,
            isRead: true,
            labelIds: [],
            latestMessageAt: new Date(),
          });
          await db.insert(message).values({
            id: 'msg-proc-authz-cent',
            transportId: 'transport-centurion',
            threadId: 'thread-proc-authz-cent',
            direction: 'inbound',
            fromAddress: 'guest@example.com',
            toAddresses: ['centurion@legacyhotel.com'],
            subject: 'Centurion process authz',
            textBody: 'body',
            receivedAt: new Date(),
          });

          const frontdesk = await callerFor('user-frontdesk', { db });
          await expect(
            frontdesk.mail.processEmailContent({
              html: '<p>hi</p>',
              messageId: 'msg-proc-authz-cent',
            }),
          ).rejects.toThrow(/NOT_FOUND/);

          await expect(
            frontdesk.mail.processEmailContent({
              html: '<p>hi</p>',
              messageId: 'msg-does-not-exist',
            }),
          ).rejects.toThrow(/NOT_FOUND/);
        });
      },
      30000,
    );
  },
);

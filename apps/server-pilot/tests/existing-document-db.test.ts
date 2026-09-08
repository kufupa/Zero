import {
  aiWorkflowRun,
  attachment,
  mailboxAccess,
  mailThread,
  message,
  mailboxTransport,
} from '../src/db/schema/mail.js';
import { FakeS3Storage, getS3Storage, resetS3Storage, setS3Storage } from '../src/storage/s3.js';
import { TEST_DB_AVAILABLE, probeTestDb, withSeededTestDb } from './helpers/test-db.js';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { CENTURION_USER_ID, TRANSPORT_ID } from '../src/db/seed.js';
import { resolveMailboxContext } from '../src/trpc/context.js';
import { __setDbForTests, type DB } from '../src/db/client.js';
import { claimNextAiRun } from '../src/ai/run-ledger.js';
import { executeAiRun } from '../src/ai/worker.js';
import { appRouter } from '../src/trpc/router.js';
import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';

const reachable = await probeTestDb();
const OBSERVED_AT = new Date('2026-09-08T09:00:00.000Z');
const THREAD_SUBJECT = 'Synthetic U9 tax invoice DOC-RED';
const SYNTHETIC_PROPERTY = 'HRCEN-U9-RED';
const SYNTHETIC_GUEST = 'guest-u9-red';
const SYNTHETIC_PAYER = 'payer-u9-red';
const DOCUMENT_BYTES = Buffer.from('Synthetic authorized invoice bytes\n', 'utf8');

type ExistingDocumentListInput = {
  threadId: string;
  source: 'mail_attachment' | 'hms_sent_attachment';
  kind?: 'tax_invoice';
  requestedPriceVisibility?: 'allowed' | 'forbidden' | 'unknown';
};

type ExistingDocumentReadInput = {
  threadId: string;
  documentRef: string;
  format: 'text' | 'artifact';
};

type ExistingDocumentCaller = {
  enqueueExistingDocumentList(input: ExistingDocumentListInput): Promise<{
    runId: string;
    readResultRef: string;
    runState: string;
  }>;
  enqueueExistingDocumentRead(input: ExistingDocumentReadInput): Promise<{
    runId: string;
    readResultRef: string;
    runState: string;
  }>;
  readHmsReceipt(input: { threadId: string; readResultRef: string }): Promise<{
    result: {
      toolId: string;
      status: string;
      data: {
        documents?: Array<{ documentRef: string | null }>;
        document?: { documentRef: string | null };
      } | null;
    };
  }>;
};

const WORKER_ENV_KEYS = [
  'PORT',
  'BETTER_AUTH_URL',
  'BETTER_AUTH_SECRET',
  'AWS_REGION',
  'S3_BUCKET',
  'AI_WORKER_LANE',
  'HMS_READ_SERVICE_ENABLED',
  'HMS_DRAFT_ENRICHMENT_MODE',
  'HMS_RUN_DEADLINE_MS',
] as const;

async function withReadOnlyWorkerEnv<T>(callback: () => Promise<T>): Promise<T> {
  const previous = new Map(WORKER_ENV_KEYS.map((key) => [key, process.env[key]]));
  process.env.PORT = '3000';
  process.env.BETTER_AUTH_URL = 'https://synthetic.invalid';
  process.env.BETTER_AUTH_SECRET = 'x'.repeat(32);
  process.env.AWS_REGION = 'synthetic-region-1';
  process.env.S3_BUCKET = 'u9-document-synthetic-bucket';
  process.env.AI_WORKER_LANE = 'hms';
  process.env.HMS_READ_SERVICE_ENABLED = 'true';
  process.env.HMS_DRAFT_ENRICHMENT_MODE = 'off';
  process.env.HMS_RUN_DEADLINE_MS = '150000';
  try {
    return await callback();
  } finally {
    for (const key of WORKER_ENV_KEYS) {
      const value = previous.get(key);
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

async function authenticatedCaller(db: DB, userId = CENTURION_USER_ID) {
  const mailbox = await resolveMailboxContext(userId, TRANSPORT_ID, db);
  return appRouter.createCaller({
    auth: null as never,
    reqHeaders: new Headers(),
    sessionUser: { id: userId, email: '', name: null },
    ...mailbox,
  });
}

async function seedDocumentMailbox(db: DB) {
  const threadId = `u9-thread-${randomUUID()}`;
  const messageId = `u9-message-${randomUUID()}`;
  const attachmentId = `u9-attachment-${randomUUID()}`;
  await db
    .insert(mailboxTransport)
    .values({
      id: TRANSPORT_ID,
      email: 'centurion@legacyhotel.com',
      ownerHeaderValue: 'centurion@legacyhotel.com',
      mailboxType: 'shared',
      isActive: true,
    })
    .onConflictDoNothing({ target: mailboxTransport.id });
  await db
    .insert(mailboxAccess)
    .values({
      id: `access-${CENTURION_USER_ID}-${TRANSPORT_ID}`,
      userId: CENTURION_USER_ID,
      transportId: TRANSPORT_ID,
      role: 'owner',
      isDefault: true,
    })
    .onConflictDoNothing({ target: mailboxAccess.id });
  await db.insert(mailThread).values({
    id: threadId,
    transportId: TRANSPORT_ID,
    threadRootId: `<${threadId}@synthetic.invalid>`,
    subject: THREAD_SUBJECT,
    snippet: THREAD_SUBJECT,
    latestMessageAt: OBSERVED_AT,
  });
  await db.insert(message).values({
    id: messageId,
    transportId: TRANSPORT_ID,
    threadId,
    direction: 'inbound',
    fromAddress: 'synthetic-billing@example.invalid',
    toAddresses: ['centurion@legacyhotel.com'],
    subject: THREAD_SUBJECT,
    textBody: `Synthetic tax invoice. Property ${SYNTHETIC_PROPERTY}. Guest ${SYNTHETIC_GUEST}. Payer ${SYNTHETIC_PAYER}. Stay 2026-09-10 through 2026-09-12. Version v1. Prices visible.`,
    receivedAt: OBSERVED_AT,
  });
  await db.insert(attachment).values({
    id: attachmentId,
    messageId,
    filename: 'synthetic-tax-invoice-v1.txt',
    mimeType: 'text/plain',
    sizeBytes: DOCUMENT_BYTES.byteLength,
    s3Key: `attachments/${messageId}/000-synthetic-tax-invoice-v1.txt`,
  });
  await getS3Storage().putObject({
    key: `attachments/${messageId}/000-synthetic-tax-invoice-v1.txt`,
    body: DOCUMENT_BYTES,
    contentType: 'text/plain',
  });
  return { threadId, messageId, attachmentId };
}

async function claimAndExecute(db: DB, runId: string) {
  const claimed = await claimNextAiRun({
    ownerId: `u9-document-worker-${randomUUID()}`,
    lane: 'hms',
    runKind: 'read_tool',
    db,
  });
  expect(claimed?.id).toBe(runId);
  return executeAiRun(runId);
}

describe.skipIf(!TEST_DB_AVAILABLE || !reachable)('U9 existing-document trusted DB path', () => {
  beforeEach(() => {
    setS3Storage(new FakeS3Storage());
  });

  afterEach(() => {
    resetS3Storage();
    __setDbForTests(null);
  });

  it('runs authenticated list then a fresh authenticated read through queue, worker, and durable receipts', async () => {
    await withReadOnlyWorkerEnv(() =>
      withSeededTestDb(async (db) => {
        __setDbForTests({ db, conn: null as never });
        const fixture = await seedDocumentMailbox(db);
        const caller = (await authenticatedCaller(db)) as unknown as {
          ai: ExistingDocumentCaller;
        };
        const list = await caller.ai.enqueueExistingDocumentList({
          threadId: fixture.threadId,
          source: 'mail_attachment',
          kind: 'tax_invoice',
          requestedPriceVisibility: 'allowed',
        });
        expect(list.runState).toBe('queued');
        expect((await claimAndExecute(db, list.runId)).state).toBe('succeeded');
        const listReceipt = await caller.ai.readHmsReceipt({
          threadId: fixture.threadId,
          readResultRef: list.readResultRef,
        });
        expect(listReceipt.result).toMatchObject({
          toolId: 'documents_list_existing',
          status: 'ok',
        });
        const documentRef = listReceipt.result.data?.documents?.[0]?.documentRef;
        expect(documentRef).toMatch(/^doc:/);

        const read = await caller.ai.enqueueExistingDocumentRead({
          threadId: fixture.threadId,
          documentRef: documentRef!,
          format: 'text',
        });
        expect(read.runState).toBe('queued');
        expect((await claimAndExecute(db, read.runId)).state).toBe('succeeded');
        const readReceipt = await caller.ai.readHmsReceipt({
          threadId: fixture.threadId,
          readResultRef: read.readResultRef,
        });
        expect(readReceipt.result).toMatchObject({
          toolId: 'documents_read_existing',
          status: 'ok',
        });
        expect(readReceipt.result.data?.document?.documentRef).toBe(documentRef);
      }),
    );
  }, 30000);

  it('rejects a foreign or revoked mailbox before any queue insertion', async () => {
    await withReadOnlyWorkerEnv(() =>
      withSeededTestDb(async (db) => {
        __setDbForTests({ db, conn: null as never });
        const fixture = await seedDocumentMailbox(db);
        const caller = (await authenticatedCaller(db)) as unknown as {
          ai: ExistingDocumentCaller;
        };
        const accessId = `access-${CENTURION_USER_ID}-${TRANSPORT_ID}`;
        await db.delete(mailboxAccess).where(eq(mailboxAccess.id, accessId));
        await expect(
          caller.ai.enqueueExistingDocumentList({
            threadId: fixture.threadId,
            source: 'mail_attachment',
            requestedPriceVisibility: 'allowed',
          }),
        ).rejects.toThrow(/grant|mailbox|active|forbidden/i);
        const runs = await db.select({ id: aiWorkflowRun.id }).from(aiWorkflowRun);
        expect(runs).toHaveLength(0);
      }),
    );
  }, 30000);

  it.each([
    ['foreign-ref', 'doc:foreign-u9-ref'],
    ['changed-locator', 'doc:changed-locator-u9'],
    ['missing-bytes', 'doc:missing-bytes-u9'],
  ] as const)(
    'rejects a %s read without prohibited I/O',
    async (_label, documentRef) => {
      await withReadOnlyWorkerEnv(() =>
        withSeededTestDb(async (db) => {
          __setDbForTests({ db, conn: null as never });
          const fixture = await seedDocumentMailbox(db);
          const caller = (await authenticatedCaller(db)) as unknown as {
            ai: ExistingDocumentCaller;
          };
          await expect(
            caller.ai.enqueueExistingDocumentRead({
              threadId: fixture.threadId,
              documentRef,
              format: 'artifact',
            }),
          ).rejects.toThrow(
            /DOCUMENT_(?:SCOPE|REF|CHANGED)|SOURCE_UNAVAILABLE|MISSING_AUTHORIZED_BYTES|document reference is not current/,
          );
          const runs = await db.select({ id: aiWorkflowRun.id }).from(aiWorkflowRun);
          expect(runs).toHaveLength(0);
        }),
      );
    },
    30000,
  );

  it('keeps sent-mail metadata-only and never treats sent-log state as delivery or bytes', async () => {
    await withReadOnlyWorkerEnv(() =>
      withSeededTestDb(async (db) => {
        __setDbForTests({ db, conn: null as never });
        const fixture = await seedDocumentMailbox(db);
        const caller = (await authenticatedCaller(db)) as unknown as {
          ai: ExistingDocumentCaller;
        };
        const sent = await caller.ai.enqueueExistingDocumentList({
          threadId: fixture.threadId,
          source: 'hms_sent_attachment',
        });
        expect(sent.runState).toBe('queued');
        expect((await claimAndExecute(db, sent.runId)).state).toBe('succeeded');
        const receipt = await caller.ai.readHmsReceipt({
          threadId: fixture.threadId,
          readResultRef: sent.readResultRef,
        });
        expect(receipt.result.status).toBe('ok');
        expect(receipt.result.data?.documents?.[0]).toMatchObject({
          retrievable: false,
          retrievalBlocker: 'METADATA_ONLY',
        });
      }),
    );
  }, 30000);
});

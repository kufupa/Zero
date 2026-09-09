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
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
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
  limit?: number;
  cursor?: string;
  requestedPriceVisibility?: 'allowed' | 'forbidden' | 'unknown';
};

type ExistingDocumentReadInput = {
  threadId: string;
  documentRef: string;
  format: 'text' | 'artifact';
};

type ExistingDocumentMetadata = {
  documentRef: string | null;
  displayName?: string;
  source?: string;
  kind?: string;
  version?: string;
  status?: string;
  currentVersion?: boolean;
  propertyRef?: string | null;
  guestRef?: string | null;
  priceVisibility?: string;
  retrievable?: boolean;
  retrievalBlocker?: string | null;
};

type ExistingDocumentReadData = {
  documents?: ExistingDocumentMetadata[];
  sourceOutcomes?: Array<{
    status?: string;
    issues?: Array<{ code: string }>;
  }>;
  document?: {
    documentRef: string | null;
    artifactRef?: string | null;
    extractionState?: string;
    validation?: Record<string, unknown>;
    text?: string | null;
    retrievalBlocker?: string | null;
  } | null;
  artifactRef?: string | null;
  sourceHash?: string | null;
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
      blocker?: string | null;
      issues?: Array<{ code: string }>;
      data: ExistingDocumentReadData | null;
    };
  }>;
};

type ObservedDocumentQuery = {
  limit: number | null;
  orderBy: boolean;
  sql: string;
};

/**
 * Observe the real Drizzle select builders while delegating every operation
 * to the supplied DB. This is intentionally a test-only boundary assertion:
 * authority, joins, and execution still use the actual PG handle.
 */
function observeDocumentQueries(db: DB) {
  const queries: ObservedDocumentQuery[] = [];
  type QueryObject = object & {
    toSQL?: () => { sql?: unknown };
  };
  type SelectDb = {
    select: (...args: unknown[]) => unknown;
  };

  const wrapQuery = (query: unknown): unknown => {
    if (!query || typeof query !== 'object') return query;
    const state = { limit: null as number | null, orderBy: false };
    const proxy = (value: unknown): unknown => {
      if (!value || typeof value !== 'object') return value;
      return new Proxy(value as object, {
        get(target, property) {
          const member = Reflect.get(target, property, target);
          if (property === 'then' && typeof member === 'function') {
            return (...args: unknown[]) => {
              const toSQL = Reflect.get(target, 'toSQL', target);
              const sqlResult =
                typeof toSQL === 'function'
                  ? (toSQL as (this: QueryObject) => { sql?: unknown }).call(target)
                  : null;
              if (typeof sqlResult?.sql === 'string') {
                queries.push({
                  limit: state.limit,
                  orderBy: state.orderBy,
                  sql: sqlResult.sql,
                });
              }
              return (member as (...values: unknown[]) => unknown).apply(target, args);
            };
          }
          if (typeof member !== 'function') return member;
          return (...args: unknown[]) => {
            if (property === 'limit' && typeof args[0] === 'number') {
              state.limit = args[0];
            }
            if (property === 'orderBy') state.orderBy = true;
            return proxy((member as (...values: unknown[]) => unknown).apply(target, args));
          };
        },
      });
    };
    return proxy(query);
  };

  const selectDb = db as unknown as SelectDb;
  const originalSelect = selectDb.select.bind(selectDb);
  const selectSpy = vi
    .spyOn(selectDb, 'select')
    .mockImplementation((...args) => wrapQuery(originalSelect(...args)));
  return {
    queries,
    restore: () => selectSpy.mockRestore(),
  };
}

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

async function authenticatedDocumentCaller(db: DB): Promise<ExistingDocumentCaller> {
  const caller = await authenticatedCaller(db);
  return (caller as unknown as { ai: ExistingDocumentCaller }).ai;
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
  const execution = await executeAiRun(runId);
  if (execution.state !== 'succeeded') {
    const [failedRun] = await db
      .select({ failureClass: aiWorkflowRun.failureClass, lastError: aiWorkflowRun.lastError })
      .from(aiWorkflowRun)
      .where(eq(aiWorkflowRun.id, runId))
      .limit(1);
    throw new Error(
      `existing-document worker ${execution.state}: ${failedRun?.failureClass ?? 'unknown'} ${failedRun?.lastError ?? 'no persisted error'}`,
    );
  }
  return execution;
}

async function executeDocumentList(
  db: DB,
  caller: ExistingDocumentCaller,
  input: ExistingDocumentListInput,
) {
  const list = await caller.enqueueExistingDocumentList(input);
  expect(list.runState).toBe('queued');
  expect((await claimAndExecute(db, list.runId)).state).toBe('succeeded');
  const receipt = await caller.readHmsReceipt({
    threadId: input.threadId,
    readResultRef: list.readResultRef,
  });
  return { list, result: receipt.result };
}

async function executeDocumentRead(
  db: DB,
  caller: ExistingDocumentCaller,
  input: ExistingDocumentReadInput,
) {
  const read = await caller.enqueueExistingDocumentRead(input);
  expect(read.runState).toBe('queued');
  expect((await claimAndExecute(db, read.runId)).state).toBe('succeeded');
  const receipt = await caller.readHmsReceipt({
    threadId: input.threadId,
    readResultRef: read.readResultRef,
  });
  return { read, result: receipt.result };
}

async function addDocumentMessageWithAttachment(
  db: DB,
  input: {
    threadId: string;
    messageId: string;
    attachmentId: string;
    direction: 'inbound' | 'outbound';
    observedAt: Date;
    filename: string;
    textBody: string;
    bytes: Buffer;
  },
) {
  await db.insert(message).values({
    id: input.messageId,
    transportId: TRANSPORT_ID,
    threadId: input.threadId,
    direction: input.direction,
    fromAddress: 'synthetic-billing@legacyhotel.com',
    toAddresses: ['centurion@legacyhotel.com'],
    subject: input.filename,
    textBody: input.textBody,
    ...(input.direction === 'inbound'
      ? { receivedAt: input.observedAt }
      : { sentAt: input.observedAt }),
  });
  const s3Key = `attachments/${input.messageId}/000-${input.filename}`;
  await db.insert(attachment).values({
    id: input.attachmentId,
    messageId: input.messageId,
    filename: input.filename,
    mimeType: 'text/plain',
    sizeBytes: input.bytes.byteLength,
    s3Key,
  });
  await getS3Storage().putObject({
    key: s3Key,
    body: input.bytes,
    contentType: 'text/plain',
  });
  return { s3Key };
}

function sameLengthDocumentBytes(text: string) {
  const bytes = Buffer.alloc(DOCUMENT_BYTES.byteLength, 0x21);
  Buffer.from(text, 'utf8').copy(bytes, 0, 0, bytes.byteLength);
  return bytes;
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
        await addDocumentMessageWithAttachment(db, {
          threadId: fixture.threadId,
          messageId: `u9-sent-only-message-${randomUUID()}`,
          attachmentId: `u9-sent-only-attachment-${randomUUID()}`,
          direction: 'outbound',
          observedAt: new Date(OBSERVED_AT.getTime() - 30 * 60 * 1000),
          filename: 'sent-tax-invoice-v1.txt',
          textBody: `Sent tax invoice. Property ${SYNTHETIC_PROPERTY}. Guest ${SYNTHETIC_GUEST}.`,
          bytes: DOCUMENT_BYTES,
        });
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
          status: 'manual_required',
        });
        expect(readReceipt.result.data?.document?.documentRef).toBe(documentRef);
        expect(readReceipt.result.data?.text).toBe(DOCUMENT_BYTES.toString('utf8').trim());
        expect(readReceipt.result.data?.validation).toEqual({
          identity: 'unknown',
          stayDates: 'unknown',
          payer: 'unknown',
          kind: 'unknown',
          version: 'unknown',
          priceVisibility: 'unknown',
        });
        expect(readReceipt.result.issues?.[0]?.code).toBe('INPUT_MISSING');
      }),
    );
  }, 30000);

  it('bounds list results to the trigger horizon and the requested message direction', async () => {
    await withReadOnlyWorkerEnv(() =>
      withSeededTestDb(async (db) => {
        __setDbForTests({ db, conn: null as never });
        const fixture = await seedDocumentMailbox(db);
        await addDocumentMessageWithAttachment(db, {
          threadId: fixture.threadId,
          messageId: `u9-sent-message-${randomUUID()}`,
          attachmentId: `u9-sent-attachment-${randomUUID()}`,
          direction: 'outbound',
          observedAt: new Date(OBSERVED_AT.getTime() - 30 * 60 * 1000),
          filename: 'sent-tax-invoice-v1.txt',
          textBody: `Sent tax invoice. Property ${SYNTHETIC_PROPERTY}. Guest ${SYNTHETIC_GUEST}.`,
          bytes: DOCUMENT_BYTES,
        });
        const caller = await authenticatedDocumentCaller(db);
        const queuedInbound = await caller.enqueueExistingDocumentList({
          threadId: fixture.threadId,
          source: 'mail_attachment',
          kind: 'tax_invoice',
          requestedPriceVisibility: 'allowed',
        });
        expect(queuedInbound.runState).toBe('queued');
        await addDocumentMessageWithAttachment(db, {
          threadId: fixture.threadId,
          messageId: `u9-later-message-${randomUUID()}`,
          attachmentId: `u9-later-attachment-${randomUUID()}`,
          direction: 'inbound',
          observedAt: new Date(OBSERVED_AT.getTime() + 60 * 60 * 1000),
          filename: 'later-tax-invoice-v2.txt',
          textBody: `Later tax invoice. Property ${SYNTHETIC_PROPERTY}. Guest ${SYNTHETIC_GUEST}.`,
          bytes: DOCUMENT_BYTES,
        });
        expect((await claimAndExecute(db, queuedInbound.runId)).state).toBe('succeeded');
        const inboundReceipt = await caller.readHmsReceipt({
          threadId: fixture.threadId,
          readResultRef: queuedInbound.readResultRef,
        });
        const inbound = inboundReceipt;
        expect(inbound.result.status).toBe('ok');
        expect(inbound.result.data?.documents).toHaveLength(1);
        expect(inbound.result.data?.documents?.[0]?.displayName).toBe(
          'synthetic-tax-invoice-v1.txt',
        );

        const sent = await executeDocumentList(db, caller, {
          threadId: fixture.threadId,
          source: 'hms_sent_attachment',
        });
        expect(sent.result.status).toBe('ok');
        expect(sent.result.data?.documents).toHaveLength(1);
        expect(sent.result.data?.documents?.[0]?.displayName).toBe('sent-tax-invoice-v1.txt');
        expect(sent.result.data?.documents?.[0]?.source).toBe('hms_sent_attachment');
      }),
    );
  }, 30000);

  it('does not promote misleading labels into independently verified document facts', async () => {
    await withReadOnlyWorkerEnv(() =>
      withSeededTestDb(async (db) => {
        __setDbForTests({ db, conn: null as never });
        const fixture = await seedDocumentMailbox(db);
        await db
          .update(message)
          .set({
            subject: 'proforma-invoice-v9-draft.txt',
            textBody:
              'Tax invoice FINAL v9. Property WRONG-PROPERTY. Guest wrong-guest. Payer wrong-payer. Stay 2030-01-01 through 2030-01-02. Prices visible.',
          })
          .where(eq(message.id, fixture.messageId));
        await db
          .update(attachment)
          .set({ filename: 'proforma-invoice-v9-draft.txt' })
          .where(eq(attachment.id, fixture.attachmentId));
        const caller = await authenticatedDocumentCaller(db);
        const listed = await executeDocumentList(db, caller, {
          threadId: fixture.threadId,
          source: 'mail_attachment',
        });
        expect(listed.result.data?.documents).toHaveLength(1);
        const metadata = listed.result.data?.documents?.[0];
        expect(metadata?.retrievable).toBe(false);
        expect(metadata?.retrievalBlocker).toBe('DOCUMENT_VALIDATION_INCOMPLETE');

        const read = await executeDocumentRead(db, caller, {
          threadId: fixture.threadId,
          documentRef: metadata?.documentRef ?? '',
          format: 'text',
        });
        expect(read.result.status).toBe('manual_required');
        expect(read.result.issues?.[0]?.code).toBe('INPUT_MISSING');
        expect(read.result.data?.validation).toMatchObject({
          identity: 'unknown',
          stayDates: 'unknown',
          payer: 'unknown',
          kind: 'unknown',
          version: 'unknown',
          priceVisibility: 'unknown',
        });
      }),
    );
  }, 30000);

  it('does not classify a pro-forma invoice filename as a tax invoice', async () => {
    await withReadOnlyWorkerEnv(() =>
      withSeededTestDb(async (db) => {
        __setDbForTests({ db, conn: null as never });
        const fixture = await seedDocumentMailbox(db);
        await db
          .update(attachment)
          .set({ filename: 'proforma-invoice-v1.txt' })
          .where(eq(attachment.id, fixture.attachmentId));
        const caller = await authenticatedDocumentCaller(db);
        const listed = await executeDocumentList(db, caller, {
          threadId: fixture.threadId,
          source: 'mail_attachment',
        });
        expect(listed.result.data?.documents).toHaveLength(1);
        expect(listed.result.data?.documents?.[0]?.kind).not.toBe('tax_invoice');
      }),
    );
  }, 30000);

  it('rejects a listed ref after its locator changes before queue insertion', async () => {
    await withReadOnlyWorkerEnv(() =>
      withSeededTestDb(async (db) => {
        __setDbForTests({ db, conn: null as never });
        const fixture = await seedDocumentMailbox(db);
        const caller = await authenticatedDocumentCaller(db);
        const listed = await executeDocumentList(db, caller, {
          threadId: fixture.threadId,
          source: 'mail_attachment',
          kind: 'tax_invoice',
          requestedPriceVisibility: 'allowed',
        });
        const documentRef = listed.result.data?.documents?.[0]?.documentRef;
        expect(documentRef).toMatch(/^doc:/);
        const replacementKey = `attachments/${fixture.messageId}/000-replaced-same-size.txt`;
        await db
          .update(attachment)
          .set({ s3Key: replacementKey })
          .where(eq(attachment.id, fixture.attachmentId));
        await getS3Storage().putObject({
          key: replacementKey,
          body: DOCUMENT_BYTES,
          contentType: 'text/plain',
        });
        let storageIoStarted = false;
        const storage = getS3Storage();
        const originalGetObjectBounded = storage.getObjectBounded.bind(storage);
        storage.getObjectBounded = async (key, maxBytes, signal) => {
          storageIoStarted = true;
          return originalGetObjectBounded(key, maxBytes, signal);
        };

        await expect(
          caller.enqueueExistingDocumentRead({
            threadId: fixture.threadId,
            documentRef: documentRef!,
            format: 'text',
          }),
        ).rejects.toThrow(/DOCUMENT_CHANGED|document reference is not current/i);
        expect(storageIoStarted).toBe(false);
        const runs = await db
          .select({ id: aiWorkflowRun.id })
          .from(aiWorkflowRun)
          .where(eq(aiWorkflowRun.threadId, fixture.threadId));
        expect(runs).toHaveLength(1);
      }),
    );
  }, 30000);

  it('does not accept a same-key same-size replacement under an old listed ref', async () => {
    await withReadOnlyWorkerEnv(() =>
      withSeededTestDb(async (db) => {
        __setDbForTests({ db, conn: null as never });
        const fixture = await seedDocumentMailbox(db);
        const caller = await authenticatedDocumentCaller(db);
        const listed = await executeDocumentList(db, caller, {
          threadId: fixture.threadId,
          source: 'mail_attachment',
          kind: 'tax_invoice',
          requestedPriceVisibility: 'allowed',
        });
        const documentRef = listed.result.data?.documents?.[0]?.documentRef;
        expect(documentRef).toMatch(/^doc:/);
        await getS3Storage().putObject({
          key: `attachments/${fixture.messageId}/000-synthetic-tax-invoice-v1.txt`,
          body: sameLengthDocumentBytes('Wrong body identity, draft, v9, hidden price.'),
          contentType: 'text/plain',
        });

        const read = await executeDocumentRead(db, caller, {
          threadId: fixture.threadId,
          documentRef: documentRef!,
          format: 'text',
        });
        expect(read.result.status).toBe('manual_required');
        expect(read.result.issues?.[0]?.code).toBe('DOCUMENT_CHANGED');
        expect(read.result.data?.text).toBeNull();
      }),
    );
  }, 30000);

  it('denies a listed ref when its authorized bytes disappear before read', async () => {
    await withReadOnlyWorkerEnv(() =>
      withSeededTestDb(async (db) => {
        __setDbForTests({ db, conn: null as never });
        const fixture = await seedDocumentMailbox(db);
        const caller = await authenticatedDocumentCaller(db);
        const listed = await executeDocumentList(db, caller, {
          threadId: fixture.threadId,
          source: 'mail_attachment',
          kind: 'tax_invoice',
          requestedPriceVisibility: 'allowed',
        });
        const documentRef = listed.result.data?.documents?.[0]?.documentRef;
        expect(documentRef).toMatch(/^doc:/);
        await getS3Storage().deleteObject(
          `attachments/${fixture.messageId}/000-synthetic-tax-invoice-v1.txt`,
        );

        const read = await executeDocumentRead(db, caller, {
          threadId: fixture.threadId,
          documentRef: documentRef!,
          format: 'text',
        });
        expect(read.result.status).toBe('manual_required');
        expect(read.result.issues?.[0]?.code).toMatch(/SOURCE_UNAVAILABLE|UNSUPPORTED_FORMAT/);
        expect(read.result.data?.text).toBeNull();
        expect(read.result.data?.sourceHash ?? null).toBeNull();
      }),
    );
  }, 30000);

  it('does not expose a hash when a listed object is truncated before read', async () => {
    await withReadOnlyWorkerEnv(() =>
      withSeededTestDb(async (db) => {
        __setDbForTests({ db, conn: null as never });
        const fixture = await seedDocumentMailbox(db);
        const caller = await authenticatedDocumentCaller(db);
        const listed = await executeDocumentList(db, caller, {
          threadId: fixture.threadId,
          source: 'mail_attachment',
          kind: 'tax_invoice',
          requestedPriceVisibility: 'allowed',
        });
        const documentRef = listed.result.data?.documents?.[0]?.documentRef;
        expect(documentRef).toMatch(/^doc:/);
        await getS3Storage().putObject({
          key: `attachments/${fixture.messageId}/000-synthetic-tax-invoice-v1.txt`,
          body: DOCUMENT_BYTES.subarray(0, DOCUMENT_BYTES.byteLength - 1),
          contentType: 'text/plain',
        });

        const read = await executeDocumentRead(db, caller, {
          threadId: fixture.threadId,
          documentRef: documentRef!,
          format: 'text',
        });
        expect(read.result.status).toBe('manual_required');
        expect(read.result.data?.sourceHash ?? null).toBeNull();
        expect(read.result.data?.text).toBeNull();
      }),
    );
  }, 30000);

  it('revalidates the grant immediately before storage I/O', async () => {
    await withReadOnlyWorkerEnv(() =>
      withSeededTestDb(async (db) => {
        __setDbForTests({ db, conn: null as never });
        const fixture = await seedDocumentMailbox(db);
        const caller = await authenticatedDocumentCaller(db);
        const listed = await executeDocumentList(db, caller, {
          threadId: fixture.threadId,
          source: 'mail_attachment',
          kind: 'tax_invoice',
          requestedPriceVisibility: 'allowed',
        });
        const documentRef = listed.result.data?.documents?.[0]?.documentRef;
        expect(documentRef).toMatch(/^doc:/);

        const revokingStorage = new FakeS3Storage();
        await revokingStorage.putObject({
          key: `attachments/${fixture.messageId}/000-synthetic-tax-invoice-v1.txt`,
          body: DOCUMENT_BYTES,
          contentType: 'text/plain',
        });
        let storageIoStarted = false;
        const originalHeadObject = revokingStorage.headObject.bind(revokingStorage);
        revokingStorage.headObject = async (key) => {
          await db
            .delete(mailboxAccess)
            .where(eq(mailboxAccess.id, `access-${CENTURION_USER_ID}-${TRANSPORT_ID}`));
          return originalHeadObject(key);
        };
        const originalGetObjectBounded = revokingStorage.getObjectBounded.bind(revokingStorage);
        revokingStorage.getObjectBounded = async (key, maxBytes, signal) => {
          storageIoStarted = true;
          return originalGetObjectBounded(key, maxBytes, signal);
        };
        setS3Storage(revokingStorage);

        const read = await caller.enqueueExistingDocumentRead({
          threadId: fixture.threadId,
          documentRef: documentRef!,
          format: 'text',
        });
        expect((await claimAndExecute(db, read.runId)).state).toBe('succeeded');
        const [storedRun] = await db
          .select({ readResult: aiWorkflowRun.readResult })
          .from(aiWorkflowRun)
          .where(eq(aiWorkflowRun.id, read.runId));
        const result = storedRun?.readResult as {
          status?: string;
          blocker?: string | null;
          issues?: Array<{ code: string }>;
          data?: { text?: string | null } | null;
        } | null;
        expect(storageIoStarted).toBe(false);
        expect(result?.status).toBe('manual_required');
        expect(result?.issues?.[0]?.code).toMatch(
          /SOURCE_UNAVAILABLE|SCOPE_DENIED|READ_AUTH|UNSUPPORTED_FORMAT/i,
        );
        expect(result?.data?.text ?? null).toBeNull();
      }),
    );
  }, 30000);

  it('does not emit an unusable artifact handle when artifact retrieval is unsupported', async () => {
    await withReadOnlyWorkerEnv(() =>
      withSeededTestDb(async (db) => {
        __setDbForTests({ db, conn: null as never });
        const fixture = await seedDocumentMailbox(db);
        const caller = await authenticatedDocumentCaller(db);
        const listed = await executeDocumentList(db, caller, {
          threadId: fixture.threadId,
          source: 'mail_attachment',
          kind: 'tax_invoice',
          requestedPriceVisibility: 'allowed',
        });
        const documentRef = listed.result.data?.documents?.[0]?.documentRef;
        expect(documentRef).toMatch(/^doc:/);
        const read = await executeDocumentRead(db, caller, {
          threadId: fixture.threadId,
          documentRef: documentRef!,
          format: 'artifact',
        });
        expect(read.result.status).toBe('manual_required');
        expect(read.result.data?.artifactRef ?? null).toBeNull();
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
        const runs = await db
          .select({ id: aiWorkflowRun.id })
          .from(aiWorkflowRun)
          .where(eq(aiWorkflowRun.threadId, fixture.threadId));
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
          const runs = await db
            .select({ id: aiWorkflowRun.id })
            .from(aiWorkflowRun)
            .where(eq(aiWorkflowRun.threadId, fixture.threadId));
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
        await addDocumentMessageWithAttachment(db, {
          threadId: fixture.threadId,
          messageId: `u9-sent-only-message-${randomUUID()}`,
          attachmentId: `u9-sent-only-attachment-${randomUUID()}`,
          direction: 'outbound',
          observedAt: new Date(OBSERVED_AT.getTime() - 30 * 60 * 1000),
          filename: 'sent-tax-invoice-v1.txt',
          textBody: `Sent tax invoice. Property ${SYNTHETIC_PROPERTY}. Guest ${SYNTHETIC_GUEST}.`,
          bytes: DOCUMENT_BYTES,
        });
        const caller = (await authenticatedCaller(db)) as unknown as {
          ai: ExistingDocumentCaller;
        };
        let storageReads = 0;
        const storage = getS3Storage();
        const originalGetObjectBounded = storage.getObjectBounded.bind(storage);
        storage.getObjectBounded = async (key, maxBytes, signal) => {
          storageReads += 1;
          return originalGetObjectBounded(key, maxBytes, signal);
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
        expect(storageReads).toBe(0);
      }),
    );
  }, 30000);

  it('hashes only the requested page before list I/O and preserves continuation', async () => {
    await withReadOnlyWorkerEnv(() =>
      withSeededTestDb(async (db) => {
        __setDbForTests({ db, conn: null as never });
        const fixture = await seedDocumentMailbox(db);
        for (let index = 0; index < 51; index += 1) {
          await addDocumentMessageWithAttachment(db, {
            threadId: fixture.threadId,
            messageId: `u9-large-message-${index}-${randomUUID()}`,
            attachmentId: `u9-large-attachment-${index}-${randomUUID()}`,
            direction: 'inbound',
            observedAt: new Date(OBSERVED_AT.getTime() - (index + 1) * 60 * 1000),
            filename: `large-tax-invoice-${index}.txt`,
            textBody: `Large thread document ${index}.`,
            bytes: DOCUMENT_BYTES,
          });
        }
        const storage = getS3Storage();
        let storageReads = 0;
        const originalGetObjectBounded = storage.getObjectBounded.bind(storage);
        storage.getObjectBounded = async (key, maxBytes, signal) => {
          storageReads += 1;
          return originalGetObjectBounded(key, maxBytes, signal);
        };
        const observed = observeDocumentQueries(db);
        const caller = await authenticatedDocumentCaller(db);
        const listed = await executeDocumentList(db, caller, {
          threadId: fixture.threadId,
          source: 'mail_attachment',
          limit: 1,
        });
        expect(listed.result.status).toBe('ok');
        expect(listed.result.data?.documents).toHaveLength(1);
        expect(listed.result.data?.page.hasMore).toBe(true);
        expect(listed.result.data?.page.nextCursor).toMatch(/^doc:/);
        expect(storageReads).toBe(1);

        storageReads = 0;
        const nextCaller = await authenticatedDocumentCaller(db);
        const nextPage = await executeDocumentList(db, nextCaller, {
          threadId: fixture.threadId,
          source: 'mail_attachment',
          limit: 1,
          cursor: listed.result.data?.page.nextCursor!,
        });
        expect(nextPage.result.status).toBe('ok');
        expect(nextPage.result.data?.documents).toHaveLength(1);
        expect(nextPage.result.data?.documents?.[0]?.documentRef).not.toBe(
          listed.result.data?.documents?.[0]?.documentRef,
        );
        expect(nextPage.result.data?.page.hasMore).toBe(true);
        // Resolving a cursor whose opaque ref contains the prior content hash
        // must hash the cursor row once, then the next returned row once.
        expect(storageReads).toBe(2);

        const firstDocumentRef = listed.result.data?.documents?.[0]?.documentRef;
        expect(firstDocumentRef).toMatch(/^doc:/);
        const queriesBeforeRead = observed.queries.length;
        const readCaller = await authenticatedDocumentCaller(db);
        const read = await executeDocumentRead(db, readCaller, {
          threadId: fixture.threadId,
          documentRef: firstDocumentRef!,
          format: 'text',
        });
        expect(read.result.status).toBe('manual_required');
        expect(read.result.data?.document?.documentRef).toBe(firstDocumentRef);
        expect(read.result.data?.text).toBe(DOCUMENT_BYTES.toString('utf8').trim());

        // The worker source query is distinguished from issuer/ref checks by
        // its causal outbound timestamp and deterministic attachment fields.
        // This keeps the regression non-vacuous: a generic attachment query
        // with a limit cannot satisfy the normal list-path proof.
        const workerSourceQueries = observed.queries.filter(
          (query) =>
            query.limit !== null &&
            query.limit >= 2 &&
            /from "attachment"/i.test(query.sql) &&
            /"attachment"\."s3_key"/i.test(query.sql) &&
            /"message"\."sent_at"/i.test(query.sql) &&
            /"message"\."created_at"/i.test(query.sql),
        );
        expect(workerSourceQueries.length).toBeGreaterThanOrEqual(2);
        for (const query of workerSourceQueries) {
          expect(query.orderBy).toBe(true);
          expect(query.sql).toMatch(/order by/i);
          expect(query.sql).not.toMatch(/text_body|html_body|subject/i);
        }
        const readAttachmentQueries = observed.queries
          .slice(queriesBeforeRead)
          .filter(
            (query) =>
              query.limit === 51 &&
              /from "attachment"/i.test(query.sql) &&
              /"attachment"\."s3_key"/i.test(query.sql),
          );
        expect(readAttachmentQueries.length).toBeGreaterThanOrEqual(2);
        for (const query of readAttachmentQueries) {
          expect(query.orderBy).toBe(true);
          expect(query.sql).toMatch(/order by/i);
          expect(query.sql).not.toMatch(/text_body|html_body|subject/i);
        }

        const capCaller = await authenticatedDocumentCaller(db);
        const capPage = await executeDocumentList(db, capCaller, {
          threadId: fixture.threadId,
          source: 'mail_attachment',
          limit: 50,
        });
        expect(capPage.result.status).toBe('ok');
        expect(capPage.result.data?.documents).toHaveLength(50);
        expect(capPage.result.data?.page.hasMore).toBe(true);
        const boundaryRef = capPage.result.data?.page.nextCursor;
        expect(boundaryRef).toMatch(/^doc:/);

        const boundaryReadCaller = await authenticatedDocumentCaller(db);
        const boundaryRead = await executeDocumentRead(db, boundaryReadCaller, {
          threadId: fixture.threadId,
          documentRef: boundaryRef!,
          format: 'text',
        });
        expect(boundaryRead.result.status).toBe('manual_required');
        expect(boundaryRead.result.data?.document?.documentRef).toBe(boundaryRef);
        expect(boundaryRead.result.data?.text).toBe(DOCUMENT_BYTES.toString('utf8').trim());

        const capNextCaller = await authenticatedDocumentCaller(db);
        const capNextPage = await executeDocumentList(db, capNextCaller, {
          threadId: fixture.threadId,
          source: 'mail_attachment',
          limit: 50,
          cursor: boundaryRef!,
        });
        expect(capNextPage.result.status).toBe('partial');
        expect(capNextPage.result.data?.documents ?? []).toHaveLength(0);
        expect(capNextPage.result.data?.page.hasMore).toBe(false);
        expect(capNextPage.result.data?.page.nextCursor).toBeNull();
        expect(capNextPage.result.data?.sourceOutcomes?.[0]).toMatchObject({
          status: 'partial',
          issues: [{ code: 'LIST_ROW_LIMIT' }],
        });
        observed.restore();
      }),
    );
  }, 30000);

  it('returns an explicit unresolved cursor outcome for a valid-shaped missing page ref', async () => {
    await withReadOnlyWorkerEnv(() =>
      withSeededTestDb(async (db) => {
        __setDbForTests({ db, conn: null as never });
        const fixture = await seedDocumentMailbox(db);
        const caller = await authenticatedDocumentCaller(db);
        const unresolved = await executeDocumentList(db, caller, {
          threadId: fixture.threadId,
          source: 'mail_attachment',
          limit: 1,
          cursor: `doc:${'a'.repeat(64)}:${'b'.repeat(64)}`,
        });
        expect(unresolved.result.status).toBe('partial');
        expect(unresolved.result.data?.sourceOutcomes?.[0]).toMatchObject({
          status: 'partial',
          issues: [{ code: 'LIST_CURSOR_UNRESOLVED' }],
        });
        expect(unresolved.result.issues?.[0]?.code).toBe('SOURCE_UNAVAILABLE');
        expect(unresolved.result.data?.documents ?? []).toHaveLength(0);
        expect(unresolved.result.data?.page.hasMore).toBe(false);
      }),
    );
  }, 30000);
});

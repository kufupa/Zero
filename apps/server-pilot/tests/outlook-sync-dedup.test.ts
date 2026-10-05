import { withIngestionDb } from './helpers/ingestion-db.js';
import { describe, expect, it } from 'vitest';

const data = () => ({
  direction: 'inbound' as const,
  internetMessageId: 'same@example.test',
  fromAddress: 'Guest <guest@example.test>',
  toAddresses: ['hotel@example.test'],
  ccAddresses: [],
  authoredAt: new Date('2026-10-04T10:00:00Z'),
  textBody: 'A real reservation request.',
  htmlBody: null,
  attachments: [{ sizeBytes: 3, sha256: 'a'.repeat(64) }],
});

describe('conservative shared canonical identity', () => {
  it('requires independently corroborated identity, never template content alone', async () => {
    const { compatibleCanonicalEvidence } = await import(
      '../src/mail/ingest/canonical-identity.js'
    );
    expect(compatibleCanonicalEvidence(data(), data())).toBe(true);
    expect(compatibleCanonicalEvidence(data(), { ...data(), internetMessageId: null })).toBe(false);
    expect(
      compatibleCanonicalEvidence(data(), { ...data(), internetMessageId: 'another@example.test' }),
    ).toBe(false);
    expect(compatibleCanonicalEvidence(data(), { ...data(), direction: 'outbound' })).toBe(false);
    expect(
      compatibleCanonicalEvidence(data(), { ...data(), fromAddress: 'other@example.test' }),
    ).toBe(false);
    expect(compatibleCanonicalEvidence(data(), { ...data(), authoredAt: null })).toBe(false);
    expect(compatibleCanonicalEvidence(data(), { ...data(), textBody: 'Different request' })).toBe(
      false,
    );
    expect(
      compatibleCanonicalEvidence(data(), {
        ...data(),
        attachments: [{ sizeBytes: 3, sha256: 'b'.repeat(64) }],
      }),
    ).toBe(false);
  });
  it('permits retained richer attachments when independent body and identity corroborate', async () => {
    const { compatibleCanonicalEvidence } = await import(
      '../src/mail/ingest/canonical-identity.js'
    );
    expect(compatibleCanonicalEvidence(data(), { ...data(), attachments: [] })).toBe(true);
    expect(compatibleCanonicalEvidence(data(), { ...data(), textBody: null, htmlBody: null })).toBe(
      false,
    );
  });
  it('uses the same real mailbox lock and reports ambiguous reused IDs', async () =>
    withIngestionDb(async ({ db }) => {
      const { persistOutlookHistory } = await import('../src/mail/ingest/outlook-history.js');
      const { findCanonicalCandidate, lockCanonicalMailbox } = await import(
        '../src/mail/ingest/canonical-identity.js'
      );
      const input = {
        transportId: 'transport-centurion',
        sourceObservationId: 'one',
        semanticVersion: 'v1',
        ...data(),
        subject: 'Request',
        inReplyTo: null,
        references: [],
        bccAddresses: [],
        sentAt: null,
        originalMsgKey: 'outlook-sync-originals/v1/source/one.msg',
        attachments: [],
        sourceProvenance: { read: false },
      };
      const first = await persistOutlookHistory(db, input);
      const twin = await persistOutlookHistory(db, { ...input, sourceObservationId: 'another-pc' });
      expect(twin.messageId).toBe(first.messageId);
      expect(twin.linked).toBe(true);
      await db.transaction(async (tx) => {
        await lockCanonicalMailbox(tx as typeof db, input.transportId);
        expect(
          await findCanonicalCandidate(tx as typeof db, input.transportId, data()),
        ).toMatchObject({ kind: 'unique', message: { id: first.messageId } });
      });
    }));
});

it('POP3 and native twins use one mailbox resolver while retaining independent originals', async () =>
  withIngestionDb(async ({ db }) => {
    const { persistOutlookHistory } = await import('../src/mail/ingest/outlook-history.js');
    const { persistInboundMessage } = await import('../src/mail/ingest/store.js');
    const { FakeS3Storage } = await import('../src/storage/s3.js');
    const { message, attachment } = await import('../src/db/schema/mail.js');
    const native = await persistOutlookHistory(db, {
      transportId: 'transport-centurion',
      sourceObservationId: 'native-first',
      semanticVersion: 'v1',
      ...data(),
      attachments: [],
      subject: 'Request',
      inReplyTo: null,
      references: [],
      bccAddresses: [],
      sentAt: null,
      originalMsgKey: 'outlook-sync-originals/v1/source/first.msg',
      sourceProvenance: {},
    });
    const result = await persistInboundMessage(
      {
        ownerHeaderValue: 'centurion@legacyhotels.co.za',
        outboundCorrelation: { kind: 'absent' },
        messageId: 'same@example.test',
        inReplyTo: null,
        references: [],
        fromAddress: 'Guest <guest@example.test>',
        toAddresses: ['hotel@example.test'],
        ccAddresses: [],
        bccAddresses: [],
        subject: 'Request',
        textBody: data().textBody,
        htmlBody: null,
        receivedAt: data().authoredAt,
        attachments: [],
        rawHeaderLines: [],
      },
      Buffer.from('raw'),
      { ingestMailboxId: 'ingest-nava-legacy', pop3Uidl: 'pop3-twin', messageId: 'candidate-twin' },
      { db, storage: new FakeS3Storage(), skipAiEnqueue: true },
    );
    expect('messageId' in result && result.messageId).toBe(native.messageId);
    expect(await db.select().from(message)).toHaveLength(1);
    expect(await db.select().from(attachment)).toHaveLength(0);
  }));

it('attachment corroboration compares checksum multiplicity', async () => {
  const { compatibleCanonicalEvidence } = await import('../src/mail/ingest/canonical-identity.js');
  const a = { sizeBytes: 3, sha256: 'a'.repeat(64) },
    b = { sizeBytes: 3, sha256: 'b'.repeat(64) };
  expect(
    compatibleCanonicalEvidence(
      { ...data(), attachments: [a, a] },
      { ...data(), attachments: [a, b] },
    ),
  ).toBe(false);
});

it('display attachment identity preserves richer variants and source multiplicity', async () => {
  const { newCanonicalAttachments } = await import('../src/mail/ingest/canonical-identity.js');
  const item = {
    filename: 'image.png',
    mimeType: 'image/png',
    sizeBytes: 3,
    sha256: 'a'.repeat(64),
    s3Key: 'first',
    contentId: 'one',
    isInline: true,
  };
  const twin = { ...item, s3Key: 'second' };
  expect(newCanonicalAttachments([item], [twin])).toEqual([]);
  expect(newCanonicalAttachments([item], [twin, { ...twin, s3Key: 'third' }])).toHaveLength(1);
  expect(newCanonicalAttachments([item], [{ ...twin, contentId: 'two' }])).toHaveLength(1);
  expect(newCanonicalAttachments([item], [{ ...twin, filename: 'other.png' }])).toHaveLength(1);
  expect(newCanonicalAttachments([item], [{ ...twin, sha256: null }])).toHaveLength(1);
});

it(
  'independent POP3 receipts survive reconciliation and each repeated UIDL is idempotent',
  async () =>
    withIngestionDb(async ({ db }) => {
      const { persistOutlookHistory } = await import('../src/mail/ingest/outlook-history.js');
      const { persistInboundMessage } = await import('../src/mail/ingest/store.js');
      const { FakeS3Storage } = await import('../src/storage/s3.js');
      const schema = await import('../src/db/schema/mail.js');
      await persistOutlookHistory(db, {
        transportId: 'transport-centurion',
        sourceId: 'source-one',
        sourceObservationId: 'native',
        semanticVersion: '1',
        ...data(),
        attachments: [],
        subject: 'Request',
        inReplyTo: null,
        references: [],
        bccAddresses: [],
        sentAt: null,
        originalMsgKey: 'outlook-sync-originals/v1/source/native.msg',
        sourceProvenance: {},
      });
      const parsed = {
        ownerHeaderValue: 'centurion@legacyhotels.co.za',
        outboundCorrelation: { kind: 'absent' as const },
        messageId: data().internetMessageId,
        inReplyTo: null,
        references: [],
        fromAddress: data().fromAddress,
        toAddresses: data().toAddresses,
        ccAddresses: [],
        bccAddresses: [],
        subject: 'Request',
        textBody: data().textBody,
        htmlBody: null,
        receivedAt: data().authoredAt,
        attachments: [],
        rawHeaderLines: [],
      };
      const binary = {
        filename: 'request.pdf',
        mimeType: 'application/pdf',
        sizeBytes: 3,
        sha256: 'a'.repeat(64),
        contentId: null,
        isInline: false,
      };
      const store = (uidl: string) =>
        persistInboundMessage(
          {
            ...parsed,
            attachments: [0, 1].map((index) => ({
              ...binary,
              s3Key: `attachments/candidate-${uidl}/${index}.pdf`,
            })),
          },
          Buffer.from(`raw ${uidl}`),
          { ingestMailboxId: 'ingest-nava-legacy', pop3Uidl: uidl, messageId: `candidate-${uidl}` },
          { db, storage: new FakeS3Storage(), skipAiEnqueue: true },
        );
      await store('one');
      await store('two');
      expect((await store('two')).kind).toBe('duplicate');
      expect(await db.select().from(schema.mailIngestSourceReceipt)).toHaveLength(2);
      expect(await db.select().from(schema.message)).toHaveLength(1);
      // Two identical attachments in one source remain two; a second delivery adds no UI copies.
      expect(await db.select().from(schema.attachment)).toHaveLength(2);
      const [canonical] = await db.select().from(schema.message);
      await persistOutlookHistory(db, {
        transportId: 'transport-centurion',
        sourceId: 'source-two',
        sourceObservationId: 'native-twin',
        semanticVersion: '1',
        ...data(),
        subject: 'Request',
        inReplyTo: null,
        references: [],
        bccAddresses: [],
        sentAt: null,
        originalMsgKey: 'outlook-sync-originals/v1/source/native-twin.msg',
        sourceProvenance: {},
        attachments: [0, 1].map((index) => ({
          ...binary,
          sourceAttachmentId: `native-${index}`,
          s3Key: `outlook-sync-originals/v1/source/native-twin/${index}.pdf`,
        })),
      });
      expect(await db.select().from(schema.attachment)).toHaveLength(2);
      expect((await db.select().from(schema.message))[0]?.id).toBe(canonical.id);
    }),
  20_000,
);

it(
  'a verified POP3 source with ambiguous reused IDs remains separate without automatic admission',
  async () =>
    withIngestionDb(async ({ db }) => {
      const { persistOutlookHistory } = await import('../src/mail/ingest/outlook-history.js');
      const { persistInboundMessage } = await import('../src/mail/ingest/store.js');
      const { FakeS3Storage } = await import('../src/storage/s3.js');
      const { message, mailThread, aiWorkflowRun } = await import('../src/db/schema/mail.js');
      const { randomUUID } = await import('node:crypto');
      await persistOutlookHistory(db, {
        transportId: 'transport-centurion',
        sourceId: 'one',
        sourceObservationId: 'reused',
        semanticVersion: 'v1',
        ...data(),
        attachments: [],
        subject: 'Request',
        inReplyTo: null,
        references: [],
        bccAddresses: [],
        sentAt: null,
        originalMsgKey: 'outlook-sync-originals/v1/source/reused.msg',
        sourceProvenance: {},
      });
      const [first] = await db.select().from(message);
      const threadId = randomUUID();
      await db.insert(mailThread).values({
        id: threadId,
        transportId: 'transport-centurion',
        threadRootId: 'other',
        historyOnly: true,
      });
      await db.insert(message).values({
        ...first!,
        id: randomUUID(),
        threadId,
        originalMsgS3Key: 'outlook-sync-originals/v1/source/other.msg',
      });
      await persistInboundMessage(
        {
          ownerHeaderValue: 'centurion@legacyhotels.co.za',
          outboundCorrelation: { kind: 'absent' },
          messageId: data().internetMessageId,
          inReplyTo: null,
          references: [],
          fromAddress: data().fromAddress,
          toAddresses: data().toAddresses,
          ccAddresses: [],
          bccAddresses: [],
          subject: 'Request',
          textBody: data().textBody,
          htmlBody: null,
          receivedAt: data().authoredAt,
          attachments: [],
          rawHeaderLines: [],
        },
        Buffer.from('raw'),
        {
          ingestMailboxId: 'ingest-nava-legacy',
          pop3Uidl: 'ambiguous-source',
          messageId: randomUUID(),
        },
        { db, storage: new FakeS3Storage(), ingestSource: 'live-pop3' },
      );
      expect(await db.select().from(message)).toHaveLength(3);
      expect(await db.select().from(aiWorkflowRun)).toHaveLength(0);
    }),
  30_000,
);

it(
  'retrying an ambiguous historical observation preserves attention without converting it to unique',
  async () =>
    withIngestionDb(async ({ db }) => {
      const { persistOutlookHistory } = await import('../src/mail/ingest/outlook-history.js');
      const { message, mailThread } = await import('../src/db/schema/mail.js');
      const { randomUUID } = await import('node:crypto');
      const input = {
        transportId: 'transport-centurion',
        sourceId: 'one',
        sourceObservationId: 'reused-retry',
        semanticVersion: 'v1',
        ...data(),
        attachments: [],
        subject: 'Request',
        inReplyTo: null,
        references: [],
        bccAddresses: [],
        sentAt: null,
        originalMsgKey: 'outlook-sync-originals/v1/source/reused.msg',
        sourceProvenance: {},
      };
      await persistOutlookHistory(db, input);
      const [first] = await db.select().from(message);
      const threadId = randomUUID();
      await db.insert(mailThread).values({
        id: threadId,
        transportId: 'transport-centurion',
        threadRootId: 'other',
        historyOnly: true,
      });
      await db.insert(message).values({ ...first!, id: randomUUID(), threadId });
      const ambiguous = { ...input, sourceObservationId: 'third' };
      expect((await persistOutlookHistory(db, ambiguous)).attention).toBe(true);
      expect((await persistOutlookHistory(db, ambiguous)).attention).toBe(true);
    }),
  30_000,
);

it('malformed source Message-IDs cannot corroborate canonical identity', async () => {
  const { compatibleCanonicalEvidence } = await import('../src/mail/ingest/canonical-identity.js');
  for (const id of ['template', 'same id@example.test', '<broken@example.test', 'x@@example.test'])
    expect(
      compatibleCanonicalEvidence(
        { ...data(), internetMessageId: id },
        { ...data(), internetMessageId: id },
      ),
    ).toBe(false);
});

it(
  'outbound twins corroborate the authored SentOn clock rather than provider receipt time',
  async () =>
    withIngestionDb(async ({ db }) => {
      const { persistOutlookHistory } = await import('../src/mail/ingest/outlook-history.js');
      const { message } = await import('../src/db/schema/mail.js');
      const { eq } = await import('drizzle-orm');
      const sentAt = data().authoredAt;
      const input = {
        ...data(),
        direction: 'outbound' as const,
        transportId: 'transport-centurion',
        sourceId: 'source-one',
        sourceObservationId: 'sent-one',
        semanticVersion: '1',
        subject: 'Reply',
        inReplyTo: null,
        references: [],
        bccAddresses: [],
        authoredAt: sentAt,
        sentAt,
        originalMsgKey: 'outlook-sync-originals/v1/source/sent-one.msg',
        attachments: [],
        sourceProvenance: {},
      };
      const first = await persistOutlookHistory(db, input);
      await db
        .update(message)
        .set({ receivedAt: new Date('2026-10-04T12:00:00Z') })
        .where(eq(message.id, first.messageId));
      const twin = await persistOutlookHistory(db, {
        ...input,
        sourceObservationId: 'sent-two',
        originalMsgKey: 'outlook-sync-originals/v1/source/sent-two.msg',
      });
      expect(twin).toMatchObject({ linked: true, messageId: first.messageId });
      expect(await db.select().from(message)).toHaveLength(1);
    }),
  20_000,
);

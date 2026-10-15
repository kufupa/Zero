import {
  aiWorkflowRun,
  mailCategory,
  mailThread,
  mailThreadCategory,
  message,
} from '../src/db/schema/mail.js';
import { aiShadowAdmission } from '../src/db/schema/ai-shadow-evaluation.js';
import { workItem } from '../src/db/schema/work.js';
import { withIngestionDb } from './helpers/ingestion-db.js';
import type { DB } from '../src/db/client.js';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
// Each integration case creates/migrates a fresh database and compiles the worker.
import { eq } from 'drizzle-orm';

async function recordDeterministicChannelRoute(
  db: DB,
  input: { threadId: string; triggerMessageId: string },
): Promise<string> {
  const [run] = await db
    .select()
    .from(aiWorkflowRun)
    .where(eq(aiWorkflowRun.triggerMessageId, input.triggerMessageId))
    .limit(1);
  if (!run || run.runKind !== 'inbound_triage') {
    throw new Error('Expected inbound_triage run for deterministic channel route');
  }

  const categoryId = `test-automated-channel-${input.triggerMessageId}`;
  const finishedAt = new Date();
  await db.insert(mailCategory).values({
    id: categoryId,
    transportId: 'transport-centurion',
    slug: 'automated-channel',
    name: 'Automated / Channel',
    color: '#475569',
    sortOrder: 200,
  });
  await db.insert(mailThreadCategory).values({
    threadId: input.threadId,
    categoryId,
    transportId: 'transport-centurion',
    createdAt: new Date(finishedAt.getTime() - 1_000),
  });
  await db
    .update(aiWorkflowRun)
    .set({
      state: 'succeeded',
      finishedAt,
      metrics: {
        ...(run.metrics ?? {}),
        deterministicMailSourceRoute: true,
        applyMode: 'full',
      },
    })
    .where(eq(aiWorkflowRun.id, run.id));
  return categoryId;
}

const history = (id: string, at = '2026-10-04T10:00:00Z') => ({
  transportId: 'transport-centurion',
  sourceId: 'source-one',
  sourceObservationId: id,
  semanticVersion: '1',
  direction: 'inbound' as const,
  internetMessageId: `${id}@example.test`,
  fromAddress: 'guest@example.test',
  toAddresses: ['centurion@legacyhotels.co.za'],
  ccAddresses: [],
  bccAddresses: [],
  authoredAt: new Date(at),
  sentAt: null,
  textBody: `Body ${id}`,
  htmlBody: null,
  subject: 'Request',
  inReplyTo: null as string | null,
  references: [] as string[],
  originalMsgKey: `outlook-sync-originals/v1/source/${id}`,
  attachments: [],
  sourceProvenance: {},
});

describe('live-admission Azure Luna labels', () => {
  it('enqueues inbound triage as Azure Luna, not Nova Lite', () => {
    const source = readFileSync(
      new URL('../src/mail/ingest/live-admission.ts', import.meta.url),
      'utf8',
    );
    expect(source).toMatch(/modelId: 'gpt-6-luna'/);
    expect(source).toMatch(/routeId: 'azure_luna_max'/);
    expect(source).toMatch(/protocol: 'azure-foundry-responses'/);
    expect(source).not.toMatch(/modelId: DEFAULT_AI_MODEL_ID/);
  });
});

describe('first live admission and immutable inputs on PostgreSQL', () => {
  it(
    'queues triage only for channel mail when the regular classifier is retired',
    async () => {
      const previous = {
        classifier: process.env.INBOUND_TRIAGE_CLASSIFIER,
        extraction: process.env.INBOUND_EXTRACTION,
      };
      process.env.INBOUND_TRIAGE_CLASSIFIER = 'off';
      process.env.INBOUND_EXTRACTION = 'on';
      try {
        await withIngestionDb(async ({ db }) => {
          const { persistOutlookHistory } = await import('../src/mail/ingest/outlook-history.js');
          const { admitLiveMessage } = await import('../src/mail/ingest/live-admission.js');
          const saved = await persistOutlookHistory(db, {
            ...history('expedia-live-source'),
            fromAddress: 'notifications@m.expediapartnercentral.com',
            subject: 'Expedia Partner Central - New reservation',
          });

          await db.transaction((tx) =>
            admitLiveMessage(tx as typeof db, {
              transportId: 'transport-centurion',
              canonicalMessageId: saved.messageId,
              evidence: { kind: 'verified-pop3', sourceReceiptId: 'uidl-expedia-source' },
            }),
          );

          const runs = await db
            .select()
            .from(aiWorkflowRun)
            .where(eq(aiWorkflowRun.triggerMessageId, saved.messageId));
          expect(runs.map((run) => run.runKind)).toEqual(['inbound_triage']);
          expect(runs[0]?.metrics).toMatchObject({
            mailSourceDecision: {
              kind: 'channel',
              source: 'Expedia Partner Central',
              reason: 'sender_domain:m.expediapartnercentral.com',
            },
          });
          expect(await db.select().from(aiShadowAdmission)).toHaveLength(0);
          expect(await db.select().from(workItem)).toHaveLength(0);
        });
      } finally {
        if (previous.classifier === undefined) delete process.env.INBOUND_TRIAGE_CLASSIFIER;
        else process.env.INBOUND_TRIAGE_CLASSIFIER = previous.classifier;
        if (previous.extraction === undefined) delete process.env.INBOUND_EXTRACTION;
        else process.env.INBOUND_EXTRACTION = previous.extraction;
      }
    },
    20_000,
  );

  it.each(['admitLiveMessage', 'persistInboundMessage'] as const)(
    'removes only route-owned automated-channel for a direct reply via %s and queues extraction',
    async (admissionPath) => {
      const previous = {
        classifier: process.env.INBOUND_TRIAGE_CLASSIFIER,
        extraction: process.env.INBOUND_EXTRACTION,
        writeGate: process.env.AI_WRITE_GATE_ENABLED,
      };
      process.env.INBOUND_TRIAGE_CLASSIFIER = 'off';
      process.env.INBOUND_EXTRACTION = 'on';
      process.env.AI_WRITE_GATE_ENABLED = 'true';
      try {
        await withIngestionDb(async ({ db }) => {
          const { persistOutlookHistory } = await import('../src/mail/ingest/outlook-history.js');
          const { admitLiveMessage } = await import('../src/mail/ingest/live-admission.js');
          const channelMessageId = `channel-${admissionPath}@example.test`;
          const channel = await persistOutlookHistory(db, {
            ...history(`channel-${admissionPath}`),
            internetMessageId: channelMessageId,
            fromAddress: 'noreply@synxis.com',
            subject: 'SynXis reservation update',
            textBody: 'Channel confirmation',
          });
          await db.transaction((tx) =>
            admitLiveMessage(tx as typeof db, {
              transportId: 'transport-centurion',
              canonicalMessageId: channel.messageId,
              evidence: { kind: 'verified-pop3', sourceReceiptId: `uidl-${admissionPath}-channel` },
            }),
          );
          const routeCategoryId = await recordDeterministicChannelRoute(db, {
            threadId: channel.threadId,
            triggerMessageId: channel.messageId,
          });

          const staffCategoryId = `test-staff-folder-${admissionPath}`;
          await db.insert(mailCategory).values({
            id: staffCategoryId,
            transportId: 'transport-centurion',
            slug: `staff-folder-${admissionPath}`,
            name: 'Staff folder',
            color: null,
            sortOrder: 900,
          });
          await db.insert(mailThreadCategory).values({
            threadId: channel.threadId,
            categoryId: staffCategoryId,
            transportId: 'transport-centurion',
          });
          const spamUserLockedAt = new Date('2026-10-01T12:00:00Z');
          await db
            .update(mailThread)
            .set({ spamUserLockedAt })
            .where(eq(mailThread.id, channel.threadId));

          let replyMessageId: string;
          let replyThreadId: string;
          if (admissionPath === 'admitLiveMessage') {
            const reply = await persistOutlookHistory(db, {
              ...history('direct-reply-live-admission'),
              inReplyTo: channelMessageId,
              references: [channelMessageId],
            });
            await db.transaction((tx) =>
              admitLiveMessage(tx as typeof db, {
                transportId: 'transport-centurion',
                canonicalMessageId: reply.messageId,
                evidence: { kind: 'verified-pop3', sourceReceiptId: 'uidl-direct-live-reply' },
              }),
            );
            replyMessageId = reply.messageId;
            replyThreadId = reply.threadId;
          } else {
            const { persistInboundMessage } = await import('../src/mail/ingest/store.js');
            const { FakeS3Storage } = await import('../src/storage/s3.js');
            const replyId = 'store-direct-reply';
            const reply = await persistInboundMessage(
              {
                ownerHeaderValue: 'centurion@legacyhotels.co.za',
                outboundCorrelation: { kind: 'absent' },
                messageId: `${replyId}@example.test`,
                inReplyTo: channelMessageId,
                references: [channelMessageId],
                fromAddress: 'guest@example.test',
                toAddresses: ['centurion@legacyhotels.co.za'],
                ccAddresses: [],
                bccAddresses: [],
                subject: 'Re: Guest amendment',
                textBody: 'Please amend my stay.',
                htmlBody: null,
                receivedAt: new Date(),
                attachments: [],
                rawHeaderLines: [],
              },
              Buffer.from('raw'),
              {
                ingestMailboxId: 'ingest-nava-legacy',
                pop3Uidl: 'uidl-store-direct-reply',
                messageId: replyId,
              },
              { db, storage: new FakeS3Storage() },
            );
            expect(reply.kind).toBe('stored');
            if (reply.kind !== 'stored') return;
            replyMessageId = reply.messageId;
            replyThreadId = reply.threadId;
          }

          expect(replyThreadId).toBe(channel.threadId);
          const categories = await db
            .select({ slug: mailCategory.slug })
            .from(mailThreadCategory)
            .innerJoin(mailCategory, eq(mailCategory.id, mailThreadCategory.categoryId))
            .where(eq(mailThreadCategory.threadId, channel.threadId));
          expect(categories.map((category) => category.slug)).not.toContain('automated-channel');
          expect(categories.map((category) => category.slug)).toContain(
            `staff-folder-${admissionPath}`,
          );
          const [thread] = await db
            .select({ spamUserLockedAt: mailThread.spamUserLockedAt })
            .from(mailThread)
            .where(eq(mailThread.id, channel.threadId));
          expect(thread?.spamUserLockedAt).toEqual(spamUserLockedAt);

          const replyRuns = await db
            .select({ runKind: aiWorkflowRun.runKind, state: aiWorkflowRun.state })
            .from(aiWorkflowRun)
            .where(eq(aiWorkflowRun.triggerMessageId, replyMessageId));
          expect(replyRuns).toContainEqual({ runKind: 'inbound_extraction', state: 'queued' });
          expect(routeCategoryId).toBeTruthy();
        });
      } finally {
        if (previous.classifier === undefined) delete process.env.INBOUND_TRIAGE_CLASSIFIER;
        else process.env.INBOUND_TRIAGE_CLASSIFIER = previous.classifier;
        if (previous.extraction === undefined) delete process.env.INBOUND_EXTRACTION;
        else process.env.INBOUND_EXTRACTION = previous.extraction;
        if (previous.writeGate === undefined) delete process.env.AI_WRITE_GATE_ENABLED;
        else process.env.AI_WRITE_GATE_ENABLED = previous.writeGate;
      }
    },
    20_000,
  );

  it(
    'preserves automated-channel when staff re-applies it after the deterministic route',
    async () => {
      const previous = process.env.INBOUND_TRIAGE_CLASSIFIER;
      process.env.INBOUND_TRIAGE_CLASSIFIER = 'off';
      try {
        await withIngestionDb(async ({ db }) => {
          const { persistOutlookHistory } = await import('../src/mail/ingest/outlook-history.js');
          const { admitLiveMessage } = await import('../src/mail/ingest/live-admission.js');
          const channelMessageId = 'channel-manual-reapply@example.test';
          const channel = await persistOutlookHistory(db, {
            ...history('channel-manual-reapply'),
            internetMessageId: channelMessageId,
            fromAddress: 'noreply@synxis.com',
          });
          await db.transaction((tx) =>
            admitLiveMessage(tx as typeof db, {
              transportId: 'transport-centurion',
              canonicalMessageId: channel.messageId,
              evidence: { kind: 'verified-pop3', sourceReceiptId: 'uidl-manual-route-channel' },
            }),
          );
          const categoryId = await recordDeterministicChannelRoute(db, {
            threadId: channel.threadId,
            triggerMessageId: channel.messageId,
          });
          const [route] = await db
            .select({ finishedAt: aiWorkflowRun.finishedAt })
            .from(aiWorkflowRun)
            .where(eq(aiWorkflowRun.triggerMessageId, channel.messageId))
            .limit(1);
          if (!route?.finishedAt) throw new Error('Expected completed deterministic channel route');
          await db
            .update(mailThreadCategory)
            .set({ createdAt: new Date(route.finishedAt.getTime() + 1_000) })
            .where(eq(mailThreadCategory.categoryId, categoryId));

          const reply = await persistOutlookHistory(db, {
            ...history('manual-reapply-reply'),
            inReplyTo: channelMessageId,
            references: [channelMessageId],
          });
          await db.transaction((tx) =>
            admitLiveMessage(tx as typeof db, {
              transportId: 'transport-centurion',
              canonicalMessageId: reply.messageId,
              evidence: { kind: 'verified-pop3', sourceReceiptId: 'uidl-manual-route-reply' },
            }),
          );

          const [membership] = await db
            .select({ categoryId: mailThreadCategory.categoryId })
            .from(mailThreadCategory)
            .where(eq(mailThreadCategory.categoryId, categoryId));
          expect(membership).toBeDefined();
        });
      } finally {
        if (previous === undefined) delete process.env.INBOUND_TRIAGE_CLASSIFIER;
        else process.env.INBOUND_TRIAGE_CLASSIFIER = previous;
      }
    },
    20_000,
  );

  it(
    'admits a history-created message once and snapshots pre-admission richer context',
    async () =>
      withIngestionDb(async ({ db }) => {
        const { persistOutlookHistory } = await import('../src/mail/ingest/outlook-history.js');
        const { admitLiveMessage, readAdmissionSnapshot } = await import(
          '../src/mail/ingest/live-admission.js'
        );
        const trigger = await persistOutlookHistory(db, history('trigger'));
        const prior = await persistOutlookHistory(db, {
          ...history('prior', '2026-10-04T09:00:00Z'),
          inReplyTo: 'trigger@example.test',
        });
        const first = await db.transaction((tx) =>
          admitLiveMessage(tx as typeof db, {
            transportId: 'transport-centurion',
            canonicalMessageId: trigger.messageId,
            evidence: { kind: 'verified-pop3', sourceReceiptId: 'uidl-1' },
          }),
        );
        const repeat = await db.transaction((tx) =>
          admitLiveMessage(tx as typeof db, {
            transportId: 'transport-centurion',
            canonicalMessageId: trigger.messageId,
            evidence: { kind: 'verified-pop3', sourceReceiptId: 'uidl-1' },
          }),
        );
        expect(first.admitted).toBe(true);
        expect(repeat.admitted).toBe(false);
        expect(await db.select().from(aiWorkflowRun)).toHaveLength(1);
        await db
          .update(message)
          .set({ textBody: 'Late enrichment' })
          .where(eq(message.id, prior.messageId));
        await persistOutlookHistory(db, {
          ...history('later', '2026-10-04T09:30:00Z'),
          inReplyTo: 'trigger@example.test',
        });
        const snap = await readAdmissionSnapshot(db, first.receiptId);
        expect(snap.threadMessages.map((x) => x.id)).toContain(prior.messageId);
        expect(snap.threadMessages.find((x) => x.id === prior.messageId)?.textBody).toBe(
          'Body prior',
        );
        expect(snap.threadMessages.some((x) => x.textBody === 'Body later')).toBe(false);
        const [thread] = await db
          .select()
          .from(mailThread)
          .where(eq(mailThread.id, trigger.threadId));
        expect(thread).toMatchObject({ historyOnly: false, isRead: false });
      }),
    20_000,
  );
  it('rejects scan-only timestamps and old imports as fresh live authority', async () => {
    const { qualifiesNativeAdmission } = await import('../src/mail/ingest/live-admission.js');
    const cutover = new Date('2026-10-04T08:00:00Z');
    const evidence = {
      direction: 'inbound',
      receivedAt: '2026-10-04T10:00:00Z',
      event: { kind: 'inventory', observedAt: '2026-10-04T10:01:00Z', receivedAt: null },
    };
    expect(qualifiesNativeAdmission(cutover, evidence)).toBe(false);
    expect(
      qualifiesNativeAdmission(cutover, {
        ...evidence,
        event: { ...evidence.event, kind: 'folder-hint' },
      }),
    ).toBe(false);
    expect(
      qualifiesNativeAdmission(cutover, {
        ...evidence,
        event: { ...evidence.event, kind: 'new-mail', receivedAt: evidence.receivedAt },
      }),
    ).toBe(true);
    expect(
      qualifiesNativeAdmission(cutover, {
        ...evidence,
        receivedAt: '2026-09-01T00:00:00Z',
        event: { ...evidence.event, kind: 'new-mail', receivedAt: '2026-09-01T00:00:00Z' },
      }),
    ).toBe(false);
  });
  it('requires observed unsent to saved submission and resolved outbound direction', async () => {
    const { qualifiesNativeAdmission } = await import('../src/mail/ingest/live-admission.js');
    const cutover = new Date('2026-10-04T08:00:00Z');
    const evidence = {
      direction: 'outbound',
      sentAt: '2026-10-04T10:00:00Z',
      event: {
        kind: 'saved-sent',
        observedAt: '2026-10-04T10:01:00Z',
        wasUnsent: true,
        isUnsent: false,
        sentCopySaved: true,
      },
    };
    expect(qualifiesNativeAdmission(cutover, evidence)).toBe(true);
    expect(
      qualifiesNativeAdmission(cutover, {
        ...evidence,
        event: { ...evidence.event, isUnsent: true },
      }),
    ).toBe(false);
    expect(
      qualifiesNativeAdmission(cutover, {
        ...evidence,
        event: { ...evidence.event, wasUnsent: false },
      }),
    ).toBe(false);
    expect(qualifiesNativeAdmission(cutover, { ...evidence, direction: 'unknown' })).toBe(false);
  });
  it(
    'rolls admission receipt and enqueue back together',
    async () =>
      withIngestionDb(async ({ db }) => {
        const { persistOutlookHistory } = await import('../src/mail/ingest/outlook-history.js');
        const { admitLiveMessage } = await import('../src/mail/ingest/live-admission.js');
        const saved = await persistOutlookHistory(db, history('rollback'));
        await expect(
          db.transaction(async (tx) => {
            await admitLiveMessage(tx as typeof db, {
              transportId: 'transport-centurion',
              canonicalMessageId: saved.messageId,
              evidence: { kind: 'verified-pop3', sourceReceiptId: 'one' },
            });
            throw new Error('rollback');
          }),
        ).rejects.toThrow('rollback');
        expect(await db.select().from(aiWorkflowRun)).toHaveLength(0);
        const next = await db.transaction((tx) =>
          admitLiveMessage(tx as typeof db, {
            transportId: 'transport-centurion',
            canonicalMessageId: saved.messageId,
            evidence: { kind: 'verified-pop3', sourceReceiptId: 'one' },
          }),
        );
        expect(next.admitted).toBe(true);
      }),
    20_000,
  );
});

it('snapshot membership replaces creation cutoff while preserving the original business clock', async () => {
  const { buildCausalTriageMessages } = await import('../src/ai/triage-input.js');
  const trigger = {
    id: 'A',
    from: 'guest@example.test',
    body: 'trigger',
    direction: 'inbound' as const,
    createdAt: new Date('2026-10-04T08:00Z'),
    receivedAt: new Date('2026-10-04T09:00Z'),
    sentAt: null,
  };
  const beforeAdmission = {
    ...trigger,
    id: 'B',
    body: 'prior context',
    createdAt: new Date('2026-10-04T10:00Z'),
    receivedAt: new Date('2026-10-04T08:30Z'),
  };
  expect(
    buildCausalTriageMessages([trigger, beforeAdmission], 'A', {
      snapshotMessageIds: ['A', 'B'],
    }).map((x) => x.id),
  ).toEqual(['A', 'B']);
  expect(buildCausalTriageMessages([trigger, beforeAdmission], 'A').map((x) => x.id)).toEqual([
    'A',
  ]);
  expect(trigger.receivedAt.toISOString()).toBe('2026-10-04T09:00:00.000Z');
});

it(
  'verified POP3 delivery supplies independent live authority without rewriting the authored clock',
  async () =>
    withIngestionDb(async ({ db }) => {
      const { persistOutlookHistory } = await import('../src/mail/ingest/outlook-history.js');
      const { persistInboundMessage } = await import('../src/mail/ingest/store.js');
      const { FakeS3Storage } = await import('../src/storage/s3.js');
      const original = history('pop3-first-live', '2026-09-01T10:00:00Z');
      const saved = await persistOutlookHistory(db, original);
      expect(await db.select().from(aiWorkflowRun)).toHaveLength(0);
      await persistInboundMessage(
        {
          ownerHeaderValue: 'centurion@legacyhotels.co.za',
          outboundCorrelation: { kind: 'absent' },
          messageId: original.internetMessageId,
          inReplyTo: null,
          references: [],
          fromAddress: original.fromAddress,
          toAddresses: original.toAddresses,
          ccAddresses: [],
          bccAddresses: [],
          subject: original.subject,
          textBody: original.textBody,
          htmlBody: null,
          receivedAt: original.authoredAt,
          attachments: [],
          rawHeaderLines: [],
        },
        Buffer.from('raw'),
        { ingestMailboxId: 'ingest-nava-legacy', pop3Uidl: 'live-twin', messageId: 'candidate' },
        { db, storage: new FakeS3Storage(), ingestSource: 'live-pop3' },
      );
      const runs = await db.select().from(aiWorkflowRun);
      expect(runs).toHaveLength(1);
      expect(runs[0]).toMatchObject({
        triggerMessageId: saved.messageId,
        admissionSnapshotId: expect.any(String),
      });
      const [stored] = await db.select().from(message).where(eq(message.id, saved.messageId));
      expect(stored.receivedAt).toEqual(original.authoredAt);
    }),
  20_000,
);

it(
  'never replays an existing operational row during baseline seeding',
  async () =>
    withIngestionDb(async ({ db }) => {
      const { persistOutlookHistory } = await import('../src/mail/ingest/outlook-history.js');
      const { seedLiveAdmissionBaseline, admitLiveMessage } = await import(
        '../src/mail/ingest/live-admission.js'
      );
      const saved = await persistOutlookHistory(db, history('baseline'));
      await db.update(message).set({ historyOnly: false }).where(eq(message.id, saved.messageId));
      expect(await seedLiveAdmissionBaseline(db, 'transport-centurion')).toBe(1);
      const result = await db.transaction((tx) =>
        admitLiveMessage(tx as typeof db, {
          transportId: 'transport-centurion',
          canonicalMessageId: saved.messageId,
          evidence: { kind: 'verified-pop3', sourceReceiptId: 'later' },
        }),
      );
      expect(result.admitted).toBe(false);
      expect(await db.select().from(aiWorkflowRun)).toHaveLength(0);
    }),
  20_000,
);

it(
  'existing operational mail cannot race startup seeding into repeated AI work',
  async () =>
    withIngestionDb(async ({ db }) => {
      const { persistOutlookHistory } = await import('../src/mail/ingest/outlook-history.js');
      const { admitLiveMessage } = await import('../src/mail/ingest/live-admission.js');
      const saved = await persistOutlookHistory(db, history('baseline-race'));
      await db.update(message).set({ historyOnly: false }).where(eq(message.id, saved.messageId));
      const result = await db.transaction((tx) =>
        admitLiveMessage(tx as typeof db, {
          transportId: 'transport-centurion',
          canonicalMessageId: saved.messageId,
          evidence: { kind: 'verified-pop3', sourceReceiptId: 'later' },
        }),
      );
      expect(result.admitted).toBe(false);
      expect(await db.select().from(aiWorkflowRun)).toHaveLength(0);
    }),
  20_000,
);

it(
  'large retained bodies admit using bounded projections without capping source mail',
  async () =>
    withIngestionDb(async ({ db }) => {
      const { persistOutlookHistory } = await import('../src/mail/ingest/outlook-history.js');
      const { admitLiveMessage, readAdmissionSnapshot } = await import(
        '../src/mail/ingest/live-admission.js'
      );
      const trigger = await persistOutlookHistory(db, {
        ...history('big-trigger'),
        textBody: 'é'.repeat(100_000),
      });
      for (let i = 0; i < 40; i++)
        await persistOutlookHistory(db, {
          ...history(`big-${i}`),
          inReplyTo: 'big-trigger@example.test',
          textBody: 'é'.repeat(100_000),
        });
      const admitted = await db.transaction((tx) =>
        admitLiveMessage(tx as typeof db, {
          transportId: 'transport-centurion',
          canonicalMessageId: trigger.messageId,
          evidence: { kind: 'verified-pop3', sourceReceiptId: 'big' },
        }),
      );
      const snapshot = await readAdmissionSnapshot(db, admitted.receiptId);
      expect(Buffer.byteLength(JSON.stringify(snapshot))).toBeLessThan(256 * 1024);
      expect(
        (await db.select().from(message)).find((m) => m.id === trigger.messageId)?.textBody,
      ).toHaveLength(100_000);
    }),
  20_000,
);

it('the model-facing classifier preserves frozen membership after the trigger creation clock', async () => {
  const { classifyWorkflowMailTriage } = await import('../src/ai/workflows/mail-triage.js');
  const trigger = {
    id: 'A',
    from: 'guest@example.test',
    body: 'TRIGGER_BODY',
    direction: 'inbound' as const,
    createdAt: new Date('2026-10-04T08:00Z'),
    receivedAt: new Date('2026-10-04T09:00Z'),
    sentAt: null,
  };
  let prompt = '';
  await classifyWorkflowMailTriage(
    {
      transportId: 't',
      threadId: 'thread',
      triggerMessageId: 'A',
      messages: [
        trigger,
        {
          ...trigger,
          id: 'B',
          body: 'FROZEN_PRIOR_BODY',
          createdAt: new Date('2026-10-04T10:00Z'),
          receivedAt: new Date('2026-10-04T08:30Z'),
        },
      ],
      snapshotMessageIds: ['A', 'B'],
      asOf: '2026-10-04T11:00:00Z',
      modelId: 'fake',
      promptVersion: 'triage-v6',
    } as never,
    {
      invoke: async (input) => {
        prompt = input.userPrompt;
        return {
          modelId: 'fixture',
          output: {
            primaryFolder: 'unknown-review',
            priority: 'P3',
            urgent: false,
            overlays: {},
            isSpam: false,
            suggestedTools: [],
            sourceScope: 'external',
            automationState: 'unknown',
            humanAction: 'review_required',
            confidence: 0,
            rationale: 'Fixture',
            policyFlags: [],
            abstainReason: 'fixture',
          },
          usage: {
            inputTokens: 0,
            outputTokens: 0,
            totalTokens: 0,
            latencyMs: 0,
            estimatedCostUsd: 0,
            rateTableVersion: 'fixture',
          },
        };
      },
    },
  );
  expect(prompt).toContain('FROZEN_PRIOR_BODY');
  expect(prompt).toContain('TRIGGER_BODY');
});

it(
  'the real triage worker uses frozen body/context and original clocks after enrichment',
  async () =>
    withIngestionDb(async ({ db }) => {
      const { __setDbForTests } = await import('../src/db/client.js');
      const { persistOutlookHistory } = await import('../src/mail/ingest/outlook-history.js');
      const { admitLiveMessage, readAdmissionSnapshot } = await import(
        '../src/mail/ingest/live-admission.js'
      );
      const { claimNextAiRun } = await import('../src/ai/run-ledger.js');
      const { executeAiRun } = await import('../src/ai/worker.js');
      const mastra = await import('../src/ai/mastra.js');
      const { vi } = await import('vitest');
      const original = history('worker-trigger'),
        trigger = await persistOutlookHistory(db, original);
      await persistOutlookHistory(db, {
        ...history('worker-prior', '2026-10-04T09:00:00Z'),
        inReplyTo: original.internetMessageId,
      });
      const admitted = await db.transaction((tx) =>
        admitLiveMessage(tx as typeof db, {
          transportId: original.transportId,
          canonicalMessageId: trigger.messageId,
          evidence: { kind: 'verified-pop3', sourceReceiptId: 'worker' },
        }),
      );
      const frozen = await readAdmissionSnapshot(db, admitted.receiptId);
      await db
        .update(message)
        .set({ textBody: 'MUTABLE_LATE_BODY', receivedAt: new Date('2026-11-01T00:00:00Z') })
        .where(eq(message.id, trigger.messageId));
      await persistOutlookHistory(db, {
        ...history('worker-later'),
        inReplyTo: original.internetMessageId,
      });
      const attempts: Record<string, any>[] = [];
      const spy = vi.spyOn(mastra, 'createMastraRuntime').mockReturnValue({
        getWorkflow: () => ({
          createRun: async () => ({
            start: async ({ inputData }: any) => {
              attempts.push(inputData);
              if (attempts.length === 1) throw new Error('ECONNRESET snapshot retry fixture');
              return {
                status: 'success',
                result: {
                  traceId: 'fixture',
                  output: {
                    primaryFolder: 'unknown-review',
                    priority: 'P3',
                    urgent: false,
                    overlays: {},
                    isSpam: false,
                    suggestedTools: [],
                    sourceScope: 'external',
                    automationState: 'unknown',
                    humanAction: 'review_required',
                    confidence: 0,
                    rationale: 'Fixture',
                    policyFlags: [],
                    abstainReason: 'fixture',
                  },
                  metrics: {},
                },
              };
            },
          }),
        }),
      } as never);
      __setDbForTests({ db, conn: null as never });
      const testEnv = {
        PORT: '39999',
        DATABASE_URL: process.env.TEST_DATABASE_URL!,
        BETTER_AUTH_URL: 'http://localhost:39999',
        BETTER_AUTH_SECRET: 'outlook-sync-test-secret',
        AWS_REGION: 'us-east-1',
        S3_BUCKET: 'outlook-sync-test',
        AI_ENABLED: 'false',
        AI_WRITE_GATE_ENABLED: 'false',
        AI_DRAFTS_ENABLED: 'false',
      };
      const previous = new Map(Object.keys(testEnv).map((key) => [key, process.env[key]]));
      Object.assign(process.env, testEnv);
      try {
        const claimed = await claimNextAiRun({
          ownerId: 'outlook-snapshot-worker',
          lane: 'default',
        });
        expect(claimed?.admissionSnapshotId).toBe(admitted.receiptId);
        expect((await executeAiRun(claimed!.id)).state).toBe('retry_wait');
        expect(
          (await db.select().from(aiWorkflowRun).where(eq(aiWorkflowRun.id, claimed!.id)))[0],
        ).toMatchObject({ state: 'retry_wait', attempts: 1, failureClass: 'TRANSIENT_NETWORK' });
        await db
          .update(message)
          .set({
            textBody: 'EVEN_LATER_RETRY_BODY',
            fromAddress: 'changed@example.test',
            references: ['late-retry@example.test'],
          })
          .where(eq(message.id, trigger.messageId));
        // Drive the persisted retry deadline without sleeping through its backoff.
        await db
          .update(aiWorkflowRun)
          .set({ nextRunAt: new Date(0) })
          .where(eq(aiWorkflowRun.id, claimed!.id));
        const retried = await claimNextAiRun({ ownerId: 'outlook-retry-worker', lane: 'default' });
        expect(retried?.id).toBe(claimed!.id);
        expect((await executeAiRun(retried!.id)).state).toBe('succeeded');
        expect(attempts).toHaveLength(2);
        expect(attempts[1]).toEqual(attempts[0]);
        const seen = attempts[1];
        expect(seen?.body).toBe(original.textBody);
        expect(seen?.messages.map((m: any) => m.id)).toEqual(
          frozen.threadMessages.map((m) => m.id),
        );
        expect(seen?.messages.find((m: any) => m.id === trigger.messageId).receivedAt).toEqual(
          original.authoredAt,
        );
        expect(seen?.snapshotMessageIds).toEqual(frozen.threadMessages.map((m) => m.id));
      } finally {
        spy.mockRestore();
        __setDbForTests(null);
        for (const [key, value] of previous)
          value === undefined ? delete process.env[key] : (process.env[key] = value);
      }
    }),
  30_000,
);

it(
  'a later authorized staff draft uses enriched history without inheriting automatic admission inputs',
  async () =>
    withIngestionDb(async ({ db, url }) => {
      const { __setDbForTests } = await import('../src/db/client.js');
      const { persistOutlookHistory } = await import('../src/mail/ingest/outlook-history.js');
      const { admitLiveMessage, readAdmissionSnapshot } = await import(
        '../src/mail/ingest/live-admission.js'
      );
      const { runAiWorkerOnce } = await import('../src/ai/worker.js');
      const { appRouter } = await import('../src/trpc/router.js');
      const { resolveMailboxContext } = await import('../src/trpc/context.js');
      const { user } = await import('../src/db/schema/auth.js');
      const { aiDraftGeneration, mailDraft, mailLiveAdmission, mailboxAccess, outboundSendQueue } =
        await import('../src/db/schema/mail.js');
      const staffId = 'staff-current-history';
      await db.insert(user).values({
        id: staffId,
        name: 'History draft staff',
        email: 'staff-history@example.test',
        emailVerified: true,
      });
      await db.insert(mailboxAccess).values({
        id: 'staff-current-history-access',
        userId: staffId,
        transportId: 'transport-centurion',
        role: 'member',
      });
      const original = { ...history('staff-draft-trigger'), textBody: null };
      const trigger = await persistOutlookHistory(db, original);
      const admitted = await db.transaction((tx) =>
        admitLiveMessage(tx as typeof db, {
          transportId: original.transportId,
          canonicalMessageId: trigger.messageId,
          evidence: { kind: 'verified-pop3', sourceReceiptId: 'staff-draft-live' },
        }),
      );
      expect(admitted.admitted).toBe(true);
      const frozen = await readAdmissionSnapshot(db, admitted.receiptId);
      expect(
        frozen.threadMessages.find((row) => row.id === trigger.messageId)?.textBody,
      ).toBeNull();
      const enrichedBody = 'CURRENT_HISTORY_BODY Please confirm my reservation.';
      const enriched = await persistOutlookHistory(db, {
        ...original,
        semanticVersion: '2',
        textBody: enrichedBody,
        originalMsgKey: 'outlook-sync-originals/v1/source/staff-draft-trigger-v2',
      });
      expect(enriched.messageId).toBe(trigger.messageId);
      expect(
        (await db.select().from(message).where(eq(message.id, trigger.messageId)))[0]?.textBody,
      ).toBe(enrichedBody);
      expect(await db.select().from(aiWorkflowRun)).toHaveLength(1);
      expect(await db.select().from(mailDraft)).toHaveLength(0);
      const testEnv = {
        PORT: '39999',
        DATABASE_URL: url,
        BETTER_AUTH_URL: 'http://localhost:39999',
        BETTER_AUTH_SECRET: 'outlook-sync-test-secret',
        AWS_REGION: 'us-east-1',
        S3_BUCKET: 'outlook-sync-test',
        AI_ENABLED: 'false',
        AI_WRITE_GATE_ENABLED: 'false',
        AI_DRAFTS_ENABLED: 'true',
        AI_MODEL_ROUTE: 'approved-local',
        AI_WORKER_LANE: 'default',
        HMS_DRAFT_ENRICHMENT_MODE: 'off',
      };
      const previous = new Map(Object.keys(testEnv).map((key) => [key, process.env[key]]));
      __setDbForTests({ db, conn: null as never });
      Object.assign(process.env, testEnv);
      try {
        // Resolve the real grant instead of injecting a pre-resolved mailbox context.
        expect(await resolveMailboxContext(staffId, original.transportId, db)).toMatchObject({
          accessRole: 'member',
          activeTransportId: original.transportId,
        });
        const caller = appRouter.createCaller({
          auth: null as never,
          reqHeaders: new Headers({ 'x-zero-active-transport': original.transportId }),
          sessionUser: { id: staffId, email: 'staff-history@example.test', name: 'Staff' },
        });
        const refresh = await caller.ai.refreshHmsCandidate({ threadId: trigger.threadId });
        const [queued] = await db
          .select()
          .from(aiWorkflowRun)
          .where(eq(aiWorkflowRun.id, refresh.runId));
        expect(queued).toMatchObject({
          runKind: 'candidate_draft',
          executorLane: 'default',
          triggerMessageId: trigger.messageId,
          admissionSnapshotId: null,
          admissionSnapshotHash: null,
        });
        expect(
          (
            await db
              .select()
              .from(aiDraftGeneration)
              .where(eq(aiDraftGeneration.id, queued!.generationId!))
          )[0],
        ).toMatchObject({ requestedByUserId: staffId });
        let prompt = '';
        const worked = await runAiWorkerOnce({
          runKind: 'candidate_draft',
          idempotencyPrefix: refresh.idempotencyKey,
          candidateDraftRouteFactory: () => ({
            route: {
              routeId: 'outlook-history-staff-draft-local',
              purpose: 'draft',
              protocol: 'in_process',
              access: 'current_app',
              egress: 'none',
              retention: 'bounded',
              usage: 'reported',
              modelId: 'outlook-history-staff-draft-model',
            },
            transport: async (request) => {
              prompt = request.userPrompt;
              return {
                output: {
                  replyText: '[MISSING: reservation status | how: approved reservation read]',
                },
                usage: { inputTokens: 5, outputTokens: 7, latencyMs: 1 },
              };
            },
          }),
        });
        expect(worked).toBe(true);
        expect(prompt).toContain('u5-prepared-draft-input-v1');
        expect(prompt).toContain(enrichedBody);
        const [draft] = await db
          .select()
          .from(mailDraft)
          .where(eq(mailDraft.threadId, trigger.threadId));
        expect(draft).toMatchObject({ status: 'candidate', createdByUserId: staffId });
        expect(
          (await db.select().from(aiWorkflowRun).where(eq(aiWorkflowRun.id, refresh.runId)))[0],
        ).toMatchObject({
          state: 'succeeded',
          admissionSnapshotId: null,
          admissionSnapshotHash: null,
        });
        expect(await readAdmissionSnapshot(db, admitted.receiptId)).toEqual(frozen);
        expect(await db.select().from(mailLiveAdmission)).toHaveLength(1);
        const runs = await db.select().from(aiWorkflowRun);
        expect(runs.filter((run) => run.runKind === 'inbound_triage')).toHaveLength(1);
        expect(runs.filter((run) => run.runKind === 'candidate_draft')).toHaveLength(1);
        expect(await db.select().from(outboundSendQueue)).toHaveLength(0);
      } finally {
        __setDbForTests(null);
        for (const [key, value] of previous)
          value === undefined ? delete process.env[key] : (process.env[key] = value);
      }
    }),
  30_000,
);

it(
  'concurrent native and POP3 admission and a pre-lock waiter enqueue once from fresh committed context',
  async () =>
    withIngestionDb(async ({ db, url }) => {
      const { persistOutlookHistory } = await import('../src/mail/ingest/outlook-history.js');
      const { admitLiveMessage, readAdmissionSnapshot } = await import(
        '../src/mail/ingest/live-admission.js'
      );
      const { lockCanonicalMailbox } = await import('../src/mail/ingest/canonical-identity.js');
      const { drizzle } = await import('drizzle-orm/postgres-js');
      const postgres = (await import('postgres')).default;
      const schema = await import('../src/db/schema/index.js');
      const connection = postgres(url, { max: 1, ssl: false, onnotice: () => undefined }),
        other = drizzle(connection, { schema });
      const trigger = await persistOutlookHistory(db, history('race-trigger'));
      let release!: () => void, locked!: () => void;
      const acquired = new Promise<void>((r) => (locked = r)),
        hold = new Promise<void>((r) => (release = r));
      let priorId = '';
      const producer = db.transaction(async (tx) => {
        await lockCanonicalMailbox(tx as typeof db, 'transport-centurion');
        locked();
        await hold;
        priorId = (
          await persistOutlookHistory(tx as typeof db, {
            ...history('race-context', '2026-10-04T09:00:00Z'),
            inReplyTo: 'race-trigger@example.test',
          })
        ).messageId;
      });
      await acquired;
      const waiter = other.transaction((tx) =>
        admitLiveMessage(tx as typeof db, {
          transportId: 'transport-centurion',
          canonicalMessageId: trigger.messageId,
          evidence: { kind: 'verified-pop3', sourceReceiptId: 'raced-pop3' },
        }),
      );
      release();
      await producer;
      try {
        const native = db.transaction((tx) =>
          admitLiveMessage(tx as typeof db, {
            transportId: 'transport-centurion',
            canonicalMessageId: trigger.messageId,
            evidence: {
              kind: 'native',
              sourceReceiptId: 'raced-native',
              cutover: new Date('2026-10-04T08:00:00Z'),
              observation: {
                direction: 'inbound',
                receivedAt: '2026-10-04T10:00:00.000Z',
                event: {
                  kind: 'new-mail',
                  receivedAt: '2026-10-04T10:00:00.000Z',
                  observedAt: '2026-10-04T11:00:00Z',
                },
              },
            },
          }),
        );
        const results = await Promise.all([waiter, native]);
        expect(results.filter((r) => r.admitted)).toHaveLength(1);
        const receipt = results.find((r) => r.admitted)!;
        expect(
          (await readAdmissionSnapshot(db, receipt.receiptId)).threadMessages.map((r) => r.id),
        ).toContain(priorId);
        expect(await db.select().from(aiWorkflowRun)).toHaveLength(1);
      } finally {
        await connection.end();
      }
    }),
  30_000,
);

it(
  'pinned artifact descriptors and snapshot hashes survive later attachment enrichment',
  async () =>
    withIngestionDb(async ({ db }) => {
      const { persistOutlookHistory } = await import('../src/mail/ingest/outlook-history.js');
      const { admitLiveMessage, readAdmissionSnapshot } = await import(
        '../src/mail/ingest/live-admission.js'
      );
      const { attachment, mailLiveAdmission } = await import('../src/db/schema/mail.js');
      const trigger = await persistOutlookHistory(db, {
        ...history('artifact-trigger'),
        attachments: [
          {
            sourceAttachmentId: '1',
            filename: 'quote.pdf',
            mimeType: 'application/pdf',
            sizeBytes: 3,
            sha256: 'a'.repeat(64),
            s3Key: 'outlook-sync-originals/v1/source/artifact-old',
            contentId: null,
            isInline: false,
          },
        ],
      });
      const admitted = await db.transaction((tx) =>
        admitLiveMessage(tx as typeof db, {
          transportId: 'transport-centurion',
          canonicalMessageId: trigger.messageId,
          evidence: { kind: 'verified-pop3', sourceReceiptId: 'artifact' },
        }),
      );
      await db
        .update(attachment)
        .set({ s3Key: 'outlook-sync-originals/v1/source/artifact-new', sha256: 'b'.repeat(64) })
        .where(eq(attachment.messageId, trigger.messageId));
      const frozen = await readAdmissionSnapshot(db, admitted.receiptId);
      expect(frozen.artifacts[0]).toMatchObject({
        s3Key: 'outlook-sync-originals/v1/source/artifact-old',
        sha256: 'a'.repeat(64),
      });
      await db
        .update(mailLiveAdmission)
        .set({ snapshot: { ...frozen, threadMessages: [] } })
        .where(eq(mailLiveAdmission.id, admitted.receiptId));
      await expect(readAdmissionSnapshot(db, admitted.receiptId)).rejects.toThrow('integrity');
    }),
  30_000,
);

it(
  'the shadow worker uses the same immutable admission context and pinned artifact membership',
  async () =>
    withIngestionDb(async ({ db }) => {
      const { __setDbForTests } = await import('../src/db/client.js');
      const { persistOutlookHistory } = await import('../src/mail/ingest/outlook-history.js');
      const { admitLiveMessage } = await import('../src/mail/ingest/live-admission.js');
      const { claimNextAiRun } = await import('../src/ai/run-ledger.js');
      const { executeAiRun } = await import('../src/ai/worker.js');
      const { aiShadowPrediction } = await import('../src/db/schema/ai-shadow-evaluation.js');
      const testEnv = {
        PORT: '39999',
        DATABASE_URL: process.env.TEST_DATABASE_URL!,
        BETTER_AUTH_URL: 'http://localhost:39999',
        BETTER_AUTH_SECRET: 'outlook-sync-test-secret',
        AWS_REGION: 'us-east-1',
        S3_BUCKET: 'outlook-sync-test',
        AI_ENABLED: 'false',
        AI_WRITE_GATE_ENABLED: 'false',
        AI_DRAFTS_ENABLED: 'false',
        AI_MODEL_ROUTE: 'approved-local',
        AI_SHADOW_EXECUTION_MODE: 'local_synthetic',
        AI_SHADOW_ADMISSION_CAP_PER_DAY: '10',
        AI_SHADOW_CAP_SCOPE: 'outlook-test',
        AI_SHADOW_TOKEN_CAP_PER_DAY: '10000',
        AI_SHADOW_SPEND_CAP_USD_PER_DAY: '1',
        AI_SHADOW_BROWSER_CAP_PER_DAY: '1',
      };
      const previous = new Map(Object.keys(testEnv).map((key) => [key, process.env[key]]));
      Object.assign(process.env, testEnv);
      __setDbForTests({ db, conn: null as never });
      try {
        const trigger = await persistOutlookHistory(db, history('shadow-trigger'));
        const prior = await persistOutlookHistory(db, {
          ...history('shadow-prior', '2026-10-04T09:00:00Z'),
          inReplyTo: 'shadow-trigger@example.test',
        });
        await db.transaction((tx) =>
          admitLiveMessage(tx as typeof db, {
            transportId: 'transport-centurion',
            canonicalMessageId: trigger.messageId,
            evidence: { kind: 'verified-pop3', sourceReceiptId: 'shadow' },
          }),
        );
        const shadow = (await db.select().from(aiWorkflowRun)).find(
          (r) => r.runKind === 'shadow_prediction',
        );
        expect(shadow?.admissionSnapshotId).toBeTruthy();
        await db
          .update(aiWorkflowRun)
          .set({ state: 'succeeded' })
          .where(eq(aiWorkflowRun.runKind, 'inbound_triage'));
        await db
          .update(message)
          .set({ textBody: 'LATE_SHADOW_BODY' })
          .where(eq(message.id, prior.messageId));
        await persistOutlookHistory(db, {
          ...history('shadow-later'),
          inReplyTo: 'shadow-trigger@example.test',
        });
        expect(
          (await claimNextAiRun({ ownerId: 'outlook-shadow-worker', lane: 'default' }))?.id,
        ).toBe(shadow!.id);
        const route = {
          routeId: 'outlook-shadow-route',
          purpose: 'shadow' as const,
          protocol: 'in_process' as const,
          access: 'current_app' as const,
          egress: 'none' as const,
          retention: 'bounded' as const,
          usage: 'reported' as const,
          modelId: 'fixture',
        };
        let prompt = '';
        const result = await executeAiRun(shadow!.id, {
          shadowModelRoute: route,
          shadowModelAdapter: {
            invoke: async (input) => {
              prompt = input.userPrompt;
              return {
                modelId: 'fixture',
                output: { outcome: 'manual_review' },
                provenance: {
                  routeId: route.routeId,
                  modelId: route.modelId,
                  purpose: 'shadow',
                  protocol: 'in_process',
                  usageSource: 'reported',
                },
                usage: {
                  inputTokens: 0,
                  outputTokens: 0,
                  totalTokens: 0,
                  latencyMs: 0,
                  estimatedCostUsd: 0,
                  rateTableVersion: 'fixture',
                },
              };
            },
          },
        });
        const [finished] = await db
          .select()
          .from(aiWorkflowRun)
          .where(eq(aiWorkflowRun.id, shadow!.id));
        expect(result.state, finished?.lastError ?? 'worker result').toBe('succeeded');
        expect(prompt).toContain('Body shadow-prior');
        expect(prompt).not.toContain('LATE_SHADOW_BODY');
        expect(prompt).not.toContain('Body shadow-later');
        expect(await db.select().from(aiShadowPrediction)).toHaveLength(1);
      } finally {
        __setDbForTests(null);
        for (const [key, value] of previous)
          value === undefined ? delete process.env[key] : (process.env[key] = value);
      }
    }),
  30_000,
);

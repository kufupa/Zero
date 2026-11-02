import { createHash, randomUUID } from 'node:crypto';
import { Readable } from 'node:stream';
import type { S3Client } from '@aws-sdk/client-s3';
import { eq } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { attachment, mailThread, message } from '../src/db/schema/mail.js';
import { outlookSyncArtifact, outlookSyncObservation, outlookSyncSource } from '../src/db/schema/outlook-sync.js';
import type { DB } from '../src/db/client.js';
import { OutlookSyncStorage } from '../src/outlook-sync/storage.js';
import { prepareVoucherFilingSource, readApprovedVoucherFilingSource } from '../src/ai/voucher-filing-source.js';
import { outlookSyncFixture } from './helpers/outlook-sync-fixture.js';

const ingestionDbAvailable = Boolean(process.env.TEST_DATABASE_URL?.trim()) && process.env.CONFIRM_DISPOSABLE_TEST_DB === '1';
async function withIngestionDb<T>(callback: (context: { db: DB }) => Promise<T>): Promise<T> {
  const helper = await import('./helpers/ingestion-db.js');
  return helper.withIngestionDb(callback);
}

const sha = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');
const original = Buffer.from('%PDF-1.7 synthetic attachment');

async function setup(db: DB) {
  const f = await outlookSyncFixture(db);
  const sourceId = randomUUID(), observationId = randomUUID(), artifactId = randomUUID();
  const messageId = randomUUID(), threadId = randomUUID(), attachmentId = randomUUID();
  const digest = sha(original);
  const key = `outlook-sync-originals/v1/${sha(JSON.stringify([sourceId, observationId, artifactId]))}/${digest}`;
  const receipt = { key, bytes: original.length, sha256: digest, eTag: '"etag-1"', versionId: 'version-1' };
  await db.insert(outlookSyncSource).values({ id: sourceId, deviceId: f.deviceId, transportId: f.transportId,
    userId: f.userId, storeId: f.storeId, rootEntryId: f.rootEntryId, sessionId: f.sessionId, policyGeneration: 1,
    authorityExpiresAt: new Date(Date.now() + 60_000), activationKey: randomUUID(), activationTicketHash: 'hash',
    activationTicketCiphertext: 'cipher', activationExpiresAt: new Date(Date.now() + 60_000) });
  await db.insert(mailThread).values({ id: threadId, transportId: f.transportId, threadRootId: randomUUID() });
  await db.insert(message).values({ id: messageId, threadId, transportId: f.transportId, direction: 'inbound',
    fromAddress: 'synthetic@example.test', sourceProvenance: { version: 1, sourceId, observationId, artifactOrigin: null,
      artifacts: [{ role: 'attachment:1', artifactId, receipt }] } });
  await db.insert(attachment).values({ id: attachmentId, messageId, filename: 'proof.pdf', mimeType: 'application/pdf',
    sizeBytes: original.length, sha256: digest, s3Key: key, sourceAttachmentId: '1', isInline: false });
  await db.insert(outlookSyncObservation).values({ id: observationId, sourceId, sourceObservationId: randomUUID(),
    semanticVersion: 1, evidence: {}, availability: 'available', direction: 'inbound', canonicalMessageId: messageId,
    requiredArtifactRoles: ['attachment:1'], exportState: 'retained', ingestionState: 'committed' });
  await db.insert(outlookSyncArtifact).values({ id: artifactId, observationId, role: 'attachment:1', version: 1,
    expectedBytes: original.length, sha256: digest, contentType: 'application/pdf', sealedKey: key,
    verifiedReceipt: receipt, acceptedAt: new Date() });

  const state = { bytes: Buffer.from(original), version: 'version-1' as string | undefined, eTag: '"etag-1"',
    calls: [] as { name: string; input: Record<string, unknown> }[], onGet: undefined as undefined | (() => Promise<void>) };
  const client = { send: async (command: { constructor: { name: string }; input: Record<string, unknown> }) => {
    const name = command.constructor.name, input = command.input;
    state.calls.push({ name, input });
    if (input.Key !== key) throw new Error('wrong key');
    if (name === 'HeadObjectCommand') return { ContentLength: state.bytes.length, ETag: state.eTag, VersionId: state.version };
    if (name === 'GetObjectCommand') {
      if (input.VersionId !== state.version || input.IfMatch !== state.eTag) throw new Error('version mismatch');
      const bytes = Buffer.from(state.bytes);
      await state.onGet?.();
      return { Body: Readable.from([bytes]), ContentLength: bytes.length, ETag: state.eTag, VersionId: state.version };
    }
    throw new Error('unexpected storage operation');
  } } as unknown as S3Client;
  const storage = new OutlookSyncStorage({ bucket: 'private-mail', region: 'af-south-1', client });
  const input = { transportId: f.transportId, messageId, attachmentId };
  const deps = { db, storage, signal: new AbortController().signal, checkAuthority: async () => true };
  const form = (source: Awaited<ReturnType<typeof prepareVoucherFilingSource>> & { status: 'ready' }) => ({
    executor: 'cloud-write/v1' as const, action: 'attach_document' as const, propertyCode: 'HRCEN',
    payload: { source: source.source, kind: 'voucher' as const,
      stay: { confirmation: '123456-1', arrival: '2027-01-01', firstName: 'Proof', lastName: 'Labtest' } },
  });
  return { input, deps, form, state, receipt, key, sourceId, observationId, artifactId, messageId, attachmentId };
}

describe.skipIf(!ingestionDbAvailable)('voucher filing source with disposable database', () => {
  it('reads the accepted version at prepare and execution, binding the private receipt into approval', async () =>
    withIngestionDb(async ({ db }) => {
      const s = await setup(db);
      const prepared = await prepareVoucherFilingSource(s.input, s.deps);
      expect(prepared.status).toBe('ready');
      if (prepared.status !== 'ready') throw new Error('expected source');
      expect(prepared.source.sha256).toBe(sha(original));
      expect(prepared.source.snapshotDigest).toMatch(/^[a-f0-9]{64}$/);
      expect(JSON.stringify(prepared)).not.toContain(s.key);
      const read = await readApprovedVoucherFilingSource(s.form(prepared), s.deps);
      expect(read).toEqual({ status: 'ready', bytes: original });
      const gets = s.state.calls.filter((call) => call.name === 'GetObjectCommand');
      expect(gets).toHaveLength(2);
      for (const call of gets) expect(call.input).toMatchObject({ VersionId: 'version-1', IfMatch: '"etag-1"' });
      expect(s.state.calls.every((call) => ['HeadObjectCommand', 'GetObjectCommand'].includes(call.name))).toBe(true);
    }));

  it('refuses malformed or ambiguously attributed receipts without reading bytes', async () =>
    withIngestionDb(async ({ db }) => {
      const s = await setup(db);
      const originalProvenance = { version: 1, sourceId: s.sourceId, observationId: s.observationId, artifactOrigin: null,
        artifacts: [{ role: 'attachment:1', artifactId: s.artifactId, receipt: s.receipt }] };
      for (const versionId of ['']) {
        await db.update(message).set({ sourceProvenance: { ...originalProvenance,
          artifacts: [{ role: 'attachment:1', artifactId: s.artifactId, receipt: { ...s.receipt, versionId } }] } })
          .where(eq(message.id, s.messageId));
        expect(await prepareVoucherFilingSource(s.input, s.deps)).toEqual({ status: 'refused', reason: 'source_unavailable' });
      }
      await db.update(message).set({ sourceProvenance: { ...originalProvenance,
        artifacts: [...originalProvenance.artifacts, ...originalProvenance.artifacts] } }).where(eq(message.id, s.messageId));
      expect((await prepareVoucherFilingSource(s.input, s.deps)).status).toBe('refused');
      await db.update(message).set({ sourceProvenance: originalProvenance }).where(eq(message.id, s.messageId));
      expect((await prepareVoucherFilingSource({ ...s.input, transportId: 'wrong' }, s.deps)).status).toBe('refused');
      const duplicateId = randomUUID();
      await db.insert(attachment).values({ id: duplicateId, messageId: s.messageId, filename: 'proof.pdf',
        mimeType: 'application/pdf', sizeBytes: original.length, sha256: sha(original), s3Key: s.key, sourceAttachmentId: '1' });
      expect((await prepareVoucherFilingSource(s.input, s.deps)).status).toBe('refused');
      await db.delete(attachment).where(eq(attachment.id, duplicateId));
      await db.update(attachment).set({ s3Key: `attachments/${s.messageId}/proof.pdf` }).where(eq(attachment.id, s.attachmentId));
      expect((await prepareVoucherFilingSource(s.input, s.deps)).status).toBe('refused');
      expect(s.state.calls).toHaveLength(0);
    }));

  it('accepts safe Unicode names and generic PDF MIME with matching stored artifact identity', async () =>
    withIngestionDb(async ({ db }) => {
      const s = await setup(db);
      await db.update(attachment).set({ filename: "O'Neil [Müller].pdf", mimeType: 'application/octet-stream' })
        .where(eq(attachment.id, s.attachmentId));
      await db.update(outlookSyncArtifact).set({ contentType: 'application/octet-stream' })
        .where(eq(outlookSyncArtifact.id, s.artifactId));
      const prepared = await prepareVoucherFilingSource(s.input, s.deps);
      expect(prepared).toMatchObject({ status: 'ready', source: { filename: "O'Neil [Müller].pdf", mimeType: 'application/pdf' } });
    }));

  it('resolves a linked Outlook variant by accepted artifact and committed canonical observation', async () =>
    withIngestionDb(async ({ db }) => {
      const s = await setup(db);
      // POP3-first and older Outlook messages retain their existing message-level provenance.
      await db.update(message).set({ sourceProvenance: { pop3: true } }).where(eq(message.id, s.messageId));
      await db.update(outlookSyncArtifact).set({ metadata: { fileName: 'proof.pdf' } }).where(eq(outlookSyncArtifact.id, s.artifactId));
      const [origin] = await db.select().from(outlookSyncObservation).where(eq(outlookSyncObservation.id, s.observationId));
      if (!origin) throw new Error('expected origin');
      const evidence = { contentIdentity: { sha256: sha(original), attachments: [{ role: 'attachment:1', stableId: 'stable',
        modifiedAt: '2026-11-02T12:00:00Z', sizeBytes: original.length }] },
        semantic: { subject: 'Voucher', isRead: false, categories: [] },
        timestamps: { receivedAt: '2026-11-02T12:00:00Z', modifiedAt: '2026-11-02T12:00:00Z' },
        direction: 'inbound', requiredArtifactRoles: ['attachment:1'] };
      await db.update(outlookSyncObservation).set({ evidence }).where(eq(outlookSyncObservation.id, s.observationId));
      await db.insert(outlookSyncObservation).values({ id: randomUUID(), sourceId: s.sourceId,
        sourceObservationId: origin.sourceObservationId, semanticVersion: 2,
        evidence: { ...evidence, semantic: { ...evidence.semantic, isRead: true, categories: ['Read'] } }, availability: 'available',
        direction: 'inbound', canonicalMessageId: s.messageId, artifactOrigin: { sourceId: s.sourceId, observationId: s.observationId },
        requiredArtifactRoles: ['attachment:1'], exportState: 'retained', ingestionState: 'committed' });
      expect((await prepareVoucherFilingSource({ ...s.input, transportId: 'wrong' }, s.deps)).status).toBe('refused');
      expect((await prepareVoucherFilingSource({ ...s.input, messageId: randomUUID() }, s.deps)).status).toBe('refused');
      const prepared = await prepareVoucherFilingSource(s.input, s.deps);
      expect(prepared.status).toBe('ready');
      if (prepared.status !== 'ready') throw new Error('expected linked source');
      expect(await readApprovedVoucherFilingSource(s.form(prepared), s.deps)).toEqual({ status: 'ready', bytes: original });
      await db.update(outlookSyncObservation).set({ canonicalMessageId: 'other' }).where(eq(outlookSyncObservation.id, s.observationId));
      expect((await readApprovedVoucherFilingSource(s.form(prepared), s.deps)).status).toBe('refused');
    }));

  it('accepts an unversioned receipt only when fresh bytes still match the approved hash', async () =>
    withIngestionDb(async ({ db }) => {
      const s = await setup(db);
      const { versionId: _versionId, ...receipt } = s.receipt;
      const provenance = { version: 1, sourceId: s.sourceId, observationId: s.observationId, artifactOrigin: null,
        artifacts: [{ role: 'attachment:1', artifactId: s.artifactId, receipt }] };
      await db.update(message).set({ sourceProvenance: provenance }).where(eq(message.id, s.messageId));
      await db.update(outlookSyncArtifact).set({ verifiedReceipt: receipt }).where(eq(outlookSyncArtifact.id, s.artifactId));
      s.state.version = undefined;
      const prepared = await prepareVoucherFilingSource(s.input, s.deps);
      expect(prepared.status).toBe('ready');
      if (prepared.status !== 'ready') throw new Error('expected source');
      expect(await readApprovedVoucherFilingSource(s.form(prepared), s.deps)).toEqual({ status: 'ready', bytes: original });
      s.state.bytes = Buffer.from(original); s.state.bytes[6] ^= 1;
      expect((await readApprovedVoucherFilingSource(s.form(prepared), s.deps)).status).toBe('refused');
    }));

  it('refuses changed version, bytes, approved identity and authority; never returns unapproved bytes', async () =>
    withIngestionDb(async ({ db }) => {
      const s = await setup(db);
      const prepared = await prepareVoucherFilingSource(s.input, s.deps);
      if (prepared.status !== 'ready') throw new Error('expected source');
      const form = s.form(prepared);
      expect((await readApprovedVoucherFilingSource({ ...form, payload: { ...form.payload,
        source: { ...form.payload.source, snapshotDigest: 'b'.repeat(64) } } }, s.deps)).status).toBe('refused');
      s.state.version = 'version-2';
      expect((await readApprovedVoucherFilingSource(form, s.deps)).status).toBe('refused');
      s.state.version = 'version-1';
      s.state.eTag = '"changed"';
      expect((await readApprovedVoucherFilingSource(form, s.deps)).status).toBe('refused');
      s.state.eTag = '"etag-1"';
      s.state.bytes = Buffer.from(original); s.state.bytes[6] = 0x30;
      expect((await readApprovedVoucherFilingSource(form, s.deps)).status).toBe('refused');
      s.state.bytes = Buffer.from(original);
      expect((await readApprovedVoucherFilingSource(form, { ...s.deps, checkAuthority: async () => false })).status).toBe('refused');
      let checks = 0;
      expect((await readApprovedVoucherFilingSource(form, { ...s.deps, checkAuthority: async () => ++checks === 1 })).status).toBe('refused');
      const aborted = new AbortController(); aborted.abort();
      expect((await readApprovedVoucherFilingSource(form, { ...s.deps, signal: aborted.signal })).status).toBe('refused');
      s.state.onGet = async () => {
        await db.update(attachment).set({ filename: 'changed.pdf' }).where(eq(attachment.id, s.attachmentId));
      };
      expect((await readApprovedVoucherFilingSource(form, s.deps)).status).toBe('refused');
    }));
});

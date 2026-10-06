import { randomUUID, createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { afterEach, expect, it, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import { __setDbForTests, type DB } from '../src/db/client.js';
import { TRANSPORT_ID } from '../src/db/seed.js';
import {
  attachment, aiDraftGeneration, aiWorkflowRun, mailDraft, mailThread, message,
} from '../src/db/schema/mail.js';
import { enqueueAiRun, claimNextAiRun } from '../src/ai/run-ledger.js';
import { aiWorkerOwnerId, executeAiRun, runAiWorkerOnce } from '../src/ai/worker.js';
import type { DraftModelRouteConfig, ReservationistProviderContext } from '../src/ai/draft-route-factory.js';
import type { SandboxRunner } from '../src/mail/artifacts/read-artifact.js';
import { FakeS3Storage, resetS3Storage, setS3Storage } from '../src/storage/s3.js';
import { probeTestDb, withSeededTestDb } from './helpers/test-db.js';

if (!(await probeTestDb())) throw new Error('Worker PDF regressions require disposable DB');
const savedEnv = {
  HMS_DRAFT_ENRICHMENT_MODE: process.env.HMS_DRAFT_ENRICHMENT_MODE,
  AI_MODEL_ROUTE: process.env.AI_MODEL_ROUTE,
  AI_WORKER_LANE: process.env.AI_WORKER_LANE,
};
afterEach(() => {
  resetS3Storage();
  __setDbForTests(null);
  for (const [key, value] of Object.entries(savedEnv)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

it.each(['text', 'encrypted', 'foreign-locator', 'changed-byte-hash', 'worker-once'] as const)(
  'forwards only trusted PDF parser while preserving ordinary worker source guards: %s',
  async mode => {
    process.env.HMS_DRAFT_ENRICHMENT_MODE = 'off';
    process.env.AI_MODEL_ROUTE = 'approved-local';
    process.env.AI_WORKER_LANE = 'default';
    await withSeededTestDb(async db => {
      __setDbForTests({ db, conn: null as never });
      const { threadId, triggerId, run } = await seed(db, mode !== 'worker-once');
      const id = randomUUID(), body = Buffer.from('%PDF-synthetic-worker-parser-boundary');
      const hash = createHash('sha256').update(body).digest('hex');
      const key = `attachments/${mode === 'foreign-locator' ? 'foreign-message' : triggerId}/${id}`;
      const storage = new FakeS3Storage('synthetic-local-worker-pdf');
      setS3Storage(storage);
      await storage.putObject({ key, body, contentType: 'application/pdf' });
      await db.insert(attachment).values({
        id, messageId: triggerId, filename: 'synthetic.pdf', mimeType: 'application/pdf',
        sizeBytes: body.length, s3Key: key,
      });
      // Synthetic subprocess outputs test forwarding only; actual Docker extraction
      // is separately recorded from original byte sources in private evidence.
      const runner = vi.fn<SandboxRunner>(async (tool, inputPath, signal) => {
        expect(signal?.aborted).toBe(false);
        expect(await readFile(inputPath)).toEqual(body);
        if (mode === 'changed-byte-hash' && tool === 'pdftotext') {
          storage.stored.set(key, { body: Buffer.from('%PDF-changed-source'), contentType: 'application/pdf' });
        }
        return {
          stdout: Buffer.from(tool === 'pdfinfo'
            ? `Pages: 1\nEncrypted: ${mode === 'encrypted' ? 'yes' : 'no'}\n`
            : 'Synthetic authorized document text.\f'),
          stderr: Buffer.alloc(0), exitCode: 0,
        };
      });
      let observed: ReservationistProviderContext | undefined;
      const provider: NonNullable<DraftModelRouteConfig['reservationist']> = async context => {
        observed = context;
        return {
          collectGeneratedArtifacts: () => [],
          dependencies: {
            plan: async () => ({ tasks: [{ id: 'answer', kind: 'question', required: true }], facts: [] }),
            execute: async () => ({
              tasks: [{ id: 'answer', status: 'needs_clarification', guestText: 'Staff will review the document.', evidenceRefs: [] }],
              approvedGuestClauses: { answer: 'Staff will review the document.' },
              artifacts: [], quoteRefs: [], packets: [], errors: [],
            }),
            verifyGuestClause: async task => task.guestText === 'Staff will review the document.',
          },
        };
      };
      const route = configuredRoute(provider);
      const options = { candidateDraftRoute: route, artifactSandboxRunner: runner };
      const result = mode === 'worker-once'
        ? await runAiWorkerOnce({
            idempotencyPrefix: `reservationist-pdf:${triggerId}`,
            candidateDraftRouteFactory: () => route,
            mailBaselineExtractionRouteFactory: () => undefined,
            shadowModelRouteFactory: () => undefined,
            artifactSandboxRunner: runner,
          })
        : await executeAiRun(run.id, options);
      const [stored] = await db.select().from(aiWorkflowRun).where(eq(aiWorkflowRun.id, run.id));
      const drafts = await db.select().from(mailDraft).where(eq(mailDraft.threadId, threadId));
      if (mode === 'foreign-locator') {
        expect(stored.state).not.toBe('succeeded');
        expect(runner).not.toHaveBeenCalled();
        expect(observed).toBeUndefined();
        expect(drafts).toHaveLength(0);
        return;
      }
      expect(runner.mock.calls.map(call => call[0])).toEqual(mode === 'encrypted' ? ['pdfinfo'] : ['pdfinfo', 'pdftotext']);
      expect(observed?.admissions).toHaveLength(1);
      const admission = observed!.admissions[0];
      expect(admission.metadata).toMatchObject({ sourceHash: hash, ownerRef: TRANSPORT_ID, threadId, messageId: triggerId });
      expect(admission.draftReady).toBe(false);
      if (mode === 'encrypted') {
        expect(admission).toMatchObject({ status: 'manual_required', reason: 'encrypted' });
        expect(admission.source).toBeUndefined();
        expect(admission.bytes).toBeUndefined();
      } else {
        expect(admission).toMatchObject({ status: 'admitted', reason: 'text', relation: 'current', source: { sourceHash: hash, pageCount: 1, pages: ['Synthetic authorized document text.'] } });
        expect(admission.bytes?.body).toEqual(body);
      }
      if (mode === 'changed-byte-hash') {
        expect(stored.state).not.toBe('succeeded');
        expect(drafts).toHaveLength(0);
      } else {
        expect(stored.state, stored.lastError ?? 'no worker error').toBe('succeeded');
        expect(result).toEqual(mode === 'worker-once' ? true : { runId: run.id, state: 'succeeded' });
        expect(drafts).toHaveLength(1);
        expect(drafts[0].attachments).toEqual([]);
      }
    });
  },
);

async function seed(db: DB, claim: boolean) {
  const threadId = randomUUID(), triggerId = randomUUID();
  await db.insert(mailThread).values({ id: threadId, transportId: TRANSPORT_ID, threadRootId: `synthetic-${threadId}`, subject: 'Synthetic document question', latestMessageAt: new Date() });
  await db.insert(message).values({ id: triggerId, threadId, transportId: TRANSPORT_ID, direction: 'inbound', fromAddress: 'Synthetic Guest <pdf-worker@example.invalid>', toAddresses: ['centurion@legacyhotel.com'], subject: 'Synthetic document question', textBody: 'Please review the document.', receivedAt: new Date() });
  const run = await enqueueAiRun({ transportId: TRANSPORT_ID, threadId, triggerMessageId: triggerId, runKind: 'candidate_draft', idempotencyKey: `reservationist-pdf:${triggerId}`, modelId: 'synthetic-parser-test', promptVersion: 'reservationist-v1' }, db);
  await db.insert(aiDraftGeneration).values({ id: `${run.id}-generation`, threadId, transportId: TRANSPORT_ID, requestedByUserId: 'user-navaai', contextMessageIds: [triggerId], model: 'synthetic', promptVersion: 'reservationist-v1' });
  if (claim) expect((await claimNextAiRun({ ownerId: aiWorkerOwnerId('default'), lane: 'default', idempotencyPrefix: `reservationist-pdf:${triggerId}` }))?.id).toBe(run.id);
  return { threadId, triggerId, run };
}
function configuredRoute(provider: NonNullable<DraftModelRouteConfig['reservationist']>): DraftModelRouteConfig {
  return {
    route: { routeId: 'synthetic-parser-route', modelId: 'synthetic', purpose: 'draft', protocol: 'in_process', access: 'current_app', egress: 'none', retention: 'bounded', usage: 'reported' },
    transport: async () => { throw new Error('No model call in parser regression'); },
    release: { releaseId: 'synthetic-parser-release', releaseVersion: '1', sourceRevision: 'synthetic-test', fingerprint: 'b'.repeat(64), purpose: 'draft', capabilityFamilyVersions: { reservationist: 'reservationist-runtime-v1' }, issuedAt: '2026-01-01T00:00:00Z', expiresAt: '2099-01-01T00:00:00Z', withdrawn: false },
    reservationist: provider,
  };
}

/**
 * Task 4: strict HMS shadow terminal persistence + lane/mode contracts.
 * DB-backed cases skip unless disposable TEST_DATABASE_URL + CONFIRM=1.
 * Never pilot RDS. HMS_DB_TEST_REQUIRED=1 fails closed when disposable missing.
 */
import {
  filterExactReservationCandidates,
  requireExactlyOneExactCandidate,
  selectOldestWithExactlyOneExact,
  type BuildThreadContextInput,
  type ThreadContext,
} from '../src/ai/thread-context.js';
import {
  classifyHmsShadowFailure,
  finishHmsShadowRun,
  hmsShadowMetricsSchema,
  HMS_MANUAL_OPS_REQUIRED,
  resolveHmsShadowPreBrowser,
} from '../src/ai/hms-shadow.js';
import {
  minimizeToolResultForModel,
  createMockCandidateSession,
  createCandidateTools,
} from '../src/ai/candidate-draft-agent.js';
import {
  aiDraftGeneration,
  aiWorkflowRun,
  mailDraft,
  mailDraftRevision,
} from '../src/db/schema/mail.js';
import { enqueueAiRun, claimNextAiRun, markAiRunRunning } from '../src/ai/run-ledger.js';
import { TEST_DB_AVAILABLE, probeTestDb, withSeededTestDb } from './helpers/test-db.js';
import { claimsFromToolResult } from '../src/ai/candidate-draft-agent.js';
import { aiWorkerOwnerId, executeAiRun } from '../src/ai/worker.js';
import { mailThread, message } from '../src/db/schema/mail.js';
import { shouldRetryAiFailure } from '../src/ai/run-ledger.js';
import type { ToolResult } from '../src/ai/draft-evidence.js';
import { __setDbForTests } from '../src/db/client.js';
import { describe, expect, it, vi } from 'vitest';
import { TRANSPORT_ID } from '../src/db/seed.js';
import { dirname, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { readFileSync } from 'node:fs';
import { eq, sql } from 'drizzle-orm';

const reachable = await probeTestDb();
const here = dirname(fileURLToPath(import.meta.url));

describe('hms shadow lane/mode (DB-free)', () => {
  it('hms-shadow never imports drafts / persistAiCandidateDraft', () => {
    const source = readFileSync(join(here, '..', 'src', 'ai', 'hms-shadow.ts'), 'utf8');
    expect(source).not.toMatch(/from ['"]\.\/drafts/);
    expect(source).not.toMatch(/persistAiCandidateDraft\s*\(/);
    expect(source).toMatch(/finishHmsShadowRun/);
    expect(source).toMatch(/failHmsShadowRun/);
    expect(source).toMatch(/hmsShadowMetricsSchema/);
  });

  it('Task 5 proof runner source: isolation, enqueue shape, rollback', () => {
    const proof = readFileSync(join(here, '..', 'src', 'ops', 'hms-live-proof.ts'), 'utf8');
    expect(proof).toMatch(/hms-proof:\$\{proofAttemptId\}:|hms-proof:<|`hms-proof:/);
    expect(proof).toMatch(/executorLane:\s*'hms'/);
    expect(proof).toMatch(/generationId:\s*null/);
    expect(proof).toMatch(/RUN_ISOLATION_BLOCKED/);
    expect(proof).toMatch(/countNonterminalAiRuns|NONTERMINAL_AI_RUN_STATES/);
    expect(proof).toMatch(/HMS_ROLLBACK_OK/);
    expect(proof).toMatch(/HMS_SHADOW_OK/);
    expect(proof).toMatch(/canary-proof|CanaryProof/);
    expect(proof).toMatch(/shadow-proof|ShadowProof/);
    expect(proof).not.toMatch(/process\.argv.*confirmation|argv\[[^\]]+\].*threadId/);
    // Proof writers must not persist guest/HMS cell values (digests only).
    expect(proof).toMatch(/writeAtomicJson/);
    expect(proof).not.toMatch(/writeAtomicJson\([^)]*guestName/);
    expect(proof).toMatch(/valuesCaptured:\s*false/);
  });

  it('worker HMS shadow branch uses finishHmsShadowRun, not persistAiCandidateDraft', () => {
    const source = readFileSync(join(here, '..', 'src', 'ai', 'worker.ts'), 'utf8');
    expect(source).toMatch(/finishHmsShadowRun/);
    expect(source).toMatch(/failHmsShadowRun/);
    expect(source).toMatch(/createLiveHmsCandidateSessionFactory/);
    expect(source).toMatch(/createProductionHmsRuntime|getOrCreateProductionHmsRuntime/);
    expect(source).toMatch(/probeAttachmentIds:\s*\[\s*\]/);
    expect(source).toMatch(/probeCandidateIds:\s*\[\s*pre\.exact\.id\s*\]/);
    expect(source).toMatch(/resolveHmsShadowPreBrowser/);
    // HMS branch gated on executorLane === 'hms'
    expect(source).toMatch(/executorLane === 'hms'/);
    // Default lane never starts HMS runtime in maybeInit
    expect(source).toMatch(/lane !== 'hms'/);
    // off mode claims none
    expect(source).toMatch(/HMS_DRAFT_ENRICHMENT_MODE === 'off'/);
    expect(source).toMatch(/dependencyRevision:\s*'playwright-1\.63\.0-chromium-1243'/);
    // No production mock fallback on HMS path
    const hmsBlock = source.slice(
      source.indexOf("executorLane === 'hms'"),
      source.indexOf('Non-HMS claim-safe path'),
    );
    expect(hmsBlock).not.toMatch(/createMockCandidateSession/);
    expect(hmsBlock).not.toMatch(/persistAiCandidateDraft/);
  });

  it('worker closes HMS runtime before DB on loop and scoped-drain failures', () => {
    const source = readFileSync(join(here, '..', 'src', 'ai', 'worker.ts'), 'utf8');
    const loop = source.slice(
      source.indexOf('export async function runAiWorkerLoop'),
      source.indexOf('async function main()'),
    );
    const main = source.slice(source.indexOf('async function main()'));
    expect(loop).toMatch(
      /try\s*\{[\s\S]*while \(!stopping\)[\s\S]*\}\s*finally\s*\{[\s\S]*await closeAiWorkerResources\(\)/,
    );
    expect(main).toMatch(
      /if \(scoped\)[\s\S]*try\s*\{[\s\S]*runAiWorkerDrain[\s\S]*\}\s*finally\s*\{\s*await closeAiWorkerResources\(\)/,
    );
    const singletonClose = source.slice(
      source.indexOf('export async function closeProductionHmsRuntimeForTests'),
      source.indexOf('export function createLiveHmsCandidateSessionFactory'),
    );
    expect(singletonClose).not.toMatch(/\.close\(\)\.catch/);
  });

  it('CandidateSessionFactory is async Promise-returning', () => {
    const source = readFileSync(join(here, '..', 'src', 'ai', 'worker.ts'), 'utf8');
    expect(source).toMatch(/export type CandidateSessionFactory/);
    expect(source).toMatch(
      /Promise<import\('\.\/candidate-draft-agent\.js'\)\.CandidateToolSession>/,
    );
  });

  it('enabled mode rejected at env; shadow metrics schema is strict', () => {
    expect(() =>
      hmsShadowMetricsSchema.parse({
        outcome: 'candidate',
        toolCalls: 1,
        toolBudgetUsed: 1,
        claimCount: 2,
        guestName: 'SHOULD_REJECT',
      }),
    ).toThrow();
    expect(
      hmsShadowMetricsSchema.parse({
        outcome: 'insufficient_evidence',
        toolCalls: 0,
        toolBudgetUsed: 0,
        claimCount: 0,
      }),
    ).toMatchObject({ outcome: 'insufficient_evidence' });
  });

  it('failure classifier strips synthetic PII tokens to fixed AiFailureClass', () => {
    const err = new Error(
      'Guest Alice Example at 12 Fake St reservation CONF-SECRET-999 failed auth',
    );
    const cls = classifyHmsShadowFailure(err);
    expect(cls).toBe('AUTH');
    expect(cls).not.toMatch(/Alice|CONF-SECRET|Fake St/);
  });

  it('AUDIT_CAPTURE is nonretryable and never echoes raw artifact paths', () => {
    const err = Object.assign(new Error('TRACE_FINALIZE_FAILED'), {
      code: 'AUDIT_CAPTURE',
      name: 'HmsRuntimeError',
    });
    expect(classifyHmsShadowFailure(err)).toBe('AUDIT_CAPTURE');
    expect(
      classifyHmsShadowFailure(
        Object.assign(new Error('/opt/nava/shared/hms-browser-artifacts/x'), {
          code: 'TRACE_START_FAILED',
        }),
      ),
    ).toBe('AUDIT_CAPTURE');
    expect(
      shouldRetryAiFailure({
        failureClass: 'AUDIT_CAPTURE',
        fence: {
          runId: '00000000-0000-4000-8000-000000000001',
          claimOwner: 't',
          claimToken: 't',
          deadlineAt: new Date(Date.now() + 60_000),
        },
        attempts: 0,
      }),
    ).toBe(false);
  });

  it('refresh route source fails closed with HMS_MANUAL_OPS_REQUIRED in shadow', () => {
    const ai = readFileSync(join(here, '..', 'src', 'trpc', 'routes', 'ai.ts'), 'utf8');
    expect(ai).toMatch(/HMS_MANUAL_OPS_REQUIRED/);
    expect(ai).toMatch(/HMS_DRAFT_ENRICHMENT_MODE\s*===\s*['"]shadow['"]/);
    const drafts = readFileSync(join(here, '..', 'src', 'trpc', 'routes', 'drafts.ts'), 'utf8');
    expect(drafts).toMatch(/HMS_MANUAL_OPS_REQUIRED|hmsMode === 'shadow'/);
    // Candidate refreshes run on the default worker; the isolated HMS lane is read/shadow-only.
    expect(drafts).toMatch(/executorLane:\s*'default'/);
    expect(HMS_MANUAL_OPS_REQUIRED).toBe('HMS_MANUAL_OPS_REQUIRED');
  });

  it('exact candidate filter drops surname_dates before browser', () => {
    const exact = filterExactReservationCandidates([
      { id: 'a', kind: 'confirmation', value: 'CONF-1' },
      {
        id: 'b',
        kind: 'surname_dates',
        surname: 'Example',
        arrivalDate: '2026-08-01',
        departureDate: '2026-08-03',
      },
    ]);
    expect(exact).toHaveLength(1);
    expect(exact[0]!.kind).toBe('confirmation');
  });

  it('model boundary: minimized output has status/claim ids/kinds only', async () => {
    const session = createMockCandidateSession({
      lookupCandidates: new Map([
        ['cand-1', { id: 'cand-1', kind: 'confirmation', value: 'CONF-RAW-VALUE' }],
      ]),
      findReservation: async () =>
        ({
          status: 'ok',
          draftReady: true,
          unresolvedFields: [],
          data: {
            matches: [
              {
                confirmationNumber: 'CONF-RAW-VALUE',
                externalReference: null,
                guestName: 'Synth Guest PII',
                arrivalDate: '2026-08-01',
                departureDate: '2026-08-03',
                reservationStatus: 'Confirmed',
                roomType: 'STD',
                ratePlan: null,
              },
            ],
            matchCount: 1,
            capped: false,
          },
          evidence: {
            kind: 'hms',
            id: 'ev-1',
            toolId: 'hms_find_reservation',
            toolVersion: '1.2.0',
            propertyCode: 'HRCEN',
            observedAt: new Date().toISOString(),
            expiresAt: new Date(Date.now() + 60_000).toISOString(),
            claimKeys: ['matches.0.confirmationNumber'],
            sourceHash: 'a'.repeat(64),
          },
        }) satisfies ToolResult<unknown>,
    });
    const bundle = createCandidateTools(session);
    const raw = await bundle.tools.hms_find_reservation!.execute!(
      { candidateId: 'cand-1' },
      { abortSignal: new AbortController().signal },
    );
    const claims = claimsFromToolResult(raw as ToolResult<unknown>);
    const minimized = minimizeToolResultForModel(raw as ToolResult<unknown>, claims);
    const serialized = JSON.stringify(minimized);
    expect(serialized).not.toMatch(/Synth Guest|CONF-RAW-VALUE|<html|selector|DOM/i);
    expect(minimized).toMatchObject({
      status: 'ok',
      draftReady: true,
    });
    expect(Array.isArray(minimized.claimIds)).toBe(true);
    expect(Array.isArray(minimized.claimKinds)).toBe(true);
  });

  it('requireExactlyOneExactCandidate rejects 0 and 2+', () => {
    expect(requireExactlyOneExactCandidate([])).toBeNull();
    expect(
      requireExactlyOneExactCandidate([
        { id: 'a', kind: 'confirmation', value: 'CONF-1001' },
        { id: 'b', kind: 'confirmation', value: 'CONF-1002' },
      ]),
    ).toBeNull();
    expect(
      requireExactlyOneExactCandidate([
        { id: 'a', kind: 'confirmation', value: 'CONF-1001' },
        {
          id: 's',
          kind: 'surname_dates',
          surname: 'X',
          arrivalDate: '2026-01-01',
          departureDate: '2026-01-02',
        },
      ]),
    ).toMatchObject({ id: 'a', kind: 'confirmation' });
  });

  it('selectOldestWithExactlyOneExact picks oldest eligible not newest', () => {
    const rows = [
      {
        id: 'new',
        receivedAt: new Date('2026-06-01T00:00:00Z'),
        text: 'Confirmation NEW-CONF-2 please',
      },
      {
        id: 'old',
        receivedAt: new Date('2026-01-01T00:00:00Z'),
        text: 'Confirmation OLD-CONF-1 please',
      },
      {
        id: 'mid-ambiguous',
        receivedAt: new Date('2026-03-01T00:00:00Z'),
        text: 'Confirmation A1 and Confirmation A2',
      },
    ];
    const picked = selectOldestWithExactlyOneExact(rows, (r) => r.text);
    expect(picked?.row.id).toBe('old');
    expect(picked?.candidate.value).toBe('OLD-CONF-1');
  });

  it('resolveHmsShadowPreBrowser reloads draft revision on pass 2', async () => {
    let revCalls = 0;
    const revs = ['rev-1', 'rev-2'];
    const msg = {
      id: 'm1',
      transportId: 't',
      threadId: 'th',
      direction: 'inbound' as const,
      textBody: 'Confirmation ONLY-ONE-1 please',
      htmlBody: null,
      subject: 's',
      receivedAt: new Date('2026-01-01T00:00:00Z'),
      sentAt: null,
      attachmentIds: [] as string[],
    };
    const stubBuild = async (input: BuildThreadContextInput): Promise<ThreadContext> => ({
      includedMessageIds: [msg.id],
      threadStateVersion: `v:${input.latestDraftRevisionId ?? 'null'}`,
      normalizedText: msg.textBody ?? '',
      lookupCandidates: [{ id: 'cand-1', kind: 'confirmation', value: 'ONLY-ONE-1' }],
      authorizedAttachmentIds: [],
    });

    const stale = await resolveHmsShadowPreBrowser({
      transportId: 't',
      threadId: 'th',
      triggerMessageId: 'm1',
      loadLatestDraftRevisionId: async () => revs[revCalls++] ?? null,
      loadMessages: async () => [msg],
      buildThreadContext: stubBuild,
    });
    expect(stale).toEqual({ kind: 'stale_thread' });
    expect(revCalls).toBe(2);

    revCalls = 0;
    const stableRevs = ['rev-same', 'rev-same'];
    const ready = await resolveHmsShadowPreBrowser({
      transportId: 't',
      threadId: 'th',
      triggerMessageId: 'm1',
      loadLatestDraftRevisionId: async () => stableRevs[revCalls++] ?? null,
      loadMessages: async () => [msg],
      buildThreadContext: stubBuild,
    });
    expect(ready.kind).toBe('ready');
    if (ready.kind === 'ready') {
      expect(ready.exact.value).toBe('ONLY-ONE-1');
    }
  });

  it('resolveHmsShadowPreBrowser insufficient_evidence when not exactly one', async () => {
    const msg = {
      id: 'm1',
      transportId: 't',
      threadId: 'th',
      direction: 'inbound' as const,
      textBody: 'x',
      htmlBody: null,
      subject: 's',
      receivedAt: new Date('2026-01-01T00:00:00Z'),
      sentAt: null,
      attachmentIds: [] as string[],
    };
    const result = await resolveHmsShadowPreBrowser({
      transportId: 't',
      threadId: 'th',
      triggerMessageId: 'm1',
      loadLatestDraftRevisionId: async () => null,
      loadMessages: async () => [msg],
      buildThreadContext: async () => ({
        includedMessageIds: [msg.id],
        threadStateVersion: 'v1',
        normalizedText: 'x',
        lookupCandidates: [
          { id: 'a', kind: 'confirmation', value: 'CONF-1001' },
          { id: 'b', kind: 'confirmation', value: 'CONF-1002' },
        ],
        authorizedAttachmentIds: [],
      }),
    });
    expect(result).toEqual({ kind: 'insufficient_evidence', exactCount: 2 });
  });

  it('runs authorized two-pass PDF fallback and keeps extracted text private', async () => {
    const context = {
      transportId: 't',
      threadId: 'th',
      triggerMessageId: 'm1',
      includedMessageIds: ['m1'],
      threadStateVersion: 'thread-v1',
      normalizedText: 'Please locate attached booking.',
      lookupCandidates: [],
      authorizedAttachmentIds: ['att-1'],
    } satisfies ThreadContext;
    let snapshotCalls = 0;
    const modelVisible: string[] = [];
    const result = await resolveHmsShadowPreBrowser(
      {
        transportId: 't',
        threadId: 'th',
        triggerMessageId: 'm1',
        loadLatestDraftRevisionId: async () => null,
        loadMessages: async () => [],
        loadArtifactSnapshot: async () => {
          snapshotCalls += 1;
          return {
            grantDigest: 'grant-v1',
            attachmentStateVersion: 'attachments-v1',
            context,
            pdfAttachmentIds: ['att-1'],
          };
        },
        readArtifact: async () => ({
          status: 'ok',
          draftReady: false,
          data: {
            mimeType: 'application/pdf',
            text: 'Confirmation CONF-88421',
            pageCount: 1,
            reason: 'text',
          },
          unresolvedFields: [],
          evidence: {
            kind: 'mail_attachment',
            id: 'ev-artifact',
            toolId: 'mail_read_artifact',
            toolVersion: '2',
            attachmentId: 'att-1',
            observedAt: new Date().toISOString(),
            sourceHash: 'a'.repeat(64),
            claimKeys: [],
          },
        }),
        recheckArtifactIdentity: async ({ expectedSha256 }) => expectedSha256 === 'a'.repeat(64),
      },
      {
        signal: new AbortController().signal,
        onModelVisible: (value) => modelVisible.push(JSON.stringify(value)),
      },
    );
    expect(snapshotCalls).toBe(2);
    expect(result).toMatchObject({
      kind: 'ready',
      exact: { kind: 'confirmation', value: 'CONF-88421' },
      artifactMetrics: {
        attempted: 1,
        readable: 1,
        manualRequired: 0,
      },
    });
    expect(modelVisible.join('')).not.toContain('CONF-88421');
  });

  it('skips PDFs for body exact and dedupes identical artifact candidates', async () => {
    const makeContext = (lookupCandidates: ThreadContext['lookupCandidates']) =>
      ({
        transportId: 't',
        threadId: 'th',
        triggerMessageId: 'm1',
        includedMessageIds: ['m1'],
        threadStateVersion: 'v1',
        normalizedText: 'private body',
        lookupCandidates,
        authorizedAttachmentIds: ['a', 'b'],
      }) satisfies ThreadContext;
    const readArtifact = vi.fn(async (attachmentId: string) => ({
      status: 'ok' as const,
      draftReady: false,
      data: {
        mimeType: 'application/pdf' as const,
        text: 'Confirmation CONF-SAME-100',
        pageCount: 1,
        reason: 'text' as const,
      },
      unresolvedFields: [],
      evidence: {
        kind: 'mail_attachment' as const,
        id: `ev-${attachmentId}`,
        toolId: 'mail_read_artifact' as const,
        toolVersion: '2',
        attachmentId,
        observedAt: new Date().toISOString(),
        sourceHash: 'a'.repeat(64),
        claimKeys: [],
      },
    }));
    const execute = async (context: ThreadContext) =>
      resolveHmsShadowPreBrowser({
        transportId: 't',
        threadId: 'th',
        triggerMessageId: 'm1',
        loadLatestDraftRevisionId: async () => null,
        loadMessages: async () => [],
        loadArtifactSnapshot: async () => ({
          grantDigest: 'grant',
          attachmentStateVersion: 'attachments',
          context,
          pdfAttachmentIds: ['a', 'b'],
        }),
        readArtifact,
        recheckArtifactIdentity: async () => true,
      });
    const bodyReady = await execute(
      makeContext([
        {
          id: 'body',
          kind: 'confirmation',
          value: 'CONF-BODY-100',
        },
      ]),
    );
    expect(bodyReady.kind).toBe('ready');
    expect(readArtifact).not.toHaveBeenCalled();

    const artifactReady = await execute(makeContext([]));
    expect(artifactReady).toMatchObject({
      kind: 'ready',
      exact: { value: 'CONF-SAME-100' },
      artifactMetrics: { attempted: 2, readable: 2 },
    });
  });

  it('rejects authorization, attachment, identity drift and more than three PDFs', async () => {
    const base = {
      transportId: 't',
      threadId: 'th',
      triggerMessageId: 'm1',
      includedMessageIds: ['m1'],
      threadStateVersion: 'thread-v1',
      normalizedText: 'No exact reference.',
      lookupCandidates: [],
      authorizedAttachmentIds: ['a', 'b', 'c', 'd'],
    } satisfies ThreadContext;
    const run = async (second: {
      grantDigest?: string | null;
      attachmentStateVersion?: string;
      identityOk?: boolean;
      pdfs?: string[];
    }) => {
      let pass = 0;
      return resolveHmsShadowPreBrowser({
        transportId: 't',
        threadId: 'th',
        triggerMessageId: 'm1',
        loadLatestDraftRevisionId: async () => null,
        loadMessages: async () => [],
        loadArtifactSnapshot: async () => {
          pass += 1;
          return {
            grantDigest:
              pass === 1
                ? 'grant-v1'
                : second.grantDigest === undefined
                  ? 'grant-v1'
                  : second.grantDigest,
            attachmentStateVersion:
              pass === 1 ? 'attachments-v1' : (second.attachmentStateVersion ?? 'attachments-v1'),
            context: base,
            pdfAttachmentIds: second.pdfs ?? ['a'],
          };
        },
        readArtifact: async (attachmentId) => ({
          status: 'ok',
          draftReady: false,
          data: {
            mimeType: 'application/pdf',
            text: `Confirmation CONF-${attachmentId}-100`,
            pageCount: 1,
            reason: 'text',
          },
          unresolvedFields: [],
          evidence: {
            kind: 'mail_attachment',
            id: `ev-${attachmentId}`,
            toolId: 'mail_read_artifact',
            toolVersion: '2',
            attachmentId,
            observedAt: new Date().toISOString(),
            sourceHash: 'a'.repeat(64),
            claimKeys: [],
          },
        }),
        recheckArtifactIdentity: async () => second.identityOk ?? true,
      });
    };
    await expect(run({ grantDigest: null })).resolves.toEqual({
      kind: 'authorization_denied',
    });
    await expect(run({ attachmentStateVersion: 'attachments-v2' })).resolves.toEqual({
      kind: 'stale_thread',
    });
    await expect(run({ identityOk: false })).resolves.toEqual({
      kind: 'stale_thread',
    });
    const four = await run({ pdfs: ['a', 'b', 'c', 'd'] });
    expect(four).toEqual({ kind: 'insufficient_evidence', exactCount: 0 });
  });

  it('worker HMS path wires resolveHmsShadowPreBrowser + exactly-one session', () => {
    const worker = readFileSync(join(here, '..', 'src', 'ai', 'worker.ts'), 'utf8');
    expect(worker).toMatch(/resolveHmsShadowPreBrowser/);
    expect(worker).toMatch(/lookupCandidates:\s*\[pre\.exact\]/);
  });
});

describe.skipIf(!TEST_DB_AVAILABLE || !reachable)('hms shadow persistence (disposable DB)', () => {
  it('finishHmsShadowRun leaves generation/draft/revision untouched and generationId null', async () => {
    await withSeededTestDb(async (db) => {
      const transportId = TRANSPORT_ID;
      const threadId = randomUUID();
      const messageId = randomUUID();
      await db.insert(mailThread).values({
        id: threadId,
        transportId,
        threadRootId: `<root-${threadId}@example.com>`,
        subject: 'Shadow',
        snippet: 'x',
        latestMessageAt: new Date(),
      });
      await db.insert(message).values({
        id: messageId,
        transportId,
        threadId,
        direction: 'inbound',
        fromAddress: 'guest@example.com',
        toAddresses: ['nava@example.com'],
        subject: 'CONF-ONLY-TEST',
        textBody: 'Confirmation CONF-ONLY-TEST please',
        receivedAt: new Date(),
      });

      const before = await snapshotForbidden(db, transportId);

      const run = await enqueueAiRun(
        {
          transportId,
          threadId,
          triggerMessageId: messageId,
          runKind: 'candidate_draft',
          idempotencyKey: `hms-shadow-persist:${messageId}`,
          modelId: 'amazon.nova-lite-v1:0',
          promptVersion: 'draft-v1',
          executorLane: 'hms',
        },
        db,
      );
      const claimed = await claimNextAiRun({
        ownerId: aiWorkerOwnerId('hms'),
        lane: 'hms',
        db,
      });
      expect(claimed?.id).toBe(run.id);
      await markAiRunRunning(
        {
          runId: claimed!.id,
          claimOwner: claimed!.claimOwner!,
          claimToken: claimed!.claimToken!,
          deadlineAt: claimed!.deadlineAt!,
        },
        db,
      );

      const ok = await finishHmsShadowRun(
        {
          runId: claimed!.id,
          claimOwner: claimed!.claimOwner!,
          claimToken: claimed!.claimToken!,
          deadlineAt: claimed!.deadlineAt!,
        },
        {
          outcome: 'candidate',
          toolCalls: 1,
          toolBudgetUsed: 1,
          claimCount: 2,
        },
        db,
      );
      expect(ok).toBe(true);

      const [finished] = await db
        .select()
        .from(aiWorkflowRun)
        .where(eq(aiWorkflowRun.id, run.id))
        .limit(1);
      expect(finished?.state).toBe('succeeded');
      expect(finished?.generationId).toBeNull();
      expect(finished?.metrics).toMatchObject({
        outcome: 'candidate',
        toolCalls: 1,
        toolBudgetUsed: 1,
        claimCount: 2,
      });

      const after = await snapshotForbidden(db, transportId);
      expect(after).toEqual(before);
    });
  });

  it('HMS shadow execute with injectable factory never writes draft tables; fail strips PII', async () => {
    await withSeededTestDb(async (db) => {
      // executeAiRun resolves its handle via getDb(); point it at the tx handle
      // so it sees rows seeded in this uncommitted transaction.
      __setDbForTests({ db, conn: null as never });
      try {
        process.env.HMS_DRAFT_ENRICHMENT_MODE = 'shadow';
        process.env.AI_DRAFTS_ENABLED = 'false';
        const transportId = TRANSPORT_ID;
        const threadId = randomUUID();
        const messageId = randomUUID();
        await db.insert(mailThread).values({
          id: threadId,
          transportId,
          threadRootId: `<root-${threadId}@example.com>`,
          subject: 'Booking CONF-XYZ',
          snippet: 'x',
          latestMessageAt: new Date(),
        });
        await db.insert(message).values({
          id: messageId,
          transportId,
          threadId,
          direction: 'inbound',
          fromAddress: 'guest@example.com',
          toAddresses: ['nava@example.com'],
          subject: 'Booking CONF-XYZ',
          textBody: 'Please check confirmation CONF-XYZ',
          receivedAt: new Date(),
        });

        const before = await snapshotForbidden(db, transportId);
        const run = await enqueueAiRun(
          {
            transportId,
            threadId,
            triggerMessageId: messageId,
            runKind: 'candidate_draft',
            idempotencyKey: `hms-shadow-exec:${messageId}`,
            modelId: 'amazon.nova-lite-v1:0',
            promptVersion: 'draft-v1',
            executorLane: 'hms',
          },
          db,
        );
        await claimNextAiRun({
          ownerId: aiWorkerOwnerId('hms'),
          lane: 'hms',
          db,
        });

        const result = await executeAiRun(run.id, {
          candidateSessionFactory: async () => {
            throw Object.assign(new Error('Guest SynthPII Address 99 Fake Rd CONF-LEAK'), {
              failureClass: 'POLICY_BLOCK',
            });
          },
        });
        expect(result.state).toBe('dead_letter');

        const [finished] = await db
          .select()
          .from(aiWorkflowRun)
          .where(eq(aiWorkflowRun.id, run.id))
          .limit(1);
        expect(finished?.failureClass).toBe('POLICY_BLOCK');
        expect(finished?.lastError).toBe('POLICY_BLOCK');
        expect(finished?.lastError).not.toMatch(/SynthPII|Fake Rd|CONF-LEAK/);

        const after = await snapshotForbidden(db, transportId);
        expect(after).toEqual(before);

        delete process.env.HMS_DRAFT_ENRICHMENT_MODE;
        delete process.env.AI_DRAFTS_ENABLED;
      } finally {
        __setDbForTests(null);
      }
    });
  });

  it('enqueueHmsCandidateRefresh in shadow throws HMS_MANUAL_OPS_REQUIRED before insert', async () => {
    await withSeededTestDb(async (db) => {
      process.env.HMS_DRAFT_ENRICHMENT_MODE = 'shadow';
      const before = await snapshotForbidden(db, TRANSPORT_ID);
      const { enqueueHmsCandidateRefresh } = await import('../src/trpc/routes/drafts.js');
      await expect(
        enqueueHmsCandidateRefresh({
          db,
          transportId: TRANSPORT_ID,
          threadId: 'thread-does-not-matter',
          triggerMessageId: 'msg-x',
          requestedByUserId: 'user-1',
        }),
      ).rejects.toMatchObject({ message: 'HMS_MANUAL_OPS_REQUIRED' });
      const after = await snapshotForbidden(db, TRANSPORT_ID);
      expect(after).toEqual(before);
      delete process.env.HMS_DRAFT_ENRICHMENT_MODE;
    });
  });
});

async function snapshotForbidden(
  db: Parameters<Parameters<typeof withSeededTestDb>[0]>[0],
  transportId: string,
) {
  const [gens] = await db
    .select({ c: sql<number>`count(*)::int` })
    .from(aiDraftGeneration)
    .where(eq(aiDraftGeneration.transportId, transportId));
  const [drafts] = await db
    .select({ c: sql<number>`count(*)::int` })
    .from(mailDraft)
    .where(eq(mailDraft.transportId, transportId));
  const [revs] = await db
    .select({ c: sql<number>`count(*)::int` })
    .from(mailDraftRevision)
    .innerJoin(mailDraft, eq(mailDraftRevision.draftId, mailDraft.id))
    .where(eq(mailDraft.transportId, transportId));
  return {
    aiDraftGeneration: Number(gens?.c ?? 0),
    mailDraft: Number(drafts?.c ?? 0),
    mailDraftRevision: Number(revs?.c ?? 0),
  };
}

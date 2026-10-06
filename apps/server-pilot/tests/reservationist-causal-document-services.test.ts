import {
  createReservationistDependencies,
  ReservationistTaskEvidenceUnavailable,
  type ReservationistExecutionServices,
} from '../src/ai/reservationist-execution.js';
import {
  localEvaluationInputHash,
  LOCAL_EVALUATION_VERSION,
} from '../src/ai/reservationist-evaluation-composition.js';
import { syntheticReservationistDocumentFixture } from './helpers/synthetic-reservationist-document.js';
import type { ExistingDocumentRecord } from '../src/mail/artifacts/existing-document-service.js';
import { describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';

type TestContext = Parameters<
  NonNullable<ReservationistExecutionServices['resolveExistingDocument']>
>[0];
const hash = (v: Buffer | string) => createHash('sha256').update(v).digest('hex');
// Missing implementation is an assertion failure, never a silently skipped service test.
async function create(options: any) {
  const module = await import('../src/ai/reservationist-causal-document-services.js').catch(() => ({
    createReservationistCausalDocumentServices: undefined,
  }));
  expect(
    module.createReservationistCausalDocumentServices,
    'causal document service must acquire original bytes',
  ).toBeTypeOf('function');
  return module.createReservationistCausalDocumentServices!(options);
}
function fixture() {
  const f = syntheticReservationistDocumentFixture('receipt'),
    at = '2026-10-03T08:00:00Z',
    body = f.document.body,
    sourceHash = hash(body),
    message = 'Original receipt attached.';
  const metadata = {
    attachmentId: 'original',
    messageId: 'prior',
    threadId: 'thread',
    ownerRef: 'owner',
    messageAt: at,
    mimeType: 'application/pdf',
    sizeBytes: body.length,
    sourceHash,
    disclosure: 'staff_only' as const,
  };
  const locator = {
    s3Key: 'attachments/prior/original.pdf',
    mimeType: 'application/pdf',
    sizeBytes: body.length,
    messageId: 'prior',
  };
  const record: ExistingDocumentRecord = {
    sourceRecordId: 'original',
    scopeRef: 'source-scope',
    source: 'mail_attachment',
    kind: 'other_existing',
    version: 'unknown',
    issuedAt: at,
    status: 'unknown',
    parentRef: null,
    payerRef: null,
    displayName: 'Original.pdf',
    mime: 'application/pdf',
    sizeBytes: body.length,
    sha256: sourceHash,
    priceVisibility: 'unknown',
    propertyRef: 'HRCEN',
    guestRef: null,
    stayStart: null,
    stayEnd: null,
    currentVersion: false,
    validation: {
      identity: 'unknown',
      stayDates: 'unknown',
      payer: 'unknown',
      kind: 'unknown',
      version: 'unknown',
      priceVisibility: 'unknown',
    },
    attachment: {
      attachmentId: 'original',
      authorizedAttachmentIds: new Set(['original']),
      locator,
      expectedSha256: sourceHash,
    },
  };
  const input: any = {
    version: 1,
    requestId: 'request',
    propertyCode: 'HRCEN',
    authorizationScope: { ownerRef: 'owner', threadId: 'thread' },
    trigger: { id: 'message', at: f.input.clock.causalAt },
    messages: [
      { id: 'prior', at, direction: 'outbound', text: message, disclosure: 'staff_only' },
      {
        id: 'message',
        at: f.input.clock.causalAt,
        direction: 'inbound',
        text: f.input.originalRequest.text,
        disclosure: 'guest',
      },
    ],
    authorizedArtifacts: [{ attachmentId: 'original', sourceHash }],
    clock: f.input.clock,
    capabilities: { pmsWrite: false, emailSend: false },
  };
  const authorization: any = {
    version: LOCAL_EVALUATION_VERSION,
    kind: 'user_authorized_local_evaluation',
    authorizationSource: 'reservationist-recovery-user-20261004',
    scope: 'local_disposable_evaluation',
    issuedAt: new Date().toISOString(),
    inputHash: localEvaluationInputHash(input),
    pmsWrite: false,
    emailSend: false,
    productionDraftWrite: false,
  };
  let reads = 0,
    authorizations = 0;
  const options: any = {
    input,
    authorization,
    sources: [{ metadata, filename: 'Original.pdf', record }],
    authorizeSourceRead: async () => {
      authorizations++;
      return true;
    },
    readBytes: async () => {
      reads++;
      return {
        body: Buffer.from(body),
        contentType: 'application/pdf',
        sha256: sourceHash,
        locator: { ...locator },
      };
    },
    readArtifact: async () => ({
      status: 'ok',
      draftReady: false,
      data: { mimeType: 'application/pdf', text: 'Receipt ABC123', pageCount: 1, reason: 'text' },
      unresolvedFields: [],
      evidence: {
        kind: 'mail_attachment',
        toolId: 'mail_read_artifact',
        toolVersion: '2',
        attachmentId: 'original',
        observedAt: at,
        sourceHash,
        claimKeys: [],
      },
    }),
  };
  const task: TestContext['task'] = {
    id: 'doc',
    kind: 'existing_document',
    factIds: ['ref'],
    source: {
      attachmentId: 'message:message',
      sourceHash: f.input.taskSource.sourceHash,
      page: 1,
      quote: f.input.taskSource.quote,
      start: 0,
      end: f.input.taskSource.end,
    },
  };
  const fact: TestContext['facts'][number] = {
    id: 'ref',
    kind: 'reservation_reference',
    value: 'ABC123',
    source: task.source,
    disclosure: 'guest',
    verification: 'text_verified',
    authority: 'customer_claim',
  };
  return {
    f,
    input,
    authorization,
    options,
    task,
    fact,
    body,
    metadata,
    record,
    counts: () => ({ reads, authorizations }),
  };
}
describe('authorized original causal document service', () => {
  it('does not acquire an unrelated document kind or exact foreign target before resolving the selected task', async () => {
    const f = fixture();
    const unrelated = structuredClone(f.options.sources[0]);
    unrelated.metadata.attachmentId = 'unrelated';
    unrelated.metadata.messageId = 'other-prior';
    unrelated.record.sourceRecordId = 'unrelated';
    unrelated.record.kind = 'tax_invoice';
    unrelated.record.attachment.attachmentId = 'unrelated';
    unrelated.record.attachment.authorizedAttachmentIds = new Set(['unrelated']);
    unrelated.record.attachment.locator.messageId = 'other-prior';
    unrelated.record.attachment.locator.s3Key = 'attachments/other-prior/original.pdf';
    f.input.messages.push({
      id: 'other-prior',
      at: unrelated.metadata.messageAt,
      direction: 'outbound',
      text: 'Unrelated prior attachment',
      disclosure: 'staff_only',
    });
    f.input.authorizedArtifacts.push({
      attachmentId: 'unrelated',
      sourceHash: unrelated.metadata.sourceHash,
    });
    f.authorization.inputHash = localEvaluationInputHash(f.input);
    f.options.sources.push(unrelated);
    let selectedReads = 0;
    f.options.authorizeSourceRead = async (source: any) => {
      if (source.metadata.attachmentId === 'unrelated') throw new Error('unrelated source denied');
      selectedReads++;
      return true;
    };
    const s = await create(f.options);
    await expect(
      s.services.resolveExistingDocument!({
        task: f.task,
        facts: [f.fact],
        input: f.input,
        signal: new AbortController().signal,
      }),
    ).rejects.toBeInstanceOf(ReservationistTaskEvidenceUnavailable);
    expect(selectedReads).toBeGreaterThan(0);
    expect(s.collectSourceAcquisitions()).toHaveLength(1);
  });

  it('reports every missing assertion for a same-task diagnostic without selecting a guessed target', async () => {
    const f = fixture();
    f.record.parentRef = 'ABC123';
    const s = await create(f.options);
    await expect(
      s.services.resolveExistingDocument!({
        task: f.task,
        facts: [],
        input: f.input,
        signal: new AbortController().signal,
      }),
    ).rejects.toBeInstanceOf(ReservationistTaskEvidenceUnavailable);
    expect(s.collectTaskCoverage()[0].candidateSourceHashes).toEqual([hash(f.body)]);
    expect(s.collectTaskCoverage()[0].missing).toEqual(
      expect.arrayContaining([
        'original_document_target_unverified',
        'original_document_finality_unverified',
        'original_document_version_unverified',
        'original_document_disclosure_unavailable',
      ]),
    );
  });

  it.each([false, true])(
    'passes original authority and rejects source read revoked during disclosure: revoke=%s',
    async (revoke) => {
      const f = fixture();
      f.metadata.disclosure = 'guest' as any;
      f.input.messages[0].disclosure = 'guest';
      Object.assign(f.record, {
        version: 'v1',
        status: 'sent',
        currentVersion: true,
        parentRef: 'ABC123',
        priceVisibility: 'hidden',
        validation: {
          identity: 'match',
          stayDates: 'match',
          payer: 'match',
          kind: 'match',
          version: 'current',
          priceVisibility: 'allowed',
        },
      });
      const { existingDocumentRefForRecord } = await import(
        '../src/mail/artifacts/existing-document-service.js'
      );
      f.options.sources[0].sourceProof = {
        ...f.f.document.sourceProof,
        documentRef: existingDocumentRefForRecord(f.record),
        sourceHash: hash(f.body),
        documentVersion: 'v1',
      };
      f.authorization.inputHash = localEvaluationInputHash(f.input);
      f.options.authorizeDisclosure = async (...args: any[]) => {
        const result = await (f.f.authorize as any)(...args);
        if (revoke) f.options.authorizeSourceRead = async () => false;
        return result;
      };
      const s = await create(f.options),
        factory = createReservationistDependencies({
          adapter: {
            invoke: async () => ({
              modelId: 'unpaid-synthetic-frozen-control',
              output: {
                facts: [
                  {
                    id: f.fact.id,
                    kind: f.fact.kind,
                    value: f.fact.value,
                    source: f.fact.source,
                    disclosure: f.fact.disclosure,
                  },
                ],
                tasks: [f.task],
                unresolvedAsks: [],
              },
              usage: {
                inputTokens: 0,
                outputTokens: 0,
                totalTokens: 0,
                latencyMs: 0,
                estimatedCostUsd: 0,
                rateTableVersion: 'unpaid-replay',
              },
            }),
          },
          admissions: [],
          services: s.services,
          header: {
            attention: '',
            company: '',
            clientEmail: '',
            clientTelephone: '',
            agency: '',
            signerName: '',
            signerEmail: '',
          },
          converter: { url: 'http://unused.invalid' },
        });
      const signal = new AbortController().signal,
        plan = await factory.dependencies.plan(f.input, signal),
        work = await factory.dependencies.execute(plan, f.input, signal);
      if (revoke) {
        expect(work.tasks[0].status).toBe('blocked');
        expect(work.errors.join(' ')).toContain('authority_or_integrity_failure');
        expect(work.existingDocumentReceipts).toHaveLength(0);
        return;
      }
      expect(work.tasks[0], JSON.stringify(work.errors)).toMatchObject({ status: 'complete' });
      expect(work.existingDocumentReceipts).toHaveLength(1);
      expect(factory.collectGeneratedArtifacts()[0].body.equals(f.body)).toBe(true);
      expect(s.collectTaskCoverage()[0].missing).toEqual([]);
      expect(f.f.authorize).toHaveBeenCalledOnce();
    },
  );
  it('does not cache an extraction after its source authorization was revoked during parsing', async () => {
    const f = fixture(),
      extract = f.options.readArtifact;
    f.options.readArtifact = async (...args: any[]) => {
      const result = await extract(...args);
      f.options.authorizeSourceRead = async () => false;
      return result;
    };
    const s = await create(f.options);
    await expect(s.acquireSourceDocuments(new AbortController().signal)).rejects.toThrow(
      /read_denied/,
    );
    expect(s.collectSourceAcquisitions()).toEqual([]);
  });

  it('acquires exact bytes through the existing typed document read without promoting unknown metadata', async () => {
    const f = fixture(),
      s = await create(f.options),
      items = await s.acquireSourceDocuments(new AbortController().signal);
    expect(items).toHaveLength(1);
    expect(items[0].read.data!.document).toMatchObject({
      source: 'mail_attachment',
      status: 'unknown',
      version: 'unknown',
      currentVersion: false,
      priceVisibility: 'unknown',
    });
    expect(items[0].bytes.body.equals(f.body)).toBe(true);
    expect(items[0].read.data!.sourceHash).toBe(hash(f.body));
    expect(items[0].read.data!.document.retrievable).toBe(true);
    expect(s.collectSourceAcquisitions()[0]).toMatchObject({
      sourceHash: hash(f.body),
      acquired: true,
      disclosure: 'staff_only',
      productionQualified: false,
    });
    expect(f.counts()).toEqual({ reads: 1, authorizations: 3 });
  });
  it('executes the installed resolver through the actual factory and keeps each missing source assertion typed', async () => {
    const f = fixture(),
      s = await create(f.options);
    const factory = createReservationistDependencies({
      adapter: {
        invoke: async () => ({
          modelId: 'unpaid-frozen-control',
          output: {
            facts: [
              {
                id: f.fact.id,
                kind: f.fact.kind,
                value: f.fact.value,
                source: f.fact.source,
                disclosure: f.fact.disclosure,
              },
            ],
            tasks: [f.task],
            unresolvedAsks: [],
          },
          usage: {
            inputTokens: 0,
            outputTokens: 0,
            totalTokens: 0,
            latencyMs: 0,
            estimatedCostUsd: 0,
            rateTableVersion: 'unpaid-replay',
          },
        }),
      },
      admissions: [],
      services: s.services,
      header: {
        attention: '',
        company: '',
        clientEmail: '',
        clientTelephone: '',
        agency: '',
        signerName: '',
        signerEmail: '',
      },
      converter: { url: 'http://unused.invalid' },
    });
    const signal = new AbortController().signal,
      plan = await factory.dependencies.plan(f.input, signal),
      work = await factory.dependencies.execute(plan, f.input, signal);
    expect(f.counts().reads).toBe(1);
    expect(work.tasks[0].status).toBe('needs_clarification');
    expect(work.existingDocumentReceipts).toHaveLength(0);
    expect(work.artifacts).toHaveLength(0);
    expect(s.collectTaskCoverage()[0].missing).toEqual(
      expect.arrayContaining([
        'original_document_finality_unverified',
        'original_document_version_unverified',
        'original_document_target_unverified',
        'original_document_disclosure_unavailable',
        'original_document_source_proof_unavailable',
      ]),
    );
  });
  it.each(['bytes', 'locator', 'owner', 'future', 'source-read-denied', 'revoked'])(
    'denies %s without disclosure authorization',
    async (kind) => {
      const f = fixture();
      let grants = 0;
      f.options.authorizeDisclosure = async () => {
        grants++;
        return true;
      };
      if (kind === 'bytes')
        f.options.readBytes = async () => ({
          body: Buffer.from('changed'),
          contentType: 'application/pdf',
          sha256: hash('changed'),
          locator: f.record.attachment!.locator,
        });
      if (kind === 'locator')
        f.options.readBytes = async () => ({
          body: f.body,
          contentType: 'application/pdf',
          sha256: hash(f.body),
          locator: { ...f.record.attachment!.locator, messageId: 'foreign' },
        });
      if (kind === 'owner') f.metadata.ownerRef = 'foreign';
      if (kind === 'future') f.metadata.messageAt = '2026-10-04T08:01:00Z';
      if (kind === 'source-read-denied') f.options.authorizeSourceRead = async () => false;
      if (kind === 'revoked') {
        let calls = 0;
        f.options.authorizeSourceRead = async () => ++calls === 1;
      }
      let s: any;
      try {
        s = await create(f.options);
      } catch (error) {
        expect(kind === 'owner' || kind === 'future').toBe(true);
        return;
      }
      await expect(s.acquireSourceDocuments(new AbortController().signal)).rejects.toThrow();
      expect(grants).toBe(0);
    },
  );
  it('rejects revoked byte source after a cached acquisition rather than reusing an approval', async () => {
    const f = fixture(),
      s = await create(f.options);
    await s.acquireSourceDocuments(new AbortController().signal);
    f.options.authorizeSourceRead = async () => false;
    await expect(
      s.services.resolveExistingDocument!({
        task: f.task,
        facts: [f.fact],
        input: f.input,
        signal: new AbortController().signal,
      }),
    ).rejects.toThrow();
    expect(s.collectTaskCoverage()).toHaveLength(0);
  });
  it('does not call a disclosure seam for staff-only original evidence', async () => {
    const f = fixture();
    let grants = 0;
    f.options.authorizeDisclosure = async () => {
      grants++;
      return null;
    };
    const s = await create(f.options);
    await expect(
      s.services.resolveExistingDocument!({
        task: f.task,
        facts: [f.fact],
        input: f.input,
        signal: new AbortController().signal,
      }),
    ).rejects.toBeInstanceOf(ReservationistTaskEvidenceUnavailable);
    expect(grants).toBe(0);
  });
});

import {
  deriveReservationistDocumentPurpose,
  type ReservationistDocumentPurpose,
  type ReservationistExistingDocumentCapture,
  type ReservationistExistingDocumentSourceProof,
} from './reservationist-existing-document.js';
import {
  createExistingDocumentService,
  existingDocumentRefForRecord,
  type ExistingDocumentRecord,
} from '../mail/artifacts/existing-document-service.js';
import {
  localEvaluationInputHash,
  LOCAL_EVALUATION_VERSION,
  type LocalEvaluationAuthorization,
} from './reservationist-evaluation-composition.js';
import {
  extractEmbeddedPdfText,
  type ArtifactReadResult,
  type AuthorizedArtifactBytes,
} from '../mail/artifacts/read-artifact.js';
import {
  ReservationistTaskEvidenceUnavailable,
  type ReservationistExecutionServices,
} from './reservationist-execution.js';
import type { ExistingDocumentReadResult } from '../mail/artifacts/existing-document-contracts.js';
import type { ReservationistAttachmentMetadata } from './reservationist-attachment-input.js';
import type { ReservationistRuntimeInput } from './reservationist-runtime.js';
import { quoteDigest } from '../quote-proposal/quote-revision.js';
import { isDeepStrictEqual } from 'node:util';
import { createHash } from 'node:crypto';

type Context = Parameters<
  NonNullable<ReservationistExecutionServices['resolveExistingDocument']>
>[0];
export type CausalDocumentSource = {
  metadata: ReservationistAttachmentMetadata;
  filename: string;
  record: ExistingDocumentRecord;
  sourceProof?: ReservationistExistingDocumentSourceProof;
};
export type CausalDocumentAcquisition = {
  attachmentId: string;
  sourceHash: string;
  sizeBytes: number;
  sourceAt: string;
  disclosure: 'guest' | 'staff_only';
  acquired: true;
  readStatus: ExistingDocumentReadResult['status'];
  readBlocker: string | null;
  documentRef: string;
  productionQualified: false;
};
export type CausalDocumentTaskCoverage = {
  taskId: string;
  purpose: ReservationistDocumentPurpose;
  reservationRef: string | null;
  priorQuoteRef?: string;
  candidateSourceHashes: string[];
  missing: string[];
  productionQualified: false;
};
export type CausalDocumentServiceOptions = {
  input: ReservationistRuntimeInput;
  authorization: LocalEvaluationAuthorization;
  sources: readonly CausalDocumentSource[];
  authorizeSourceRead: (source: CausalDocumentSource, signal: AbortSignal) => Promise<boolean>;
  readBytes: (
    source: CausalDocumentSource,
    signal: AbortSignal,
  ) => Promise<AuthorizedArtifactBytes | null>;
  readArtifact?: (
    source: CausalDocumentSource,
    bytes: AuthorizedArtifactBytes,
    signal: AbortSignal,
  ) => Promise<ArtifactReadResult>;
  /** Optional existing source-owner typed read; default mail service cannot certify retrievability. */
  readExistingDocument?: (
    source: CausalDocumentSource,
    bytes: AuthorizedArtifactBytes,
    signal: AbortSignal,
  ) => Promise<ExistingDocumentReadResult>;
  /** Existing source owner supplies independent authority. Local evaluation authorization never issues this grant. */
  authorizeDisclosure?: NonNullable<ReservationistExecutionServices['authorizeExistingDocument']>;
};
const hash = (bytes: Buffer | string) => createHash('sha256').update(bytes).digest('hex');
const kinds: Record<ReservationistDocumentPurpose, ExistingDocumentRecord['kind']> = {
  tax_certificate: 'supplier_compliance',
  receipt: 'other_existing',
  tax_invoice: 'tax_invoice',
  reservation_confirmation: 'reservation_confirmation',
  pro_forma: 'pro_forma',
  folio: 'folio',
  statement: 'statement',
  contract: 'contract',
  existing_quote: 'pro_forma',
  property_information: 'property_information',
};
const scoped = new Set<ReservationistDocumentPurpose>([
  'receipt',
  'tax_invoice',
  'reservation_confirmation',
  'pro_forma',
  'folio',
  'statement',
  'existing_quote',
]);
const sourceIdentity = (s: CausalDocumentSource) =>
  quoteDigest({
    ...s,
    record: {
      ...s.record,
      attachment: s.record.attachment
        ? {
            ...s.record.attachment,
            authorizedAttachmentIds: [...s.record.attachment.authorizedAttachmentIds].sort(),
          }
        : undefined,
    },
  });

/** Read-only local source integration. Unknown original metadata remains unknown in the existing service. */
export function createReservationistCausalDocumentServices(options: CausalDocumentServiceOptions) {
  const identity = quoteDigest({
      input: options.input,
      authorization: options.authorization,
      sources: options.sources.map(sourceIdentity),
    }),
    cache = new Map<
      string,
      {
        source: CausalDocumentSource;
        bytes: AuthorizedArtifactBytes;
        read: ExistingDocumentReadResult;
      }
    >(),
    acquisitions: CausalDocumentAcquisition[] = [],
    coverage: CausalDocumentTaskCoverage[] = [];
  function guard(signal: AbortSignal) {
    signal.throwIfAborted();
    const a = options.authorization,
      i = options.input;
    if (
      a.version !== LOCAL_EVALUATION_VERSION ||
      a.kind !== 'user_authorized_local_evaluation' ||
      a.authorizationSource !== 'reservationist-recovery-user-20261004' ||
      a.scope !== 'local_disposable_evaluation' ||
      a.pmsWrite !== false ||
      a.emailSend !== false ||
      a.productionDraftWrite !== false ||
      !Number.isFinite(Date.parse(a.issuedAt)) ||
      Date.parse(a.issuedAt) > Date.now() ||
      a.inputHash !== localEvaluationInputHash(i) ||
      i.capabilities.pmsWrite !== false ||
      i.capabilities.emailSend !== false ||
      !i.authorizationScope?.ownerRef ||
      !i.authorizationScope.threadId ||
      !Number.isFinite(i.clock.deadlineAt) ||
      Date.now() >= i.clock.deadlineAt ||
      identity !==
        quoteDigest({ input: i, authorization: a, sources: options.sources.map(sourceIdentity) })
    )
      throw new Error('causal_document_local_scope_denied');
  }
  function sourceGuard(s: CausalDocumentSource, signal: AbortSignal) {
    guard(signal);
    const m = s.metadata,
      i = options.input,
      r = s.record,
      a = r.attachment,
      message = i.messages.find((v) => v.id === m.messageId);
    if (
      !message ||
      m.ownerRef !== i.authorizationScope!.ownerRef ||
      m.threadId !== i.authorizationScope!.threadId ||
      m.messageAt !== message.at ||
      !Number.isFinite(Date.parse(m.messageAt)) ||
      Date.parse(m.messageAt) > Date.parse(i.clock.causalAt) ||
      !i.authorizedArtifacts.some(
        (v) =>
          typeof v === 'object' &&
          v !== null &&
          'attachmentId' in v &&
          'sourceHash' in v &&
          v.attachmentId === m.attachmentId &&
          v.sourceHash === m.sourceHash,
      ) ||
      !['guest', 'staff_only'].includes(m.disclosure) ||
      message.disclosure !== m.disclosure ||
      !a ||
      a.attachmentId !== m.attachmentId ||
      !a.authorizedAttachmentIds.has(m.attachmentId) ||
      a.locator.messageId !== m.messageId ||
      a.locator.mimeType !== m.mimeType ||
      a.locator.sizeBytes !== m.sizeBytes ||
      !a.locator.s3Key.startsWith(`attachments/${m.messageId}/`) ||
      a.locator.s3Key.includes('\\') ||
      a.locator.s3Key.split('/').some((p) => !p || p === '.' || p === '..') ||
      (a.expectedSha256 !== undefined && a.expectedSha256 !== m.sourceHash) ||
      (r.sha256 !== null && r.sha256 !== m.sourceHash) ||
      r.sourceRecordId !== m.attachmentId ||
      r.propertyRef !== i.propertyCode ||
      r.mime !== m.mimeType ||
      r.sizeBytes !== m.sizeBytes ||
      r.displayName !== s.filename ||
      !Number.isSafeInteger(m.sizeBytes) ||
      m.sizeBytes < 1 ||
      m.sizeBytes > 20 * 1024 * 1024 ||
      !/^[a-f0-9]{64}$/.test(m.sourceHash)
    )
      throw new Error('causal_document_source_identity_denied');
  }
  const initial = new AbortController().signal;
  guard(initial);
  if (
    options.sources.length > 50 ||
    new Set(options.sources.map((s) => s.metadata.attachmentId)).size !== options.sources.length
  )
    throw new Error('causal_document_source_inventory_denied');
  options.sources.forEach((s) => sourceGuard(s, initial));
  async function authorizeRead(s: CausalDocumentSource, signal: AbortSignal) {
    sourceGuard(s, signal);
    if ((await options.authorizeSourceRead(s, signal)) !== true)
      throw new Error('causal_document_source_read_denied');
    sourceGuard(s, signal);
  }
  async function acquire(s: CausalDocumentSource, signal: AbortSignal) {
    await authorizeRead(s, signal);
    const prior = cache.get(s.metadata.attachmentId);
    if (prior) return prior;
    const bytes = await options.readBytes(s, signal);
    sourceGuard(s, signal);
    if (
      !bytes ||
      !Buffer.isBuffer(bytes.body) ||
      bytes.body.length !== s.metadata.sizeBytes ||
      hash(bytes.body) !== s.metadata.sourceHash ||
      bytes.sha256 !== s.metadata.sourceHash ||
      bytes.contentType !== s.metadata.mimeType ||
      !isDeepStrictEqual(bytes.locator, s.record.attachment!.locator)
    )
      throw new Error('causal_document_byte_identity_denied');
    await authorizeRead(s, signal);
    const retained = { ...bytes, body: Buffer.from(bytes.body), locator: { ...bytes.locator } },
      before = hash(retained.body),
      scope = { scopeRef: s.record.scopeRef, propertyRef: options.input.propertyCode };
    const service = createExistingDocumentService({
      now: () => new Date(options.input.clock.sourceAt),
      resolveScope: async (ref) => (ref === scope.scopeRef ? scope : null),
      sources: {
        [s.record.source]: {
          source: s.record.source,
          list: async () => ({ records: [s.record], inventoryComplete: false }),
        },
      },
      resolveDocument: async (ref) =>
        ref === existingDocumentRefForRecord(s.record) ? { record: s.record, scope } : null,
      readArtifact: async () =>
        options.readArtifact
          ? options.readArtifact(s, { ...retained, body: Buffer.from(retained.body) }, signal)
          : extractEmbeddedPdfText(
              {
                body: retained.body,
                declaredSize: s.metadata.sizeBytes,
                declaredMime: s.metadata.mimeType,
                objectMime: retained.contentType,
              },
              {
                attachmentId: s.metadata.attachmentId,
                now: new Date(options.input.clock.sourceAt),
                signal,
              },
            ),
    });
    const ref = existingDocumentRefForRecord(s.record),
      read = options.readExistingDocument
        ? await options.readExistingDocument(
            s,
            { ...retained, body: Buffer.from(retained.body) },
            signal,
          )
        : await service.documents_read_existing({ documentRef: ref, format: 'text' });
    await authorizeRead(s, signal);
    if (
      before !== hash(retained.body) ||
      (read.data?.sourceHash !== null &&
        read.data?.sourceHash !== undefined &&
        read.data.sourceHash !== s.metadata.sourceHash)
    )
      throw new Error('causal_document_extraction_identity_denied');
    // Successful bounded acquisition proves physical byte availability only. All original
    // status, extraction, validation, version and disclosure fields remain source-owned.
    if (read.data) {
      const d = read.data.document;
      if (
        d.documentRef !== ref ||
        d.sha256 !== s.metadata.sourceHash ||
        d.sizeBytes !== retained.body.length ||
        d.mime !== retained.contentType
      )
        throw new Error('causal_document_typed_metadata_identity_denied');
      read.data.document = { ...d, retrievable: true, retrievalBlocker: null };
    }
    const item = { source: s, bytes: retained, read };
    cache.set(s.metadata.attachmentId, item);
    acquisitions.push({
      attachmentId: s.metadata.attachmentId,
      sourceHash: s.metadata.sourceHash,
      sizeBytes: s.metadata.sizeBytes,
      sourceAt: s.metadata.messageAt,
      disclosure: s.metadata.disclosure,
      acquired: true,
      readStatus: read.status,
      readBlocker: read.blocker,
      documentRef: ref,
      productionQualified: false,
    });
    return item;
  }
  function request(ctx: Context) {
    guard(ctx.signal);
    if (
      quoteDigest(ctx.input) !== quoteDigest(options.input) ||
      ctx.task.kind !== 'existing_document'
    )
      throw new Error('causal_document_request_scope_denied');
    const s = ctx.task.source,
      m = ctx.input.messages.find((m) => `message:${m.id}` === s.attachmentId);
    if (
      !m ||
      m.id !== ctx.input.trigger.id ||
      m.direction !== 'inbound' ||
      m.disclosure !== 'guest' ||
      s.sourceHash !== hash(m.text) ||
      s.quote === undefined ||
      s.start === undefined ||
      s.end === undefined ||
      m.text.slice(s.start, s.end) !== s.quote ||
      s.end - s.start !== s.quote.length
    )
      throw new Error('causal_document_request_source_denied');
    const purpose = deriveReservationistDocumentPurpose(s.quote),
      refs = ctx.facts.filter((f) => f.kind === 'reservation_reference'),
      quotes = ctx.facts.filter((f) => f.kind === 'document_reference');
    if (
      refs.length > 1 ||
      quotes.length > 1 ||
      [...refs, ...quotes].some((f) => f.disclosure !== 'guest')
    )
      throw new Error('causal_document_request_target_denied');
    const target = (
        ctx as Context & {
          existingDocumentTarget?: { reservationRef: string | null; priorQuoteRef?: string };
        }
      ).existingDocumentTarget,
      reservationRef = refs[0]?.value ?? null,
      priorQuoteRef = quotes[0]?.value;
    if (
      target &&
      (target.reservationRef !== reservationRef || target.priorQuoteRef !== priorQuoteRef)
    )
      throw new Error('causal_document_request_target_denied');
    return {
      purpose,
      reservationRef,
      ...(priorQuoteRef !== undefined ? { priorQuoteRef } : {}),
      target: purpose === 'existing_quote' ? priorQuoteRef : reservationRef,
    };
  }
  function missingFor(
    s: CausalDocumentSource,
    read: ExistingDocumentReadResult,
    purpose: ReservationistDocumentPurpose,
    target: string | null | undefined,
  ) {
    const r = s.record,
      p = s.sourceProof,
      missing: string[] = [];
    if (!['final', 'sent'].includes(r.status))
      missing.push('original_document_finality_unverified');
    if (!r.currentVersion || r.version === 'unknown')
      missing.push('original_document_version_unverified');
    if (r.kind !== kinds[purpose]) missing.push('original_document_purpose_unverified');
    if (scoped.has(purpose) && (!target || r.parentRef !== target))
      missing.push('original_document_target_unverified');
    if (
      s.metadata.disclosure !== 'guest' ||
      r.priceVisibility === 'unknown' ||
      !options.authorizeDisclosure
    )
      missing.push('original_document_disclosure_unavailable');
    if (!p) missing.push('original_document_source_proof_unavailable');
    if (
      read.status !== 'ok' ||
      !read.data ||
      read.data.extractionState !== 'complete' ||
      read.data.document.retrievable !== true
    )
      missing.push('original_document_typed_read_unverified');
    if (!scoped.has(purpose) && r.source !== 'approved_property_document')
      missing.push('original_property_document_approval_unavailable');
    return missing;
  }
  const services: ReservationistExecutionServices = {
    resolveExistingDocument: async (ctx) => {
      const q = request(ctx),
        items = [];
      for (const s of options.sources.filter(
        (s) =>
          s.record.kind === kinds[q.purpose] &&
          (!scoped.has(q.purpose) ||
            !q.target ||
            s.record.parentRef === null ||
            s.record.parentRef === q.target),
      ))
        items.push(await acquire(s, ctx.signal));
      const candidates = items.filter(
        (v) =>
          v.source.record.kind === kinds[q.purpose] &&
          (!scoped.has(q.purpose) ||
            !q.target ||
            v.source.record.parentRef === null ||
            v.source.record.parentRef === q.target),
      );
      const missing =
        candidates.length === 1
          ? missingFor(candidates[0].source, candidates[0].read, q.purpose, q.target)
          : [
              candidates.length
                ? 'original_document_selection_ambiguous'
                : 'original_document_source_unavailable',
            ];
      coverage.push({
        taskId: ctx.task.id,
        purpose: q.purpose,
        reservationRef: q.reservationRef,
        ...(q.priorQuoteRef !== undefined ? { priorQuoteRef: q.priorQuoteRef } : {}),
        candidateSourceHashes: candidates.map((v) => v.source.metadata.sourceHash),
        missing: [...missing],
        productionQualified: false,
      });
      if (missing.length)
        throw new ReservationistTaskEvidenceUnavailable(
          'causal_existing_document_evidence_unavailable',
          missing,
        );
      const chosen = candidates[0],
        p = chosen.source.sourceProof!;
      if (
        p.sourceHash !== chosen.source.metadata.sourceHash ||
        p.documentRef !== existingDocumentRefForRecord(chosen.source.record) ||
        p.documentVersion !== chosen.source.record.version ||
        p.ownerRef !== ctx.input.authorizationScope!.ownerRef ||
        p.propertyCode !== ctx.input.propertyCode ||
        p.purpose !== q.purpose ||
        p.reservationRef !== q.reservationRef ||
        p.priorQuoteRef !== q.priorQuoteRef ||
        (p.threadId !== ctx.input.authorizationScope!.threadId && scoped.has(q.purpose))
      )
        throw new Error('causal_document_original_proof_denied');
      return {
        artifactRef: `original:${p.sourceHash}`,
        filename: chosen.source.filename,
        body: Buffer.from(chosen.bytes.body),
        read: structuredClone(chosen.read),
        sourceProof: structuredClone(p),
      };
    },
    authorizeExistingDocument: async (binding, document, ctx, signal) => {
      const q = request(ctx),
        found = cache.get(
          options.sources.find((s) => s.metadata.sourceHash === binding.sourceHash)?.metadata
            .attachmentId ?? '',
        );
      if (
        !found ||
        missingFor(found.source, found.read, q.purpose, q.target).length ||
        !options.authorizeDisclosure
      )
        return null;
      await authorizeRead(found.source, signal);
      if (
        binding.ownerRef !== ctx.input.authorizationScope!.ownerRef ||
        binding.threadId !== ctx.input.authorizationScope!.threadId ||
        binding.taskId !== ctx.task.id ||
        binding.requestId !== ctx.input.requestId ||
        binding.triggerMessageId !== ctx.input.trigger.id ||
        binding.propertyCode !== ctx.input.propertyCode ||
        binding.purpose !== q.purpose ||
        binding.reservationRef !== q.reservationRef ||
        binding.priorQuoteRef !== q.priorQuoteRef ||
        hash(document.body) !== found.source.metadata.sourceHash ||
        quoteDigest(document.read) !== quoteDigest(found.read) ||
        quoteDigest(document.sourceProof) !== quoteDigest(found.source.sourceProof)
      )
        throw new Error('causal_document_disclosure_binding_denied');
      const before = quoteDigest({
          binding,
          read: document.read,
          proof: document.sourceProof,
          body: hash(document.body),
        }),
        grant = await options.authorizeDisclosure(binding, document, ctx, signal);
      await authorizeRead(found.source, signal);
      if (
        before !==
        quoteDigest({
          binding,
          read: document.read,
          proof: document.sourceProof,
          body: hash(document.body),
        })
      )
        throw new Error('causal_document_authority_mutated');
      return grant;
    },
  };
  return {
    services,
    async acquireSourceDocuments(signal: AbortSignal) {
      const items = [];
      for (const s of options.sources) items.push(await acquire(s, signal));
      return items.map((v) => ({
        ...v,
        bytes: { ...v.bytes, body: Buffer.from(v.bytes.body), locator: { ...v.bytes.locator } },
        read: structuredClone(v.read),
      }));
    },
    collectSourceAcquisitions: () => structuredClone(acquisitions),
    collectTaskCoverage: () => structuredClone(coverage),
  };
}

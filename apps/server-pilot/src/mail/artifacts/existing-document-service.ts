import {
  documentMetadataSchema,
  documentSourceSchema,
  documentValidationBlocker,
  documentValidationIsUsable,
  evaluateDocumentValidation,
  documentsListExistingInputSchema,
  documentsReadExistingInputSchema,
  existingDocumentListDataSchema,
  existingDocumentReadDataSchema,
  existingDocumentScopeSchema,
  EXISTING_DOCUMENT_MAX_LIMIT,
  type DocumentIssue,
  type DocumentKind,
  type DocumentMetadata,
  type DocumentValidation,
  type DocumentSource,
  type DocumentsListExistingInput,
  type DocumentsReadExistingInput,
  type ExistingDocumentListData,
  type ExistingDocumentListResult,
  type ExistingDocumentReadData,
  type ExistingDocumentReadResult,
  type ExistingDocumentScope,
} from './existing-document-contracts.js';
import type {
  ArtifactReadResult,
  AttachmentLocator,
  AuthorizedArtifactBytes,
} from './read-artifact.js';
import { ARTIFACT_MAX_INPUT_BYTES, ARTIFACT_MAX_OUTPUT_BYTES } from './read-artifact.js';
import { createHash } from 'node:crypto';

/** Server-resolved attachment information. It is never model input. */
export type ExistingDocumentAttachment = {
  attachmentId: string;
  authorizedAttachmentIds: ReadonlySet<string>;
  locator: AttachmentLocator;
  expectedSha256?: string;
};

/**
 * A source record is an internal adapter shape. `sourceRecordId` is used only
 * to derive a stable opaque ref and is never copied into a result.
 */
export type ExistingDocumentRecord = {
  sourceRecordId: string;
  scopeRef: string;
  source: DocumentSource;
  kind: DocumentMetadata['kind'];
  version: string;
  issuedAt: string | null;
  status: DocumentMetadata['status'];
  parentRef: string | null;
  payerRef: string | null;
  displayName: string | null;
  mime: string | null;
  sizeBytes: number | null;
  sha256: string | null;
  priceVisibility: DocumentMetadata['priceVisibility'];
  propertyRef: string;
  guestRef: string | null;
  stayStart: string | null;
  stayEnd: string | null;
  currentVersion: boolean;
  /** Internal source-evidence result; never serialized as caller input. */
  validation?: DocumentValidation;
  attachment?: ExistingDocumentAttachment;
};

export type ExistingDocumentSourcePage = {
  records: readonly ExistingDocumentRecord[];
  /** False/absent means a zero-row result is not a verified negative. */
  inventoryComplete?: boolean;
  hasMore?: boolean;
  blocker?: string;
};

export type ExistingDocumentSource = {
  source: DocumentSource;
  list(input: {
    scope: ExistingDocumentScope;
    kinds?: readonly DocumentKind[];
    limit: number;
    cursor?: string;
  }): Promise<ExistingDocumentSourcePage>;
};

export type ExistingDocumentServiceInput = {
  now?: () => Date;
  resolveScope(scopeRef: string): Promise<ExistingDocumentScope | null>;
  sources: Partial<Record<DocumentSource, ExistingDocumentSource>>;
  readArtifact?: (attachment: ExistingDocumentAttachment) => Promise<ArtifactReadResult>;
  readBytes?: (attachment: ExistingDocumentAttachment) => Promise<AuthorizedArtifactBytes | null>;
  /** Resolve a durable opaque ref when list/read use different workers. */
  resolveDocument?: (documentRef: string) => Promise<{
    record: ExistingDocumentRecord;
    scope: ExistingDocumentScope;
  } | null>;
  artifactTtlMs?: number;
};

type StoredDocument = {
  record: ExistingDocumentRecord;
  scope: ExistingDocumentScope;
  metadata: DocumentMetadata;
  fingerprint: string;
  sourceBlocker: string | null;
};

const SAFE_DISPLAY_NAME = /[^A-Za-z0-9._ -]/g;

function issue(code: string, detail?: string, field?: string): DocumentIssue {
  return {
    code,
    detail: detail ?? null,
    ...(field ? { field } : {}),
  };
}

function hash(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function opaqueDocumentRef(record: ExistingDocumentRecord): string {
  const locator = record.attachment?.locator;
  const digest = hash(
    [
      'existing-document/v2',
      record.source,
      record.scopeRef,
      record.sourceRecordId,
      record.version,
      record.sha256 ?? '',
      locator?.s3Key ?? '',
      locator?.messageId ?? '',
      locator?.sizeBytes ?? '',
    ].join('|'),
  );
  return `doc:${record.sha256 ?? 'unknown'}:${digest}`;
}

/** Extract only the server-issued content-hash binding from an opaque ref. */
export function existingDocumentSha256FromRef(documentRef: string): string | null {
  const match = /^doc:([a-f0-9]{64}):[a-f0-9]{64}$/i.exec(documentRef);
  return match?.[1]?.toLowerCase() ?? null;
}

/** Stable server-owned scope reference for one authenticated mail thread. */
export function existingDocumentScopeRef(input: {
  transportId: string;
  threadId: string;
  triggerMessageId: string;
}): string {
  return hash(
    JSON.stringify([
      'existing-document-scope/v1',
      input.transportId,
      input.threadId,
      input.triggerMessageId,
    ]),
  );
}

/**
 * Exported for the DB-backed caller/worker adapters. The returned ref stays
 * opaque; its digest binds source, scope, version, locator and content hash.
 */
export function existingDocumentRefForRecord(record: ExistingDocumentRecord): string {
  return opaqueDocumentRef(record);
}

export type MailDocumentHints = {
  propertyRef: string | null;
  guestRef: string | null;
  payerRef: string | null;
  stayStart: string | null;
  stayEnd: string | null;
  version: string | null;
  priceVisibility: DocumentMetadata['priceVisibility'];
  kind: DocumentKind;
};

const SAFE_HINT = '[A-Za-z0-9][A-Za-z0-9._:-]{0,255}';

function mailHint(text: string, label: string): string | null {
  const match = text.match(new RegExp(`\\b${label}\\s+(${SAFE_HINT})`, 'i'));
  return match?.[1] ?? null;
}

/** Parse only bounded, explicitly labelled metadata from an authorized message. */
export function parseMailDocumentHints(input: {
  filename: string;
  text: string;
}): MailDocumentHints {
  const text = input.text.slice(0, 16_384);
  const lowerName = input.filename.toLowerCase();
  const lowerText = text.toLowerCase();
  const kind: DocumentKind =
    lowerName.includes('proforma') ||
    lowerName.includes('pro-forma') ||
    lowerText.includes('pro forma') ||
    lowerText.includes('pro-forma')
      ? 'pro_forma'
      : lowerName.includes('invoice') || lowerText.includes('tax invoice')
        ? 'tax_invoice'
        : lowerName.includes('confirm')
          ? 'reservation_confirmation'
          : lowerName.includes('contract')
            ? 'contract'
            : 'other_existing';
  const stay = text.match(/\bStay\s+(\d{4}-\d{2}-\d{2})\s+through\s+(\d{4}-\d{2}-\d{2})\b/i);
  const priceVisibility = /\bprices?\s+(?:are\s+)?visible\b/i.test(text)
    ? 'visible'
    : /\bprices?\s+(?:are\s+)?hidden\b/i.test(text)
      ? 'hidden'
      : 'unknown';
  return {
    propertyRef: mailHint(text, 'Property'),
    guestRef: mailHint(text, 'Guest'),
    payerRef: mailHint(text, 'Payer'),
    stayStart: stay?.[1] ?? null,
    stayEnd: stay?.[2] ?? null,
    version: mailHint(text, 'Version'),
    priceVisibility,
    kind,
  };
}

export type MailDocumentRecordInput = {
  scope: ExistingDocumentScope;
  source: DocumentSource;
  attachmentId: string;
  authorizedAttachmentIds: ReadonlySet<string>;
  messageId: string;
  filename: string;
  mimeType: string;
  sizeBytes: number;
  s3Key: string;
  text: string;
  observedAt: string | null;
};

/** Convert a DB attachment row into the private source-adapter shape. */
export function mailAttachmentRecord(input: MailDocumentRecordInput): ExistingDocumentRecord {
  const hints = parseMailDocumentHints({ filename: input.filename, text: input.text });
  const parentRef = hash(JSON.stringify(['existing-document-parent/v1', input.messageId]));
  return {
    sourceRecordId: input.attachmentId,
    scopeRef: input.scope.scopeRef,
    source: input.source,
    kind: hints.kind,
    // Filename/message labels are candidate hints only. The DB adapter has no
    // independent version/finality/type/price authority for these rows.
    version: 'unknown',
    issuedAt: input.observedAt,
    status: 'unknown',
    parentRef,
    payerRef: null,
    displayName: input.filename,
    mime: input.mimeType,
    sizeBytes: input.sizeBytes,
    sha256: null,
    priceVisibility: 'unknown',
    propertyRef: input.scope.propertyRef,
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
      attachmentId: input.attachmentId,
      authorizedAttachmentIds: input.authorizedAttachmentIds,
      locator: {
        s3Key: input.s3Key,
        mimeType: input.mimeType,
        sizeBytes: input.sizeBytes,
        messageId: input.messageId,
      },
    },
  };
}

function safeDisplayName(value: string | null): string | null {
  if (!value) return null;
  const normalized = value.replace(SAFE_DISPLAY_NAME, '_').replace(/_+/g, '_').trim();
  return normalized.slice(0, 128) || null;
}

function sourceDefaultBlocker(source: DocumentSource): string | null {
  if (source === 'hms_finalized_document') return 'SURFACE_UNPROVEN';
  if (source === 'hms_sent_attachment') return 'METADATA_ONLY';
  return null;
}

function recordFingerprint(record: ExistingDocumentRecord): string {
  const locator = record.attachment?.locator;
  return hash(
    JSON.stringify({
      sourceRecordId: record.sourceRecordId,
      scopeRef: record.scopeRef,
      source: record.source,
      kind: record.kind,
      version: record.version,
      issuedAt: record.issuedAt,
      status: record.status,
      parentRef: record.parentRef,
      payerRef: record.payerRef,
      displayName: record.displayName,
      mime: record.mime,
      sizeBytes: record.sizeBytes,
      sha256: record.sha256,
      priceVisibility: record.priceVisibility,
      propertyRef: record.propertyRef,
      guestRef: record.guestRef,
      stayStart: record.stayStart,
      stayEnd: record.stayEnd,
      currentVersion: record.currentVersion,
      validation: record.validation ?? null,
      attachmentId: record.attachment?.attachmentId ?? null,
      locator: locator
        ? {
            s3Key: locator.s3Key,
            mimeType: locator.mimeType,
            sizeBytes: locator.sizeBytes,
            messageId: locator.messageId,
          }
        : null,
    }),
  );
}

function normalizeScope(scope: ExistingDocumentScope): ExistingDocumentScope {
  return existingDocumentScopeSchema.parse(scope);
}

function makeMetadata(
  record: ExistingDocumentRecord,
  scope: ExistingDocumentScope,
  documentRef: string,
  sourceBlocker: string | null,
): {
  metadata: DocumentMetadata;
  validation: DocumentValidation;
} {
  const metadata = documentMetadataSchema.parse({
    documentRef,
    source: record.source,
    kind: record.kind,
    version: record.version,
    issuedAt: record.issuedAt,
    status: record.status,
    parentRef: record.parentRef,
    payerRef: record.payerRef,
    displayName: safeDisplayName(record.displayName),
    mime: record.mime,
    sizeBytes: record.sizeBytes,
    sha256: record.sha256,
    retrievable: false,
    retrievalBlocker: sourceBlocker,
    priceVisibility: record.priceVisibility,
    propertyRef: record.propertyRef,
    guestRef: record.guestRef,
    stayStart: record.stayStart,
    stayEnd: record.stayEnd,
    currentVersion: record.currentVersion,
  });

  return {
    metadata,
    validation: record.validation ?? evaluateDocumentValidation({ document: metadata, scope }),
  };
}

function readData(args: {
  metadata: DocumentMetadata;
  validation: DocumentValidation;
  format: 'text' | 'artifact';
  extractionState: ExistingDocumentReadData['extractionState'];
  text?: string | null;
  artifactRef?: string | null;
  pageCount?: number | null;
  sourceHash?: string | null;
  artifactExpiresAt?: string | null;
}): ExistingDocumentReadData {
  return existingDocumentReadDataSchema.parse({
    document: args.metadata,
    artifactRef: args.artifactRef ?? null,
    text: args.text ?? null,
    extractionState: args.extractionState,
    pageCount: args.pageCount ?? null,
    validation: args.validation,
    format: args.format,
    sourceHash: args.sourceHash ?? null,
    artifactExpiresAt: args.artifactExpiresAt ?? null,
  });
}

function extractionBlocker(reason: string): string {
  switch (reason) {
    case 'unsupported':
      return 'UNSUPPORTED_FORMAT';
    case 'encrypted':
      return 'ENCRYPTED_ARTIFACT';
    case 'no_embedded_text':
      return 'NO_EMBEDDED_TEXT';
    case 'too_large':
      return 'ARTIFACT_TOO_LARGE';
    case 'too_many_pages':
      return 'ARTIFACT_TOO_MANY_PAGES';
    case 'timeout':
      return 'ARTIFACT_READ_TIMEOUT';
    case 'malformed':
      return 'MALFORMED_ARTIFACT';
    default:
      return 'ARTIFACT_READ_FAILED';
  }
}

function currentMetadata(entry: StoredDocument): {
  metadata: DocumentMetadata;
  validation: DocumentValidation;
} {
  return makeMetadata(entry.record, entry.scope, entry.metadata.documentRef!, entry.sourceBlocker);
}

export function createMetadataOnlyDocumentSource(input: {
  source: DocumentSource;
  records: readonly ExistingDocumentRecord[];
  blocker: string;
  inventoryComplete?: boolean;
}): ExistingDocumentSource {
  documentSourceSchema.parse(input.source);
  return {
    source: input.source,
    async list() {
      return {
        records: input.records,
        inventoryComplete: input.inventoryComplete ?? true,
        blocker: input.blocker,
      };
    },
  };
}

export type ExistingDocumentService = ReturnType<typeof createExistingDocumentService>;

export function createExistingDocumentService(input: ExistingDocumentServiceInput) {
  const refs = new Map<string, StoredDocument>();

  const manualList = (
    blocker: string,
    issues: DocumentIssue[] = [issue(blocker)],
  ): ExistingDocumentListResult => ({
    status: 'manual_required',
    data: null,
    blocker,
    issues,
  });

  const manualRead = (args: {
    entry?: StoredDocument;
    metadata?: DocumentMetadata;
    validation?: DocumentValidation;
    format: 'text' | 'artifact';
    blocker: string;
    extractionState?: ExistingDocumentReadData['extractionState'];
    pageCount?: number | null;
    sourceHash?: string | null;
    issues?: DocumentIssue[];
  }): ExistingDocumentReadResult => {
    const metadata = args.metadata ?? args.entry?.metadata;
    const validation =
      args.validation ?? (args.entry ? currentMetadata(args.entry).validation : null);
    if (!metadata || !validation) {
      return {
        status: 'manual_required',
        data: null,
        blocker: args.blocker,
        issues: args.issues ?? [issue(args.blocker)],
      };
    }
    return {
      status: 'manual_required',
      data: readData({
        metadata,
        validation,
        format: args.format,
        extractionState: args.extractionState ?? 'partial',
        pageCount: args.pageCount,
        sourceHash: args.sourceHash,
      }),
      blocker: args.blocker,
      issues: args.issues ?? [issue(args.blocker)],
    };
  };

  async function listExistingDocuments(
    rawInput: DocumentsListExistingInput,
  ): Promise<ExistingDocumentListResult> {
    const parsed = documentsListExistingInputSchema.safeParse(rawInput);
    if (!parsed.success)
      return manualList('INVALID_DOCUMENT_REQUEST', [issue('INVALID_DOCUMENT_REQUEST')]);
    const request = parsed.data;
    const scopeRaw = await input.resolveScope(request.scopeRef);
    if (!scopeRaw) return manualList('SCOPE_DENIED');
    const scope = normalizeScope(scopeRaw);
    const source = input.sources[request.source];
    if (!source || source.source !== request.source) {
      return manualList('SOURCE_UNAVAILABLE');
    }

    let page: ExistingDocumentSourcePage;
    try {
      page = await source.list({
        scope,
        kinds: request.kinds,
        limit: request.limit ?? 20,
        cursor: request.cursor,
      });
    } catch {
      return manualList('SOURCE_UNAVAILABLE');
    }

    // A bounded source may be unable to resolve an opaque continuation within
    // its scan window. Preserve that explicit incomplete outcome; do not turn
    // it into a generic invalid cursor or a verified empty result.
    if (page.blocker === 'LIST_CURSOR_UNRESOLVED') {
      const data = existingDocumentListDataSchema.parse({
        documents: [],
        page: { returnedCount: 0, hasMore: false, nextCursor: null },
        sourceOutcomes: [
          {
            source: request.source,
            status: 'partial',
            issues: [issue(page.blocker)],
          },
        ],
      });
      return {
        status: 'partial',
        data,
        blocker: page.blocker,
        issues: [issue(page.blocker)],
      };
    }

    const rows: Array<{
      metadata: DocumentMetadata;
      validation: DocumentValidation;
      record: ExistingDocumentRecord;
      sourceBlocker: string | null;
    }> = [];
    let foreignRows = 0;
    for (const record of page.records.slice(0, EXISTING_DOCUMENT_MAX_LIMIT)) {
      if (record.source !== request.source) continue;
      if (record.scopeRef !== request.scopeRef) {
        foreignRows += 1;
        continue;
      }
      if (request.kinds && !request.kinds.includes(record.kind)) continue;
      const sourceBlocker = page.blocker ?? sourceDefaultBlocker(record.source);
      const ref = opaqueDocumentRef(record);
      const built = makeMetadata(record, scope, ref, sourceBlocker);
      const validationBlocker = documentValidationBlocker(built.validation);
      const retrievable =
        sourceBlocker === null &&
        record.attachment !== undefined &&
        documentValidationIsUsable(built.validation);
      const metadata = documentMetadataSchema.parse({
        ...built.metadata,
        retrievable,
        retrievalBlocker: retrievable
          ? null
          : (sourceBlocker ??
            validationBlocker ??
            (record.attachment ? 'DOCUMENT_NOT_RETRIEVABLE' : 'MISSING_AUTHORIZED_BYTES')),
      });
      refs.set(ref, {
        record,
        scope,
        metadata,
        fingerprint: recordFingerprint(record),
        sourceBlocker,
      });
      rows.push({ metadata, validation: built.validation, record, sourceBlocker });
    }

    if (foreignRows > 0 && rows.length === 0) {
      return manualList('SCOPE_DENIED');
    }

    const limit = request.limit ?? 20;
    let start = 0;
    if (request.cursor) {
      const cursorIndex = rows.findIndex((row) => row.metadata.documentRef === request.cursor);
      if (cursorIndex < 0) return manualList('CURSOR_INVALID');
      start = cursorIndex + 1;
    }
    const selected = rows.slice(start, start + limit).map((row) => row.metadata);
    const hasMore = page.hasMore === true || start + limit < rows.length;
    const nextCursor = hasMore ? (selected.at(-1)?.documentRef ?? null) : null;
    const sourceOutcome = {
      source: request.source,
      status: page.blocker ? ('partial' as const) : ('ok' as const),
      issues: page.blocker ? [issue(page.blocker)] : [],
    };
    const data: ExistingDocumentListData = existingDocumentListDataSchema.parse({
      documents: selected,
      page: { returnedCount: selected.length, hasMore, nextCursor },
      sourceOutcomes: [sourceOutcome],
    });

    const boundedBlocker = page.blocker?.startsWith('LIST_') ? page.blocker : null;
    if (selected.length === 0 && page.inventoryComplete !== true) {
      return {
        status: boundedBlocker ? 'partial' : 'unverified_negative',
        data,
        blocker: boundedBlocker ?? 'INVENTORY_INCOMPLETE',
        issues: [issue(boundedBlocker ?? 'INVENTORY_INCOMPLETE')],
      };
    }
    return {
      // A metadata-only source can still provide a truthful successful
      // metadata response; its inability to provide bytes is represented by
      // each row's retrievalBlocker and the source outcome, not hidden as a
      // failed list call.
      status: boundedBlocker ? 'partial' : 'ok',
      data,
      blocker: boundedBlocker,
      issues: page.blocker ? [issue(page.blocker)] : [],
    };
  }

  async function readExistingDocument(
    rawInput: DocumentsReadExistingInput,
  ): Promise<ExistingDocumentReadResult> {
    const parsed = documentsReadExistingInputSchema.safeParse(rawInput);
    if (!parsed.success) {
      return manualRead({ format: 'text', blocker: 'INVALID_DOCUMENT_REQUEST' });
    }
    const request = parsed.data;
    let entry = refs.get(request.documentRef);
    if (!entry && input.resolveDocument) {
      try {
        const resolved = await input.resolveDocument(request.documentRef);
        if (resolved) {
          const sourceBlocker = sourceDefaultBlocker(resolved.record.source);
          const ref = opaqueDocumentRef(resolved.record);
          // A changed locator/version/hash produces a different ref. Do not
          // silently rebind an old caller ref to a new source record.
          if (ref === request.documentRef) {
            const built = makeMetadata(
              resolved.record,
              normalizeScope(resolved.scope),
              ref,
              sourceBlocker,
            );
            entry = {
              record: resolved.record,
              scope: normalizeScope(resolved.scope),
              metadata: built.metadata,
              fingerprint: recordFingerprint(resolved.record),
              sourceBlocker,
            };
            refs.set(ref, entry);
          }
        }
      } catch {
        // Treat resolver failures as an opaque scope miss; no source I/O.
      }
    }
    if (!entry) return manualRead({ format: request.format, blocker: 'SCOPE_DENIED' });

    if (recordFingerprint(entry.record) !== entry.fingerprint) {
      const current = currentMetadata(entry);
      return manualRead({
        metadata: current.metadata,
        validation: current.validation,
        format: request.format,
        blocker: 'DOCUMENT_CHANGED',
        issues: [issue('DOCUMENT_CHANGED')],
      });
    }

    const current = currentMetadata(entry);
    const validationBlocker = documentValidationBlocker(current.validation);
    if (validationBlocker && request.format === 'artifact') {
      return manualRead({
        metadata: current.metadata,
        validation: current.validation,
        format: request.format,
        blocker: validationBlocker,
      });
    }
    if (entry.sourceBlocker) {
      return manualRead({
        metadata: current.metadata,
        validation: current.validation,
        format: request.format,
        blocker: entry.sourceBlocker,
      });
    }
    if (!entry.record.attachment) {
      return manualRead({
        metadata: current.metadata,
        validation: current.validation,
        format: request.format,
        blocker: 'MISSING_AUTHORIZED_BYTES',
      });
    }

    if (request.format === 'artifact') {
      // The existing U9 surface has no private artifact persistence/resolver.
      // Never mint a handle that cannot be resolved by an authorized route.
      return manualRead({
        metadata: current.metadata,
        validation: current.validation,
        format: request.format,
        blocker: 'UNSUPPORTED_FORMAT',
        extractionState: 'unsupported',
      });
    }

    if (!input.readArtifact) {
      return manualRead({
        metadata: current.metadata,
        validation: current.validation,
        format: request.format,
        blocker: 'SOURCE_UNAVAILABLE',
      });
    }
    let result: ArtifactReadResult;
    try {
      result = await input.readArtifact(entry.record.attachment);
    } catch {
      return manualRead({
        metadata: current.metadata,
        validation: current.validation,
        format: request.format,
        blocker: 'SOURCE_UNAVAILABLE',
      });
    }
    const sourceHash =
      typeof result.evidence.sourceHash === 'string' &&
      /^[a-f0-9]{64}$/i.test(result.evidence.sourceHash)
        ? result.evidence.sourceHash
        : null;
    if (result.status !== 'ok' || !result.data.text) {
      const blocker = extractionBlocker(result.data.reason);
      return manualRead({
        metadata: current.metadata,
        validation: current.validation,
        format: request.format,
        blocker,
        extractionState: result.data.reason === 'unsupported' ? 'unsupported' : 'partial',
        pageCount: result.data.pageCount,
        sourceHash,
      });
    }
    if (entry.record.sha256 && sourceHash !== entry.record.sha256) {
      return manualRead({
        metadata: current.metadata,
        validation: current.validation,
        format: request.format,
        blocker: 'DOCUMENT_CHANGED',
        sourceHash,
        pageCount: result.data.pageCount,
      });
    }
    return {
      status: validationBlocker ? 'manual_required' : 'ok',
      data: readData({
        metadata: current.metadata,
        validation: current.validation,
        format: request.format,
        extractionState: 'complete',
        text: result.data.text,
        pageCount: result.data.pageCount,
        sourceHash,
      }),
      blocker: validationBlocker,
      issues: validationBlocker ? [issue(validationBlocker)] : [],
    };
  }

  return {
    documents_list_existing: listExistingDocuments,
    documents_read_existing: readExistingDocument,
    scopeRefFor(documentRef: string): string | null {
      return refs.get(documentRef)?.scope.scopeRef ?? null;
    },
    listExistingDocuments,
    readExistingDocument,
  };
}

// Keep the service module's public imports visibly tied to the bounded reader
// constants; this guards future adapters from widening limits accidentally.
export const EXISTING_DOCUMENT_BYTE_LIMITS = {
  maxInputBytes: ARTIFACT_MAX_INPUT_BYTES,
  maxTextBytes: ARTIFACT_MAX_OUTPUT_BYTES,
};

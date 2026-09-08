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
  EXISTING_DOCUMENT_ARTIFACT_TTL_MS,
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
  return `doc:${hash(
    [
      'existing-document/v1',
      record.source,
      record.scopeRef,
      record.sourceRecordId,
      record.version,
      record.sha256 ?? '',
    ].join('|'),
  )}`;
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
    validation: evaluateDocumentValidation({ document: metadata, scope }),
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
  const now = input.now ?? (() => new Date());
  const ttlMs = input.artifactTtlMs ?? EXISTING_DOCUMENT_ARTIFACT_TTL_MS;
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

    if (selected.length === 0 && page.inventoryComplete !== true) {
      return {
        status: 'unverified_negative',
        data,
        blocker: 'INVENTORY_INCOMPLETE',
        issues: [issue('INVENTORY_INCOMPLETE')],
      };
    }
    return {
      // A metadata-only source can still provide a truthful successful
      // metadata response; its inability to provide bytes is represented by
      // each row's retrievalBlocker and the source outcome, not hidden as a
      // failed list call.
      status: 'ok',
      data,
      blocker: null,
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
    const entry = refs.get(request.documentRef);
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
    if (validationBlocker) {
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
      if (!input.readBytes) {
        return manualRead({
          metadata: current.metadata,
          validation: current.validation,
          format: request.format,
          blocker: 'SOURCE_UNAVAILABLE',
        });
      }
      let bytes: AuthorizedArtifactBytes | null;
      try {
        bytes = await input.readBytes(entry.record.attachment);
      } catch {
        return manualRead({
          metadata: current.metadata,
          validation: current.validation,
          format: request.format,
          blocker: 'SOURCE_UNAVAILABLE',
        });
      }
      if (!bytes) {
        return manualRead({
          metadata: current.metadata,
          validation: current.validation,
          format: request.format,
          blocker: 'UNSUPPORTED_FORMAT',
          extractionState: 'unsupported',
        });
      }
      if (entry.record.sha256 && bytes.sha256 !== entry.record.sha256) {
        return manualRead({
          metadata: current.metadata,
          validation: current.validation,
          format: request.format,
          blocker: 'DOCUMENT_CHANGED',
        });
      }
      const artifactRef = `artifact:${hash(`${request.documentRef}|${bytes.sha256}`)}`;
      const expires = new Date(now().getTime() + ttlMs).toISOString();
      return {
        status: 'ok',
        data: readData({
          metadata: current.metadata,
          validation: current.validation,
          format: request.format,
          extractionState: 'complete',
          artifactRef,
          sourceHash: bytes.sha256,
          artifactExpiresAt: expires,
        }),
        blocker: null,
        issues: [],
      };
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
    const sourceHash = result.evidence.sourceHash;
    if (result.status !== 'ok' || !result.data.text) {
      const blocker = extractionBlocker(result.data.reason);
      return manualRead({
        metadata: current.metadata,
        validation: current.validation,
        format: request.format,
        blocker,
        extractionState: result.data.reason === 'unsupported' ? 'unsupported' : 'partial',
        pageCount: result.data.pageCount,
        sourceHash: /^[a-f0-9]{64}$/i.test(sourceHash) ? sourceHash : null,
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
      status: 'ok',
      data: readData({
        metadata: current.metadata,
        validation: current.validation,
        format: request.format,
        extractionState: 'complete',
        text: result.data.text,
        pageCount: result.data.pageCount,
        sourceHash,
      }),
      blocker: null,
      issues: [],
    };
  }

  return {
    documents_list_existing: listExistingDocuments,
    documents_read_existing: readExistingDocument,
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
